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
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// 하드코딩 fallback — DB 없이도 최소 작동 (dev / DB 장애 대비)
const FALLBACK = {
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

function adminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
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

  const admin = adminClient();
  if (!admin) {
    // DB 미설정 — 로컬 개발이거나 env 누락. fallback 만 반환.
    cache.set(cacheKey, { data: FALLBACK, source: 'fallback' }, 60);
    return { data: FALLBACK, source: 'fallback' };
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
    cache.set(cacheKey, { data: FALLBACK, source: 'fallback' }, 60);
    return { data: FALLBACK, source: 'fallback' };
  }
}

module.exports = { getSnapshot, FALLBACK };
