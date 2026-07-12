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
const axios = require('axios');
const logger = require('../logger');
const { getSupabaseAdmin } = require('../db/client');

const BR_TITLE_URL = 'https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo';
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
      const r = await axios.get(MOLIT_DETAIL_URL, {
        params: { serviceKey: key, LAWD_CD: lawdCd, DEAL_YMD: ym, numOfRows: 1000, pageNo: 1, _type: 'json' },
        timeout: 7000, headers: { Accept: 'application/json' },
      });
      const items = r.data?.response?.body?.items?.item;
      const arr = Array.isArray(items) ? items : items ? [items] : [];
      const hit = arr.find((it) => (it.aptNm || '').trim() === aptName && (!umdNm || (it.umdNm || '').trim() === umdNm) && String(it.jibun || '').trim());
      if (hit) return { jibun: String(hit.jibun).trim(), sigungu: (hit.sggNm || '').trim(), umdNm: (hit.umdNm || '').trim() };
    } catch (_) { /* try previous month */ }
  }
  return null;
}

/**
 * 단지 표제부 조회 (캐시 우선). KAPT 없는 단지 fallback 용.
 * @returns {object|null} { bldNm, useAprDay(YYYYMMDD), hhldCnt, grndFlrCnt, ugrndFlrCnt, totArea, mainPurpsCdNm, strctCdNm, dongCnt, jibun } | null
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
    const r = await axios.get(BR_TITLE_URL, {
      params: {
        serviceKey: process.env.MOLIT_API_KEY,
        sigunguCd: region.sigunguCd, bjdongCd: region.bjdongCd,
        platGbCd: '0', bun: parsed.bun, ji: parsed.ji,
        numOfRows: 30, pageNo: 1, _type: 'json',
      },
      timeout: 8000, headers: { Accept: 'application/json' },
    });
    const code = r.data?.response?.header?.resultCode;
    if (!OK.has(code)) {
      logger.warn({ code, msg: r.data?.response?.header?.resultMsg, aptName }, 'buildingRegister: 표제부 비정상 코드');
      return null;
    }
    const items = r.data?.response?.body?.items?.item;
    const arr = Array.isArray(items) ? items : items ? [items] : [];
    // 대표 동 = 세대수 최대(주건물). 세대수 동률/부재 시 연면적 최대.
    const best = arr.slice().sort((a, b) =>
      ((parseInt(b.hhldCnt, 10) || 0) - (parseInt(a.hhldCnt, 10) || 0)) ||
      ((parseFloat(b.totArea) || 0) - (parseFloat(a.totArea) || 0)))[0];
    if (best) {
      title = {
        bldNm: (best.bldNm || '').trim() || null,
        useAprDay: (best.useAprDay || '').trim() || null,
        hhldCnt: parseInt(best.hhldCnt, 10) || null,
        grndFlrCnt: parseInt(best.grndFlrCnt, 10) || null,
        ugrndFlrCnt: parseInt(best.ugrndFlrCnt, 10) || null,
        totArea: parseFloat(best.totArea) || null,
        mainPurpsCdNm: (best.mainPurpsCdNm || '').trim() || null,
        strctCdNm: (best.strctCdNm || '').trim() || null,
        dongCnt: arr.length,
        jibun: ji.jibun,
      };
    }
  } catch (e) {
    logger.warn({ err: e.message, aptName }, 'buildingRegister: getBrTitleInfo 실패');
    return null;
  }
  if (!title) return null;

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

module.exports = { getBuildingTitle, parseJibun, resolveBjdong, resolveJibun };
