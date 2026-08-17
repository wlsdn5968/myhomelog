/**
 * 관심단지 신규 실거래 알림 발송 cron (Sprint EEEEEE, FFFFFF 카카오 채널 추가)
 *
 * 채널 (게이트 독립 — 충족된 채널만 발송):
 *   1) 웹푸시: push_subscriptions (익명 브라우저 단위) — VAPID env + web-push 패키지 + 테이블
 *   2) 카카오톡 나에게 보내기: kakao_notify_tokens (로그인 유저 단위) — KAKAO_REST_API_KEY +
 *      카카오 콘솔(talk_message 선택동의) + 테이블. portai(wlsdn5968/portai) 실동작 패턴 포팅.
 *
 * 공통 흐름 (일 1회 18:20 UTC, molit-ingest 3슬롯 후):
 *   두 채널의 관심단지 lawd_cd 합집합 + 최소 워터마크로 molit_transactions 의
 *   '새로 반영된 거래(ingested_at 기준)'를 1회 조회 → 채널별 매칭·발송 → 워터마크 갱신.
 *   이름 매칭은 NAMEFIX 공용 유틸(normalizeAptName) + molit_aliases canonical — 검색/추천과 동일 semantics.
 */
const logger = require('../logger');
const { getAliasCanonicalMap } = require('../services/transactionService');
const { normalizeAptName } = require('../utils/aptName');
const { isKakaoConfigured, sendKakaoMemo, refreshKakaoToken } = require('../services/kakaoMemoService');
// SSOT-2026-08-09 (Plan 007): 자체 createClient → db/client 팩토리 (null-게이트 의미 유지)
const { getSupabaseAdmin } = require('../db/client');

function dbClient() {
  return getSupabaseAdmin();
}

const norm = s => String(s || '').normalize('NFC').replace(/\s+/g, '').toLowerCase();
// NAMEFIX 유틸 재사용 — MOLIT 분리표기("상계주공9(고층)")를 표시명("상계주공9")과 동일 취급.
const nn = s => norm(normalizeAptName(String(s || '')));
const fmtEok = man => (man / 10000).toFixed(man >= 100000 ? 0 : 1); // 만원 → 억

/** 테이블 로드 — 미생성(42P01)은 [] 로 조용히 처리 */
async function loadRows(admin, table) {
  const { data, error } = await admin.from(table).select('*').limit(500);
  if (error) {
    if (['42P01','PGRST205'].includes(String(error.code))) return { rows: [], missing: true };
    throw new Error(`${table}: ${error.message}`);
  }
  // SUBS-CAP-2026-08-17: limit(500) 은 조용한 상한이다 — 구독자가 500 을 넘으면 초과분은
  //   **알림을 영영 못 받는데 아무 신호도 안 난다**(이 저장소가 반복해서 겪은 PostgREST 행 캡 부류).
  //   현재 3명이라 여유가 크지만, 늘어난 순간을 알아야 페이징으로 바꿀 수 있다.
  if ((data || []).length >= 500) {
    logger.warn({ table, rows: data.length }, '알림 구독자 조회가 상한(500)에 닿음 — 페이징 필요');
  }
  return { rows: data || [], missing: false };
}

