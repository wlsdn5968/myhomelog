/**
 * R-ONE (한국부동산원 부동산통계) 연동 — 지역 가격지수
 *
 * [실호출로 확정된 명세 — 2026-07-25 Sprint RRRRRR]
 *   base            https://www.reb.or.kr/r-one/openapi/
 *   데이터          SttsApiTblData.do  (STATBL_ID·DTACYCLE_CD·WRTTIME_IDTFR_ID·Type=json, 선택 pIndex·pSize)
 *   세부항목(계층)  SttsApiTblItm.do   (ITM_ID·PAR_ITM_ID·ITM_NM·ITM_FULLNM)
 *   인증 파라미터   KEY   ⚠ data.go.kr 의 serviceKey 가 아님. env REB_RONE_API_KEY.
 *   성공 판정       RESULT.CODE === 'INFO-000'
 *   응답 형태       { "<루트키>": [ { head:[{list_total_count},{RESULT}] }, { row:[...] } ] }
 *
 * [지역 매칭 — 이 파일에서 가장 중요한 부분]
 *   데이터 응답의 CLS_NM 은 '중구'·'서구'처럼 **동명이 그대로** 오고 GRP_NM 은 전부 null 이라
 *   이름만으로는 서울 중구와 부산 중구를 원리적으로 구별할 수 없다(실측). 세부항목 API 의
 *   ITM_FULLNM 이 "서울>강북지역>도심권>중구" 처럼 전체 경로를 주므로, **최상위(시도)+말단(시군구)**
 *   조합으로만 우리 lawd_cd 에 매칭한다. 중간 권역(강북지역·도심권·중부산권)은 무시.
 *   이 규칙을 어기고 이름 매칭으로 되돌리면 Sprint PPPPPP 의 P0(서울 중구 LTV 오표기)이 재현된다.
 *
 * [비용] 무료 공공 API. AI 비용 0. 캐시로 외부 호출 최소화(지수 6h·계층 24h).
 */
const axios = require('axios');
const cache = require('../cache');
const logger = require('../logger');
const { LAWD_CODES } = require('./transactionService');

const BASE = 'https://www.reb.or.kr/r-one/openapi';
const KEY = process.env.REB_RONE_API_KEY;

// 실측 확정 통계표 (2026-07-25)
const STATBL = {
  saleIndex:   'A_2024_00045', // (월) 매매가격지수_아파트  2003~
  jeonseIndex: 'A_2024_00050', // (월) 전세가격지수_아파트  2003~
};

const TTL_INDEX = 6 * 3600;   // 지수 데이터 6시간
const TTL_HIER  = 24 * 3600;  // 지역 계층 24시간 (거의 안 변함)

/** 시도 표기 → lawd_cd prefix. R-ONE ITM_FULLNM 최상위 토큰 기준(실측: '서울','부산',… '경기'). */
const SIDO_PREFIX = {
  '서울': '11', '부산': '26', '대구': '27', '인천': '28', '광주': '29',
  '대전': '30', '울산': '31', '세종': '36', '경기': '41',
};

function isEnabled() { return !!KEY; }

/** R-ONE 공통 호출 — 성공 시 row 배열, 실패/에러 시 null (graceful). */
async function call(path, params) {
  if (!KEY) return null;
  try {
    const r = await axios.get(`${BASE}/${path}`, {
      params: { KEY, Type: 'json', ...params },
      timeout: 15000,
    });
    const body = r.data;
    const rootKey = body && typeof body === 'object' ? Object.keys(body)[0] : null;
    const arr = rootKey ? body[rootKey] : null;
    if (!Array.isArray(arr)) return null;
    const head = arr.find(x => x && x.head);
    const code = head ? (head.head.find(x => x.RESULT) || {}).RESULT?.CODE : null;
    if (code && code !== 'INFO-000') {
      logger.warn({ src: 'rone', path, code }, 'R-ONE 응답 코드 비정상');
      return null;
    }
    const rowsNode = arr.find(x => x && x.row);
    return rowsNode ? rowsNode.row : [];
  } catch (e) {
    logger.warn({ src: 'rone', path, err: e.message }, 'R-ONE 호출 실패(무시)');
    return null;
  }
}

/**
 * 지역 계층 → { clsId: lawdCd } 매핑. 세부항목 API 1회 조회 후 24h 캐시.
 * ITM_FULLNM("서울>강북지역>도심권>중구")의 최상위=시도, 말단=시군구로만 매칭한다.
 */
