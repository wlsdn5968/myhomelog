/**
 * SWAP-HELPER-2026-10-30 (Plan 155): 갈아타기 계산(#view-swap).
 *  ① 시안 예시 숫자 = 앱 계산식(calcLTV 처분조건부) ② 파는 쪽 중개보수 = 시행규칙 별표 1 매매 상한(복비 계산기와 같은 표)
 *  ③ 기한(금융위 FAQ 6개월 · 소득세법 시행령 §155 3년/2년) ④ 가격을 지어내지 않는다 ⑤ 화면 연결
 * 실행: cd backend && TZ=UTC node --test test/swap-helper.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
const fnSrc = (name) => {
  const i = html.indexOf(`\nfunction ${name}(`);
  assert.ok(i >= 0, `${name} 없음`);
  const rest = html.slice(i + 1);
  const m = rest.slice(1).search(/\n(?:function |const |let |\/\/ )/);
  return rest.slice(0, m + 1);
};
const NAMES = ['_loanBaseRate', 'calcLTV', '_swpComm', '_swpWon', '_swpAddMonths', '_swpFmtFull', '_swpCalc', '_dclParse', '_swpDeadlines', '_dclDiff'];
// 규제 판정은 실제 함수 대신 고정 — 이 테스트는 계산 배선을 본다(규제 판정 자체는 regulation 테스트들이 고정)
// eslint-disable-next-line no-new-func
const F = new Function('window', `const isRegFront=(r,c)=>String(c||'').startsWith('11')||/서울/.test(r);\n${NAMES.map(fnSrc).join('\n')}\nreturn {${NAMES.join(',')}};`)({ _ecosMortgageRate: null });

test('① 시안 예시: 8.5억 매도·대출 2억·현금 0.5억 / 서울 마포구 12억·연소득 9,000만 → 쓸 수 있는 돈 6억 9,660만, 대출 4억 5,100만, 부족 5,240만', () => {
  const s = { sell: '8.5', debt: '2', cgt: '', cash: '0.5', buy: '12', inc: '9000', wide: '서울', sgg: '마포구', lawd: '11440', use: 'y' };
  const c = F._swpCalc(s);
  assert.equal(c.comm, 0.034);
  assert.equal(F._swpWon(c.avail), '6억 9,660만');
  assert.equal(c.ltv, 0.4);
  assert.equal(F._swpWon(c.lL), '4억 8,000만');
  assert.equal(c.cap, 6);
  assert.equal(c.dL, 4.51);
  assert.equal(c.fin, 4.51);
  assert.equal(c.by, 'inc');
  assert.equal(c.mo, 215);
  assert.equal(F._swpWon(c.gap), '5,240만');
  // 판 돈을 아직 못 쓰면 가진 현금만 → 부족 6억 9,900만
  const n = F._swpCalc({ ...s, use: 'n' });
  assert.equal(F._swpWon(n.avail), '5,000만');
  assert.equal(F._swpWon(n.gap), '6억 9,900만');
  // 양도세(만 원) 입력은 쓸 수 있는 돈에서 뺀다
  assert.equal(F._swpWon(F._swpCalc({ ...s, cgt: '1000' }).avail), '6억 8,660만');
});

test('② 파는 쪽 중개보수: 별표 1 매매 상한요율·한도액, 구간은 이상~미만 — 복비 계산기 표와 같은 값', () => {
  const won = (e) => Math.round(F._swpComm(e) * 10000); // 만 원
  assert.equal(won(0.4), 24);   // 4천만 × 0.6% = 24
  assert.equal(won(0.49), 25);  // 29.4 → 한도 25
  assert.equal(won(0.5), 25);   // 5천만부터 0.5% → 25
  assert.equal(won(1.99), 80);  // 99.5 → 한도 80
  assert.equal(won(2), 80);     // 2억부터 0.4%
  assert.equal(won(8.5), 340);
  assert.equal(won(9), 450);    // 9억부터 0.5%
  assert.equal(won(12), 720);   // 12억부터 0.6%
  assert.equal(won(15), 1050);  // 15억부터 0.7%
  assert.equal(F._swpComm(0), 0);
  // 복비 계산기(calcComm) 매매 표와 숫자가 같다
  const i = html.indexOf('function calcComm(');
  const body = html.slice(i, html.indexOf('\n}', i));
  for (const t of ['rate:0.006,cap:25', 'rate:0.005,cap:80', 'max:90000,rate:0.004', 'max:120000,rate:0.005', 'max:150000,rate:0.006', 'max:Infinity,rate:0.007']) {
    assert.ok(body.includes(t), `calcComm 매매 표에 ${t} 없음 — 두 표가 갈렸다`);
  }
});

test('③ 기한: 잔금 2027-01-29 → 처분 2027-07-29, 일시적 2주택 2030-01-29(둘 다 조정 2029-01-29), 없는 날은 그 달 말일', () => {
  const d = F._swpDeadlines('2027-01-29');
  assert.equal(F._swpFmtFull(d.dispose), '2027년 7월 29일');
  assert.equal(F._swpFmtFull(d.tmp3), '2030년 1월 29일');
  assert.equal(F._swpFmtFull(d.tmp2), '2029년 1월 29일');
  assert.equal(F._dclDiff(d.dispose, F._dclParse('2026-10-30')), 272);
  assert.equal(F._swpFmtFull(F._swpDeadlines('2026-08-31').dispose), '2027년 2월 28일');
  assert.equal(F._swpFmtFull(F._swpDeadlines('2028-02-29').tmp3), '2031년 2월 28일');
  assert.equal(F._swpDeadlines(''), null);
});

test('④ 가격을 지어내지 않는다: 참고값은 상세 거래의 대표 평형에서만, 팔 가격은 사용자가 넣거나 버튼으로만', () => {
  const g = fnSrc('goSwapFromCurrentDetail');
  assert.match(g, /const rep=_repAreaOf\(tx\);/);
  assert.match(g, /const ref=prices\.length\?\{/);
  assert.match(g, /s\.sell='';/, '단지를 바꾸면 이전 팔 가격을 지운다');
  assert.match(fnSrc('_swpFillAvg'), /실제 팔 가격과 다를 수 있어요/);
  // 사는 비용은 계산하지 않고 '빼기 전'이라고 밝힌다
  assert.match(html, /사는 비용\(취득세·중개보수 등\)은 빼기 전이에요\./);
  // 대출 계산으로 넘길 때 처분조건부 = 무주택 한도(금융위 FAQ)
  assert.match(fnSrc('_swpToCalc'), /pick\('cc-h','무주택'\)/);
  assert.match(html, /두 집 모두 조정대상지역이면 2년\(\$\{_swpFmtFull\(dl\.tmp2\)\}\)이에요\. 2026년 10월 1일 시행 기준이고, 적용 시점은 세무서와 확인해요\./);
});

test('⑤ 화면 연결: 뷰 등록·도구 메뉴·도구 시트·단지 상세 다음에 할 일·calcLTV 시군구 코드', () => {
  assert.match(html, /<div class="biz-view" id="view-swap">/);
  assert.match(html, /swap: {2}\{display:'flex', lp:false, rp:false\}/);
  assert.match(html, /<button class="htab" onclick="sv\('swap',this\)">/);
  assert.match(html, /class="ts-item" data-tool="swap"/);
  assert.equal((html.match(/\['clause','subs','calc','biz','deal','swap','guide'\]\.includes\(v\)/g) || []).length, 2);
  assert.match(html, /if\(v==='swap'\)\{try\{_swpRender\(\);\}catch\(_\)\{\}\}/);
  assert.match(html, /k:'swap', tier:'txt', l:'지금 집으로 갈아타기 계산', oc:'goSwapFromCurrentDetail\(\)'/);
  assert.match(html, /function calcLTV\(buy,cash,inc,mo,house,isF,region,lawdCd\)\{/);
  assert.match(html, /const isR=isRegFront\(region,lawdCd\)/);
  assert.match(html, /'view-deal','view-swap',/);
  // 일시적 2주택 취득세: 지방세법 §13조의2 ①2호(일시적 2주택은 중과 제외)·시행령 §28조의5 — law.go.kr 원문 확인
  assert.match(html, /새 집 취득세도 같은 기간 안에 지금 집을 팔면 2주택 중과 대신 기본세율이에요\./);
  assert.match(html, /\['지방세법 제13조의2',law\('지방세법','제13조의2'\)\],\['지방세법 시행령 제28조의5',law\('지방세법시행령','제28조의5'\)\]/);
  // 리뷰 반영: 손상된 저장값·참고값, 연도 입력 중 값, 지역 메뉴 도착 뒤 재판정, 핵심 숫자만 읽어 주기
  assert.match(fnSrc('_swpLoad'), /!Array\.isArray\(o\)/);
  assert.match(fnSrc('_swpRender'), /\['min','avg','max','n'\]\.every\(k=>Number\.isFinite\(a\.ref\[k\]\)\)/);
  assert.equal(F._dclParse('0002-01-29'), null);
  assert.equal(F._swpDeadlines('0002-01-29'), null);
  assert.match(html, /REGION_MENU = next; _regionMenuLoaded = true;\n\s*try\{const sw=document\.getElementById\('view-swap'\)[^\n]*_swpRender\(\)/);
  assert.match(html, /<div class="swp-out" id="swpOut"><\/div>\n\s*<p class="swp-live" id="swpLive" aria-live="polite"><\/p>/);
});
