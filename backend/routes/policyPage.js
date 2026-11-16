'use strict';
/**
 * backend/routes/policyPage.js — /policy: 정부 발표로 바뀐 부동산 제도를 날짜순으로 정리한 서버 렌더 페이지.
 *
 * POLICY-CHANGES-1116 (plans/203): 앱 안의 "정책 변화" 화면(frontend/js/policy.js)과 같은 자료를 쓴다.
 *   자료 원본은 backend/data/policy-changes.json 하나다. DB 와 외부 API 를 부르지 않고, 응답은 CDN 이 하루 기억한다
 *   (자료는 배포로만 바뀐다). 서버 렌더 패턴은 dataSources.js 와 같다(공용 셸 없음, 테마 토큰만 공유).
 *   글은 자료 파일의 것만 내보낸다. 권하는 말과 전망은 쓰지 않는다.
 */
const express = require('express');
const { THEME_CSS, FONT_STACK, FONT_LINK } = require('./_ssrTheme');
const { escHtml: esc } = require('../utils/htmlEscape');
const DATA = require('../data/policy-changes.json');

const router = express.Router();
const ORIGIN = 'https://myhomelog.vercel.app';
const CATS = [['loan', '대출'], ['zone', '규제지역·토지거래허가'], ['tax', '세금'], ['supply', '청약·공급'], ['rent', '전월세']];
const STATUS_LABEL = { '시행': '시행', '예정': '예정', '안': '정부안', '계획': '계획', '종료': '끝남' };
const STATUS_CLASS = { '시행': 'on', '예정': 'soon', '안': 'soon', '계획': 'plan', '종료': 'end' };
const SRC_NAME = { 'www.korea.kr': '정책브리핑', 'www.fsc.go.kr': '금융위원회', 'www.law.go.kr': '국가법령정보센터' };
const dot = (d) => String(d || '').replace(/-/g, '.');
const catLabel = (c) => (CATS.find((x) => x[0] === c) || [])[1] || '';

function sorted() {
  return DATA.items.map((it, i) => ({ it, i })).sort((a, b) => (a.it.date < b.it.date ? 1 : a.it.date > b.it.date ? -1 : a.i - b.i)).map((x) => x.it);
}

function card(it) {
  const many = it.src.length > 1;
  const links = it.src.map((u) => {
    let host = ''; try { host = new URL(u).host; } catch (_) { host = ''; }
    return `<a href="${esc(u)}" rel="noopener" target="_blank">원문 보기${many && SRC_NAME[host] ? ' · ' + esc(SRC_NAME[host]) : ''} ↗</a>`;
  }).join('');
  const ba = it.before
    ? `<div class="ba"><div class="box before"><div class="lb">지금까지</div><div class="tx">${esc(it.before)}</div></div><div class="arrow" aria-hidden="true">→</div><div class="box after"><div class="lb">바뀐 뒤</div><div class="tx">${esc(it.after)}</div></div></div>`
    : `<div class="ba one"><div class="box after"><div class="lb">바뀐 뒤</div><div class="tx">${esc(it.after)}</div></div></div>`;
  return `<article class="card${it.status === '종료' ? ' ended' : ''}" id="p-${esc(it.date)}-${esc(it.cat)}">
    <div class="meta"><time datetime="${esc(it.date)}">${esc(dot(it.date))}</time><span>·</span><span>${esc(it.org)}</span><span class="chip">${esc(catLabel(it.cat))}</span><span class="chip st-${STATUS_CLASS[it.status] || 'on'}">${esc(STATUS_LABEL[it.status] || it.status)}</span></div>
    <h3>${esc(it.title)}</h3>
    ${it.status === '안' ? '<div class="draft">아직 확정되지 않았어요</div>' : ''}
    ${ba}
    <dl><div><dt>누구에게</dt><dd>${esc(it.who)}</dd></div>${it.effective ? `<div><dt>시행</dt><dd>${esc(dot(it.effective))}</dd></div>` : ''}</dl>
    ${it.note ? `<p class="note">${esc(it.note)}</p>` : ''}
    <div class="cfoot"><span class="srcs">${links}</span><span class="chk">확인 ${esc(dot(DATA.checked))}</span></div>
  </article>`;
}

