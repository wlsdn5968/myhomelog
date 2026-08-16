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

// KOSIS-REDIS-2026-08-16 (Plan 017): 아래 순이동 로더(_fetchNetMigrationAll)에는 이미 있는
//   Redis 2차 캐시를 미분양 로더에도 역이식한다. Vercel 서버리스가 콜드스타트/스케일아웃으로
//   인스턴스를 갈아끼울 때마다 node-cache 는 비어 있어 KOSIS 를 다시 부르고 있었다(월간 통계인데).
//
//   ⚠ **그대로 복붙하면 안 된다** — 순이동 로더의 반환값은 평범한 객체(`byCode`)지만
//     이쪽 반환값의 `map` 은 **Map 인스턴스**다. Upstash 는 set(객체)→JSON 직렬화이므로
//     Map 을 그대로 실으면 `{"map":{}}` 로 납작해지고, 복원 시 getUnsoldTrend 의
//     `all.map.get(...)` 이 **TypeError: all.map.get is not a function** 으로 죽는다
//     (2026-08-16 Node 실측 확인). 저장은 엔트리 배열로 pack, 복원은 unpack 한다.
//   형태를 못 알아보면 null → **캐시 미스로 떨어뜨린다**(fail-safe: 최악이라도 기존 동작인 외부 조회).
function _packUnsold(out) {
  if (!out || !(out.map instanceof Map)) return null;
  return { entries: Array.from(out.map.entries()), fetchedAt: out.fetchedAt };
}
function _unpackUnsold(packed) {
  if (!packed || !Array.isArray(packed.entries)) return null;
  return { map: new Map(packed.entries), fetchedAt: packed.fetchedAt };
}

