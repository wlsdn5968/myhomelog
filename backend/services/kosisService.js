/**
 * KOSIS 시·군·구별 미분양현황 — KOSIS-2026-07-14 (Sprint HHHHH, 집사닷컴 벤치마킹)
 *
 * 실측 검증(임시 endpoint _kosischk, d9b7832~34abbf7)으로 확정한 것만 사용:
 *   - 통계표: orgId=116(국토교통부) · tblId=DT_MLTM_2082 "시·군·구별 미분양현황" (검색 API 실응답으로 확정.
 *     비공식 언급 101/DT_1YL202001E 는 "해당 통계표가 존재하지 않습니다"로 반려)
 *   - 파라미터: itmId=ALL & objL1=ALL & objL2=ALL & prdSe=M (objL2 누락 시 err20 실측)
 *   - 응답 필드: C1_NM(시도, 예 '서울') · C2_NM(시군구, 예 '종로구'/'계') · DT(호수) · PRD_DE(YYYYMM)
 * 정책: KOSIS_API_KEY 미설정/실패 → null(표시 생략). 전국 전체를 24h 캐시(월간 통계·KOSIS 분당 1000건 제한 존중).
 */
const axios = require('axios');
const cache = require('../cache');
const logger = require('../logger');

const CACHE_KEY = 'kosis:unsold:v1';
const MONTHS = 4; // 최근 4개월 추이

async function _fetchAll() {
  const hit = cache.get(CACHE_KEY);
  if (hit !== undefined) return hit;
  const key = process.env.KOSIS_API_KEY;
  if (!key) { cache.set(CACHE_KEY, null, 21600); return null; }
  try {
    const url = `https://kosis.kr/openapi/Param/statisticsParameterData.do?method=getList&apiKey=${encodeURIComponent(key)}&orgId=116&tblId=DT_MLTM_2082&itmId=ALL&objL1=ALL&objL2=ALL&format=json&jsonVD=Y&prdSe=M&newEstPrdCnt=${MONTHS}`;
    const r = await axios.get(url, { timeout: 12000 });
    const rows = Array.isArray(r.data) ? r.data : null;
    if (!rows || !rows.length) {
      logger.warn({ preview: JSON.stringify(r.data).slice(0, 200) }, 'KOSIS 미분양 응답 비정상 — null');
      cache.set(CACHE_KEY, null, 3600);
      return null;
    }
    // (시도|시군구) → [{ym, cnt}] 맵으로 압축
    const map = new Map();
    for (const row of rows) {
      const sido = String(row.C1_NM || '').trim();
      const sgg = String(row.C2_NM || '').trim();
      const ym = String(row.PRD_DE || '').trim();
      const cnt = parseInt(row.DT, 10);
      if (!sido || !sgg || !ym || !Number.isFinite(cnt)) continue;
      const k = `${sido}|${sgg}`;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push({ ym, cnt });
    }
    for (const arr of map.values()) arr.sort((a, b) => a.ym.localeCompare(b.ym));
    const out = { map, fetchedAt: new Date().toISOString() };
    cache.set(CACHE_KEY, out, 86400); // 24h — 월간 통계
    return out;
  } catch (e) {
    logger.warn({ err: e.message }, 'KOSIS 미분양 조회 실패 — null (1h 후 재시도)');
    cache.set(CACHE_KEY, null, 3600);
    return null;
  }
}

const SIDO_KEYS = ['서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종', '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주'];

/**
 * 지역 문자열(예 '서울 노원구') + 시군구명(예 '노원구')으로 미분양 추이 조회.
 * 매칭 실패(통합시 표기 차이 등) 시 null — 호출측은 생략(graceful).
 */
async function getUnsoldTrend(regionStr, sigunguName) {
  const all = await _fetchAll();
  if (!all || !all.map) return null;
  const rs = String(regionStr || '');
  const sido = SIDO_KEYS.find(s => rs.includes(s));
  const sgg = String(sigunguName || '').trim();
  if (!sido || !sgg) return null;
  // 정확 키 → 시군구 부분일치(예 KOSIS '고양시' vs 우리 '고양시 일산동구' 케이스) 순으로 시도
  let arr = all.map.get(`${sido}|${sgg}`);
  if (!arr) {
    for (const [k, v] of all.map.entries()) {
      const [s, g] = k.split('|');
      if (s === sido && g !== '계' && (sgg.includes(g) || g.includes(sgg))) { arr = v; break; }
    }
  }
  if (!arr || !arr.length) return null;
  return {
    sido, sigungu: sgg,
    months: arr.slice(-MONTHS),
    latest: arr[arr.length - 1],
    source: '국토교통부 미분양주택현황보고 (KOSIS)',
  };
}

module.exports = { getUnsoldTrend, KOSIS_CACHE_KEY: CACHE_KEY };
