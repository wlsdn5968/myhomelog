/**
 * APT-PAGE-2026-08-29 (Sprint NNNNNNN-32): GET /apt/:aptSeq — 단지별 서버렌더 페이지.
 *
 * [왜] 지역 페이지(122개)로 sitemap 이 16 → 139 가 됐지만, 한국에서 실제 검색량은
 *   **"단지명 + 실거래가"** 쪽이 훨씬 크다. 우리는 22,473개 단지의 거래를 들고 있는데
 *   그중 크롤 가능한 페이지가 0개였다(`/?apt=반포자이` 는 홈과 동일한 메타를 반환).
 *
 * [대상 문턱 — 실측] 거래 3건 이상 + 최근 1년 내 거래 = **15,954개**(전체 22,473 중).
 *   · 1~2건짜리는 통계가 아니라 잡음이다(TRUST 게이트가 '거래 1건 단지 무조건 배제'로 정한 원칙과 동일).
 *   · 오래된 단지는 색인 가치가 낮고, 얇은 페이지를 대량 생성하면 사이트 전체 품질 평가에 해롭다.
 *   ⚠ 이 문턱은 sitemap 노출 기준이다. 페이지 자체는 문턱 아래여도 열리되(직접 링크 대응)
 *     **거래가 없으면 no-store + noindex** 로 색인을 막는다.
 *
 * [식별자] apt_seq. MOLIT 이 부여한 것이고 전 22,473건이 `^\d{5}-\d+$` 형식임을 실측했다.
 *   ⚠ 이름으로 조회하지 않는다 — '현대'·'벽산' 같은 흔한 이름이 남의 거래를 끌어오면
 *     공개 페이지에 잘못된 시세가 실린다. getTransactionsByAptSeq 는 정확 일치만 한다.
 *
 * [절대 룰] 과거 실거래 나열만. 추천·예측 없음. 층·향 보정 불가를 본문에 명시한다.
 */
'use strict';

const express = require('express');
const logger = require('../logger');
const router = express.Router();

const ORIGIN = 'https://myhomelog.vercel.app';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const comma = (v) => Number(v).toLocaleString('ko-KR');
const eok = (v) => (Number.isFinite(Number(v)) ? (Number(v) / 10000).toFixed(2) + '억' : '');

/** /briefing·/region 과 동일한 단일 테마 셸 — 의도된 커미트먼트. */
function pageShell({ title, desc, canonical, body, noindex, image }) {
  // OG-IMAGE-DYNAMIC-2026-09-02: 단지 사실이 있으면 그 단지 카드를, 없으면 기본 이미지를 쓴다.
  //   `image` 를 안 넘긴 호출(404 셸 등)은 종전대로 정적 og.png 를 쓴다.
  const ogImg = image || `${ORIGIN}/og.png`;
  return `<!DOCTYPE html><html lang="ko"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:type" content="article">
<!-- OG-IMAGE-2026-09-02 (감사 P3): 이 세 SSR 페이지에는 og:image·twitter 카드가 **아예 없었다**.
     카카오톡·X·스레드에 링크를 붙여도 미리보기 이미지가 나오지 않아, 공개 페이지를 공유해도
     타임라인에서 눈에 띄지 않았다(운영자 SNS 자산과 직결). 단지별 동적 이미지는 별도 과제이고,
     우선 앱과 같은 기본 이미지라도 붙여 카드가 그려지게 한다. -->
<meta property="og:image" content="${esc(ogImg)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(ogImg)}">
<meta name="robots" content="${noindex ? 'noindex, follow' : 'index, follow'}">
<style>
  :root{--bg:#080E18;--card:#101B2B;--bd:#22334A;--tx:#E8EFFA;--sub:#93A4BD;--amb:#FFC93C;--acc:#4C8DFF}
  *{box-sizing:border-box;margin:0}
  body{background:var(--bg);color:var(--tx);font-family:Pretendard,-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;line-height:1.7;padding:28px 16px}
  main{max-width:680px;margin:0 auto}
  .eyebrow{color:var(--amb);font-size:11px;font-weight:800;letter-spacing:2px}
  h1{font-size:28px;margin:4px 0 2px;letter-spacing:-.02em}
  .tag{color:var(--sub);font-size:12px;margin-bottom:18px}
  .card{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:14px 16px;margin-bottom:12px}
  .card h2{font-size:13px;color:var(--amb);margin-bottom:8px}
  .src{color:var(--sub);font-size:10px;font-weight:500}
  .row{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px dashed var(--bd);font-size:13px}
  .row:last-child{border-bottom:none}
  .row .k{color:var(--sub);font-size:12px}
  .num{font-variant-numeric:tabular-nums}
  .kpi{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:4px}
  @media(max-width:520px){.kpi{grid-template-columns:1fr 1fr}}
  .kpi div b{display:block;font-size:19px;font-weight:800;font-variant-numeric:tabular-nums}
  .kpi div span{font-size:11px;color:var(--sub)}
  a{color:var(--acc);text-decoration:none}
  .links{display:flex;flex-wrap:wrap;gap:7px;margin-top:6px}
  .links a{font-size:12px;color:var(--sub);border:1px solid var(--bd);border-radius:7px;padding:4px 9px}
  .foot{color:var(--sub);font-size:10.5px;margin-top:20px;line-height:1.8}
  .cta{display:inline-block;margin-top:14px;padding:10px 18px;background:var(--amb);color:#1A2436;border-radius:9px;font-weight:700;font-size:13px}
</style></head><body><main>${body}
<div class="foot">⚠ 국토교통부 실거래가 신고 자료를 정리한 것이며, <strong>매수·매도 추천이 아닙니다</strong>. 미래 가격을 예측하지 않습니다.<br>
층·향·수리 상태에 따른 가격 차이는 보정하지 않습니다 — 실제 판단은 임장으로 확인하세요.<br>
© 내집로그 · <a href="${ORIGIN}/">myhomelog.vercel.app</a></div>
</main></body></html>`;
}

