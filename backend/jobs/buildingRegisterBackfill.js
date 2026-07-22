/**
 * building_register 점진 백필 — BR-BACKFILL-2026-07-19 (Sprint LLLLLL-4)
 *
 * 배경:
 *   건축물대장 세대수(getBuildingTitle)는 추천/보고서에서 KAPT 미매칭 후보에 온디맨드로 채워지고
 *   building_register 에 캐시된다(LLLLLL-3). 하지만 아직 검색 안 된 단지는 캐시가 비어 콜드 때
 *   추천이 느리다. 이 cron 이 거래 활발한 단지(6개월 n>=2) 중 캐시 없는 곳을 미리 채운다.
 *
 * 카카오 쿼터 보호 (중요):
 *   getBuildingTitle 은 지번→법정동코드에 Kakao 주소검색을 쓴다 — 지오코딩/검색과 쿼터를 공유하므로
 *   대량 호출은 실서비스(지도)를 깰 수 있다. 따라서 하루 total cap 을 매우 보수적으로(기본 100) 두고
 *   단일 실행에서만 처리한다(chunk loop 최소). building_register 캐시라 1회 채우면 재호출 없음.
 *
 * 게이트:
 *   후보 선정은 molit 그룹핑 anti-join 이 필요해 Postgres 함수 get_br_backfill_candidates 사용.
 *   함수 미생성 시 graceful no-op(로그만) — 운영자 SQL(SPRINT_NOTES BR-BACKFILL) 실행 후 활성.
 *
 * 안전:
 *   - getBuildingTitle 은 실패 시 null(캐시 미기록) — 실패 단지는 다음 실행에서 재시도(무한재시도는
 *     total cap 이 방어). 성공분은 building_register 에 남아 후보에서 제외(anti-join).
 *   - budgetMs 마진에서 종료(Vercel maxDuration 안전).
 */
const { createClient } = require('@supabase/supabase-js');
const { getBuildingTitle } = require('../services/buildingRegisterService');
const logger = require('../logger');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.service_role;

// BR-ACCEL-2026-07-22 (Sprint MMMMMM, 백로그 감사 A3): 100→300. 실측 3일 정상 가동(일 ~100 적재,
//   351행)·실패 0 확인 후 상향. Kakao +300/일(한도 100K)·건축HUB ~300-600/일(한도 10K) — 둘 다 안전.
//   잔여 ~9.2K → 92일에서 ~31일로 단축. 수동 트리거 상한(MAX)은 500.
const DEFAULT_TOTAL_CAP = 300;
const MAX_TOTAL_CAP = 500;
const CONCURRENCY = 3;

function adminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * @param {Object} opts
 * @param {number} [opts.cap=100]        — 하루 total 처리 상한 (Kakao 쿼터 보호)
 * @param {number} [opts.budgetMs=180000]
 */
async function run({ cap = DEFAULT_TOTAL_CAP, budgetMs = 180000 } = {}) {
  const started = Date.now();
  const admin = adminClient();
  if (!admin) return { ok: false, error: 'Supabase 미설정', processed: 0 };

  const totalCap = Math.min(Math.max(parseInt(cap) || DEFAULT_TOTAL_CAP, 1), MAX_TOTAL_CAP);

  // 후보 조회 — Postgres 함수(거래 n>=2 & building_register 미보유). 미생성 시 graceful no-op.
  let candidates = [];
  try {
    const { data, error } = await admin.rpc('get_br_backfill_candidates', { lim: totalCap });
    if (error) {
      // 42883: function 미존재 → 게이트 미충족(운영자 SQL 대기)
      logger.warn({ err: error.message, code: error.code }, 'building-register 백필: 후보 함수 미생성(운영자 SQL 대기) — no-op');
      return { ok: true, gated: true, processed: 0, note: 'get_br_backfill_candidates 미생성' };
    }
    candidates = Array.isArray(data) ? data : [];
  } catch (e) {
    logger.warn({ err: e.message }, 'building-register 백필: 후보 조회 실패 — no-op');
    return { ok: true, processed: 0, error: e.message };
  }
  if (!candidates.length) return { ok: true, processed: 0, message: '후보 없음(캐시 최신)' };

  let filled = 0, missed = 0;
  const queue = candidates.slice(0, totalCap);
  async function worker() {
    while (queue.length) {
      if ((Date.now() - started) > budgetMs - 10000) return; // budget 마진 종료
      const c = queue.shift();
      try {
        const t = await getBuildingTitle({
          lawdCd: String(c.lawd_cd || ''),
          sigungu: String(c.sigungu || ''),
          umdNm: String(c.umd_nm || ''),
          aptName: String(c.apt_name || ''),
        });
        if (t && Number.isFinite(t.hhldCnt) && t.hhldCnt > 0) filled++;
        else missed++;
      } catch (_) { missed++; }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const elapsed = Date.now() - started;
  logger.info({
    source: 'building-register-backfill',
    candidates: candidates.length, filled, missed, elapsedMs: elapsed,
  }, `building-register 백필: ${filled} 채움 / ${missed} 미확인 (${elapsed}ms)`);
  return { ok: true, processed: filled + missed, filled, missed, elapsedMs: elapsed };
}

module.exports = { run };
