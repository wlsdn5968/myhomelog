const express = require('express');
const router = express.Router();

// 규제 데이터는 자주 변경되므로 DB or 수동 갱신 구조
// 실서비스에서는 크롤링 또는 관리자 패널로 갱신

const REGULATIONS = {
  lastUpdated: '2025-10-16',
  source: '금융위원회 2025.10.15 주택시장 안정화 대책',
  sourceUrl: 'https://fsc.go.kr',
  regulatedRegions: {
    seoul: '서울 전 지역 (25개 구)',
    gyeonggi: ['과천시', '광명시', '성남시 분당구', '성남시 수정구', '성남시 중원구',
      '수원시 영통구', '수원시 장안구', '수원시 팔달구', '안양시 동안구',
      '용인시 수지구', '의왕시', '하남시'],
  },
  ltvTable: [
    { condition: '무주택 — 규제지역', ltv: 40, cap: [{ under: 15, max: 6 }, { under: 25, max: 4 }, { over: 25, max: 2 }] },
    { condition: '생애최초 — 규제지역', ltv: 70, cap: [{ under: 999, max: 6 }], note: '6개월 이내 전입 의무' },
    { condition: '무주택 — 비규제', ltv: 70, cap: null },
    { condition: '생애최초 — 비규제', ltv: 80, cap: null },
    { condition: '지방 생애최초', ltv: 80, cap: null },
    { condition: '1주택 추가 매수 (규제)', ltv: 0, cap: null, note: '처분조건부 6개월 시 무주택 동일' },
    { condition: '2주택 이상', ltv: 0, cap: null, note: '규제지역·수도권 구입 불가' },
  ],
  dsrRules: {
    bankDSR: 40,
    secondFinanceDSR: 50,
    stressDSRMetro: 1.5,
    stressDSRLocal: 0.75,
    stressFloorMetroRegulated: 3.0,
    maxTerm: 30,
    threshold: 100000000,
  },
  additionalRules: [
    '전세대출 보유자: 규제지역 3억 초과 아파트 취득 시 전세대출 즉시 회수',
    '신용대출 1억 초과 보유자: 대출 실행 후 1년간 규제지역 주택 구입 제한',
    '1주택자 전세대출 이자: DSR 반영 (2025.10.29~)',
    '토지거래허가구역: 취득 후 2년 실거주 의무, 갭투자 금지',
    '전세보증 비율: 수도권 80% (기존 90% → 강화)',
    '은행권 주담대 위험가중치: 15% → 20% (2026.1월~)',
  ],
  disclaimer: '규제는 수시 변경됩니다. 최종 대출 가능 여부는 금융기관에서 반드시 확인하세요.',
};

router.get('/', (req, res) => {
  res.json(REGULATIONS);
});

router.get('/ltv', (req, res) => {
  res.json({ ltvTable: REGULATIONS.ltvTable, lastUpdated: REGULATIONS.lastUpdated });
});

module.exports = router;
