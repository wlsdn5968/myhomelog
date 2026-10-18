/**
 * REGION-PAGE-2026-08-29 (Sprint NNNNNNN-31): GET /region, /region/:lawdCd — 서버렌더 지역 페이지.
 *
 * [왜 만드는가 — 실측] 2026-08-29 sitemap 전수: 크롤 가능한 URL 이 **16개**였다(그중 11개가 브리핑).
 *   단지 14,414개·시군구 118개 데이터를 들고 있는데 검색엔진이 도달할 수 있는 페이지가 사실상 없다.
 *   `/?apt=반포자이` 를 요청해도 title·description·og 가 **홈과 완전히 동일**하다(SPA라 본문이 JS 안).
 *   4개월간 가입 7명·검색 62건이라는 수치의 배경이 이것이다.
 *
 * [왜 이 형태인가] /briefing/:date 가 이미 검증된 패턴이다 — 완전한 서버렌더 HTML + canonical + OG,
 *   sitemap 자동 등록. 그걸 지역에 그대로 적용한다. **새 데이터 수집 0** — 전부 기존 서비스 재사용.
 *
 * [SNS 와의 관계] 스레드 자동화가 "노원구 최고가 경신 110건"이라고 올려도 링크가 홈으로 가면
 *   사용자가 다시 찾아야 한다. 이 페이지가 그 글의 **도착지**가 된다(SEO 와 SNS 전환을 한 번에).
 *
 * [절대 룰] 판단어·예측 없음. 모든 수치에 출처 명시. 값이 없는 칸은 **통째로 생략**(0·추정 금지).
 */
'use strict';

const express = require('express');
const logger = require('../logger');
const router = express.Router();
// APT-DISPLAY-NAME-2026-09-16 (Plan 090): 표시 전용 — aptName(조회 키)은 바꾸지 않는다.
const { displayAptName } = require('../utils/aptDisplayName');

const ORIGIN = 'https://myhomelog.vercel.app';

const { THEME_CSS, FONT_STACK, FONT_LINK } = require('./_ssrTheme'); // Plan 145: 공용 테마
const { escHtml: esc } = require('../utils/htmlEscape'); // ESC-UNIFY-2026-09-28 (Plan 124)
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const comma = (v) => Number(v).toLocaleString('ko-KR');
const eok = (v) => (Number.isFinite(Number(v)) ? (Number(v) / 10000).toFixed(2) + '억' : '');
const ym = (s) => {
  const t = String(s || '');
  return /^\d{6}$/.test(t) ? `${t.slice(0, 4)}.${t.slice(4, 6)}` : t;
};