/** MV(molit_apt_index)에서 단지 헤더 정보 — 거래가 창 밖이어도 이름·지역은 나온다. */
async function loadIndexRow(aptSeq) {
  const { getSupabaseAdmin } = require('../db/client');
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const { data, error } = await admin
    .from('molit_apt_index')
    .select('apt_seq, apt_name, lawd_cd, sigungu, umd_nm, build_year, recent_deal_date, deal_count')
    .eq('apt_seq', aptSeq)
    .limit(1);
  if (error) { logger.warn({ err: error.message, aptSeq }, '/apt 인덱스 조회 실패'); return null; }
  return (data || [])[0] || null;
}

/**
 * APT-FACTS-SSOT-2026-09-02 (Sprint RRRRRRR): 단지 사실을 **한 곳에서만** 만든다.
 *   [왜] 링크 미리보기 이미지(/api/og/apt/:seq)가 같은 단지의 숫자를 따로 계산하면,
 *     카드에는 "63건 평균 19.2억" 이 뜨는데 페이지에는 다른 값이 나올 수 있다. 이 저장소는
 *     이미 취득세·규제판정에서 **사본 2개가 갈리는** 사고를 반복해서 겪었다
 *     ([[tax-law-crosscheck-2026-06-24]]). 그래서 페이지와 이미지가 이 함수를 같이 쓴다.
 *   거래도 인덱스도 없으면 null — 호출부가 "없음" 을 각자 표현한다.
 */
