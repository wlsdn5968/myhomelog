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
