/**
 * buildingRegisterService — 건축물대장(건축HUB 표제부) 연동.
 *
 * 목적: KAPT(공동주택 의무관리대상)에 없는 소형·노후 단지(예: 성지 도화동 1984)의
 *   기본 개요(준공·층수·연면적·주용도·구조·세대수)를 건축물대장으로 보강.
 *
 * 연동 체인 (2026-07-12 SSSS, 라이브 키 검증 후):
 *   MOLIT 지번(jibun) → Kakao 주소검색으로 법정동코드(b_code) → 건축HUB 표제부
 *   (apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo, resultCode 00 확인).
 *   지번은 molit_transactions.jibun(적재분) 우선, 없으면 MOLIT 라이브 1회 조회.
 *   결과는 building_register(apt_key upsert)에 캐시.
 *
 * 키: process.env.MOLIT_API_KEY(data.go.kr 건축HUB 활용신청 완료) + KAKAO_REST_API_KEY.
 */
const axios = require('axios'); // Kakao 주소검색 전용(릴레이 불필요 — 카카오는 정상)
const dgk = require('./dataGoKrClient'); // RELAY-2026-08-08 (Sprint BBBBBBB): data.go.kr 호출만 릴레이 대상
const logger = require('../logger');
const { getSupabaseAdmin } = require('../db/client');
const { itemArray } = require('../utils/molitParse');

const BR_TITLE_URL = 'https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo';
// DENSITY-2026-08-29 (실측): 표제부는 **동별 레코드**라 대지 단위 지표(platArea·bcRat·vlRat)가 비어 온다
//   — 에스케이북한산시티 실호출에서 archArea 687.84 는 왔는데 vlRat/bcRat/platArea 는 전부 null 이었다.
//   같은 서비스의 **총괄표제부**가 대지 단위라 여기서 가져온다(같은 키·같은 파라미터).
const BR_RECAP_URL = 'https://apis.data.go.kr/1613000/BldRgstHubService/getBrRecapTitleInfo';
const KAKAO_ADDRESS = 'https://dapi.kakao.com/v2/local/search/address.json';
const MOLIT_DETAIL_URL = 'https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev';
const OK = new Set(['00', '000']);

// jibun "60" | "60-3" | "산 12-1" → { bun:'0060', ji:'0003' } (표제부 파라미터는 4자리 zero-pad)
function parseJibun(jibun) {
  const s = String(jibun || '').replace(/산\s*/, '').trim();
  const m = s.match(/(\d+)(?:-(\d+))?/);
  if (!m) return null;
  return { bun: String(m[1]).padStart(4, '0'), ji: String(m[2] || '0').padStart(4, '0') };
}

// Kakao 지번주소 → 법정동코드(b_code 10자리) + 좌표. address = "시군구 umdNm jibun".
async function resolveBjdong(sigungu, umdNm, jibun) {
  const key = process.env.KAKAO_REST_API_KEY;
  if (!key) return null;
  const query = [sigungu, umdNm, jibun].filter(Boolean).join(' ');
  try {
    const r = await axios.get(KAKAO_ADDRESS, {
      headers: { Authorization: `KakaoAK ${key}` },
      params: { query, size: 5 },
      timeout: 5000,
    });
    const docs = r.data?.documents || [];
    const norm = (x) => String(x || '').replace(/\s/g, '');
    // umdNm 일치하는 지번주소 우선 (동명이지 오매칭 차단)
    const pick = docs.find((d) => {
      const b = d.address?.b_code;
      return b && b.length === 10 && (!umdNm || norm(d.address?.region_3depth_name) === norm(umdNm));
    }) || docs.find((d) => (d.address?.b_code || '').length === 10);
    if (!pick) return null;
    const b = pick.address.b_code;
    return { sigunguCd: b.slice(0, 5), bjdongCd: b.slice(5, 10), lat: parseFloat(pick.y), lng: parseFloat(pick.x) };
  } catch (e) {
    logger.warn({ err: e.message }, 'buildingRegister: resolveBjdong 실패');
    return null;
  }
}