async function loadAptFacts(seq) {
  const svc = require('../services/transactionService');
  let idx = null, txs = null;
  try { idx = await loadIndexRow(seq); } catch (e) { logger.warn({ err: e.message, seq }, '/apt 인덱스 예외'); }
  try { txs = await svc.getTransactionsByAptSeq(seq, 24); } catch (e) { logger.warn({ err: e.message, seq }, '/apt 거래 예외'); }
  if (!idx && (!txs || !txs.length)) return null;

  const { regionLabel } = require('../services/priceRecordsService');
  const lawdCd = String((idx && idx.lawd_cd) || (txs && txs[0] && txs[0].lawdCd) || '').trim();
  // APT-PAGE-ENRICH-2026-09-06 (Plan 069): 학교·좌표 캐시 키(buildKey)는 원본(짧은) sigungu 가
  //   필요하다("강남구" 형태 — apt_geocache/apt_schools 저장 규약과 동일, geocode.js:135 참조).
  //   regionLabel() 이 만드는 `region`("서울 강남구")은 화면 표시용이라 그대로 쓰면 캐시 키가 어긋난다.
  const sigunguRaw = String((idx && idx.sigungu) || (txs && txs[0] && txs[0].sigungu) || '').trim();
  const region = regionLabel(lawdCd, sigunguRaw);
  const aptName = (idx && idx.apt_name) || (txs && txs[0] && txs[0].aptName) || '';
  const umd = (idx && idx.umd_nm) || (txs && txs[0] && txs[0].umdNm) || '';
  const buildYear = num(idx && idx.build_year) || num(txs && txs[0] && txs[0].buildYear);
  // analyzeTransactions 는 aptName|lawdCd|umdNm 로 묶는다 — apt_seq 한 건만 넣었으니 그룹은 1개다.
  const stat = (txs && txs.length) ? (svc.analyzeTransactions(txs) || [])[0] : null;
  return { idx, txs, lawdCd, region, aptName, umd, buildYear, stat, sigungu: sigunguRaw };
}

// ── APT-PAGE-INFO-2026-09-06 (Plan 063) ────────────────────────────────────────────
// [왜] 공개 단지 페이지가 실거래만 보여준다. 이미 가진 KAPT 단지정보(apt_master.facility)를
//   붙인다 — 새 외부 API 호출 없이(비용 0) 페이지를 두껍게 만든다.
// [매칭 규칙 — 유사도 매칭 절대 금지] 이 저장소는 이름 유사도 단독 매칭으로 전국 956건을
//   오매칭한 이력이 있다([[apt-kapt-mismatch-identity-gate]]). 채택은 이 두 가지 정확일치뿐이다:
//   ① molit_aliases 배열에 이름이 정확히 들어 있다(가장 확실) ② 공백 제거 후 이름 완전일치.
//   후보가 2개 이상이면(같은 lawd_cd·umd_nm 안에서 어느 쪽 기준으로도) 카드를 만들지 않는다 —
//   확신 없으면 안 보여준다. 이 함수는 이 판단만 한다(DB 조회는 loadAptMasterMatch).
function _normAptName(s) {
  return String(s || '').replace(/\s+/g, '');
}
function pickAptMasterMatch(rows, aptName) {
  if (!Array.isArray(rows) || !rows.length || !aptName) return null;
  const aliasMatches = rows.filter((r) => Array.isArray(r.molit_aliases) && r.molit_aliases.includes(aptName));
  if (aliasMatches.length === 1) return aliasMatches[0];
  if (aliasMatches.length >= 2) return null; // 후보 2개 이상 — 확신 불가
  const target = _normAptName(aptName);
  const nameMatches = rows.filter((r) => _normAptName(r.apt_name) === target);
  if (nameMatches.length === 1) return nameMatches[0];
  return null; // 0개 또는 2개 이상 — 카드를 만들지 않는다
}

/**
 * apt_master 에서 단지정보 후보를 찾는다.
 * @returns {Promise<{errored: boolean, row: object|null}>}
 *   errored=true 는 "조회를 못 읽었다"(있을 수도 있는데 확인 불가) — 호출부가 긴 캐시를 붙이면
 *   안 된다([[degraded-response-cached-at-edge]] 의 교훈: 열화 응답을 엣지에 굳히면 사고가 난다).
 *   errored=false·row=null 은 "조회는 됐는데 정말 매칭이 없다"(또는 후보 2개 이상이라 확신 불가) —
 *   이때는 기존 캐시 정책을 그대로 쓴다.
 */
async function loadAptMasterMatch(lawdCd, umd, aptName) {
  const { getSupabaseAdmin } = require('../db/client');
  const admin = getSupabaseAdmin();
  // DB 연결 자체가 안 되면 "정말 없음"과 구분할 수 없다 — 보수적으로 errored 취급.
  if (!admin) return { errored: true, row: null };
  try {
    let q = admin.from('apt_master').select('kapt_code, apt_name, molit_aliases, facility').eq('lawd_cd', lawdCd);
    q = umd ? q.eq('umd_nm', umd) : q.limit(300); // umd 없으면 lawd_cd 전체 조회 — 상한 필수
    const { data, error } = await q;
    if (error) {
      logger.warn({ err: error.message, lawdCd, umd }, 'APT-PAGE-INFO-2026-09-06: apt_master 조회 실패');
      return { errored: true, row: null };
    }
    return { errored: false, row: pickAptMasterMatch(data || [], aptName) };
  } catch (e) {
    logger.warn({ err: e.message, lawdCd, umd }, 'APT-PAGE-INFO-2026-09-06: apt_master 조회 예외');
    return { errored: true, row: null };
  }
}