async function getClsToLawd(statblId = STATBL.saleIndex) {
  const ck = `rone:cls2lawd:${statblId}`;
  const hit = cache.get(ck);
  if (hit !== undefined) return hit;

  const rows = await call('SttsApiTblItm.do', { STATBL_ID: statblId, pSize: 500 });
  if (!rows || !rows.length) { cache.set(ck, null, 300); return null; }

  // 우리 LAWD_CODES 는 서울만 순수 구명('중구'), 그 외는 광역 접두 포함('부산중구','대구수성구').
  //   경기(41)는 시명 그대로('과천시') 또는 시+구('성남시분당구'). 아래 후보를 순서대로 시도한다.
  const map = {};
  let matched = 0;
  for (const r of rows) {
    const full = String(r.ITM_FULLNM || '').trim();
    const leaf = String(r.ITM_NM || '').trim();
    if (!full || !leaf) continue;
    const parts = full.split('>').map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) continue;          // '전국'·'수도권' 같은 집계 항목 제외
    const sido = parts[0];
    const prefix = SIDO_PREFIX[sido];
    if (!prefix) continue;                    // 우리가 다루지 않는 지방 도 — 스킵(지방 확장 금지 방침)

    // 후보 순서(실측 기반):
    //   ①서울은 순수 구명('중구') ②광역시는 '시도+구명'('부산중구')
    //   ③ 단, 이름이 전국 유일한 구는 접두 없이 저장돼 있다 — 실측: '해운대구'(26350)는
    //      '부산해운대구' 가 아니다. 그래서 광역시도 leaf 단독 후보를 함께 시도한다.
    //   ④경기는 시명 단독('과천시') 또는 상위 시 결합('성남시'+'분당구'='성남시분당구')
    //   모든 후보는 lawd_cd prefix 가 해당 시도와 일치할 때만 채택 → 동명 오매칭 원천 차단.
    const cands = [];
    if (prefix === '11') cands.push(leaf);
    else { cands.push(`${sido}${leaf}`); cands.push(leaf); }
    if (prefix === '41') {
      const parent = parts[parts.length - 2];                 // '성남시' > '분당구'
      if (parent && parent !== sido) cands.push(`${parent}${leaf}`);
    }
    for (const c of cands) {
      const code = LAWD_CODES[c];
      if (code && String(code).startsWith(prefix)) { map[r.ITM_ID] = code; matched++; break; }
    }
  }
  logger.info({ src: 'rone', statblId, rows: rows.length, matched }, 'R-ONE 지역 계층 매핑 생성');
  cache.set(ck, map, TTL_HIER);
  return map;
}

/** YYYYMM 문자열 n개 (최신순) */
function recentMonths(n) {
  const out = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 0; i < n; i++) {
    out.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

/**
 * 특정 lawd_cd 의 최근 가격지수 추이.
 * @returns {Promise<{ months: Array<{ym, sale, jeonse}>, source, basis }|null>}
 *   외부 실패·미설정·미매칭이면 null (호출부는 해당 칸을 생략 — 틀린 값 대신 미표시).
 */
async function getRegionIndex(lawdCd, { months = 6 } = {}) {
  if (!KEY || !lawdCd) return null;
  const ck = `rone:idx:${lawdCd}:${months}`;
  const hit = cache.get(ck);
  if (hit !== undefined) return hit;

  const cls2lawd = await getClsToLawd();
  if (!cls2lawd) { cache.set(ck, null, 300); return null; }
  // lawd_cd → clsId 역인덱스
  const clsId = Object.keys(cls2lawd).find(k => cls2lawd[k] === String(lawdCd));
  if (!clsId) { cache.set(ck, null, TTL_INDEX); return null; } // R-ONE 미제공 지역 — 조용히 생략

  const yms = recentMonths(months);
  const series = [];
  for (const ym of yms) {
    const [saleRows, jeonseRows] = await Promise.all([
      call('SttsApiTblData.do', { STATBL_ID: STATBL.saleIndex,   DTACYCLE_CD: 'MM', WRTTIME_IDTFR_ID: ym, pSize: 300 }),
      call('SttsApiTblData.do', { STATBL_ID: STATBL.jeonseIndex, DTACYCLE_CD: 'MM', WRTTIME_IDTFR_ID: ym, pSize: 300 }),
    ]);
    const pick = (rows) => {
      if (!rows) return null;
      const row = rows.find(x => String(x.CLS_ID) === String(clsId));
      const v = row ? Number(row.DTA_VAL) : NaN;
      return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
    };
    const sale = pick(saleRows);
    const jeonse = pick(jeonseRows);
    if (sale != null || jeonse != null) series.push({ ym, sale, jeonse });
  }
  if (!series.length) { cache.set(ck, null, TTL_INDEX); return null; }

  const out = {
    months: series.reverse(), // 과거→최신
    source: '한국부동산원 전국주택가격동향조사 (R-ONE)',
    basis: '아파트 매매·전세 가격지수(월). 수치 나열이며 시장 예측이 아닙니다.',
  };
  cache.set(ck, out, TTL_INDEX);
  return out;
}

module.exports = { isEnabled, getRegionIndex, getClsToLawd, STATBL };
