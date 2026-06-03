/**
 * apt_geocache 점진 백필 — STAB-AUDIT-2026-05-06 (운영자 발견 후속)
 *
 * 배경:
 *   - molit_transactions 16,044 distinct 단지 vs apt_geocache 172 row (1.07% coverage)
 *   - 사용자 검색 시 99% 단지가 마커 미표시 (lazy fill 의존만으로는 영원히 안 채워짐)
 *   - 운영자 ASSERT: "172 row 밖에 안되는거야"
 *
 * 전략:
 *   - 매일 1회 cron (vercel.json "0 4 * * *") + budgetMs 안 multi-chunk (50건/chunk default)
 *   - 거래 활발 단지 우선 (최근 60일 거래량 desc)
 *   - 정확 매칭 (sigungu+umd_nm+aptName) 만 INSERT — PR #44 환각 차단 검증 강제
 *   - 외부 geocoding quota 무료 한도 내 운용 목표 (월 사용량은 런타임 가변 — 고정 산정 불가)
 *
 * 안전:
 *   - NOT EXISTS apt_geocache 에만 처리 (덮어쓰기 X)
 *   - sigungu 검증 실패 시 INSERT 안 함 (환각 차단)
 *   - serverless maxDuration 안 — budgetMs(기본 240s)-15s 마진에서 chunk loop 종료 (run 함수)
 *   - resolveCoord 자체가 saveToDb 진행 → INSERT 자동
 */
const { createClient } = require('@supabase/supabase-js');
const { resolveCoordBatch, kakaoGeocode } = require('../services/geocodeCacheService');
const { isValidKoreaCoord } = require('../utils/geo');
const logger = require('../logger');

// 단지명 핵심 추출(접미사 아파트/단지/차/괄호/숫자/공백 제거) — reheal 관련성 판정용.
function _aptCore(s) { return String(s || '').replace(/아파트|오피스텔|단지|[차()\s\d]/g, ''); }

// CANON-COORD-FIX-2026-06-03 (운영자 승인 "재지오코딩 진행"): 비주거 place_name 으로 잘못 찍힌 기존 좌표를
//   본체로 in-place 재치유. 일일 backfill cron 시작 시 1회 호출.
//   2026-06-03 확장 (운영자 "태강아파트(아이파크) → 아이파크 공인중개사사무소 에 찍힘" 발견):
//   시설(충전소/주차장)뿐 아니라 사무소(공인중개사/부동산)·상점·음식점 등 비주거 전체로 탐지 확장.
const REHEAL_NONRES_KEYWORDS = [
  '공인중개사','중개사','부동산','사무소','편의점','마트','슈퍼','충전소','주차장','정류장','정문','후문',
  '관리사무소','경비실','놀이터','식당','음식점','카페','커피','병원','약국','의원','치과','한의원','학원',
  '교습소','은행','주유소','미용','이용원','세탁','노래','호프','치킨','국밥','분식','족발','횟집','고깃집',
  '당구','헬스','문구','마켓','상회','정비','공업사','교회','성당','어린이집','유치원',
];
const REHEAL_NONRES_RE = new RegExp(REHEAL_NONRES_KEYWORDS.join('|'));

/**
 * 비주거 place_name 좌표 재치유 — Kakao 재지오코딩(하드닝 필터) 후 "더 나은(주거 본체) 좌표"만 in-place UPDATE.
 * 안전: 비주거-아님 + 한국 유효좌표 + 동일 시군구(kakaoGeocode 내부 검증) + 단지명 관련성 + 이동 20m~2km 일 때만 갱신.
 *      개선 불가(여전히 비주거/실패)는 source='kakao-sub' 마킹 → 다음 run 제외(무한 재시도 방지).
 */
