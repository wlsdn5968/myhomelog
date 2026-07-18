/**
 * 관심단지 신규 실거래 푸시 발송 cron (Sprint EEEEEE)
 *
 * 흐름 (일 1회, molit-ingest 3슬롯(17:00~17:30 UTC) 이후 18:20 UTC):
 *   1) push_subscriptions 로드 (≤500)
 *   2) 구독들의 관심단지 lawd_cd 합집합으로 molit_transactions 에서
 *      ingested_at ≥ min(구독별 워터마크) 인 '오늘 새로 반영된 거래' 1회 조회
 *   3) 구독별로 (aptName 정규화 + molit_aliases canonical + lawd/umd) 매칭 → 발송
 *   4) 만료 구독(404/410) 삭제, fail_count ≥5 삭제, 워터마크(last_notified_at) 갱신
 *
 * 게이트: VAPID env + web-push 패키지 + push_subscriptions 테이블 — 없으면 { skipped } 로 조용히 종료.
 * 발신 기준을 deal_date 가 아니라 ingested_at 으로 잡는 이유: MOLIT 신고는 30일+ 지연될 수 있어
 * '오늘 우리 DB에 새로 들어온 거래'가 사용자 관점의 '새 소식'과 일치함.
 */
const { createClient } = require('@supabase/supabase-js');
const logger = require('../logger');
const { getAliasCanonicalMap } = require('../services/transactionService');
const { normalizeAptName } = require('../utils/aptName');

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
//   검색/추천/지오코딩과 같은 매칭 semantics (실측: 상계주공9 alias 빈 배열이라 norm 만으론 미매칭).
const nn = s => norm(normalizeAptName(String(s || '')));
const fmtEok = man => (man / 10000).toFixed(man >= 100000 ? 0 : 1); // 만원 → 억

async function run() {
  const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
  const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
  const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:wlsdn5968@gmail.com';
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return { skipped: 'VAPID env 미설정' };

  let webpush;
  try { webpush = require('web-push'); } catch (_) { return { skipped: 'web-push 패키지 없음' }; }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const admin = dbClient();
  if (!admin) return { skipped: 'DB 미설정' };

  // 1) 구독 로드
  const { data: subs, error: subErr } = await admin
    .from('push_subscriptions').select('*').order('id').limit(500);
  if (subErr) {
    if (String(subErr.code) === '42P01') return { skipped: 'push_subscriptions 테이블 미생성 (운영자 SQL 대기)' };
    throw new Error(subErr.message);
  }
  if (!subs || !subs.length) return { subs: 0, sent: 0 };

  const now = Date.now();
  const floor48h = new Date(now - 48 * 3600 * 1000);
  const sinceOf = s => {
    const w = s.last_notified_at ? new Date(s.last_notified_at) : null;
    // 워터마크 없거나 48h보다 오래됐으면 48h 바닥 — 과다 조회·중복 융단폭격 방지
    return (w && w > floor48h) ? w : floor48h;
  };

  // 2) lawd 합집합으로 신규 ingest 거래 1회 조회 (1000행 페이징, 최대 5천행 안전캡)
  const lawds = [...new Set(subs.flatMap(s => (s.items || []).map(it => it.lawdCd)).filter(c => /^\d{5}$/.test(String(c))))];
  if (!lawds.length) return { subs: subs.length, sent: 0, note: '유효 lawdCd 없음' };
  const minSince = new Date(Math.min(...subs.map(s => sinceOf(s).getTime()))).toISOString();

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

  // 3) alias canonical (풍림아파트A → 공릉풍림아이원 등) — 검색/추천과 동일 식별
  let aliasMap = new Map();
  try { aliasMap = await getAliasCanonicalMap(lawds); } catch (_) {}

  let sent = 0, removed = 0, failed = 0;
  const processedIds = [];
  for (const s of subs) {
    processedIds.push(s.id);
    const since = sinceOf(s);
    const items = Array.isArray(s.items) ? s.items : [];
    if (!items.length) continue;

    // 구독별 매칭: lawd + 정규화 단지명(canonical) + (있으면) 법정동
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
    if (!perItem.size) continue;

    const entries = [...perItem.entries()].sort((a, b) => b[1].count - a[1].count);
    const [topName, topG] = entries[0];
    const extra = entries.length - 1;
    const body = `${topName} 새 실거래 ${topG.count}건 · 최고 ${fmtEok(topG.maxMan)}억${extra > 0 ? ` 외 ${extra}개 단지` : ''}`;
    const payload = JSON.stringify({
      title: '📡 관심단지 새 실거래',
      body,
      url: '/',
    });
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 86400 },
      );
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

  // 4) 워터마크 일괄 갱신 (발송 유무 무관 — '여기까지 봤다'). fail_count 는 위에서 개별 관리 — 여기서 덮지 않음.
  if (processedIds.length) {
    await admin.from('push_subscriptions')
      .update({ last_notified_at: new Date().toISOString() })
      .in('id', processedIds);
  }

  const stats = { subs: subs.length, lawds: lawds.length, txScanned: rows.length, sent, removed, failed };
  logger.info({ src: 'push-notify', ...stats }, '관심단지 푸시 발송 완료');
  return stats;
}

module.exports = { run };