async function _fetchAll() {
  const hit = cache.get(CACHE_KEY);
  if (hit !== undefined) return hit;
  const redisCache = require('./redisCache');
  try {
    const restored = _unpackUnsold(await redisCache.rget(CACHE_KEY));
    if (restored) { cache.set(CACHE_KEY, restored, 86400); return restored; }
  } catch (_) { /* Redis 실패는 무시하고 외부 조회 */ }
  const key = process.env.KOSIS_API_KEY;
  if (!key) { cache.set(CACHE_KEY, null, 21600); return null; }
  try {
    const url = `https://kosis.kr/openapi/Param/statisticsParameterData.do?method=getList&apiKey=${encodeURIComponent(key)}&orgId=116&tblId=DT_MLTM_2082&itmId=ALL&objL1=ALL&objL2=ALL&format=json&jsonVD=Y&prdSe=M&newEstPrdCnt=${MONTHS}`;
    const r = await axios.get(url, { timeout: 15000 });
    const rows = Array.isArray(r.data) ? r.data : null;
    if (!rows || !rows.length) {
      logger.warn({ preview: JSON.stringify(r.data).slice(0, 200) }, 'KOSIS 미분양 응답 비정상 — null');
      cache.set(CACHE_KEY, null, 600);
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
    const packed = _packUnsold(out);  // Map → 엔트리 배열 (위 주석 참조)
    if (packed) redisCache.rset(CACHE_KEY, packed, 86400).catch(() => {});
    return out;
  } catch (e) {
    logger.warn({ err: e.message }, 'KOSIS 미분양 조회 실패 — null (10분 후 재시도)');
    cache.set(CACHE_KEY, null, 600);
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

/**
 * ── 시군구 순이동(전입-전출) ─────────────────────────────────────────────────
 * NETMIG-2026-07-25 (Sprint YYYYYY) — 지역 대시보드 5번째 칸.
 *
 * [실호출로 확정한 명세 — 임시 endpoint `/api/region/_kosischk` 로 검증, 추측 0]
 *   orgId=101 · tblId=DT_1B26001_A01 ("시군구별 이동자수", 국내인구이동통계)
 *   itmId=**T25(순이동)**  — 메타(getMeta&type=ITM) 실응답: T10 총전입 · T20 총전출 · T25 순이동
 *   objL1=ALL
 *   ⚠ **objL2 를 넣으면 err21("잘못된 요청 변수")** — 이 표는 분류가 1단계뿐이라 넣지 않는다.
 *     (미분양표 DT_MLTM_2082 는 반대로 objL2 누락 시 err20 — 표마다 다르니 표별 실호출이 필수)
 *   prdSe=M · newEstPrdCnt=N
 *   응답: C1 · C1_NM · DT(명) · PRD_DE(YYYYMM) · ITM_NM · UNIT_NM
 *
 * ★ 이 표가 R-ONE 보다 다루기 쉬운 결정적 이유: **`C1` 이 우리 lawd_cd 와 동일한 5자리 코드**다
 *   (종로구 11110 · 중구 11140 · 마포구 11440 — 실측 확인).
 *   → R-ONE 처럼 이름·계층으로 동명 구를 갈라낼 필요가 없다. **이름 매칭 금지**, 코드로만 붙인다.
 *
 * 비용: 전국이 1회 호출에 다 온다(1개월 272행 = 전국+시도+시군구) → 미분양과 같은 전국 캐시 패턴.
 *   node-cache 24h + **Redis 2차**(서버리스 인스턴스 간 공유 — Sprint TTTTTT-3 교훈).
 */
const NETMIG_CK = 'kosis:netmig:v1';
const NETMIG_MONTHS = 6;

async function _fetchNetMigrationAll() {
  const hit = cache.get(NETMIG_CK);
  if (hit !== undefined) return hit;
  const redisCache = require('./redisCache');
  try {
    const rHit = await redisCache.rget(NETMIG_CK);
    if (rHit) { cache.set(NETMIG_CK, rHit, 86400); return rHit; }
  } catch (_) { /* Redis 실패는 무시하고 외부 조회 */ }

  const key = process.env.KOSIS_API_KEY;
  if (!key) { cache.set(NETMIG_CK, null, 21600); return null; }
  try {
    const url = 'https://kosis.kr/openapi/Param/statisticsParameterData.do'
      + `?method=getList&apiKey=${encodeURIComponent(key)}&orgId=101&tblId=DT_1B26001_A01`
      + `&itmId=T25&objL1=ALL&format=json&jsonVD=Y&prdSe=M&newEstPrdCnt=${NETMIG_MONTHS}`;
    const r = await axios.get(url, { timeout: 15000 });
    const rows = Array.isArray(r.data) ? r.data : null;
    if (!rows || !rows.length) {
      logger.warn({ preview: JSON.stringify(r.data).slice(0, 200) }, 'KOSIS 순이동 응답 비정상 — null');
      cache.set(NETMIG_CK, null, 600);
      return null;
    }
    // lawd_cd(5자리) → [{ym, net}] . 전국('00')·시도(2자리)는 대시보드에서 안 쓰므로 제외.
    const byCode = {};
    for (const row of rows) {
      const code = String(row.C1 || '').trim();
      if (!/^\d{5}$/.test(code)) continue;
      const ym = String(row.PRD_DE || '').trim();
      const net = parseInt(row.DT, 10);
      if (!ym || !Number.isFinite(net)) continue;
      (byCode[code] = byCode[code] || []).push({ ym, net });
    }
    for (const arr of Object.values(byCode)) arr.sort((a, b) => a.ym.localeCompare(b.ym));
    const out = { byCode, fetchedAt: new Date().toISOString() };
    cache.set(NETMIG_CK, out, 86400);       // 24h — 월간 통계
    redisCache.rset(NETMIG_CK, out, 86400).catch(() => {});
    return out;
  } catch (e) {
    logger.warn({ err: e.message }, 'KOSIS 순이동 조회 실패 — null (10분 후 재시도)');
    cache.set(NETMIG_CK, null, 600);
    return null;
  }
}

/**
 * lawd_cd 로 순이동 추이 조회. 미제공 지역·실패는 null(호출측이 칸을 생략 — 추정치 금지).
 * @returns {Promise<{months: Array<{ym, net}>, latest, source, basis}|null>}
 */
async function getNetMigration(lawdCd) {
  const code = String(lawdCd || '').trim();
  if (!/^\d{5}$/.test(code)) return null;
  const all = await _fetchNetMigrationAll();
  const arr = all?.byCode?.[code];
  if (!arr || !arr.length) return null;
  return {
    months: arr.slice(-NETMIG_MONTHS),
    latest: arr[arr.length - 1],
    source: '국가데이터처 국내인구이동통계 (KOSIS)',
    basis: '전입-전출 순이동(명). 수치 나열이며 시장 예측이 아닙니다.',
  };
}

module.exports = { getUnsoldTrend, getNetMigration, KOSIS_CACHE_KEY: CACHE_KEY };