function page() {
  const items = sorted();
  let body = '', year = '';
  for (const it of items) {
    const y = it.date.slice(0, 4);
    if (y !== year) { body += `<h2 class="year" id="y${esc(y)}">${esc(y)}</h2>`; year = y; }
    body += card(it);
  }
  const nav = CATS.map(([k, label]) => `<a href="#c-${k}">${esc(label)} ${items.filter((x) => x.cat === k).length}건</a>`).join('');
  // 분류로 바로 가기: 분류마다 가장 최근 항목 앞에 닻을 둔다
  for (const [k] of CATS) {
    const first = items.find((x) => x.cat === k);
    if (first) body = body.replace(`id="p-${esc(first.date)}-${esc(k)}"`, `id="c-${k}"`);
  }
  const title = '부동산 정책 변화 한눈에 보기 | 내집로그';
  const desc = '2025년부터 정부 발표로 바뀐 대출, 규제지역, 세금, 청약, 전월세 제도를 날짜순으로 정리했어요. 바뀌기 전과 바뀐 뒤, 원문 링크를 함께 볼 수 있어요.';
  const ld = { '@context': 'https://schema.org', '@type': 'Article', headline: '부동산 정책 변화 한눈에 보기', dateModified: DATA.checked, inLanguage: 'ko', publisher: { '@type': 'Organization', name: '내집로그' }, mainEntityOfPage: `${ORIGIN}/policy` };
  return `<!DOCTYPE html><html lang="ko"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${ORIGIN}/policy">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${ORIGIN}/policy">
<meta property="og:type" content="article">
<meta property="og:image" content="${ORIGIN}/og.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="robots" content="index, follow">
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>
${FONT_LINK}
<style>
  ${THEME_CSS}
  *{box-sizing:border-box;margin:0}
  body{background:var(--bg);color:var(--ink);font-family:${FONT_STACK};line-height:1.6}
  .top{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 20px;background:var(--sf);border-bottom:1px solid var(--line)}
  .top b{font-size:17px;color:var(--pri)}
  .cta{display:inline-block;padding:10px 16px;background:var(--pri);color:var(--onpri);border-radius:9px;font-weight:700;font-size:14px;text-decoration:none}
  main{max-width:860px;margin:0 auto;padding:28px 16px 40px}
  h1{font-size:28px;letter-spacing:-.02em;margin-bottom:6px}
  .tag{color:var(--ink2);font-size:15px;margin-bottom:16px}
  nav.cats{display:flex;gap:16px;flex-wrap:wrap;padding:12px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin-bottom:8px}
  nav.cats a{color:var(--pri);font-weight:700;font-size:14px;text-decoration:none;padding:6px 0}
  h2.year{font-size:22px;margin:26px 0 12px}
  .card{background:var(--sf);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-bottom:14px;scroll-margin-top:12px}
  .card.ended{opacity:.6}
  .meta{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:13px;color:var(--ink2)}
  .chip{font-size:12px;border-radius:6px;padding:2px 8px;background:var(--bg);color:var(--ink)}
  .st-on{background:var(--pri);color:var(--onpri);font-weight:700}
  .st-soon{background:transparent;border:1px solid var(--pri);color:var(--pri);font-weight:700}
  .st-plan{background:transparent;border:1px solid var(--line);color:var(--ink2)}
  .st-end{color:var(--ink3)}
  h3{font-size:18px;margin:8px 0 12px;line-height:1.4}
  .draft{font-size:13px;font-weight:700;color:var(--pri);border:1px solid var(--pri);border-radius:8px;padding:8px 12px;margin-bottom:10px}
  .ba{display:grid;grid-template-columns:1fr 28px 1fr;gap:8px}
  .ba.one{grid-template-columns:1fr}
  .box{border-radius:10px;padding:12px 14px;min-width:0}
  .before{background:var(--bg)}
  .after{background:color-mix(in srgb,var(--pri) 10%,var(--sf))}
  .lb{font-size:12px;color:var(--ink3);margin-bottom:4px}
  .tx{font-size:15px;color:var(--ink2);word-break:keep-all;overflow-wrap:anywhere}
  .after .tx{color:var(--ink);font-weight:700}
  .arrow{display:flex;align-items:center;justify-content:center;color:var(--ink3)}
  dl{margin-top:12px;display:grid;gap:4px}
  dl>div{display:grid;grid-template-columns:64px 1fr;gap:8px;font-size:14px}
  dt{color:var(--ink3)}
  .note{font-size:13px;color:var(--ink3);margin-top:10px}
  .cfoot{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}
  .srcs{display:flex;gap:18px;flex-wrap:wrap}
  .srcs a{color:var(--pri);font-weight:700;font-size:14px;text-decoration:none;padding:6px 0}
  .chk{font-size:13px;color:var(--ink3)}
  .foot{color:var(--ink3);font-size:13px;margin-top:22px;padding-top:16px;border-top:1px solid var(--line);line-height:1.8}
  .foot a{color:var(--pri)}
  @media(max-width:700px){h1{font-size:23px}.ba{grid-template-columns:1fr}.arrow{transform:rotate(90deg);height:20px}.card{padding:16px}}
</style></head><body>
<div class="top"><b>내집로그</b><a class="cta" href="${ORIGIN}/">지도에서 단지 찾기</a></div>
<main>
<h1>부동산 정책 변화 한눈에 보기</h1>
<p class="tag">2025년부터 정부 발표로 바뀐 대출, 규제지역, 세금, 청약, 전월세 제도를 날짜순으로 정리했어요</p>
<nav class="cats" aria-label="분류로 바로 가기">${nav}</nav>
${body}
<div class="foot">참고용 정리예요. 실제 적용은 원문과 담당 기관에서 꼭 확인하세요. <strong>매수·매도 추천이 아니에요.</strong><br>
출처: 정책브리핑, 금융위원회, 국가법령정보센터 · 원문 확인 ${esc(dot(DATA.checked))} · ${items.length}건<br>
© 내집로그 · <a href="${ORIGIN}/?view=policy">앱에서 분류별로 보기</a> · <a href="${ORIGIN}/data-sources">데이터 출처</a></div>
</main></body></html>`;
}

let _html = null; // 자료는 배포로만 바뀌므로 인스턴스마다 한 번만 만든다
router.get('/', (req, res) => {
  if (!_html) _html = page();
  res.set('Cache-Control', 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800');
  return res.type('html').send(_html);
});

module.exports = router;
module.exports._page = page;
