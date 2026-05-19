/**
 * 학군 권역 정적 데이터 — 2026 부동산 강연 자료 기반
 *
 * 출처: 운영자 제공 강연 자료 (2026-05-19)
 *   - 3대 학원가: 대치동, 목동, 중계동 (전통적 입시 허브)
 *   - 4권역별 학군 우수 지역: 동북/동남/서북/서남
 *
 * 사용 목적:
 *   - 단지 모달 "단지정보" 탭에 권역 라벨 표시 (정보 정리)
 *   - 매수·매도 추천 X / 가격 예측 X / 정보 정리 도구
 *   - 사용자가 "이 단지가 강연에서 언급된 학군지인지" 인지 가능
 *
 * 환각 차단:
 *   - 정적 데이터 (외부 권위 인용)
 *   - 매칭 규칙 명시적 (sigungu + umdNm pattern 정확 일치)
 *   - "투자 추천" 표현 X / "학군지 분포" 같은 중립 표현만
 *
 * 갱신:
 *   - 강연 자료 업데이트 시 수동 갱신
 *   - 매년 1회 정도 검토 권장
 */

// 3대 학원가 — 한국 입시 인프라 허브 (강연 자료 1번 섹션)
const ACADEMY_HUBS = [
  {
    key: '대치',
    label: '대치동 학세권 (3대 학원가)',
    note: '대한민국 입시 정보 허브, 강사 라인업 독보적',
    sigunguPatterns: ['강남구'],
    umdPatterns: ['대치동', '도곡동', '개포동'],
  },
  {
    key: '목동',
    label: '목동 학원가 (3대 학원가)',
    note: '지역 밀착형 강세, 탄탄한 배후 수요',
    sigunguPatterns: ['양천구'],
    umdPatterns: ['목동', '신정동'],
  },
  {
    key: '중계',
    label: '중계동 은행사거리 (3대 학원가)',
    note: '지역 밀착형 강세, 학원가 형성',
    sigunguPatterns: ['노원구'],
    umdPatterns: ['중계동'],
  },
];

// 4권역별 학군 우수 지역 (강연 자료 2번 섹션)
const REGION_CLUSTERS = [
  // ── 동북권 ──
  {
    region: '동북권',
    name: '광남학군',
    note: '직주근접 + 학군 조화',
    sigunguPatterns: ['광진구'],
    umdPatterns: ['*'], // 광진구 전역
  },
  {
    region: '동북권',
    name: '길음뉴타운',
    note: '뉴타운 학군',
    sigunguPatterns: ['성북구'],
    umdPatterns: ['길음동', '돈암동', '월곡동'],
  },
  // ── 동남권 (경부라인) ──
  {
    region: '동남권',
    name: '반포',
    note: '경부라인 전통 학군 강세',
    sigunguPatterns: ['서초구'],
    umdPatterns: ['반포동', '잠원동'],
  },
  {
    region: '동남권',
    name: '잠실 삼전동·방이동',
    note: '경부라인 전통 학군 강세',
    sigunguPatterns: ['송파구'],
    umdPatterns: ['삼전동', '방이동', '잠실동', '잠실본동', '신천동', '석촌동'],
  },
  {
    region: '동남권',
    name: '명일동',
    note: '학세권',
    sigunguPatterns: ['강동구'],
    umdPatterns: ['명일동'],
  },
  {
    region: '동남권',
    name: '동탄',
    note: '수도권 신도시 학군',
    sigunguPatterns: ['화성시'],
    umdPatterns: ['*동탄*'],
  },
  {
    region: '동남권',
    name: '수지',
    note: '수도권 학군',
    sigunguPatterns: ['용인시 수지구', '수지구'],
    umdPatterns: ['*'],
  },
  {
    region: '동남권',
    name: '영통·광교',
    note: '수도권 학군',
    sigunguPatterns: ['수원시 영통구', '영통구'],
    umdPatterns: ['*'],
  },
  {
    region: '동남권',
    name: '분당·판교',
    note: '수도권 학군 강세',
    sigunguPatterns: ['성남시 분당구', '분당구'],
    umdPatterns: ['*'],
  },
  // ── 서북권 ──
  {
    region: '서북권',
    name: '일산',
    note: '1기 신도시 학군',
    sigunguPatterns: ['고양시 일산동구', '고양시 일산서구', '일산동구', '일산서구'],
    umdPatterns: ['*'],
  },
  {
    region: '서북권',
    name: '행신',
    note: '뉴타운 학군',
    sigunguPatterns: ['고양시 덕양구', '덕양구'],
    umdPatterns: ['행신동'],
  },
  {
    region: '서북권',
    name: '마포 대흥역 일대',
    note: '신흥 학원가 (신축 입주 + 학원가 팽창)',
    sigunguPatterns: ['마포구'],
    umdPatterns: ['대흥동', '염리동', '아현동', '신공덕동', '공덕동'],
  },
  // ── 서남권 (아파트 밀집지) ──
  {
    region: '서남권',
    name: '평촌',
    note: '아파트 밀집지 학군',
    sigunguPatterns: ['안양시 동안구', '동안구'],
    umdPatterns: ['*평촌*', '관양동', '호계동', '비산동'],
  },
  {
    region: '서남권',
    name: '과천',
    note: '아파트 밀집지 학군',
    sigunguPatterns: ['과천시'],
    umdPatterns: ['*'],
  },
  {
    region: '서남권',
    name: '철산',
    note: '아파트 밀집지 학군',
    sigunguPatterns: ['광명시'],
    umdPatterns: ['철산동'],
  },
  {
    region: '서남권',
    name: '송도',
    note: '아파트 밀집지 학군',
    sigunguPatterns: ['연수구', '인천 연수구', '인천광역시 연수구'],
    umdPatterns: ['송도동'],
  },
];

module.exports = { ACADEMY_HUBS, REGION_CLUSTERS };