// 단지 지번 확보: 적재분(molit_transactions.jibun) 우선 → 없으면 MOLIT 라이브(최근 6개월 중 1건).
async function resolveJibun(admin, lawdCd, umdNm, aptName) {
  try {
    let q = admin.from('molit_transactions').select('jibun, sigungu, umd_nm')
      .eq('lawd_cd', lawdCd).eq('apt_name', aptName).not('jibun', 'is', null).limit(1);
    if (umdNm) q = q.eq('umd_nm', umdNm);
    const { data } = await q;
    if (data && data[0] && data[0].jibun) return { jibun: String(data[0].jibun).trim(), sigungu: data[0].sigungu || '', umdNm: data[0].umd_nm || '' };
  } catch (_) { /* fall through to live */ }

  const key = process.env.MOLIT_API_KEY;
  if (!key) return null;
  const now = new Date();
  for (let back = 1; back <= 6; back++) {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
    try {
      const r = await dgk.get(MOLIT_DETAIL_URL, {
        params: { serviceKey: key, LAWD_CD: lawdCd, DEAL_YMD: ym, numOfRows: 1000, pageNo: 1, _type: 'json' },
        timeout: 7000, headers: { Accept: 'application/json' },
      });
      const arr = itemArray(r.data?.response?.body?.items?.item);
      const hit = arr.find((it) => (it.aptNm || '').trim() === aptName && (!umdNm || (it.umdNm || '').trim() === umdNm) && String(it.jibun || '').trim());
      if (hit) return { jibun: String(hit.jibun).trim(), sigungu: (hit.sggNm || '').trim(), umdNm: (hit.umdNm || '').trim() };
    } catch (_) { /* try previous month */ }
  }
  return null;
}

/**
 * 단지 표제부 조회 (캐시 우선). KAPT 없는 단지 fallback 용.
 * @returns {object|null} { bldNm, useAprDay(YYYYMMDD), hhldCnt, grndFlrCnt, ugrndFlrCnt, totArea, mainPurpsCdNm, strctCdNm, dongCnt, jibun, platArea, archArea, bcRat, vlRat } | null
 */
