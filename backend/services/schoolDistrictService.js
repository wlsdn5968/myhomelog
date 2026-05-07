/**
 * 학구도 (통학구역) 서비스 — 단지 좌표 → 배정 초·중 추정
 *
 * STAB-AUDIT-2026-05-07 P2 (운영자 발견):
 *   호갱노노 핵심 기능 — 단지 → 배정 초등학교/중학교 표시.
 *
 * 데이터 source:
 *   - 공공데이터 "학교통학구역(학구도)" 정보는 시도교육청별 PDF/SHP — API X
 *   - 정확한 학구도 매핑 = 시도별 학구도 데이터 import 필요 (1-2일 작업)
 *
 * Phase 1 (현재 구현):
 *   - 학구도 데이터 도입 전 fallback: 가까운 초·중 에서 가장 가까운 1개 = "**배정 가능성 높음**"
 *   - 정직 카피: "확정 X — 학구도 검색 (학교알리미 또는 교육청) 별도 확인" 안내
 *   - 운영자 정직 정책 위반 X (사실 + 가능성만 표시)
 *
 * Phase 2 (Day 7 후, P2 본격 진행 시):
 *   - 서울 25구 학구도 SHP/GeoJSON import (서울교육청 공공데이터)
 *   - turf.js point-in-polygon 으로 정확 매칭
 *   - 매년 갱신 cron 추가
 *
 * 이 service 자체는 Phase 1 단순 구현 — fallback 형태.
 */
const logger = require('../logger');

/**
 * 학구도 추정 (Phase 1 fallback)
 * @param {Object} input - { lat, lng, sigungu, umdNm }
 * @returns {Object|null} { 초등: { name, distance_m, basis }, 중학교: { ... } }
 *   basis: 'nearest' (Phase 1) | 'district_polygon' (Phase 2)
 */
async function resolveSchoolDistrict(input) {
  // Phase 1: schoolService 가 이미 가장 가까운 학교 반환 — 별도 호출 불필요.
  //   facility endpoint 가 nearbySchools 의 type='초'/'중' 첫 row 사용 → "배정 가능성"
  //   여기서는 메타 정보만 (Phase 2 placeholder)
  return {
    basis: 'nearest_fallback',
    note: '가장 가까운 학교 = 배정 가능성 (학구도 정확 매핑 미적용). 학교알리미 별도 확인 권장.',
    coverage: {
      서울: 'phase1_fallback',
      경기: 'phase1_fallback',
      인천: 'phase1_fallback',
    },
  };
}

module.exports = { resolveSchoolDistrict };
