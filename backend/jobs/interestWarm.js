/**
 * INTEREST-WARM-2026-09-05: 장기 검색 관심도(네이버 데이터랩) 캐시를 하루 1회 채운다.
 *
 * [왜] 추천 점수의 관심도(10점)가 캐시 미스면 전 단지 중간값(5)이라 변별력이 0 이었다(프로덕션 실측 히트 0/15).
 *   서버리스는 응답 후 작업을 보장하지 않아 요청 경로에서 채울 수 없다(INTEREST-2026-08-30) → cron 이 맡는다.
 * [우선순위] 최근 거래가 많은 단지부터(molit_apt_index deal_count desc) — 추천에 실제로 등장하는 순서와 같다.
 * [비용] 호출당 대상 4개(MAX_TARGETS_PER_CALL)·하루 calls(기본 60) → 240단지/일, 네이버 일 한도(1,000) 안.
 *   warmInterest 가 이미 캐시된 단지를 건너뛰므로 같은 상위 목록을 매일 돌려도 다음 미충전분으로 자연히 전진한다.
 * [캐시 키] 추천 경로(getCachedInterest)와 같은 (단지명|시군구|MOLIT 동) — 동 표기가 다르면 히트가 0 이 된다(과거 실사고).
 */
const { getSupabaseAdmin } = require('../db/client');
const logger = require('../logger');

async function run({ calls = 60, top = 2000 } = {}) {
  const dl = require('../services/naverDatalabService');
  if (!dl.hasKeys()) return { skipped: 'no-key' };
  const admin = getSupabaseAdmin();
  if (!admin) return { skipped: 'no-db' };
  const PAGE = 1000; // PostgREST 1000행 컷 — 페이지로 받는다
  const idx = [];
  for (let from = 0; from < top; from += PAGE) {
    const { data, error } = await admin.from('molit_apt_index')
      .select('apt_name, sigungu, umd_nm, deal_count')
      .order('deal_count', { ascending: false }).order('apt_name', { ascending: true })
      .range(from, Math.min(top, from + PAGE) - 1);
    if (error) throw new Error(error.message);
    idx.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  const names = [...new Set(idx.map(r => r.apt_name).filter(Boolean))];
  const geo = new Map();
  for (let i = 0; i < names.length; i += 150) {
    const { data, error } = await admin.from('apt_geocache')
      .select('apt_name, sigungu, umd_nm, lat, lng')
      .in('apt_name', names.slice(i, i + 150)).not('lat', 'is', null);
    if (error) throw new Error(error.message);
    for (const g of (data || [])) { const k = `${g.apt_name}|${g.sigungu}`; if (!geo.has(k)) geo.set(k, g); }
  }
  const items = [];
  for (const r of idx) {
    const g = geo.get(`${r.apt_name}|${r.sigungu}`);
    if (!g || g.lat == null || g.lng == null) continue;
    items.push({ aptName: r.apt_name, sigungu: r.sigungu, umd: r.umd_nm || g.umd_nm || '', lat: Number(g.lat), lng: Number(g.lng) });
  }
  const t0 = Date.now();
  const summary = await dl.warmInterest(items, calls);
  const out = { top: idx.length, withCoord: items.length, elapsedMs: Date.now() - t0, ...summary };
  logger.info(out, 'cron/warm-interest');
  return out;
}

module.exports = { run };