async function getBuildingTitle({ lawdCd, sigungu, umdNm, aptName, aptKey }) {
  const admin = getSupabaseAdmin();
  if (!admin || !lawdCd || !aptName) return null;
  // BR-MARKER-FIX-2026-07-12: 캐시키를 lawdCd+aptName 기준으로 통일 (지도 마커 경로는 p.sigungu/umd 부재 →
  //   기존 sigungu/umd 포함 키가 검색 경로와 달라져 캐시/조회가 어긋났음).
  const cacheKey = aptKey || `name:${aptName}|${lawdCd}`;

  try {
    const { data } = await admin.from('building_register').select('title').eq('apt_key', cacheKey).limit(1);
    if (data && data[0] && data[0].title) return { ...data[0].title, cached: true };
  } catch (_) { /* no cache */ }

  // MOLIT 원본에서 지번+시군구+동 자체 확보 → 호출자가 sigungu/umd 를 안 넘겨도 동작(마커 경로 버그 수정).
  const ji = await resolveJibun(admin, lawdCd, umdNm, aptName);
  if (!ji || !ji.jibun) return null;
  const rSgg = ji.sigungu || sigungu || '';
  const rUmd = ji.umdNm || umdNm || '';
  const region = await resolveBjdong(rSgg, rUmd, ji.jibun);
  if (!region) return null;
  const parsed = parseJibun(ji.jibun);
  if (!parsed) return null;

  let title = null;
  try {
    const r = await dgk.get(BR_TITLE_URL, {
      params: {
        serviceKey: process.env.MOLIT_API_KEY,
        sigunguCd: region.sigunguCd, bjdongCd: region.bjdongCd,
        platGbCd: '0', bun: parsed.bun, ji: parsed.ji,
        numOfRows: 100, pageNo: 1, _type: 'json', // BR-SUM-2026-07-19: 대단지(>30동) 전체 동 커버 위해 30→100
      },
      timeout: 8000, headers: { Accept: 'application/json' },
    });
    const code = r.data?.response?.header?.resultCode;
    if (!OK.has(code)) {
      logger.warn({ code, msg: r.data?.response?.header?.resultMsg, aptName }, 'buildingRegister: 표제부 비정상 코드');
      return null;
    }
    const arr = itemArray(r.data?.response?.body?.items?.item);
    // 대표 동(주건물) = 세대수 최대 — bldNm·연식·구조 등 표시 필드용.
    const best = arr.slice().sort((a, b) =>
      ((parseInt(b.hhldCnt, 10) || 0) - (parseInt(a.hhldCnt, 10) || 0)) ||
      ((parseFloat(b.totArea) || 0) - (parseFloat(a.totArea) || 0)))[0];
    // BR-SUM-2026-07-19 (운영자 전수감사 발견: 황골마을주공1=영통포레파크원 실제 3,129세대인데 건축물대장이
    //   118세대(한 동)만 반환): 표제부는 동별 레코드라 대표동 1개의 hhldCnt 는 다동 단지의 "한 동" 세대수일
    //   뿐 — 단지 전체는 전 동 hhldCnt 합. 소형 단독건물(성지 84=1동)은 합=단일값이라 무영향. 비주거 동은
    //   hhldCnt 0 이라 합에 안 섞임. 총 세대수(hhldCnt)만 합산, 표시 필드는 대표동 유지.
    const totalHh = arr.reduce((s, b) => s + (parseInt(b.hhldCnt, 10) || 0), 0);
    if (best) {
      title = {
        bldNm: (best.bldNm || '').trim() || null,
        useAprDay: (best.useAprDay || '').trim() || null,
        hhldCnt: totalHh > 0 ? totalHh : (parseInt(best.hhldCnt, 10) || null),
        grndFlrCnt: parseInt(best.grndFlrCnt, 10) || null,
        ugrndFlrCnt: parseInt(best.ugrndFlrCnt, 10) || null,
        totArea: parseFloat(best.totArea) || null,
        mainPurpsCdNm: (best.mainPurpsCdNm || '').trim() || null,
        strctCdNm: (best.strctCdNm || '').trim() || null,
        dongCnt: arr.length,
        jibun: ji.jibun,
        // DENSITY-2026-08-29: **이미 같은 응답에 오는데 버리고 있던 필드들.**
        //   [왜 필요한가] 지금 재건축 판정은 연식 하나("준공 30년 이상")뿐이라, 같은 1989년이라도
        //   용적률 180% 단지와 300% 단지가 똑같이 표시된다 — 실제 여력은 정반대다.
        //   ⚠ 이것은 사실 표기이지 추천이 아니다(절대 룰 ①: 매수·매도 추천 금지).
        //   ⚠ **실측 결과(2026-08-29, 에스케이북한산시티 11305)**: 표제부(동별 레코드)에서 실제로 오는 건
        //     archArea 뿐이고 platArea·bcRat·vlRat 은 **전부 null 이었다** — 대지 단위 지표라서다.
        //     그래서 아래에서 **총괄표제부**로 보강한다. 여기 4줄은 표제부가 값을 주는 경우를 위한 것이고,
        //     실제 값의 주 공급원은 총괄표제부다(둘 다 없으면 null 로 남고 화면에 칸이 안 뜬다).
        platArea: parseFloat(best.platArea) || null,   // 대지면적(㎡)
        archArea: parseFloat(best.archArea) || null,   // 건축면적(㎡)
        bcRat: parseFloat(best.bcRat) || null,         // 건폐율(%)
        vlRat: parseFloat(best.vlRat) || null,         // 용적률(%)
      };
    }
  } catch (e) {
    logger.warn({ err: e.message, aptName }, 'buildingRegister: getBrTitleInfo 실패');
    return null;
  }
  if (!title) return null;

  // DENSITY-2026-08-29: 대지 단위 지표는 총괄표제부에서 보강한다. **실패해도 표제부 결과는 그대로 반환**
  //   (부가 정보라 없다고 단지 정보를 버리면 안 된다). 파라미터는 표제부와 동일.
  try {
    const rr = await dgk.get(BR_RECAP_URL, {
      params: {
        serviceKey: process.env.MOLIT_API_KEY,
        sigunguCd: region.sigunguCd, bjdongCd: region.bjdongCd,
        platGbCd: '0', bun: parsed.bun, ji: parsed.ji,
        numOfRows: 10, pageNo: 1, _type: 'json',
      },
      timeout: 8000, headers: { Accept: 'application/json' },
    });
    if (OK.has(rr.data?.response?.header?.resultCode)) {
      const ra = itemArray(rr.data?.response?.body?.items?.item);
      // 총괄표제부는 대지당 1건이 원칙 — 여러 건이면 연면적 최대(주된 대지)를 쓴다.
      const rb = ra.slice().sort((a, b) => (parseFloat(b.totArea) || 0) - (parseFloat(a.totArea) || 0))[0];
      if (rb) {
        if (!title.platArea) title.platArea = parseFloat(rb.platArea) || null;
        if (!title.archArea) title.archArea = parseFloat(rb.archArea) || null;
        if (!title.bcRat) title.bcRat = parseFloat(rb.bcRat) || null;
        if (!title.vlRat) title.vlRat = parseFloat(rb.vlRat) || null;
      }
    }
  } catch (e) {
    logger.warn({ err: e.message, aptName }, 'buildingRegister: 총괄표제부 보강 실패(무시)');
  }


  try {
    await admin.from('building_register').upsert({
      apt_key: cacheKey,
      sigungu_cd: region.sigunguCd, bjdong_cd: region.bjdongCd, bun: parsed.bun, ji: parsed.ji,
      title, source: 'bldrgsthub', fetched_at: new Date().toISOString(),
    }, { onConflict: 'apt_key' });
  } catch (e) {
    logger.warn({ err: e.message }, 'buildingRegister: 캐시 저장 실패(무시)');
  }
  return title;
}

