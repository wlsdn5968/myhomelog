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
const { createClient } = require('@supabase/supabase-js');
const logger = require('../logger');
const { getAliasCanonicalMap } = require('../services/transactionService');
const { normalizeAptName } = require('../utils/aptName');
const { isKakaoConfigured, sendKakaoMemo, refreshKakaoToken } = require('../services/kakaoMemoService');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.service_role;

function dbClient() {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const norm = s => String(s || '').normalize('NFC').replace(/\s+/g, '').toLowerCase();
// NAMEFIX 유틸 재사용 — MOLIT 분리표기("상계주공9(고층)")를 표시명("상계주공9")과 동일 취급.
const nn = s => norm(normalizeAptName(String(s || '')));
const fmtEok = man => (man / 10000).toFixed(man >= 100000 ? 0 : 1); // 만원 → 억

/** 테이블 로드 — 미생성(42P01)은 [] 로 조용히 처리 */
async function loadRows(admin, table) {
  const { data, error } = await admin.from(table).select('*').limit(500);
  if (error) {
    if (String(error.code) === '42P01') return { rows: [], missing: true };
    throw new Error(`${table}: ${error.message}`);
  }
  return { rows: data || [], missing: false };
}

/** 구독 1건의 items 를 신규 거래 rows 와 매칭 → [{name, count, maxMan}] (count desc) */
function matchItems(items, rows, aliasMap, since) {
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
  const floor48h = new Date(now - 48 * 3600 * 1000);
  const sinceOf = s => {
    const w = s.last_notified_at ? new Date(s.last_notified_at) : null;
    return (w && w > floor48h) ? w : floor48h; // 48h 바닥 — 과다조회·중복 융단폭격 방지
  };
  const allSubs = [...push.rows, ...kakao.rows];
  const lawds = [...new Set(allSubs.flatMap(s => (s.items || []).map(it => it.lawdCd)).filter(c => /^\d{5}$/.test(String(c))))];
  if (!lawds.length) return { subs: push.rows.length, kakaoSubs: kakao.rows.length, sent: 0, kakaoSent: 0, note: '유효 lawdCd 없음' };
  const minSince = new Date(Math.min(...allSubs.map(s => sinceOf(s).getTime()))).toISOString();

  // ── 신규 ingest 거래 1회 조회 (1000행 페이징, 5천행 안전캡) ──
  let rows = [];
  for (let from = 0; from <= 4000; from += 1000) {
    const { data: page, error } = await admin
      .from('molit_transactions')
      .select('apt_name, sigungu, umd_nm, lawd_cd, deal_date, deal_amount, exclu_use_ar, ingested_at')
      .in('lawd_cd', lawds)
      .gte('ingested_at', minSince)
      .order('ingested_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    if (page && page.length) rows = rows.concat(page);
    if (!page || page.length < 1000) break;
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
