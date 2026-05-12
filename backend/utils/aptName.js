/**
 * 단지명 표시·매칭용 정규화 — NAMEFIX-2026-05-11
 *
 * 배경 (운영자 발견, 2026-05-11):
 *   MOLIT 실거래 raw 데이터는 한 단지를 층수별로 분리 등록한 케이스가 있음.
 *   예) "상계주공9(고층)", "상계주공9(저층)" — 동일 단지인데 라벨만 다름.
 *   결과:
 *     1) 사용자 표시 "상계주공9(고층)" 어색 — 운영자 직접 지적
 *     2) Kakao 좌표 매칭 시 query 가 "(고층)" 까지 포함되어 검색 실패
 *     3) 평형/거래량 합산이 분리되어 부정확
 *
 * 정책:
 *   - DB raw `apt_name` 은 그대로 유지 — molit_transactions / apt_geocache 등
 *     기존 row 와 호환성 보존 (재마이그레이션 회피).
 *   - 사용자 가시 응답 + 외부 API 매칭 query 시점에만 정규화.
 *   - `(고층) / (중층) / (저층)` suffix 만 제거.
 *     차수("1차", "2차") · 동 정보는 단지 식별 핵심이라 보존.
 *
 * 적용처:
 *   - backend/services/propertyService.js  — recommend 응답의 aptName
 *   - backend/services/transactionService.js — getTransactionsByApt / 그룹별 결과
 *   - backend/services/geocodeCacheService.js — kakaoGeocode 의 query 빌드
 *   - (DB cache key buildKey 는 raw 유지 — 호환성)
 */

const FLOOR_SUFFIX_RE = /\s*\(\s*(?:고|중|저)\s*층\s*\)\s*/g;

/**
 * 단지명을 표시·매칭용으로 정규화.
 * @param {string|null|undefined} name
 * @returns {string}  정규화된 단지명 (빈 입력은 빈 문자열)
 */
function normalizeAptName(name) {
  if (name == null) return '';
  return String(name)
    .replace(FLOOR_SUFFIX_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { normalizeAptName };
