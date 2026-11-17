/**
 * SPLIT-1117 (plans/202 2단계): 화면을 읽지 않는 계산 함수 여섯 개를 frontend/js/calc.js 로 옮겼다.
 *  옮기기만 했다. 값이 같은지는 기존 검사(regulation-tax, report, recommend, cap-metro-1116, audit-report-1114)가 본다.
 *  여기서는 나눈 구조가 깨지지 않는지만 본다.
 * 실행: cd backend && TZ=UTC node --test test/split-1117.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readIndexHtml, readFrontendJs } = require('../testSupport/readFrontend');

const html = readIndexHtml();
const js = readFrontendJs('calc.js');
const NAMES = ['_pickTierRate', '_pickTierRateUnder', 'computePolicyLoan', '_loanBaseRate', 'calcLoanLimitsPure', 'calcInputProblem'];

test('calc.js 는 본체와 다른 나눈 파일보다 먼저 부르는 일반 스크립트다', () => {
  const tag = '<script src="/js/calc.js"></script>';
  assert.equal(html.split(tag).length - 1, 1);
  assert.ok(html.indexOf(tag) < html.indexOf('<script src="/js/swap-checklist.js"></script>'), '갈아타기 계산이 _loanBaseRate 를 쓴다');
  assert.ok(!/<script[^>]*(type=["']module["']|defer|async)[^>]*calc\.js/.test(html));
});

test('옮긴 함수는 calc.js 에 한 번씩만 있고 본체에는 없다', () => {
  for (const n of NAMES) {
    assert.equal(js.split(`\nfunction ${n}(`).length - 1, 1, `${n} 가 calc.js 에 한 번 있어야 한다`);
    assert.ok(!html.includes(`function ${n}(`), `${n} 가 본체에 남아 있다(두 벌이 되면 뒤의 것이 이긴다)`);
  }
});

test('calc.js 는 본체 없이 실행되고, 화면 요소를 읽지 않는다', () => {
  assert.ok(!/document\.|getElementById|querySelector/.test(js), '화면을 읽는 코드는 본체에 둔다');
  const sandbox = { window: {} };
  assert.doesNotThrow(() => vm.runInNewContext(js, sandbox, { filename: 'calc.js' }));
  for (const n of NAMES) assert.equal(typeof sandbox[n], 'function', n);
  // 경계 뜻이 서로 다르다: 취득세는 이하, 중개보수는 미만
  const tiers = [{ underAuk: 6, rate: 0.01 }, { underAuk: 9, rate: 0.02 }];
  assert.equal(sandbox._pickTierRate(tiers, 6, 0.03), 0.01);
  assert.equal(sandbox._pickTierRateUnder(tiers, 6, 0.03), 0.02);
  assert.equal(sandbox._loanBaseRate(), 0.04, '시중 금리를 못 받았으면 4%');
  assert.equal(sandbox.calcInputProblem({ buy: 5, inc: 5000, ratePct: 4, yrs: 30, ex: 0, cash: 1, cl: 0, jl: 0 }), '');
  assert.notEqual(sandbox.calcInputProblem({ buy: -1 }), '');
});

test('파일을 못 받았을 때 한 번 알린다', () => {
  assert.ok(html.includes("if(typeof calcLoanLimitsPure!=='function'&&!window._calcMissSent){window._calcMissSent=true;try{toast('화면 일부를 불러오지 못했어요. 새로 고침해 주세요');"));
});

// SPLIT-1117b (plans/202 3단계): 단지 상세 안에 있던 보유세와 취득세 계산, 평 환산을 함수로 뽑았다.
//   기준 값은 뽑기 전 코드를 그대로 실행한 결과다(2026-11-17, 2,288건 대조에서 새 함수와 같았다).
test('calcHoldingTaxes: 뽑기 전 계산과 같은 값을 낸다', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(js + '\nthis.calcHoldingTaxes=calcHoldingTaxes;this._sqmToPy=_sqmToPy;this.PY=PYEONG_M2;', sandbox);
  const f = sandbox.calcHoldingTaxes;
  const same = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));
  same(f(12.5, true), { official: 8.75, propTaxW: 147, compTax1H: 0, compTax2H: 0, compTax3H: 0, acqTax1H: 3750, acqTax2H: 10000, acqTax3H: 15000 });
  same(f(7.5, false), { official: 5.25, propTaxW: 63, compTax1H: 0, compTax2H: 0, compTax3H: 0, acqTax1H: 1500, acqTax2H: 1500, acqTax3H: 6000 });
  same(f(30, true), { official: 21, propTaxW: 441, compTax1H: 318, compTax2H: 480, compTax3H: 480, acqTax1H: 9000, acqTax2H: 24000, acqTax3H: 36000 });
  assert.equal(f(6, false).acqTax1H, 600, '6억 이하는 1%');
  assert.equal(sandbox.PY, 3.3058);
  assert.equal(sandbox._sqmToPy(84.97), 26);
  assert.equal(sandbox._sqmToPy(59.9), 18);
});

test('본체는 뽑은 함수를 부르고 숫자를 따로 적지 않는다', () => {
  assert.equal(html.split('calcHoldingTaxes(market, _acqIsReg)').length - 1, 1);
  assert.ok(html.includes('const _acqIsReg = (p.area && typeof isRegFront === \'function\') ? isRegFront(p.area, p.lawdCd) : true;'), '조정대상지역 판정은 단지 상세에 그대로 있다');
  assert.ok(!/[/*] ?3\.3058\)/.test(html) && !html.includes('_PC_PY=3.3058'), '평 환산 숫자는 calc.js 한 곳에만 둔다');
  assert.equal(js.split('3.3058').length - 1, 2, 'calc.js 에는 설명 한 번과 값 한 번');
  assert.equal(require('../utils/pyeong').PYEONG_M2, 3.3058, '서버와 같은 값');
});
