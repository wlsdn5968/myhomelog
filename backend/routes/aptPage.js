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
  const region = regionLabel(lawdCd, (idx && idx.sigungu) || (txs && txs[0] && txs[0].sigungu) || '');
  const aptName = (idx && idx.apt_name) || (txs && txs[0] && txs[0].aptName) || '';
  const umd = (idx && idx.umd_nm) || (txs && txs[0] && txs[0].umdNm) || '';
  const buildYear = num(idx && idx.build_year) || num(txs && txs[0] && txs[0].buildYear);
  // analyzeTransactions 는 aptName|lawdCd|umdNm 로 묶는다 — apt_seq 한 건만 넣었으니 그룹은 1개다.
  const stat = (txs && txs.length) ? (svc.analyzeTransactions(txs) || [])[0] : null;
  return { idx, txs, lawdCd, region, aptName, umd, buildYear, stat };
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

  const { txs, lawdCd, region, aptName, umd, buildYear, stat } = af;

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

  const body = `<div class="eyebrow">MYHOMELOG APT</div>
    <h1>${esc(aptName)} 실거래가</h1>
    <div class="tag">${esc(region)}${umd ? ' ' + esc(umd) : ''} · 단지코드 ${esc(seq)}</div>
    ${cards.length ? cards.join('') : `<div class="card"><h2>최근 거래 없음</h2>
      <div style="font-size:12.5px;color:var(--sub)">최근 24개월 안에 신고된 거래가 없어요. 값을 지어내지 않고 비워둡니다.</div></div>`}
    <div class="card"><h2>이 지역 더 보기</h2>
      <div class="links">${lawdCd ? `<a href="/region/${esc(lawdCd)}">${esc(region)} 지역 데이터</a>` : ''}<a href="/region">전국 시군구 전체</a></div>
    </div>
    <a class="cta" href="${ORIGIN}/">${esc(aptName)} 대출 한도·비용 계산 →</a>`;

  const title = `${aptName} 실거래가 — ${region}${umd ? ' ' + umd : ''} | 내집로그`;
  const desc = facts.length
    ? `${aptName}(${region}${umd ? ' ' + umd : ''}) ${facts.join(' · ')}. 국토교통부 실거래 신고 자료 정리 — 매수 추천이 아닙니다.`
    : `${aptName}(${region}${umd ? ' ' + umd : ''}) 국토교통부 실거래 신고 자료. 최근 24개월 거래 기록이 없습니다.`;

  // 거래가 없으면 색인시키지 않는다 — 얇은 페이지를 대량으로 색인시키면 사이트 전체 평가에 해롭다.
  // ⚠ CACHE-POISON-2026-08-29 의 교훈: 열화 상태(카드 0)에 긴 캐시를 붙이지 않는다.
  const thin = !cards.length;
  res.set('Cache-Control', thin ? 'no-store' : 'public, max-age=0, s-maxage=21600, stale-while-revalidate=86400');
  res.type('html').send(pageShell({ title, desc, canonical: `${ORIGIN}/apt/${seq}`, body, noindex: thin,
    // 얇은 페이지(거래 0)는 카드에 쓸 숫자가 없으므로 기본 이미지를 유지한다.
    image: thin ? null : `${ORIGIN}/api/og/apt/${encodeURIComponent(seq)}` }));
});

module.exports = router;
// 링크 미리보기 이미지 라우트가 같은 사실을 쓰도록 함께 내보낸다 (APT-FACTS-SSOT-2026-09-02)
module.exports.loadAptFacts = loadAptFacts;
