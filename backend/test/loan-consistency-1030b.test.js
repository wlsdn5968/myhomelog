/**
 * 2차 소비자 체험 점검(2026-10-30) 후속 — Plan 158.
 *  A 같은 단지 대출 숫자 3갈래(카드 4.01억 · 상세 4.05억 · 대출 계산 2.32억)
 *    ① 상세 머리도 카드와 같은 _cardMaxLoan ② 대출 계산으로 넘길 때 주택 보유·생애최초·지역 칩도 옮긴다
 *  B 금리가 세션 중 4% → 4.88% 로 바뀜 ③ /api/rates 는 값을 기다리고 성공만 엣지 캐시 ④ 화면은 시작 때 받아 다시 계산
 * 실행: cd backend && TZ=UTC node --test test/loan-consistency-1030b.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
const fnSrc = (name) => {
  let i = html.indexOf(`\nfunction ${name}(`);
  if (i < 0) { i = html.indexOf(`\nasync function ${name}(`); }
  assert.ok(i >= 0, `${name} 없음`);
  const rest = html.slice(i + 1);
  const m = rest.slice(1).search(/\n(?:function |const |let |\/\/ |async function )/);
  return rest.slice(0, m + 1);
};

test('① 상세 머리의 최대 대출은 목록 카드와 같은 함수(소득 기준 반영)', () => {
  assert.match(html, /\$\{p\.maxLoan\?` \| 최대 \$\{_escHtml\(_cardMaxLoan\(p\.maxLoan\)\)\}`:''\}/);
  assert.doesNotMatch(html, /\| 최대 \$\{_escHtml\(p\.maxLoan\)\}/);
});

function carry({ h, f, wide, lawdSide = '', regionSide = '서울', ctx, regLawds = ['11'] }) {
  const picked = {};
  // eslint-disable-next-line no-new-func
  const fn = new Function('env', `
    const document={getElementById:()=>null};
    const gct=(g)=>({'ch-h':env.h,'ch-f':env.f,'ch-r':env.wide})[g]||'';
    const _calcChip=(g,l)=>{env.picked[g]=l;};
    const getRegionLawdCd=()=>env.lawdSide; const getRegionForSearch=()=>env.regionSide;
    const isRegFront=(area,code)=>env.regLawds.some(p=>String(code||'').startsWith(p))||(!code&&/서울/.test(area));
    const dc=()=>{};
    ${fnSrc('_carrySidebarToCalc')}
    return _carrySidebarToCalc;`)({ h, f, wide, lawdSide, regionSide, regLawds, picked });
  fn(false, ctx);
  return picked;
}

test('② 대출 계산으로 넘길 때 주택 보유·생애최초·지역 칩도 같은 조건으로', () => {
  // 운영 실측 상황: 무주택·생애최초 예·서울 도봉구 단지 → 무주택·예·규제
  assert.deepEqual(carry({ h: '무주택', f: '예', wide: '서울', ctx: { area: '도봉구 도봉동', lawdCd: '11320' } }), { 'cc-h': '무주택', 'cc-f': '예', 'cc-r': '서울규제' });
  // 처분조건부 = 무주택 한도(대출 계산엔 칩이 없다)
  assert.equal(carry({ h: '1주택 (처분조건부)', f: '아니오', wide: '서울', ctx: { area: '', lawdCd: '11320' } })['cc-h'], '무주택');
  assert.equal(carry({ h: '1주택', f: '', wide: '서울', ctx: { area: '', lawdCd: '11320' } })['cc-h'], '1주택');
  // 생애최초를 고르지 않았으면 대출 계산 칩을 바꾸지 않는다
  assert.equal(carry({ h: '무주택', f: '', wide: '서울', ctx: { area: '', lawdCd: '11320' } })['cc-f'], undefined);
  // 지방(부산 26) 단지 → 지방, 경기 비규제 → 비규제
  assert.equal(carry({ h: '무주택', f: '예', wide: '지방', ctx: { area: '해운대구', lawdCd: '26350' } })['cc-r'], '지방');
  assert.equal(carry({ h: '무주택', f: '예', wide: '경기', ctx: { area: '평택시', lawdCd: '41220' } })['cc-r'], '비규제');
  // 단지에 시군구 코드가 없고 이름으로도 규제가 아니면 지역 칩을 단정하지 않는다
  assert.equal(carry({ h: '무주택', f: '예', wide: '경기', ctx: { area: '어딘가', lawdCd: '' } })['cc-r'], undefined);
  // 사이드바에서 열 때(ctx 없음): 사이드바 지역 기준
  assert.equal(carry({ h: '무주택', f: '예', wide: '지방', lawdSide: '', regionSide: '지방' })['cc-r'], '지방');
  // goCalcFromDetail 이 그 단지 정보를 넘긴다
  assert.match(fnSrc('goCalcFromDetail'), /_carrySidebarToCalc\(false,_d\?\{area:\[_d\.sigungu\|\|'',_d\.area\|\|''\]\.join\(' '\)\.trim\(\),lawdCd:_d\.lawdCd\|\|''\}:null\)/);
});

async function getRates(ecos, hf) {
  const set = (rel, exp) => {
    const p = require.resolve(rel);
    const saved = require.cache[p];
    require.cache[p] = { id: p, filename: p, loaded: true, exports: exp };
    return () => { if (saved) require.cache[p] = saved; else delete require.cache[p]; };
  };
  const undo = [
    set('../services/ecosService', { getEcosRates: async () => ecos }),
    set('../services/hfService', { getHfRates: async () => hf }),
  ];
  process.env.VERCEL = '1';
  const app = require('../server');
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, r));
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/rates`);
    return { cc: res.headers.get('cache-control'), body: await res.json() };
  } finally {
    await new Promise((r) => srv.close(r));
    undo.forEach((u) => u());
  }
}

test('③ /api/rates: 값을 기다려 돌려주고, 받았을 때만 엣지 캐시 — 빈 값은 캐시하지 않는다', async () => {
  const ok = await getRates({ mortgageRate: 4.88, mortgageRateMonth: '202609' }, null);
  assert.equal(ok.body.ecosRates.mortgageRate, 4.88);
  assert.match(ok.cc, /s-maxage=3600/);
  const none = await getRates(null, null);
  assert.deepEqual(none.body, { ecosRates: null, hfRates: null });
  assert.equal(none.cc, 'no-store');
});

test('④ 화면은 시작 때 /api/rates 를 받고, 금리가 바뀌면 대출 계산·목록 카드·갈아타기를 다시 계산', () => {
  assert.match(html, /if\(ok\) checkMolit\(\);\n\s*if\(ok\) loadRates\(\);/);
  const f = fnSrc('loadRates');
  assert.match(f, /fetch\(`\$\{CFG\.api\}\/rates`/);
  assert.match(f, /if\(window\._ecosMortgageRate===before\) return;/);
  assert.match(f, /dc\(\)/);
  assert.match(f, /renderListGrid\(\)/);
  assert.match(f, /_swpRender\(\)/);
});