async function rehealSubfeatures(admin, { cap = 300, budgetMs = 120000 } = {}) {
  const started = Date.now();
  const { data: rows } = await admin
    .from('apt_geocache')
    .select('apt_key, apt_name, sigungu, umd_nm, lat, lng, place_name, address')
    .eq('source', 'kakao')
    .or(REHEAL_NONRES_KEYWORDS.map(k => `place_name.ilike.%${k}%`).join(','))
    .limit(cap);
  const subs = (rows || []).filter(r => REHEAL_NONRES_RE.test(r.place_name || ''));
  if (!subs.length) return { tried: 0, healed: 0, marked: 0 };

  let tried = 0, healed = 0, marked = 0;
  const queue = [...subs];
  async function worker() {
    while (queue.length && (Date.now() - started) < budgetMs) {
      const r = queue.shift();
      tried++;
      try {
        const fresh = await kakaoGeocode({ aptName: r.apt_name, sigungu: r.sigungu, umdNm: r.umd_nm, address: r.address });
        let didHeal = false;
        if (fresh && isValidKoreaCoord(fresh.lat, fresh.lng) && !REHEAL_NONRES_RE.test(fresh.placeName || '')) {
          // 안전장치: 재지오코딩 결과 place_name 이 단지명과 관련될 때만(이웃 단지 오매칭 차단)
          const aCore = _aptCore(r.apt_name);
          const pCore = _aptCore(fresh.placeName || '');
          const related = aCore.length >= 2 && (pCore.includes(aCore) || aCore.includes(pCore));
          const dx = (fresh.lng - Number(r.lng)) * Math.cos(fresh.lat * Math.PI / 180);
          const moved = 111000 * Math.sqrt(Math.pow(fresh.lat - Number(r.lat), 2) + Math.pow(dx, 2));
          if (related && moved >= 20 && moved <= 2000) {
            await admin.from('apt_geocache').update({
              lat: fresh.lat, lng: fresh.lng, place_name: fresh.placeName, address: fresh.address, source: 'kakao',
            }).eq('apt_key', r.apt_key);
            healed++; didHeal = true;
          }
        }
        // 개선 불가/관련성 미달 → 좌표 불변, source 마킹해 다음 run 제외(무한 재시도 방지).
        //   단, fresh=null(Kakao 일시실패/쿼터소진/페널티거부)은 마킹 안 함 → 다음 run 재시도(false-마킹 방지).
        if (!didHeal && fresh) {
          await admin.from('apt_geocache').update({ source: 'kakao-sub' }).eq('apt_key', r.apt_key);
          marked++;
        }
      } catch (_) { /* 개별 실패(Kakao 일시오류 등) 무시 — source 유지 → 다음 run 재시도 */ }
    }
  }
  await Promise.all(Array.from({ length: 4 }, () => worker()));
  logger.info({ source: 'geocache-reheal', tried, healed, marked, elapsedMs: Date.now() - started },
    `geocache reheal: ${healed} 본체교정 / ${marked} 개선불가마킹 / ${tried} 시도`);
  return { tried, healed, marked };
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.service_role;

const DEFAULT_CHUNK = 50;
const MAX_CHUNK = 100;

function adminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * 백필 multi-chunk 실행 (budget time 안에 반복)
 * @param {Object} opts
 * @param {number} [opts.chunk=50]   — 1 chunk 처리 단지 수
 * @param {number} [opts.daysBack=180] — 거래 lookback 일수
 * @param {number} [opts.budgetMs=240000] — 총 실행 budget (Vercel maxDuration 300s 안전 마진)
 */
async function run({ chunk = DEFAULT_CHUNK, daysBack = 180, budgetMs = 240000 } = {}) {
  const started = Date.now();
  const admin = adminClient();
  if (!admin) {
    return { ok: false, error: 'Supabase 미설정', processed: 0 };
  }

  const limit = Math.min(Math.max(parseInt(chunk) || DEFAULT_CHUNK, 1), MAX_CHUNK);
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // CANON-COORD-FIX-2026-06-03: 하위시설 좌표 재치유 (1회 본체 교정) — 백필 루프 전 최대 90s.
  let reheal = { tried: 0, healed: 0, marked: 0 };
  try { reheal = await rehealSubfeatures(admin, { cap: 300, budgetMs: 120000 }); }
  catch (e) { logger.warn({ err: e.message }, 'geocache reheal 실패(무시)'); }

  // budget 안 multi-chunk loop
  let totalProcessed = 0, totalInserted = 0, totalFailed = 0, chunks = 0;
  while ((Date.now() - started) < budgetMs - 15000) {  // 15s 마진 (마지막 chunk 안전 종료)
    const tickResult = await runOneChunk(admin, limit, since);
    if (tickResult.processed === 0) break; // 더 처리할 단지 X
    totalProcessed += tickResult.processed;
    totalInserted += tickResult.inserted;
    totalFailed += tickResult.failed;
    chunks++;
  }
  const elapsed = Date.now() - started;
  logger.info({
    source: 'geocache-backfill',
    chunks, totalProcessed, totalInserted, totalFailed, elapsedMs: elapsed,
  }, `geocache backfill: ${chunks} chunks, ${totalInserted}/${totalProcessed} 백필 (${elapsed}ms)`);
  return { ok: true, reheal, chunks, processed: totalProcessed, inserted: totalInserted, failed: totalFailed, elapsedMs: elapsed };
}

async function runOneChunk(admin, limit, since) {
  const tickStart = Date.now();

  // 거래 활발 단지 (apt_name, sigungu, umd_nm) distinct + 거래수 desc — RPC 또는 raw SQL
  // RPC 미정의 시 fallback: 일반 query (DISTINCT + 거래량 그룹)
  let candidates = [];
  try {
    const { data, error } = await admin.rpc('geocache_backfill_candidates', {
      p_limit: limit,
      p_since: since,
    });
    if (error) throw error;
    candidates = data || [];
  } catch (rpcErr) {
    logger.debug({ err: rpcErr.message }, 'geocache_backfill_candidates RPC 미정의 — fallback');
    // Fallback: 단순 fetch (서울 25구 우선)
    const { data, error } = await admin
      .from('molit_transactions')
      .select('apt_name, sigungu, umd_nm')
      .gte('deal_date', since)
      .limit(limit * 20); // 중복 많아 over-fetch
    if (error) {
      logger.error({ err: error.message }, 'geocache backfill 후보 조회 실패');
      return { ok: false, error: error.message, processed: 0 };
    }
    // distinct + 거래수 집계
    const groups = {};
    for (const r of (data || [])) {
      const k = `${r.apt_name}|${r.sigungu}|${r.umd_nm}`;
      groups[k] = (groups[k] || 0) + 1;
    }
    candidates = Object.entries(groups)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit * 5)
      .map(([k]) => {
        const [apt_name, sigungu, umd_nm] = k.split('|');
        return { apt_name, sigungu, umd_nm };
      });
  }

  if (!candidates.length) {
    return { processed: 0, inserted: 0, failed: 0, message: '후보 없음' };
  }

  // apt_geocache 미보유 단지만 필터
  const keys = candidates.map(c => `${c.apt_name}|${c.sigungu}|${c.umd_nm}`);
  const { data: existing } = await admin
    .from('apt_geocache')
    .select('apt_name, sigungu, umd_nm')
    .in('apt_name', candidates.map(c => c.apt_name).slice(0, 200));

  const existingSet = new Set((existing || []).map(e => `${e.apt_name}|${e.sigungu||''}|${e.umd_nm||''}`));
  const todo = candidates.filter(c => !existingSet.has(`${c.apt_name}|${c.sigungu}|${c.umd_nm}`)).slice(0, limit);

  if (!todo.length) {
    return { processed: 0, inserted: 0, failed: 0, message: '모두 이미 보유' };
  }

  // resolveCoordBatch — sigungu 검증 강제 (PR #44 fix), saveToDb 자동 INSERT
  const items = todo.map(t => ({
    aptName: t.apt_name,
    sigungu: t.sigungu,
    umdNm: t.umd_nm,
  }));

  const results = await resolveCoordBatch(items, 4);
  const inserted = results.filter(r => r && r.lat && r.lng).length;
  const failed = results.length - inserted;

  return { processed: todo.length, inserted, failed, elapsedMs: Date.now() - tickStart };
}

module.exports = { run };