/**
 * 총괄표제부만 단독 조회 — DENSITY-BACKFILL-2026-08-29
 *
 * 왜 별도 함수인가:
 *   getBuildingTitle 은 지번→법정동코드 해석에 **Kakao 주소검색**을 쓴다(지도·지오코딩과 쿼터 공유).
 *   그런데 building_register 에 이미 캐시된 행은 sigungu_cd/bjdong_cd/bun/ji 를 **컬럼으로 들고 있다**
 *   (실측 2026-08-29: 5,918행 전부 완비). 그 값을 그대로 재사용하면 Kakao 를 **한 번도 안 쓰고**
 *   총괄표제부만 다시 부를 수 있다 → 기존 캐시에 대지 단위 지표를 붙이는 백필이 쿼터 위험 없이 가능.
 *
 * ⚠ 값이 없는 게 정상인 경우가 많다 — 실측상 1988년 이하 준공은 총괄표제부 자체가 없다.
 *   그래서 호출자는 "null 이어도 키를 기록"해 같은 행을 매 회차 재조회하지 않게 해야 한다.
 *
 * @returns {Promise<{platArea:?number,archArea:?number,bcRat:?number,vlRat:?number}|null>}
 *          null = 호출 자체가 실패(재시도 가치 있음) / 객체 = 조회 성공(값은 전부 null 일 수 있음)
 */
async function fetchRecapOnly({ sigunguCd, bjdongCd, bun, ji }) {
  if (!sigunguCd || !bjdongCd || !bun) return null;
  try {
    const rr = await dgk.get(BR_RECAP_URL, {
      params: {
        serviceKey: process.env.MOLIT_API_KEY,
        sigunguCd, bjdongCd, platGbCd: '0', bun, ji: ji || '0000',
        numOfRows: 10, pageNo: 1, _type: 'json',
      },
      timeout: 8000, headers: { Accept: 'application/json' },
    });
    if (!OK.has(rr.data?.response?.header?.resultCode)) return null;
    const ra = itemArray(rr.data?.response?.body?.items?.item);
    const rb = ra.slice().sort((a, b) => (parseFloat(b.totArea) || 0) - (parseFloat(a.totArea) || 0))[0];
    // 조회는 됐는데 항목이 0건 = "이 대지엔 총괄표제부가 없다". 성공으로 취급해 전부 null 을 돌려준다
    // (실패로 취급하면 값 없는 노후 단지를 영원히 재조회하게 된다).
    if (!rb) return { platArea: null, archArea: null, bcRat: null, vlRat: null };
    return {
      platArea: parseFloat(rb.platArea) || null,
      archArea: parseFloat(rb.archArea) || null,
      bcRat: parseFloat(rb.bcRat) || null,
      vlRat: parseFloat(rb.vlRat) || null,
    };
  } catch (e) {
    logger.warn({ err: e.message, sigunguCd, bjdongCd, bun }, 'buildingRegister: 총괄표제부 단독조회 실패');
    return null;
  }
}

module.exports = { getBuildingTitle, parseJibun, resolveBjdong, resolveJibun, fetchRecapOnly };
