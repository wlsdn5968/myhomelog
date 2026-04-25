/**
 * 규제 정보 서비스
 *
 * 우선순위:
 *   1) DB (regulations_snapshot) 최신 유효 스냅샷 — in-process 10분 캐시
 *   2) DB 미설정/장애 시 하드코딩 fallback (아래 FALLBACK)
 *
 * 이렇게 한 이유:
 *   - DB 에서 읽으면 규제 개정 시 **재배포 없이** 갱신 가능 (migration 추가만).
 *   - DB 장애 시에도 서비스가 뻗지 않도록 fallback 유지 — 규제는 공개 정보라
 *     fallback 이 낡더라도 노출 OK (disclaimer 가 이미 "최종 확인 필수" 명시).
 *   - 10분 캐시 — 규제는 자주 바뀌지 않으니 긴 TTL 도 안전하지만,
 *     운영자가 DB 에 새 row 넣고 반영이 최대 10분만 지연되는게 합리적.
 */
const cache = require('../cache');
const logger = require('../logger');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.service_role;

// 하드코딩 fallback — DB 없이도 최소 작동 (dev / DB 장애 / Vercel env 누락 대비)
// P1 (2026-04-25): key 별 fallback 분리 — 기존 단일 FALLBACK 은 housing 만 반환해서
//   acquisition_tax_2025 호출 시에도 housing 데이터가 응답되어 frontend 가
//   tax.acquisitionTax 를 못 찾는 버그 수정.
const FALLBACK_BY_KEY = {
  housing_loan_2025: {
    lastUpdated: '2025-10-16',
    source: '금융위원회 2025.10.15 주택시장 안정화 대책',
    sourceUrl: 'https://fsc.go.kr',
    regulatedRegions: {
      seoul: '서울 전 지역 (25개 구)',
      gyeonggi: [
        '과천시', '광명시', '성남시 분당구', '성남시 수정구', '성남시 중원구',
        '수원시 영통구', '수원시 장안구', '수원시 팔달구', '안양시 동안구',
        '용인시 수지구', '의왕시', '하남시',
      ],
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
      bankDSR: 40, secondFinanceDSR: 50,
      stressDSRMetro: 1.5, stressDSRLocal: 0.75, stressFloorMetroRegulated: 3.0,
      maxTerm: 30, threshold: 100000000,
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
  },
  acquisition_tax_2025: {
    lastUpdated: '2026-04-25',
    source: '지방세법 제11조 + 공인중개사법 시행규칙 별표1',
    sourceUrl: 'https://www.law.go.kr/법령/지방세법',
    acquisitionTax: {
      noHouse: {
        firstBuyerDiscount: { underAuk: 1.5, rate: 0.008, note: '생애최초 1.5억 이하 50% 감면' },
        tiers: [
          { underAuk: 6,   rate: 0.01 },
          { underAuk: 9,   rate: 0.02 },
          { underAuk: 999, rate: 0.03 },
        ],
      },
      oneHouse: {
        tiers: [
          { underAuk: 6,   rate: 0.01 },
          { underAuk: 9,   rate: 0.02 },
          { underAuk: 999, rate: 0.03 },
        ],
      },
      twoHousePlus: { rate: 0.08, note: '조정대상지역 다주택 중과 8%' },
    },
    eduTaxRate:       0.1,
    spclTaxRate:      0.002,
    spclTaxThreshold: 0.01,
    commission: [
      { underAuk: 0.5, rate: 0.006 },
      { underAuk: 2,   rate: 0.005 },
      { underAuk: 9,   rate: 0.004 },
      { underAuk: 12,  rate: 0.005 },
      { underAuk: 15,  rate: 0.006 },
      { underAuk: 999, rate: 0.007 },
    ],
    regFee: { rate: 0.0015, baseManwon: 20 },
    disclaimer: '취득세·복비·등기비는 매년 변경되며, 본 계산은 추정치입니다. 실제 비용은 ±1,500만원 이상 차이 가능. 최종 금액은 세무사·법무사 확인 필수.',
  },
};

// 하위 호환 — 기존 import { FALLBACK } 코드 (housing 만 반환)
const FALLBACK = FALLBACK_BY_KEY.housing_loan_2025;

// P1 (2026-04-25): regulations_snapshot 은 RLS "public_read" 정책으로 anon 접근 가능.
// → service_role 불필요. publishable key 우선 사용 (defense in depth: 권한 최소화).
// → service_role 은 fallback (dev 환경에서 publishable key 미설정 시).
// 이전: service_role 만 시도 → Vercel production env 에 service_role 없으면 fallback 으로 떨어져
//       매번 코드 변경 + 재배포 필요. publishable key 만으로 snapshot 읽기 가능 — 운영 효율 ↑.
function snapshotClient() {
  if (!SUPABASE_URL) return null;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY
           || process.env.SUPABASE_ANON_KEY
           || SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  return createClient(SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * 키에 대응되는 최신 유효 스냅샷 조회 (valid_from <= now < valid_to).
 * @param {string} key  예) 'housing_loan_2025'
 */
async function getSnapshot(key = 'housing_loan_2025') {
  const cacheKey = `reg:${key}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const admin = snapshotClient();
  if (!admin) {
    // DB 미설정 — 로컬 개발이거나 env 누락. fallback 만 반환.
    const fb = FALLBACK_BY_KEY[key] || null;
    cache.set(cacheKey, { data: fb, source: 'fallback' }, 60);
    return { data: fb, source: 'fallback' };
  }

  try {
    const { data, error } = await admin
      .from('regulations_snapshot')
      .select('data, valid_from, source_url, source_effective_date')
      .eq('key', key)
      .lte('valid_from', new Date().toISOString())
      .or('valid_to.is.null,valid_to.gt.' + new Date().toISOString())
      .order('valid_from', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    if (!data?.data) {
      cache.set(cacheKey, { data: FALLBACK, source: 'fallback' }, 60);
      return { data: FALLBACK, source: 'fallback' };
    }

    const out = {
      data: data.data,
      source: 'db',
      validFrom: data.valid_from,
      sourceUrl: data.source_url,
      effectiveDate: data.source_effective_date,
    };
    cache.set(cacheKey, out, 600); // 10분
    return out;
  } catch (e) {
    logger.warn({ err: e.message, key }, 'regulations_snapshot 조회 실패 — fallback 사용');
    const fb = FALLBACK_BY_KEY[key] || null;
    cache.set(cacheKey, { data: fb, source: 'fallback' }, 60);
    return { data: fb, source: 'fallback' };
  }
}

/**
 * 규제지역 매칭 키워드 set 반환 (substring 매칭용).
 *
 * 왜 이게 필요한가:
 *   - 기존: propertyService.computeLTV / 프론트 calcLTV 가 정규식
 *     `/서울|강남|서초|송파|용산|분당|과천/` 으로 규제지역 판정 → snapshot 의
 *     "성남시 분당구","광명시","하남시","의왕시" 등 10개 경기 규제지역이 누락되어
 *     LTV 70% 로 오표기 → 사용자가 계약금 걸고 은행 가서 실제 40% 만 나오는
 *     **수억원 손실 시나리오**.
 *   - 개선: snapshot 의 regulatedRegions 를 "성남시 분당구" 같은 풀 네임 + 공백 제거 +
 *     핵심 키워드("분당","과천","광명") 변형으로 set 화 → substring 매칭으로 강건.
 *
 * 한계 (인정):
 *   - "중구"는 서울/부산/대구 모두 존재 — 단독 입력 시 모호. 사용자 입력에
 *     광역명이 함께 있으면 정확. (향후: lawdCd 기반 매칭으로 완전화)
 */
async function getRegulatedKeywords() {
  const cacheKey = 'reg:keywords:v2';
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const { data } = await getSnapshot('housing_loan_2025');
  const reg = data?.regulatedRegions || {};
  const keywords = new Set();
  const seoulRegulated = !!reg.seoul; // "서울 전 지역" 명시 시 서울 전체 규제

  const gyeonggi = Array.isArray(reg.gyeonggi) ? reg.gyeonggi : [];
  for (const fullName of gyeonggi) {
    const trimmed = String(fullName || '').trim();
    if (!trimmed) continue;
    keywords.add(trimmed);
    keywords.add(trimmed.replace(/\s+/g, ''));
    const tokens = trimmed.split(/\s+/);
    for (const tok of tokens) {
      const core = tok.replace(/(시|구|군)$/, '');
      if (core && core.length >= 2) keywords.add(core);
    }
  }

  const out = { keywords: Array.from(keywords), seoulRegulated };
  cache.set(cacheKey, out, 600); // 10분 — getSnapshot 과 동일 TTL
  return out;
}

// 서울 25개 자치구 키워드 — snapshot.seoul = "서울 전 지역" 일 때 매칭용
// (snapshot 에 25개 명시 안 돼있으므로 코드 상수로 보완)
const SEOUL_GU_KEYWORDS = [
  '강남','강동','강북','강서','관악','광진','구로','금천','노원',
  '도봉','동대문','동작','마포','서대문','서초','성동','성북','송파','양천',
  '영등포','용산','은평','종로','중랑',
];

/**
 * 사용자 입력 region 문자열이 규제지역인지 판단 (async — snapshot 캐시 hit 시 즉시).
 *   - "서울"/"강남"/"송파" 등 → true
 *   - "분당"/"과천"/"광명"/"수지"/"하남"/"의왕" 등 → true
 *   - "일산"/"동두천"/"화성"/"인천" 등 → false
 *   - 빈 문자열 → false (보수적)
 */
async function isRegulatedRegion(regionStr) {
  const r = String(regionStr || '').normalize('NFC').trim();
  if (!r) return false;
  const { keywords, seoulRegulated } = await getRegulatedKeywords();

  if (seoulRegulated) {
    if (r.includes('서울')) return true;
    for (const gu of SEOUL_GU_KEYWORDS) if (r.includes(gu)) return true;
  }
  for (const kw of keywords) if (r.includes(kw)) return true;
  return false;
}

module.exports = {
  getSnapshot,
  FALLBACK,
  getRegulatedKeywords,
  isRegulatedRegion,
  SEOUL_GU_KEYWORDS,
};