/**
 * 단지정보 카드를 만든다 — "미확인 원칙": 값이 없는 항목은 행 자체를 만들지 않는다
 * (`0`·`미상` 금지 — 이 저장소가 반복해 당한 결함). buildFacility(앱 상세와 같은 함수)를
 * 재사용만 하고 고치지 않는다 — 그 함수가 이미 담은 판단(세대수 원천 등)을 그대로 쓴다.
 * ⚠ KAPT 도보시간(kaptdWtimesub/kaptdWtimebus)은 관리사무소 자기신고값이라 넣지 않는다
 * ([[substring-band-matching-and-selfreported-data]] — 실측 일치율 42.6%).
 * @returns {{html: string, householdsFact: string|null, builtYearFact: string|null}}
 */
function buildAptInfoCard(row) {
  const { buildFacility } = require('../utils/buildFacility');
  const stored = (row.facility && !row.facility._empty) ? row.facility : null;
  const fac = buildFacility(stored, row.kapt_code, (stored && stored._dtl) || null);
  const empty = { html: '', householdsFact: null, builtYearFact: null };
  if (!fac) return empty;

  // buildFacility 는 "모름"을 0(dongCount·parkingTotal)이나 null 로 섞어 내보낸다(그 함수의 기존
  // 설계 — 고치지 않는다). 여기서는 표시 목적으로만 양수만 값으로 인정한다.
  const posInt = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const rows = [];
  const hh = posInt(fac.totalHouseholds);
  if (hh) rows.push(['총 세대수', `${comma(hh)}세대`]);
  const dong = posInt(fac.dongCount);
  if (dong) rows.push(['총 동수', `${comma(dong)}개동`]);
  const floorRange = (posInt(fac.bottomFloor) && posInt(fac.topFloor)) ? `${fac.bottomFloor}~${fac.topFloor}층`
    : (posInt(fac.topFloor) ? `최고 ${fac.topFloor}층` : null);
  if (floorRange) rows.push(['층수', floorRange]);
  let builtYmd = null;
  if (fac.builtDate) {
    const s = String(fac.builtDate);
    builtYmd = s.length === 8 ? `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6, 8)}` : (s.length === 6 ? `${s.slice(0, 4)}.${s.slice(4, 6)}` : esc(s));
    rows.push(['준공일', builtYmd]);
  }
  // APT-PAGE-ENRICH-2026-09-06 (Plan 069): fac.address 는 buildFacility 가 이미 도로명→지번
  //   폴백을 마친 값이다(ADDR-FALLBACK-2026-08-30) — 여기서 새로 판단하지 않고 그대로 노출만 한다.
  if (fac.address) rows.push(['주소', esc(String(fac.address))]);
  const parkTotal = posInt(fac.parkingTotal);
  if (parkTotal) rows.push(['총 주차대수', `${comma(parkTotal)}대${fac.parkingRatio ? ` (세대당 ${fac.parkingRatio}대)` : ''}`]);
  if (fac.heatType) rows.push(['난방방식', esc(String(fac.heatType))]);
  // STRUCTURE-2026-09-06 (Plan 068/069): fac.structureType 은 _dtl.codeStr(진짜 건물 구조,
  //   예: 철근콘크리트구조) — hallType(복도유형, 아래)과는 다른 필드다. Plan 065 가 바로잡은
  //   라벨 규칙을 유지: "구조" 라는 라벨은 이 필드에만 쓴다.
  if (fac.structureType) rows.push(['구조', esc(String(fac.structureType))]);
  // APT-PAGE-LABEL-2026-09-06 (Plan 065): fac.hallType(buildFacility.js 의 codeHallNm)은
  //   현관 접근 방식(계단식/복도식/혼합식)이지 건물 구조(codeStr)가 아니다. Plan 063 이
  //   "구조" 라고 잘못 표기했다 — 라벨만 사실대로 바로잡는다(값·필드는 그대로).
  if (fac.hallType) rows.push(['복도유형', esc(String(fac.hallType))]);
  const elev = posInt(fac.elevatorCount);
  if (elev) rows.push(['승강기', `${comma(elev)}대`]);
  const cctv = posInt(fac.cctvCount);
  if (cctv) rows.push(['CCTV', `${comma(cctv)}대`]);

  if (!rows.length) return empty; // 보여줄 값이 하나도 없으면 카드 자체를 만들지 않는다

  const html = `<div class="card"><h2>단지정보 <span class="src">한국부동산원 공동주택관리정보시스템(K-apt)</span></h2>
    ${rows.map(([k, v]) => `<div class="row"><span class="k">${esc(k)}</span><span class="num">${v}</span></div>`).join('')}
  </div>`;

  const builtYear = fac.builtDate ? parseInt(String(fac.builtDate).slice(0, 4)) : null;
  return {
    html,
    householdsFact: hh ? `${comma(hh)}세대` : null,
    builtYearFact: (Number.isFinite(builtYear) && builtYear > 1900) ? `${builtYear}년 준공` : null,
  };
}

