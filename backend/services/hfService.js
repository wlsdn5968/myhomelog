/**
 * 한국주택금융공사(HF) 정책모기지 금리 — HF-2026-07-14 (Sprint HHHHH)
 *
 * 배경:
 *   - 정책자금 4종 비교 표의 보금자리론·디딤돌 금리가 하드코딩("2026.7 공시 기준 대략치") → 매월 stale.
 *   - 운영자 data.go.kr 활용신청(디딤돌 15082028·u-보금자리론 15082039) 후 임시 검증 endpoint
 *     (_hfchk, 8bef760)로 2026-07-14 실호출 검증한 것만 배선:
 *     · 디딤돌: apis.data.go.kr/B551408/didimdol-loan-rate/didimdol-info — interest_{10y|15y|20y|30y}_{2000|4000|6000}
 *       [실측 2.85~3.8, applyDy 2026071X]
 *     · u-보금자리론: apis.data.go.kr/B551408/u-loan-rate/uloan-info — interest_{10y|15y|20y|30y}
 *       [실측 5.0~5.2, applyDy 20260714]
 *     · JSON 반환 파라미터 = dataType:'JSON' (실측 — _type/resultType 은 XML 반환)
 *   - ⚠ 신혼 디딤돌·신생아 특례 금리는 본 API 에 없음(표의 해당 행은 하드코딩 유지).
 *   - ⚠ "보금자리론" 표기는 u-보금자리론 공시 기준(아낌e- 등 타 변형과 금리 다를 수 있음 — 각주 명시).
 *
 * 정책: MOLIT_API_KEY(data.go.kr 공용) 사용. 실패/키없음 → null(하드코딩 표가 fallback — 기존 표시 유지).
 */
const axios = require('axios');
const cache = require('../cache');
const logger = require('../logger');

const CACHE_KEY = 'hf:rates:v1';
const DIDIMDOL_URL = 'https://apis.data.go.kr/B551408/didimdol-loan-rate/didimdol-info';
const ULOAN_URL = 'https://apis.data.go.kr/B551408/u-loan-rate/uloan-info';

function _minMax(obj, prefix) {
  const vals = Object.entries(obj || {})
    .filter(([k, v]) => k.startsWith(prefix) && v != null && String(v).match(/^\d+(\.\d+)?$/))
    .map(([, v]) => parseFloat(v));
  if (!vals.length) return null;
  return { min: Math.min(...vals), max: Math.max(...vals) };
}

async function getHfRates() {
  const hit = cache.get(CACHE_KEY);
  if (hit !== undefined) return hit;
  const key = process.env.MOLIT_API_KEY;
  if (!key || key === 'your_molit_api_key') { cache.set(CACHE_KEY, null, 21600); return null; }
  try {
    const params = { serviceKey: key, pageNo: 1, numOfRows: 5, dataType: 'JSON' };
    const [dR, uR] = await Promise.all([
      axios.get(DIDIMDOL_URL, { params, timeout: 15000 }),
      axios.get(ULOAN_URL, { params, timeout: 15000 }),
    ]);
    const dItem = dR.data && dR.data.body && dR.data.body.item;
    const uItem = uR.data && uR.data.body && uR.data.body.item;
    const didimdol = dItem ? { ..._minMax(dItem, 'interest_'), applyDy: String(dItem.applyDy || '') } : null;
    const bogeum = uItem ? { ..._minMax(uItem, 'interest_'), applyDy: String(uItem.applyDy || '') } : null;
    if (!didimdol && !bogeum) { cache.set(CACHE_KEY, null, 600); return null; }
    const out = { didimdol, bogeum, source: '한국주택금융공사 (data.go.kr)' };
    cache.set(CACHE_KEY, out, 43200); // 12h — 공시 금리는 월 단위 변동
    return out;
  } catch (e) {
    logger.warn({ err: e.message }, 'HF 금리 조회 실패 — null (하드코딩 표 유지, 10분 후 재시도)');
    cache.set(CACHE_KEY, null, 600);
    return null;
  }
}

module.exports = { getHfRates, HF_CACHE_KEY: CACHE_KEY };
