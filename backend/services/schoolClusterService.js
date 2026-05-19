/**
 * 학군 권역 (학세권) 분류 서비스
 *
 * Sprint OO (2026-05-19, 운영자 요청 "강연 자료 적용"):
 *   - 2026 부동산 강연 자료의 3대 학원가 + 4권역 분류를 단지에 매핑
 *   - 정적 데이터 기반 (환각 위험 0)
 *   - 매수 추천 X / 가격 예측 X / 정보 정리 도구
 *
 * 입력: sigungu, umdNm
 * 출력: { hubs: [...], regions: [...] } | null
 */
const { ACADEMY_HUBS, REGION_CLUSTERS } = require('../data/schoolClusters');

/**
 * sigungu pattern 매칭 — 정확 일치 또는 부분 일치 (단지 sigungu 가 양식 다양)
 * 예: "강남구" matches "서울 강남구", "강남구"
 *      "성남시 분당구" matches "성남시 분당구", "분당구" (단지 sigungu 가 둘 다 있을 수 있음)
 */
function matchSigungu(sigungu, patterns) {
  if (!sigungu) return false;
  const sg = String(sigungu).trim();
  return patterns.some(p => {
    if (sg === p) return true;
    // 양방향 substring — 단지 데이터의 sigungu 표기 양식 차이 흡수
    // 단, 너무 짧은 (2글자) 매칭은 false positive 위험 → length >= 3 만 양방향
    if (p.length >= 3 && sg.includes(p)) return true;
    if (sg.length >= 3 && p.includes(sg)) return true;
    return false;
  });
}

/**
 * umdNm pattern 매칭 — '*' wildcard, '*OO*' substring, 또는 정확 일치
 */
function matchUmd(umdNm, patterns) {
  const umd = String(umdNm || '').trim();
  return patterns.some(p => {
    if (p === '*') return true;
    if (p.startsWith('*') && p.endsWith('*')) {
      const inner = p.slice(1, -1);
      return umd.includes(inner);
    }
    return umd === p;
  });
}

/**
 * 단지의 학군 권역 정보 해결
 * @param {Object} input - { sigungu, umdNm }
 * @returns {Object|null} { hubs, regions, source, disclaimer } 또는 null
 */
function resolveSchoolCluster({ sigungu, umdNm }) {
  if (!sigungu) return null;

  const hubs = [];
  const regions = [];

  // 3대 학원가
  for (const hub of ACADEMY_HUBS) {
    if (matchSigungu(sigungu, hub.sigunguPatterns) &&
        matchUmd(umdNm, hub.umdPatterns)) {
      hubs.push({
        key: hub.key,
        label: hub.label,
        note: hub.note,
      });
    }
  }

  // 4권역
  for (const cluster of REGION_CLUSTERS) {
    if (matchSigungu(sigungu, cluster.sigunguPatterns) &&
        matchUmd(umdNm, cluster.umdPatterns)) {
      regions.push({
        region: cluster.region,
        name: cluster.name,
        label: `${cluster.region} 학군지 (${cluster.name})`,
        note: cluster.note,
      });
    }
  }

  if (!hubs.length && !regions.length) return null;

  return {
    hubs,
    regions,
    source: '2026_lecture_static',
    disclaimer: '강연 자료 기반 학군지 분류. 매수·매도 추천 아님 — 정보 정리 용도.',
  };
}

module.exports = { resolveSchoolCluster };