// ── APT-PAGE-ENRICH-2026-09-06 (Plan 069) ──────────────────────────────────────────
// [왜] 063/065/068 이 붙인 K-apt 단지정보 카드에 이어, 이미 캐시된(비용 0) 학교·좌표 데이터를
//   붙인다. ⚠ 절대 제약: 외부 API 호출 0 — resolveSchools/kakaoSearchSchools/resolveCoord
//   (캐시 미스 시 Kakao 재호출)는 이 파일 어디서도 참조하지 않는다. 캐시 전용 함수만 쓴다:
//   schoolService.getCachedSchoolsBatch·geocodeCacheService.resolveCoordFromCacheOnly.
// [키] 유사도 매칭 금지 원칙을 그대로 따른다 — 학교·좌표 키는 063 이 확정한 apt_master `row`
//   (alias/완전일치로 고른 행)의 kapt_code/apt_name 으로만 만든다. row 가 없으면(매칭 불가·
//   오류) 학교·좌표 조회 자체를 하지 않는다 — 이름만으로 별도 후보를 찾지 않는다.

/** 초·중·고 순으로 정렬해 "주변 학교" 카드를 만든다. 값이 없으면 빈 문자열(카드 생략).
 *  ⚠ schoolService._normalizeSchoolsList 가 캐시 히트 시 거리순 재정렬을 하므로(초/중/고
 *  뒤섞일 수 있음), 여기서 type 기준으로 다시 그룹핑해 표시 순서를 보장한다. */
function buildSchoolsCard(schools) {
  if (!Array.isArray(schools) || !schools.length) return '';
  const TYPE_ORDER = { 초: 0, 중: 1, 고: 2 };
  const valid = schools.filter((s) => s && s.name && Number.isFinite(Number(s.distance_m)));
  if (!valid.length) return '';
  const sorted = [...valid].sort((a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9));
  return `<div class="card"><h2>주변 학교 <span class="src">카카오 지도 · 교육청 공시(캐시)</span></h2>
    ${sorted.map((s) => `<div class="row"><span class="k">${esc(String(s.type || ''))} ${esc(String(s.name))}</span><span class="num">${comma(Math.round(Number(s.distance_m)))}m</span></div>`).join('')}
  </div>`;
}