/** 구독 1건의 items 를 신규 거래 rows 와 매칭 → [{name, count, maxMan}] (count desc) */
function matchItems(rawItems, rows, aliasMap, since) {
  // DEDUP-2026-07-18 (실측: 카카오 연결 items 에 동일 단지 2건 — 북마크 로컬·서버 병합 중복) —
  //   같은 (aptName, lawdCd) 중복 항목이 거래를 이중 카운트해 '새 실거래 N건'을 부풀리는 것 차단.
  const seen = new Set();
  const items = (rawItems || []).filter(it => {
    const k = `${nn(it.aptName)}|${it.lawdCd}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const perItem = new Map();
  for (const r of rows) {
    if (new Date(r.ingested_at) <= since) continue;
    const canon = aliasMap.get(`${r.apt_name}|${r.umd_nm || ''}`) || r.apt_name;
    for (const it of items) {
      if (it.lawdCd !== r.lawd_cd) continue;
      if (nn(canon) !== nn(it.aptName) && nn(r.apt_name) !== nn(it.aptName)) continue;
      if (it.umdNm && r.umd_nm && norm(it.umdNm) !== norm(r.umd_nm)) continue;
      const g = perItem.get(it.aptName) || { count: 0, maxMan: 0 };
      g.count += 1;
      g.maxMan = Math.max(g.maxMan, Number(r.deal_amount) || 0);
      perItem.set(it.aptName, g);
    }
  }
  return [...perItem.entries()]
    .map(([name, g]) => ({ name, ...g }))
    .sort((a, b) => b.count - a.count);
}

function buildBody(entries) {
  const top = entries[0];
  const extra = entries.length - 1;
  return `${top.name} 새 실거래 ${top.count}건 · 최고 ${fmtEok(top.maxMan)}억${extra > 0 ? ` 외 ${extra}개 단지` : ''}`;
}

async function run() {
  const admin = dbClient();
  if (!admin) return { skipped: 'DB 미설정' };

  // ── 두 채널 구독 로드 (게이트 독립) ──
  const push = await loadRows(admin, 'push_subscriptions');
  const kakao = isKakaoConfigured() ? await loadRows(admin, 'kakao_notify_tokens') : { rows: [], missing: false };
  if (!push.rows.length && !kakao.rows.length) {
    return { subs: 0, kakaoSubs: 0, sent: 0, kakaoSent: 0, note: '구독 없음' };
  }

  const now = Date.now();
  // CRON-MISS-2026-08-17 (Sprint MMMMMMM-24): 바닥을 48h → 72h.
  //   [근거] Vercel 공식 문서: cron 전달은 **best effort** 라 회차가 통째로 누락될 수 있고
  //     (그때 런타임 로그도 안 남는다) 실패해도 재시도하지 않는다. 즉 누락은 예외가 아니라 정상 범위다.
  //     바닥이 48h 면 **하루만 걸러도 경계**이고 이틀 연속이면 그 사이 신고된 거래가 영구히 안 나간다
  //     — 사용자는 관심단지 거래를 놓치고, 놓쳤다는 사실조차 모른다.
  //   72h = 2회 연속 누락 내성. cronStats 의 미실행 임계 50h(=2회 누락)와 같은 기준으로 맞춘다.
  //   ⚠ 알림 폭주 걱정은 없다 — buildBody 는 구독자당 **요약 1건**을 만든다("N건 · 최고 X억 외 M개 단지").
  //     창을 넓혀도 메시지 수가 아니라 N 만 커진다. 조회량도 실측상 무시할 수준이다
  //     (2026-08-17: 구독 지역 전체의 48h 내 신규 적재 = **11행**).
  const NOTIFY_FLOOR_MS = 72 * 3600 * 1000;
  const floorTs = new Date(now - NOTIFY_FLOOR_MS);
  const sinceOf = s => {
    const w = s.last_notified_at ? new Date(s.last_notified_at) : null;
    return (w && w > floorTs) ? w : floorTs;
  };
  const allSubs = [...push.rows, ...kakao.rows];
  const lawds = [...new Set(allSubs.flatMap(s => (s.items || []).map(it => it.lawdCd)).filter(c => /^\d{5}$/.test(String(c))))];
  if (!lawds.length) return { subs: push.rows.length, kakaoSubs: kakao.rows.length, sent: 0, kakaoSent: 0, note: '유효 lawdCd 없음' };
  const minSince = new Date(Math.min(...allSubs.map(s => sinceOf(s).getTime()))).toISOString();

  // ── 신규 ingest 거래 1회 조회 (1000행 페이징, 5천행 안전캡) ──
  // ⚠ CAP-ORDER-2026-08-17 (Sprint MMMMMMM-24): 정렬을 오름차순 → **내림차순**으로 바꿨다.
  //   안전캡(5,000행)에 걸리면 잘리는 쪽이 생기는데, 오름차순이면 **가장 최근 거래가 잘린다** —
  //   "새 실거래 알림" 에서 최신을 버리고 오래된 것만 남기는 것은 정확히 반대다.
  //   내림차순이면 최신은 반드시 포함되고, 캡에 걸릴 때 건수가 과소 보고될 뿐이다(거짓 신호가 아니다).
  //   [언제 발현되나 — 실측] 평소엔 무해하다(2026-08-17 구독 지역 48h 신규 = 11행).
  //     그러나 지역 backfill 같은 대량 적재일엔 하루 +47,319행이 들어온 적이 있다(2026-08-16).
  //     그런 날 구독 지역이 겹치면 캡을 넘긴다. 정렬만 바꿔도 그때 최신을 잃지 않는다.
  const ROW_CAP = 5000;
  let rows = [];
  for (let from = 0; from <= ROW_CAP - 1000; from += 1000) {
    const { data: page, error } = await admin
      .from('molit_transactions')
      .select('apt_name, sigungu, umd_nm, lawd_cd, deal_date, deal_amount, exclu_use_ar, ingested_at')
      .in('lawd_cd', lawds)
      .gte('ingested_at', minSince)
      .order('ingested_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    if (page && page.length) rows = rows.concat(page);
    if (!page || page.length < 1000) break;
  }
  // 캡에 닿았다 = 이번 회차에 못 본 거래가 있다는 뜻. 조용히 넘기면 건수가 틀린 채로 발송된다.
  if (rows.length >= ROW_CAP) {
    logger.warn({ rows: rows.length, cap: ROW_CAP, lawds: lawds.length },
      '알림 조회가 안전캡에 닿음 — 건수가 과소 보고될 수 있다(최신은 포함)');
  }

  let aliasMap = new Map();
  try { aliasMap = await getAliasCanonicalMap(lawds); } catch (_) {}

  // ── 채널 1: 웹푸시 ──
  let sent = 0, removed = 0, failed = 0;
  const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
  const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
  let webpush = null;
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    try {
      webpush = require('web-push');
      webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:wlsdn5968@gmail.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    } catch (_) { webpush = null; }
  }
  const pushProcessed = [];
  if (webpush) {
    for (const s of push.rows) {
      pushProcessed.push(s.id);
      const entries = matchItems(Array.isArray(s.items) ? s.items : [], rows, aliasMap, sinceOf(s));
      if (!entries.length) continue;
      const payload = JSON.stringify({ title: '📡 관심단지 새 실거래', body: buildBody(entries), url: '/' });
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86400 });
        sent += 1;
        if (s.fail_count > 0) await admin.from('push_subscriptions').update({ fail_count: 0 }).eq('id', s.id);
      } catch (e) {
        const code = e?.statusCode;
        if (code === 404 || code === 410) {
          await admin.from('push_subscriptions').delete().eq('id', s.id);
          removed += 1;
        } else {
          failed += 1;
          const fc = (s.fail_count || 0) + 1;
          if (fc >= 5) { await admin.from('push_subscriptions').delete().eq('id', s.id); removed += 1; }
          else await admin.from('push_subscriptions').update({ fail_count: fc }).eq('id', s.id);
        }
      }
    }
    if (pushProcessed.length) {
      await admin.from('push_subscriptions').update({ last_notified_at: new Date().toISOString() }).in('id', pushProcessed);
    }
  }

  // ── 채널 2: 카카오톡 나에게 보내기 (Sprint FFFFFF) ──
  let kakaoSent = 0, kakaoFailed = 0, kakaoRemoved = 0, kakaoRefreshed = 0;
  const kakaoProcessed = [];
  for (const t of kakao.rows) {
    kakaoProcessed.push(t.user_id);
    const entries = matchItems(Array.isArray(t.items) ? t.items : [], rows, aliasMap, sinceOf(t));
    if (!entries.length) continue;

    // 만료 임박(60초 여유) 시 선제 refresh — portai 는 401 후행 refresh, 우리는 예방 + 후행 둘 다
    let accessToken = t.access_token;
    const preExpired = t.expires_at && new Date(t.expires_at).getTime() < now + 60 * 1000;
    const doRefresh = async () => {
      const rf = await refreshKakaoToken(t.refresh_token);
      if (!rf.ok) return false;
      accessToken = rf.accessToken;
      kakaoRefreshed += 1;
      await admin.from('kakao_notify_tokens').update({
        access_token: rf.accessToken,
        refresh_token: rf.refreshToken || t.refresh_token,
        expires_at: rf.expiresIn ? new Date(Date.now() + rf.expiresIn * 1000).toISOString() : null,
      }).eq('user_id', t.user_id);
      return true;
    };
    if (preExpired && !(await doRefresh())) {
      kakaoFailed += 1;
      const fc = (t.fail_count || 0) + 1;
      if (fc >= 5) { await admin.from('kakao_notify_tokens').delete().eq('user_id', t.user_id); kakaoRemoved += 1; }
      else await admin.from('kakao_notify_tokens').update({ fail_count: fc }).eq('user_id', t.user_id);
      continue;
    }

    const msg = { title: '📡 내집로그 관심단지 새 실거래', description: buildBody(entries), webUrl: 'https://myhomelog.vercel.app' };
    let r = await sendKakaoMemo({ accessToken, ...msg });
    if (r.needsRefresh && (await doRefresh())) {
      r = await sendKakaoMemo({ accessToken, ...msg });
    }
    if (r.ok && !r.skipped) {
      kakaoSent += 1;
      if (t.fail_count > 0) await admin.from('kakao_notify_tokens').update({ fail_count: 0 }).eq('user_id', t.user_id);
    } else if (!r.ok) {
      kakaoFailed += 1;
      const fc = (t.fail_count || 0) + 1;
      if (fc >= 5) { await admin.from('kakao_notify_tokens').delete().eq('user_id', t.user_id); kakaoRemoved += 1; }
      else await admin.from('kakao_notify_tokens').update({ fail_count: fc }).eq('user_id', t.user_id);
    }
  }
  if (kakaoProcessed.length) {
    await admin.from('kakao_notify_tokens').update({ last_notified_at: new Date().toISOString() }).in('user_id', kakaoProcessed);
  }

  const stats = {
    lawds: lawds.length, txScanned: rows.length,
    subs: push.rows.length, sent, removed, failed,
    webGate: webpush ? 'on' : (push.rows.length ? 'off(VAPID/pkg)' : 'off'),
    kakaoSubs: kakao.rows.length, kakaoSent, kakaoFailed, kakaoRemoved, kakaoRefreshed,
    kakaoGate: isKakaoConfigured() ? (kakao.missing ? 'off(table)' : 'on') : 'off(env)',
  };
  logger.info({ src: 'push-notify', ...stats }, '관심단지 알림 발송 완료 (웹푸시+카카오)');
  return stats;
}

module.exports = { run };