/** /briefing/:date 와 동일한 단일 테마 셸 — 의도된 커미트먼트(뷰어 테마와 무관하게 고정). */
function pageShell({ title, desc, canonical, body, image }) {
  const ogImg = image || `${ORIGIN}/og.png`; // OG-REGION-2026-09-05: 통계가 있는 지역은 동적 카드(/api/og/region)
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
<meta name="robots" content="index, follow">
${FONT_LINK}
<style>
  ${THEME_CSS}
  *{box-sizing:border-box;margin:0}
  body{background:var(--bg);color:var(--ink);font-family:${FONT_STACK};line-height:1.7;padding:28px 16px}
  main{max-width:680px;margin:0 auto}
  .eyebrow{color:var(--pri);font-size:12px;font-weight:800;letter-spacing:2px}
  h1{font-size:28px;margin:4px 0 2px;letter-spacing:-.02em}
  .tag{color:var(--ink3);font-size:12px;margin-bottom:18px}
  .card{background:var(--sf);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:12px}
  .card h2{font-size:14px;color:var(--pri);margin-bottom:8px}
  .src{color:var(--ink3);font-size:12px;font-weight:500}
  .row{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px dashed var(--line);font-size:14px}
  .row:last-child{border-bottom:none}
  .row .k{color:var(--ink3);font-size:12px}
  .num{font-variant-numeric:tabular-nums}
  .big{font-size:20px;font-weight:800;font-variant-numeric:tabular-nums}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  @media(max-width:560px){.grid{grid-template-columns:1fr}}
  .links{display:flex;flex-wrap:wrap;gap:7px;margin-top:6px}
  .links a{font-size:12px;color:var(--ink3);border:1px solid var(--line2);border-radius:7px;padding:4px 9px;text-decoration:none}
  .links a:hover{border-color:var(--pri);color:var(--ink)}
  a{color:var(--pri);text-decoration:none}
  .foot{color:var(--ink3);font-size:12px;margin-top:20px;line-height:1.8}
  .cta{display:inline-block;margin-top:14px;padding:10px 18px;background:var(--pri);color:var(--onpri);border-radius:9px;font-weight:700;font-size:14px}
</style></head><body><main>${body}
<div class="foot">공식 통계 수치를 정리한 정보예요. <strong>매수·매도 추천이 아니고</strong>, 미래 가격도 예측하지 않아요.<br>
출처: 국토교통부 실거래가 · 한국부동산원 R-ONE · 국토교통부 미분양주택현황(KOSIS) · 국가데이터처 국내인구이동통계(KOSIS) · 금융위원회<br>
© 내집로그 · <a href="${ORIGIN}/">myhomelog.vercel.app</a></div>
</main></body></html>`;
}

/** 전 지역 목록 — 표시명은 lawd_cd 파생(동명 구 구별). 이름순. */
// SEO-REGION-APT-LINKS-2026-09-02 (감사 P1-8): 단지 페이지 15,954개가 **사이트맵에만** 있고
//   어떤 페이지도 /apt/* 로 링크하지 않았다(전수 grep: 앱 0 · SSR 0). 내부 링크가 없는 URL 은
//   크롤 우선순위가 낮다 — 구글 색인이 1페이지에 머문 구조적 이유다.
//   지역 페이지가 그 지역 단지로 링크하면 119개 지역 × N 으로 단지 페이지가 링크 그래프에 들어온다.
async function topAptsOfRegion(lawdCd, limit = 30) {
  const { getSupabaseAdmin } = require('../db/client');
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  try {
    const { data, error } = await admin
      .from('molit_apt_index')
      .select('apt_seq, apt_name, umd_nm, build_year, deal_count')
      .eq('lawd_cd', String(lawdCd))
      .order('deal_count', { ascending: false })
      .limit(limit);
    if (error) throw error;
    // apt_seq 형식이 맞는 것만 — /apt 라우트가 거부하는 형식을 링크하면 죽은 링크가 된다.
    return (data || []).filter(r => r && /^\d{5}-\d+$/.test(String(r.apt_seq || '')));
  } catch (e) {
    logger.warn({ err: e.message, lawdCd }, '/region 단지 링크 조회 실패');
    return [];
  }
}

function regionList() {
  const { LAWD_CODES } = require('../services/transactionService');
  const { regionLabel } = require('../services/priceRecordsService');
  return Object.values(LAWD_CODES)
    .map(String)
    .filter((c, i, a) => a.indexOf(c) === i)
    .map(code => ({ lawdCd: code, name: regionLabel(code, '') }))
    .filter(r => r.name)
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

// ── GET /region — 전 지역 허브(크롤러가 118개를 타고 들어갈 입구) ─────────────────
router.get('/', (req, res) => {
  const list = regionList();
  const body = `<div class="eyebrow">MYHOMELOG REGION</div>
    <h1>지역별 아파트 실거래 데이터</h1>
    <div class="tag">전국 ${list.length}개 시군구 · 국토교통부 실거래 신고 기준</div>
    <div class="card"><h2>지역 선택</h2>
      <div class="links">${list.map(r => `<a href="/region/${esc(r.lawdCd)}">${esc(r.name)}</a>`).join('')}</div>
    </div>
    <a class="cta" href="${ORIGIN}/">지도·계산기와 함께 보기 →</a>`;
  res.set('Cache-Control', 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800');
  res.type('html').send(pageShell({
    title: `지역별 아파트 실거래 데이터 — 전국 ${list.length}개 시군구 | 내집로그`,
    desc: `전국 ${list.length}개 시군구의 아파트 실거래 거래량·가격지수·미분양·인구 순이동을 공식 통계로 정리했어요. 매수 추천이 아니에요.`,
    canonical: `${ORIGIN}/region`,
    body,
  }));
});

// OG-REGION-2026-09-05 (감사 P3-14): 지역 페이지의 description 과 OG 카드가 **같은 함수**로 사실 문장을 만든다.
//   따로 만들면 "카드엔 123건, 페이지엔 다른 값" — 취득세 사본 2개가 3주간 다른 값을 낸 사고와 같은 구조다.
async function loadRegionData(region) {
  // PARALLEL-2026-10-14 (Plan 140): dash·rec·weekly 는 서로의 결과를 쓰지 않는다(입력은 전부 region 하나) —
  //   직렬이면 지연이 합산된다. 각 단계는 자기 try/catch 로 null 을 돌려주므로 Promise.all 이 reject 되는 일이 없고,
  //   한 단계가 실패해도 나머지 값은 종전과 똑같이 채워진다(부분 실패 처리 불변).
  const dashP = (async () => {
    try { return await require('./region').buildDashboard(region); }
    catch (e) { logger.warn({ err: e.message, code: region.lawdCd }, '/region 대시보드 실패'); return null; }
  })();
  const recP = (async () => {
    try {
      const svc = require('../services/priceRecordsService');
      return svc.sliceRegion(await svc.getPriceRecordsByRegion(), region.lawdCd);
    } catch (e) { logger.warn({ err: e.message, code: region.lawdCd }, '/region 경신 조회 실패'); return null; }
  })();
  // WEEKLY-DISCLOSURE-2026-09-05 (감사 P3-14 "주간 변동"): 계약일 기준 주간 변동은 만들지 않는다 — 국토부 공개는
  //   신고 후 최대 30일 지연·배치라 주별 등락이 시장이 아니라 공개 일정을 반영한다(실측: 전국 신규 공개 전주 5,390 →
  //   이번 주 11,763건). 대신 **"이번 주 새로 공개된 거래"** 를 그 사실 그대로 낸다(적재일 ingested_at 기준, 계약일 아님).
  //   지역별 중간값 41건/주(2026-09-05 실측)라 대부분 지역에서 의미 있는 숫자가 나온다. 0건이면 카드·문장 모두 생략.
  const weeklyP = (async () => {
    let weekly = null;
    try {
      const { getSupabaseAdmin } = require('../db/client');
      const admin = getSupabaseAdmin();
      if (admin) {
        const since = new Date(Date.now() - 7 * 86400000).toISOString();
        const { count, error } = await admin.from('molit_transactions').select('*', { count: 'exact', head: true })
          .eq('lawd_cd', String(region.lawdCd)).gte('ingested_at', since);
        if (!error && Number.isFinite(Number(count))) weekly = { count: Number(count), sinceDate: since.slice(0, 10) };
      }
    } catch (e) { logger.warn({ err: e.message, code: region.lawdCd }, '/region 주간 공개 건수 조회 실패'); }
    return weekly;
  })();
  const [dash, rec, weekly] = await Promise.all([dashP, recP, weeklyP]);
  return { dash, rec, weekly };
}

/** 값이 있는 것만, 페이지 카드와 같은 순서로(경신 → 거래량 → 가격지수 → 미분양 → 순이동). 0·추정 금지. */
function regionFacts(dash, rec, weekly) {
  const facts = [];
  if (rec && (num(rec.highCount) || num(rec.lowCount))) {
    facts.push(`최근 ${num(rec.windowDays) || 30}일 최고가 경신 ${num(rec.highCount) || 0}건 · 최저가 경신 ${num(rec.lowCount) || 0}건`);
  }
  if (weekly && num(weekly.count) > 0) facts.push(`최근 7일 신규 공개 ${comma(num(weekly.count))}건`);
  const tx = dash && dash.txTrend;
  if (tx && Array.isArray(tx.months) && tx.months.length) {
    const last = tx.months[tx.months.length - 1];
    if (last) facts.push(`${ym(last.ym)} 실거래 ${comma(num(last.n) || 0)}건`);
  }
  const pi = dash && dash.priceIndex;
  if (pi && Array.isArray(pi.months) && pi.months.length) {
    const last = pi.months[pi.months.length - 1];
    if (last && last.sale != null) facts.push(`${ym(last.ym)} 매매가격지수 ${last.sale}`);
  }
  const un = dash && dash.unsold;
  if (un && un.latest && num(un.latest.cnt) != null) facts.push(`미분양 ${comma(num(un.latest.cnt))}호(${ym(un.latest.ym)})`);
  const mg = dash && dash.netMigration;
  if (mg && mg.latest && num(mg.latest.net) != null) {
    const n = num(mg.latest.net);
    facts.push(`인구 순이동 ${n > 0 ? '+' : ''}${comma(n)}명(${ym(mg.latest.ym)})`);
  }
  return facts;
}

// ── GET /region/:lawdCd ────────────────────────────────────────────────────────
router.get('/:lawdCd', async (req, res) => {
  const code = String(req.params.lawdCd || '').trim();
  const { resolveRegion } = require('./region');
  const region = /^\d{5}$/.test(code) ? resolveRegion({ lawdCd: code }) : null;
  if (!region) {
    res.set('Cache-Control', 'no-store'); // 없는 지역을 캐시하지 않는다
    return res.status(404).type('html').send(pageShell({
      title: '지역을 찾을 수 없어요 | 내집로그',
      desc: '지역 코드에 맞는 페이지가 없어요.',
      canonical: `${ORIGIN}/region`,
      body: `<div class="eyebrow">MYHOMELOG REGION</div><h1>지역 없음</h1>
        <p style="font-size:14px;color:var(--ink3)">지역 코드에 맞는 페이지가 없어요.</p>
        <a class="cta" href="/region">전체 지역 보기 →</a>`,
    }));
  }

  const { regionLabel } = require('../services/priceRecordsService');
  const label = regionLabel(region.lawdCd, region.name);

  // PARALLEL-2026-10-14 (Plan 140): 지역 데이터와 주요 단지 목록은 서로 독립(둘 다 region.lawdCd 만 입력) — 함께 기다린다.
  //   topAptsOfRegion 은 내부 try/catch 로 실패 시 [] 를 돌려주므로 종전과 같은 부분 실패 동작이다.
  const [{ dash, rec, weekly }, apts] = await Promise.all([loadRegionData(region), topAptsOfRegion(region.lawdCd, 30)]);

  // ── 카드들 — 값이 없으면 카드 자체를 만들지 않는다(0·추정 금지) ──
  const cards = [];
  const facts = regionFacts(dash, rec, weekly);   // description·OG 카드가 같은 문장을 쓴다(사본 금지)

  if (rec && (num(rec.highCount) || num(rec.lowCount))) {
    const row = (it, kind) => `<div class="row"><span>${esc(it.aptName || '')} <span class="k">${esc(it.umdNm || '')}${it.excluUseAr ? ' · 전용 ' + esc(String(it.excluUseAr)) + '㎡' : ''}</span></span><span class="num" style="white-space:nowrap"><b style="color:var(--pri)">${eok(it.dealAmount)}</b> <span class="k">직전 ${kind === 'high' ? '최고' : '최저'} ${eok(kind === 'high' ? it.prevMax : it.prevMin)} · ${num(it.priorCount) || 0}건</span></span></div>`;
    cards.push(`<div class="card">
      <h2>최근 ${num(rec.windowDays) || 30}일 최고·최저 경신 <span class="src">같은 단지·같은 전용면적 기준 · ${esc(String(rec.sinceDate || '').replace(/-/g, '.'))} 이후 쌓인 거래 안에서</span></h2>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:8px">비교 가능 거래 ${comma(num(rec.comparedCount) || 0)}건 중 최고가 경신 <b style="color:var(--ink)">${comma(num(rec.highCount) || 0)}건</b> · 최저가 경신 <b style="color:var(--ink)">${comma(num(rec.lowCount) || 0)}건</b></div>
      ${(rec.high || []).slice(0, 3).map(it => row(it, 'high')).join('')}
      ${(rec.low || []).slice(0, 3).map(it => row(it, 'low')).join('')}
      <div class="src" style="margin-top:8px">직전 거래 ${num(rec.minPrior) || 3}건 이상인 평형만 비교 · 단지당 1건만 표시 · 층·향은 보정하지 않음</div>
    </div>`);
  }

  if (weekly && num(weekly.count) > 0) {
    cards.push(`<div class="card"><h2>최근 7일 새로 공개된 실거래 <span class="src">국토교통부 신고 후 공개된 날 기준 · ${esc(String(weekly.sinceDate || '').replace(/-/g, '.'))} 이후</span></h2>
      <div class="big">${comma(num(weekly.count))}<span style="font-size:14px;font-weight:600">건</span></div>
      <div class="src">계약일이 아니라 <b>공개된 시점</b> 기준이에요. 신고·공개 일정에 따라 주마다 차이가 크니 시장의 주간 변동으로 보지 마세요.</div></div>`);
  }

  const tx = dash && dash.txTrend;
  if (tx && Array.isArray(tx.months) && tx.months.length) {
    const ms = tx.months.slice(-6);
    cards.push(`<div class="card"><h2>월별 실거래 건수 <span class="src">${esc(tx.source || '')}</span></h2>
      ${ms.map(m => `<div class="row"><span class="k">${esc(ym(m.ym))}</span><span class="num">${comma(num(m.n) || 0)}건</span></div>`).join('')}
      ${tx.note ? `<div class="src" style="margin-top:8px">${esc(tx.note)}</div>` : ''}</div>`);
  }

  const pi = dash && dash.priceIndex;
  if (pi && Array.isArray(pi.months) && pi.months.length) {
    const ms = pi.months.slice(-6);
    cards.push(`<div class="card"><h2>아파트 가격지수 <span class="src">${esc(pi.source || '')}</span></h2>
      ${ms.map(m => `<div class="row"><span class="k">${esc(ym(m.ym))}</span><span class="num">매매 ${esc(String(m.sale))}${m.jeonse != null ? ` · 전세 ${esc(String(m.jeonse))}` : ''}</span></div>`).join('')}
      ${pi.basis ? `<div class="src" style="margin-top:8px">${esc(pi.basis)}</div>` : ''}</div>`);
  }

  const half = [];
  const un = dash && dash.unsold;
  if (un && un.latest && num(un.latest.cnt) != null) {
    half.push(`<div class="card"><h2>미분양 <span class="src">${esc(un.source || '')}</span></h2>
      <div class="big">${comma(num(un.latest.cnt))}<span style="font-size:14px;font-weight:600">호</span></div>
      <div class="src">${esc(ym(un.latest.ym))} 기준${un.sido ? ` · ${esc(un.sido)} ${esc(un.sigungu || '')}` : ''}</div></div>`);
  }
  const mg = dash && dash.netMigration;
  if (mg && mg.latest && num(mg.latest.net) != null) {
    const n = num(mg.latest.net);
    half.push(`<div class="card"><h2>인구 순이동 <span class="src">${esc(mg.source || '')}</span></h2>
      <div class="big">${n > 0 ? '+' : ''}${comma(n)}<span style="font-size:14px;font-weight:600">명</span></div>
      <div class="src">${esc(ym(mg.latest.ym))} 기준${mg.basis ? ` · ${esc(mg.basis)}` : ''}</div></div>`);
  }
  if (half.length) cards.push(`<div class="grid">${half.join('')}</div>`);

  const rg = dash && dash.regulation;
  if (rg && rg.status) {
    cards.push(`<div class="card"><h2>대출 규제 <span class="src">금융위원회 고시 기준</span></h2>
      <div class="row"><span class="k">현재 상태</span><span><b style="color:${rg.status === '규제지역' ? 'var(--pri)' : 'var(--ink3)'}">${esc(rg.status)}</b>${rg.basis ? ` <span class="k">${esc(rg.basis)}</span>` : ''}</span></div>
      <div class="src" style="margin-top:8px">LTV·DSR은 무주택·생애최초 같은 조건에 따라 달라져요. 앱의 대출 계산에서 내 조건으로 확인하세요.</div></div>`);
  }

  // 형제 지역 링크 — 크롤러가 118개를 순회할 수 있게(같은 시도 우선, 없으면 앞뒤 이름순)
  // 이 지역 단지 페이지로의 내부 링크 (SEO-REGION-APT-LINKS-2026-09-02)
  if (apts.length) {
    // APT-DISPLAY-NAME-2026-09-16 (Plan 090): 표시 전용 — a.apt_name(href 의 apt_seq 는 조회 키 그대로)은
    //   링크 텍스트에서만 감싼다.
    cards.push(`<div class="card"><h2>이 지역 주요 단지 <span class="src">최근 실거래 많은 순 · 매물 광고 아님</span></h2>
      <div class="links">${apts.map(a => `<a href="/apt/${esc(a.apt_seq)}">${esc(displayAptName(a.apt_name, { umdNm: a.umd_nm }) || '')}${a.umd_nm ? ` <span class="k">${esc(a.umd_nm)}</span>` : ''}</a>`).join('')}</div>
      <div class="src" style="margin-top:8px">단지명을 누르면 그 단지의 실거래 요약을 볼 수 있어요.</div></div>`);
  }

  const all = regionList();
  const idx = all.findIndex(r => r.lawdCd === region.lawdCd);
  const sameSido = all.filter(r => r.lawdCd.slice(0, 2) === region.lawdCd.slice(0, 2) && r.lawdCd !== region.lawdCd);
  const near = (sameSido.length ? sameSido : all.filter((_, i) => i !== idx)).slice(0, 24);

  // REGION-DEEPLINK-2026-09-28 (Plan 125): 앱 검색 조건 복원(restoreSearchFromUrl)이 읽는
  //   ?region=<광역> <세부> — 라벨은 /api/region/menu 와 같은 함수.
  const { menuEntryForLawd } = require('./region');
  const menuEntry = menuEntryForLawd(region.lawdCd);
  const ctaHref = menuEntry ? `${ORIGIN}/?region=${encodeURIComponent(`${menuEntry.wide} ${menuEntry.label}`)}` : `${ORIGIN}/`;

  const body = `<div class="eyebrow">MYHOMELOG REGION</div>
    <h1>${esc(label)} 아파트 실거래 데이터</h1>
    <div class="tag">국토교통부 실거래 신고 자료 정리</div>
    ${cards.length ? cards.join('') : '<div class="card"><h2>준비 중</h2><div style="font-size:12px;color:var(--ink3)">이 지역의 공식 통계를 아직 불러오지 못했어요.</div></div>'}
    <div class="card"><h2>주변 지역</h2><div class="links">${near.map(r => `<a href="/region/${esc(r.lawdCd)}">${esc(r.name)}</a>`).join('')}</div>
      <div style="margin-top:10px"><a href="/region">전국 ${all.length}개 시군구 전체 보기 →</a></div></div>
    <a class="cta" href="${ctaHref}">${esc(label)} 단지 찾아보기 →</a>`;

  const title = `${label} 아파트 실거래 데이터 — 거래량·가격지수·미분양 | 내집로그`;
  const desc = facts.length
    ? `${label} ${facts.slice(0, 3).join(' · ')}. 국토교통부·한국부동산원 공식 통계를 정리했어요. 매수 추천이 아니에요.`
    : `${label} 아파트 실거래 거래량·가격지수·미분양·인구 순이동을 공식 통계로 정리했어요. 매수 추천이 아니에요.`;

  // ⚠ CACHE-POISON-2026-08-29 의 교훈: **열화된 응답에는 긴 캐시를 붙이지 않는다.**
  //   카드가 하나도 없으면 원자료 조회가 통째로 실패한 상태다 — 그걸 하루 굳히면 장애가 하루가 된다.
  // STALE-PAGE-2026-09-06 (Plan 058): 카드가 있어도 rec.stale(최대 14일 된 스냅샷 — priceRecordsService
  //   가 재계산 실패 시 돌려주는 마지막 성공 스냅샷, sliceRegion 이 Plan 054 에서 그 표식을 보존하도록
  //   고쳤다)이면 그 숫자 자체가 낡은 것이다. cards.length 만 보면 이 열화를 못 잡고 6시간+SWR 24시간이
  //   그대로 굳는다 — "장애"가 아니라 "낡은 값을 정상처럼 보여주는 상태"가 하루 넘게 지속된다.
  const isStale = !!(rec && rec.stale);
  res.set('Cache-Control', (cards.length && !isStale)
    ? 'public, max-age=0, s-maxage=21600, stale-while-revalidate=86400'
    : 'no-store');
  res.type('html').send(pageShell({
    title, desc, canonical: `${ORIGIN}/region/${region.lawdCd}`, body,
    image: facts.length ? `${ORIGIN}/api/og/region/${region.lawdCd}` : null,
  }));
});

module.exports = router;
module.exports.loadRegionData = loadRegionData;   // OG 카드와 공유
module.exports.regionFacts = regionFacts;