router.get('/:aptSeq', async (req, res) => {
  const seq = String(req.params.aptSeq || '').trim();
  if (!/^\d{5}-\d+$/.test(seq)) {
    res.set('Cache-Control', 'no-store');
    return res.status(404).type('html').send(pageShell({
      title: '단지를 찾을 수 없습니다 | 내집로그', desc: '요청한 단지 코드에 해당하는 페이지가 없습니다.',
      canonical: `${ORIGIN}/region`, noindex: true,
      body: `<div class="eyebrow">MYHOMELOG APT</div><h1>단지 없음</h1>
        <p style="font-size:13px;color:var(--sub)">요청한 단지 코드 형식이 올바르지 않아요.</p>
        <a class="cta" href="/region">지역별로 찾아보기 →</a>`,
    }));
  }

  const af = await loadAptFacts(seq);

  if (!af) {
    res.set('Cache-Control', 'no-store'); // 없는 단지를 캐시하지 않는다
    return res.status(404).type('html').send(pageShell({
      title: '단지를 찾을 수 없습니다 | 내집로그', desc: '요청한 단지의 실거래 기록이 없습니다.',
      canonical: `${ORIGIN}/region`, noindex: true,
      body: `<div class="eyebrow">MYHOMELOG APT</div><h1>기록 없음</h1>
        <p style="font-size:13px;color:var(--sub)">이 단지의 실거래 기록이 없어요. 값을 지어내지 않고 비워둡니다.</p>
        <a class="cta" href="/region">지역별로 찾아보기 →</a>`,
    }));
  }

  const { txs, lawdCd, region, aptName, umd, buildYear, stat, sigungu } = af;

  const cards = [];
  const facts = [];

  if (stat) {
    cards.push(`<div class="card">
      <h2>최근 24개월 실거래 요약 <span class="src">국토교통부 실거래 신고</span></h2>
      <div class="kpi">
        <div><b>${comma(num(stat.dealCount) || 0)}건</b><span>거래 건수</span></div>
        <div><b>${esc(String(stat.avgPriceAuk))}억</b><span>평균가(시간 가중)</span></div>
        <div><b>${eok(stat.medianPrice)}</b><span>중앙값</span></div>
      </div>
      <div class="row"><span class="k">가격 범위</span><span class="num">${eok(stat.minPrice)} ~ ${eok(stat.maxPrice)}</span></div>
      <div class="row"><span class="k">최근 거래일</span><span class="num">${esc(String(stat.recentDeal))}</span></div>
      ${buildYear ? `<div class="row"><span class="k">준공</span><span class="num">${buildYear}년</span></div>` : ''}
      <div class="src" style="margin-top:8px">평균가는 최근 거래에 가중치를 둔 값입니다. 절사평균(상하 10% 제외) ${eok(stat.trimmedAvgPrice)}.</div>
    </div>`);
    facts.push(`최근 24개월 ${comma(num(stat.dealCount) || 0)}건`);
    facts.push(`평균 ${stat.avgPriceAuk}억`);
    if (stat.recentDeal) facts.push(`최근 거래 ${stat.recentDeal}`);

    const ps = (stat.pyeongStats || []).filter(p => num(p.dealCount));
    if (ps.length) {
      cards.push(`<div class="card"><h2>평형별 <span class="src">전용면적 기준 · 같은 평형끼리만 비교</span></h2>
        ${ps.map(p => `<div class="row">
          <span><b>${esc(String(p.pyeong))}평</b> <span class="k">${p.excluUseAr ? '전용 ' + esc(String(p.excluUseAr)) + '㎡ · ' : ''}${comma(num(p.dealCount) || 0)}건${p.floorRange ? ` · ${p.floorRange.min}~${p.floorRange.max}층` : ''}</span></span>
          <span class="num">중앙 ${eok(p.medianPrice)} <span class="k">${eok(p.minPrice)}~${eok(p.maxPrice)}</span></span>
        </div>`).join('')}
      </div>`);
    }

    const raw = (stat.rawList || []).slice(0, 10);
    if (raw.length) {
      cards.push(`<div class="card"><h2>최근 거래 ${raw.length}건 <span class="src">국토교통부 신고 기준</span></h2>
        ${raw.map(t => `<div class="row">
          <span class="k">${t.dealYear}.${String(t.dealMonth).padStart(2, '0')}.${String(t.dealDay).padStart(2, '0')}</span>
          <span class="num">전용 ${esc(String(t.excluUseAr))}㎡ · ${num(t.floor) ? t.floor + '층' : '층 미상'} · <b>${eok(t.dealAmount)}</b></span>
        </div>`).join('')}
        <div class="src" style="margin-top:8px">${esc(String(stat.floorAdjustmentNote || ''))}</div>
      </div>`);
    }
  }

  // 거래가 없으면 색인시키지 않는다 — 얇은 페이지를 대량으로 색인시키면 사이트 전체 평가에 해롭다.
  // ⚠ CACHE-POISON-2026-08-29 의 교훈: 열화 상태(카드 0)에 긴 캐시를 붙이지 않는다.
  // ⚠ APT-PAGE-INFO-2026-09-06: thin 은 여기서, 아래 단지정보 카드를 붙이기 전에 확정한다 —
  //   단지정보가 있다고 거래 0 페이지를 색인시키면 안 된다(Plan 063 범위 밖 — thin 판정 불변).
  const thin = !cards.length;

  // APT-PAGE-INFO-2026-09-06 (Plan 063): 단지정보(K-apt) 카드 — cards/thin 과 분리해서 붙인다.
  let infoCardHtml = '';
  let aptMasterErrored = false;
  let hasKaptFact = false;
  // APT-PAGE-ENRICH-2026-09-06 (Plan 069): 학교·지도 링크 — 왕복 예산(apt_master 1 + 학교 1 +
  //   좌표 1 = 최대 3) 안에서 학교·좌표는 Promise.all 로 병렬 조회한다. 오류 시(같은 방식으로
  //   aptMasterErrored 처럼) 긴 캐시를 막는다 — "못 읽음"과 "정말 없음"을 구분 못 하면 열화
  //   응답(카드 없음)이 엣지에 6시간 굳는다([[degraded-response-cached-at-edge]]).
  let schoolsCardHtml = '';
  let mapLinkHtml = '';
  let enrichErrored = false;
  if (lawdCd && aptName) {
    const { errored, row } = await loadAptMasterMatch(lawdCd, umd, aptName);
    aptMasterErrored = errored;
    if (row) {
      const cardInfo = buildAptInfoCard(row);
      infoCardHtml = cardInfo.html;
      if (cardInfo.householdsFact) facts.push(cardInfo.householdsFact);
      if (cardInfo.builtYearFact) facts.push(cardInfo.builtYearFact);
      hasKaptFact = !!(cardInfo.householdsFact || cardInfo.builtYearFact);

      // 학교·좌표는 063 이 확정한 이 row(kapt_code/apt_name)로만 키를 만든다 — 유사도 매칭 금지.
      const schoolCoordApt = { kaptCode: row.kapt_code || null, aptName: row.apt_name, sigungu, umdNm: umd };
      try {
        const schoolSvc = require('../services/schoolService');
        const geoSvc = require('../services/geocodeCacheService');
        const [schoolsBatch, coord] = await Promise.all([
          schoolSvc.getCachedSchoolsBatch([schoolCoordApt]),
          geoSvc.resolveCoordFromCacheOnly(schoolCoordApt),
        ]);
        schoolsCardHtml = buildSchoolsCard(schoolsBatch && schoolsBatch[0]);
        if (coord && Number.isFinite(Number(coord.lat)) && Number.isFinite(Number(coord.lng))) {
          // MAP-DEEPLINK-2026-09-06 (Plan 069): frontend/index.html:8800-8810 의 handleShareUrl() 이
          //   ?apt=&area= 를 읽어 자동으로 상세를 띄운다(부팅 시 setTimeout(handleShareUrl,300), :3596).
          //   이 저장소가 이미 이 규약으로 공유 링크를 만든다(backend/routes/share.js:97) — 같은 형식을 쓴다.
          //   지도 임베드는 하지 않는다(공개 페이지는 정적 HTML 유지) — 좌표는 "링크를 보여줄지"의 게이트로만 쓴다.
          const areaLabel = `${region}${umd ? ' ' + umd : ''}`;
          const deepLink = `${ORIGIN}/?apt=${encodeURIComponent(aptName)}&area=${encodeURIComponent(areaLabel)}`;
          mapLinkHtml = `<a href="${esc(deepLink)}">지도에서 보기</a>`;
        }
      } catch (e) {
        enrichErrored = true;
        logger.warn({ err: e.message, lawdCd, umd }, 'APT-PAGE-ENRICH-2026-09-06: 학교/좌표 캐시 조회 예외');
      }
    }
  }

  const body = `<div class="eyebrow">MYHOMELOG APT</div>
    <h1>${esc(aptName)} 실거래가</h1>
    <div class="tag">${esc(region)}${umd ? ' ' + esc(umd) : ''} · 단지코드 ${esc(seq)}</div>
    ${cards.length ? cards.join('') : `<div class="card"><h2>최근 거래 없음</h2>
      <div style="font-size:12.5px;color:var(--sub)">최근 24개월 안에 신고된 거래가 없어요. 값을 지어내지 않고 비워둡니다.</div></div>`}
    ${infoCardHtml}
    ${schoolsCardHtml}
    <div class="card"><h2>이 지역 더 보기</h2>
      <div class="links">${lawdCd ? `<a href="/region/${esc(lawdCd)}">${esc(region)} 지역 데이터</a>` : ''}<a href="/region">전국 시군구 전체</a>${mapLinkHtml}</div>
    </div>
    <a class="cta" href="${ORIGIN}/">${esc(aptName)} 대출 한도·비용 계산 →</a>`;

  const title = `${aptName} 실거래가 — ${region}${umd ? ' ' + umd : ''} | 내집로그`;
  // APT-PAGE-DESC-2026-09-06 (Plan 065): 분기는 facts.length 가 아니라 thin(거래 유무, 위에서
  //   이미 확정됨)으로 가른다 — Plan 063 은 facts.length 로 갈라서, 거래가 0건인데 K-apt 세대수·
  //   준공년도 fact 만으로 facts.length>0 이 돼 "국토교통부 실거래 신고 자료 정리" 분기를 탔다.
  //   거래 0 인 경우는 그 사실이 항상 남아야 하고, KAPT 출처 fact 에는 국토교통부를 붙이지 않는다.
  // APT-PAGE-DESC-SRC-2026-09-06 (Plan 069): 거래 있음(!thin) 분기에서 facts 에 KAPT 사실
  //   (세대수·준공)이 하나라도 섞였으면 출처 문구도 그 사실대로 바꾼다 — 지금까지는 K-apt 사실이
  //   있어도 "국토교통부 실거래 신고 자료 정리" 라고만 말했다(사실과 문구 불일치). 거래 0 분기(065)는
  //   그대로 둔다 — 이미 KAPT 출처에 국토교통부를 안 붙이는 문구를 쓰고 있다.
  const txSourceLabel = hasKaptFact ? '국토교통부 실거래·K-apt 단지정보 정리' : '국토교통부 실거래 신고 자료 정리';
  const desc = !thin
    ? `${aptName}(${region}${umd ? ' ' + umd : ''}) ${facts.join(' · ')}. ${txSourceLabel} — 매수 추천이 아닙니다.`
    : (facts.length
      ? `${aptName}(${region}${umd ? ' ' + umd : ''}) 최근 24개월 거래 기록이 없습니다. K-apt 단지정보 ${facts.join(' · ')} — 매수 추천이 아닙니다.`
      : `${aptName}(${region}${umd ? ' ' + umd : ''}) 국토교통부 실거래 신고 자료. 최근 24개월 거래 기록이 없습니다 — 매수 추천이 아닙니다.`);

  // APT-PAGE-INFO-2026-09-06: 단지정보/학교/좌표 조회가 "오류로 실패"했을 때도 긴 캐시를 붙이지
  //   않는다 — "있을 수도 있는데 못 읽음"과 "정말 없음"을 구분 못 하면 열화 응답이 엣지에 굳는다
  //   ([[degraded-response-cached-at-edge]]). thin·noindex 판정 자체는 건드리지 않는다(위에서 이미 확정).
  const cacheUnsafe = thin || aptMasterErrored || enrichErrored;
  res.set('Cache-Control', cacheUnsafe ? 'no-store' : 'public, max-age=0, s-maxage=21600, stale-while-revalidate=86400');
  res.type('html').send(pageShell({ title, desc, canonical: `${ORIGIN}/apt/${seq}`, body, noindex: thin,
    // 얇은 페이지(거래 0)는 카드에 쓸 숫자가 없으므로 기본 이미지를 유지한다.
    image: thin ? null : `${ORIGIN}/api/og/apt/${encodeURIComponent(seq)}` }));
});

module.exports = router;
// 링크 미리보기 이미지 라우트가 같은 사실을 쓰도록 함께 내보낸다 (APT-FACTS-SSOT-2026-09-02)
module.exports.loadAptFacts = loadAptFacts;
