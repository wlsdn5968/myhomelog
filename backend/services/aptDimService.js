'use strict';
/**
 * aptDimService — 이름 기반 지번·준공연도 조회의 공용 폴백(Plan 107b-1/B6).
 *
 * [왜] 원본(molit_transactions)을 16개월 창으로 자르면(Plan 107c) 창 밖 단지는 이름으로 찾는
 *   조회(aptFacilityService.molitIdentity·geocodeCacheService.molitJibunAddress·
 *   buildingRegisterService.resolveJibun)에서 빈 결과가 된다 — 세 곳 다 날짜 하한이 없는 채로
 *   원본만 보기 때문이다. molit_apt_dim(Plan 107a, apt_seq 당 1행 보존, 09-20 최초 채움 후
 *   Plan 107b-1/B3 로 매일 갱신)은 원본이 지워져도 이름·지번·준공연도를 잃지 않는다.
 *
 * [원칙] 원본 우선 — 이 서비스는 호출부가 "원본 조회 결과가 비었을 때만" 부르는 폴백이다.
 *   원본이 있으면(설령 값이 빈약해도) 이 서비스를 부르지 않는다(각 호출부에서 강제).
 */
const { getSupabaseAdmin } = require('../db/client');
const cache = require('../cache');
const logger = require('../logger');

const CACHE_TTL_SEC = 3600; // 1h — 원본이 비어 반복 조회될 이름은 소수라 캐시로 충분히 줄인다.

/**
 * 이름·동(+지역)으로 molit_apt_dim 에서 단지 1행을 찾는다.
 * @param {{aptName:string, umdNm?:string, sigungu?:string, lawdCd?:string}} p
 * @returns {Promise<{aptSeq,aptName,lawdCd,sigungu,umdNm,buildYear,jibun,lastDealDate}|null>}
 */
async function findByName({ aptName, umdNm, sigungu, lawdCd } = {}) {
  if (!aptName || (!sigungu && !lawdCd)) return null; // 동명이지 오매칭 차단 — 지역 없이는 조회하지 않는다.
  const memKey = `dim:name:${lawdCd || sigungu}|${umdNm || ''}|${aptName}`;
  const hit = cache.get(memKey);
  if (hit !== undefined) return hit;

  const admin = getSupabaseAdmin();
  if (!admin) return null;
  try {
    let q = admin.from('molit_apt_dim')
      .select('apt_seq, apt_name, lawd_cd, sigungu, umd_nm, build_year, jibun, last_deal_date')
      .eq('apt_name', aptName);
    if (umdNm) q = q.eq('umd_nm', umdNm);
    if (lawdCd) q = q.eq('lawd_cd', lawdCd);
    else if (sigungu) q = q.eq('sigungu', sigungu);
    const { data, error } = await q.order('last_deal_date', { ascending: false }).limit(1);
    if (error) throw error;
    const r = (data || [])[0];
    const out = r ? {
      aptSeq: r.apt_seq,
      aptName: r.apt_name,
      lawdCd: r.lawd_cd || '',
      sigungu: r.sigungu || '',
      umdNm: r.umd_nm || '',
      buildYear: r.build_year || null,
      jibun: r.jibun || '',
      lastDealDate: r.last_deal_date || null,
    } : null;
    cache.set(memKey, out, CACHE_TTL_SEC);
    return out;
  } catch (e) {
    logger.warn({ err: e.message, aptName, umdNm, sigungu, lawdCd }, 'aptDimService.findByName 조회 실패');
    return null; // 실패는 캐시하지 않는다 — 다음 호출이 재시도(원본 빈 상태가 오래갈수록 폴백이 더 중요해진다)
  }
}

module.exports = { findByName };
