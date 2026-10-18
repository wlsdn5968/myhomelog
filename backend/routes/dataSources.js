'use strict';
/**
 * backend/routes/dataSources.js — /data-sources: 데이터 출처·갱신 주기·하지 않는 것을 한 페이지에.
 *
 * DATA-SOURCES-2026-10-19 (plans/167 §1-3): 출처 표기가 앱 띠·서버 페이지 푸터·README 에 흩어져 있고
 *   건수 문구("27만+")처럼 낡은 곳도 있었다. 이 페이지가 단일 출처이며, 갱신 주기는 vercel.json 의 cron 과 같은 값만 적는다.
 *   이용허락 유형(공공누리 등)은 저장소에 근거가 없어 적지 않는다 — 각 포털 이용조건을 따른다고만 밝힌다.
 *   서버 렌더 패턴은 regionPage.pageShell 과 같다(공용 셸 없음 — Plan 145 테마 토큰만 공유).
 */
const express = require('express');
const { THEME_CSS, FONT_STACK, FONT_LINK } = require('./_ssrTheme');
const { escHtml: esc } = require('../utils/htmlEscape');
const { fmtKst } = require('../utils/fmtKst');

const router = express.Router();
const ORIGIN = 'https://myhomelog.vercel.app';

// 갱신 주기는 vercel.json crons(UTC) 를 KST 로 옮긴 값. 바꾸면 backend/test/plan167-data-basis.test.js 가 대조한다.
const SOURCES = [
  { what: '아파트 매매 실거래가', who: '국토교통부', via: '공공데이터포털(apis.data.go.kr) 아파트 매매 실거래가 상세자료', url: 'https://www.data.go.kr', cycle: '매일 새벽 2시대(KST) 자동 수집 · 신고는 계약 뒤 30일 안이라 최근 거래가 늦게 반영될 수 있어요' },
  { what: '공동주택 기본 정보(세대수·동수·주차·관리방식)', who: '한국부동산원 K-apt', via: '공공데이터포털 공동주택 단지 목록·기본 정보', url: 'https://www.data.go.kr', cycle: '매주 월요일 새벽 5시(KST) 단지 목록 갱신 · 상세는 조회할 때 채우고 보강은 매일 새벽' },
  { what: '건축물대장(세대수 보조 확인)', who: '국토교통부', via: '공공데이터포털 건축HUB 건축물대장', url: 'https://www.data.go.kr', cycle: '조회할 때 · 비어 있는 단지는 매일 새벽 보강' },
  { what: '주택담보대출 규제(LTV·DSR 등)·취득세', who: '금융위원회 · 정책브리핑 · 국가법령정보', via: 'fsc.go.kr · korea.kr · law.go.kr 공고문', url: 'https://www.fsc.go.kr', cycle: '매일 새벽 6시대(KST) 변경 점검 · 변경이 확인되면 사람이 검토한 뒤 반영' },
  { what: '기준금리·시장금리', who: '한국은행 ECOS', via: 'ecos.bok.or.kr 통계 API', url: 'https://ecos.bok.or.kr', cycle: '조회할 때 갱신(캐시)' },
  { what: '정책 주택금융 금리', who: '한국주택금융공사', via: '공공데이터포털 공개 API', url: 'https://www.data.go.kr', cycle: '조회할 때 갱신(캐시)' },
  { what: '주택가격지수', who: '한국부동산원 R-ONE', via: 'reb.or.kr 공개 통계', url: 'https://www.reb.or.kr', cycle: '지역 페이지를 만들 때 조회' },
  { what: '미분양 주택 · 국내 인구이동', who: 'KOSIS(국가통계포털)', via: 'kosis.kr 공개 API', url: 'https://kosis.kr', cycle: '지역 페이지를 만들 때 조회' },
  { what: '단지 좌표 · 주변 시설(학원·편의시설)', who: '카카오', via: '카카오 로컬 API', url: 'https://developers.kakao.com', cycle: '조회할 때 · 좌표는 매일 새벽 보강' },
  { what: '학교 정보', who: '나이스 교육정보 개방 포털', via: 'open.neis.go.kr 학교 기본 정보', url: 'https://open.neis.go.kr', cycle: '조회할 때 갱신(캐시)' },
];

function pageShell({ title, desc, canonical, body }) {
  return `<!DOCTYPE html><html lang="ko"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:type" content="article">
<meta property="og:image" content="${ORIGIN}/og.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="robots" content="index, follow">
${FONT_LINK}
<style>
  ${THEME_CSS}
  *{box-sizing:border-box;margin:0}
  body{background:var(--bg);color:var(--ink);font-family:${FONT_STACK};line-height:1.7;padding:28px 16px}
  main{max-width:720px;margin:0 auto}
  .eyebrow{color:var(--pri);font-size:12px;font-weight:800;letter-spacing:2px}
  h1{font-size:26px;margin:4px 0 2px;letter-spacing:-.02em}
  .tag{color:var(--ink3);font-size:12px;margin-bottom:18px}
  .card{background:var(--sf);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:12px}
  .card h2{font-size:14px;color:var(--pri);margin-bottom:8px}
  .src{color:var(--ink3);font-size:12px}
  .item{padding:9px 0;border-bottom:1px dashed var(--line);font-size:14px}
  .item:last-child{border-bottom:none}
  .item b{display:block}
  .item .m{color:var(--ink2);font-size:12px}
  .item .c{color:var(--ink3);font-size:12px}
  a{color:var(--pri);text-decoration:none}
  .foot{color:var(--ink3);font-size:12px;margin-top:20px;line-height:1.8}
  .cta{display:inline-block;margin-top:14px;padding:10px 18px;background:var(--pri);color:var(--onpri);border-radius:9px;font-weight:700;font-size:14px}
</style></head><body><main>${body}
<div class="foot">공식 통계 수치를 정리한 정보예요. <strong>매수·매도 추천이 아니고</strong>, 미래 가격도 예측하지 않아요.<br>
© 내집로그 · <a href="${ORIGIN}/">myhomelog.vercel.app</a></div>
</main></body></html>`;
}

router.get('/', async (req, res) => {
  let sync = '';
  try {
    const { readDataCounts } = require('../services/healthCounts');
    const dc = await readDataCounts();
    sync = fmtKst(dc && dc.lastIngestedAt);
  } catch (_) { sync = ''; }

  const items = SOURCES.map((s) => `<div class="item"><b>${esc(s.what)}</b>
    <span class="m">${esc(s.who)} · ${esc(s.via)} · <a href="${esc(s.url)}" rel="noopener" target="_blank">${esc(s.url.replace(/^https?:\/\//, ''))}</a></span><br>
    <span class="c">갱신: ${esc(s.cycle)}</span></div>`).join('');

  const body = `<div class="eyebrow">MYHOMELOG DATA</div>
    <h1>데이터 출처와 갱신 주기</h1>
    <div class="tag">내집로그가 보여 주는 모든 숫자의 출처예요${sync ? ` · 실거래 마지막 수집 ${esc(sync)}(KST)` : ''}</div>
    <div class="card"><h2>원칙</h2>
      <div class="item">공식 출처의 값만 보여 주고, 값이 없으면 추정하지 않고 비워 둬요.</div>
      <div class="item">호가·매물·시세 예측은 다루지 않아요. 실거래 신고 자료만 정리해요.</div>
      <div class="item">공공데이터는 각 포털의 이용조건에 따라 원 출처를 표시하고 써요. 오류를 보시면 단지 상세의 "오류 신고"로 알려 주세요.</div>
    </div>
    <div class="card"><h2>출처별 안내 <span class="src">${SOURCES.length}개</span></h2>${items}</div>
    <a class="cta" href="${ORIGIN}/">내집로그로 돌아가기 →</a>`;

  res.set('Cache-Control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400');
  return res.type('html').send(pageShell({
    title: '데이터 출처와 갱신 주기 — 내집로그',
    desc: '국토교통부 실거래가·한국부동산원 공동주택 정보·금융위원회 규제 등 내집로그가 쓰는 공식 데이터의 출처와 갱신 주기예요.',
    canonical: `${ORIGIN}/data-sources`,
    body,
  }));
});

module.exports = router;
module.exports._SOURCES = SOURCES;
