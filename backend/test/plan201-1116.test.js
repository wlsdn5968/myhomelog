/**
 * backend/test/plan201-1116.test.js
 *
 * plans/201 (2026-11-16 운영자 승인 "권고대로") 가운데 시안이 필요 없는 두 가지.
 *   BUDGET-FIND      도우미가 예산 질문을 받으면 목록 화면으로 넘기는 단추를 준다(직접 단지를 골라 답하지 않는다)
 *   CMP-BAR-SCOPE    비교 담기 막대는 목록과 지도 화면에서만 보인다
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const html = read('../../frontend/index.html');
const { classifyIntent, route } = require('../services/chatDataRouter');

function fnSrc(name) {
  const a = html.indexOf(`function ${name}(`);
  assert.ok(a > 0, `${name} 를 찾지 못했다`);
  let i = html.indexOf('{', html.indexOf(')', a)), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(a, i + 1); }
  }
  throw new Error(`${name} 의 끝을 찾지 못했다`);
}

test('도우미: 예산 질문은 budgetFind 로 잡고 금액과 광역 지역을 뽑는다. 대출, 시세, 전세 질문은 그대로다', () => {
  assert.deepEqual(classifyIntent('9억으로 서울에서 살 수 있는 아파트 알려줘'), { intent: 'budgetFind', budget: 9, region: '서울' });
  assert.deepEqual(classifyIntent('예산 6.5억 경기'), { intent: 'budgetFind', budget: 6.5, region: '경기' });
  assert.deepEqual(classifyIntent('강남 30억 살만한 단지'), { intent: 'budgetFind', budget: 30, region: null });
  assert.deepEqual(classifyIntent('9999억으로 살 수 있는 곳'), { intent: 'budgetFind', budget: null, region: null }, '범위를 벗어난 금액은 넘기지 않는다');
  assert.equal(classifyIntent('5억이면 대출 얼마까지 돼?').intent, 'loanLimit');
  assert.equal(classifyIntent('5억 대출 한도').intent, 'loanLimit');
  assert.equal(classifyIntent('은마 시세').intent, 'market');
  assert.equal(classifyIntent('9억 아파트 가격').intent, 'market');
  assert.equal(classifyIntent('3억 전세').intent, 'jeonse');
  assert.equal(classifyIntent('노원구 인기단지').intent, 'popular');
});

test('도우미: 예산 질문의 답은 목록으로 넘기는 단추를 주고, 단지를 직접 고르지 않으며 면책 문장을 붙인다', async () => {
  const r = await route('9억으로 서울에서 살 수 있는 아파트 알려줘', {});
  assert.equal(r.intent, 'budgetFind');
  assert.deepEqual(r.suggestions[0], { label: '9억, 서울 조건으로 목록에서 찾기', view: 'list', budget: 9, region: '서울' });
  assert.equal(r.suggestions[1], '9억이면 대출 얼마까지 돼?');
  assert.equal(classifyIntent(r.suggestions[1]).intent, 'loanLimit', '칩 문구는 실제로 답이 나오는 질문이어야 한다');
  assert.match(r.reply, /예산으로 단지를 고르는 일은 목록 화면에서 할 수 있어요\./);
  assert.match(r.reply, /매물 추천은 하지 않고/);
  assert.match(r.reply, /매수·매도 추천이 아니에요/);
  assert.doesNotMatch(r.reply, /[—–→]/);
  const r2 = await route('10억으로 갈 수 있는 곳', {});
  assert.deepEqual(r2.suggestions[0], { label: '10억 조건으로 목록에서 찾기', view: 'list', budget: 10 }, '지역을 말하지 않으면 지역은 넘기지 않는다');
});

test('도우미: 서버는 목록 이동 칩의 예산과 지역을 숫자 범위와 허용 목록으로 거른다', () => {
  const s = read('../routes/chat.js');
  const a = s.indexOf('const sug = Array.isArray(suggestions)');
  const b = s.indexOf("return res.json({ reply, intent, suggestions: sug, source: 'data-router' });");
  assert.ok(a > 0 && b > a);
  const run = (suggestions) => new Function('suggestions', `const ALLOWED_VIEWS = new Set(['report', 'calc', 'clause', 'map', 'list']); ${s.slice(a, b)} return sug;`)(suggestions);
  assert.deepEqual(run([{ label: '9억, 서울 조건으로 목록에서 찾기', view: 'list', budget: 9, region: '서울' }]), [{ label: '9억, 서울 조건으로 목록에서 찾기', view: 'list', budget: 9, region: '서울' }]);
  assert.deepEqual(run([{ label: '목록에서 찾기', view: 'list', budget: 99999, region: '<b>' }]), [{ label: '목록에서 찾기', view: 'list' }], '범위 밖 금액과 허용되지 않은 지역은 버린다');
  assert.deepEqual(run([{ label: '대출 계산 열기', view: 'calc', budget: 9, region: '서울' }]), [{ label: '대출 계산 열기', view: 'calc' }], '목록 이동이 아니면 싣지 않는다');
  assert.deepEqual(run([{ label: '어디로', view: 'admin', budget: 9 }]), [], '허용되지 않은 화면');
});

test('도우미 화면: 목록 이동 칩에 예산이나 지역이 있으면 조건을 채워 찾고, 없으면 화면만 옮긴다', () => {
  assert.ok(html.includes("if (s.view === 'list' && (s.budget || s.region)) _chatBudgetSearch(s.budget, s.region); else VIEW_ACTS[s.view]();"));
  const mkChip = (t, on) => ({ textContent: t, _on: on, classList: { toggle(_c, v) { this._p._on = v; }, remove() { this._p._on = false; } } });
  const run = (budget, region) => {
    const bp = { value: '' }; const log = [];
    const chips = ['서울', '경기', '인천', '지방'].map((t) => { const c = mkChip(t, t === '경기'); c.classList._p = c; return c; });
    const sub = [mkChip('수원시', true)]; sub[0].classList._p = sub[0];
    const env = {
      document: { getElementById: (id) => (id === 'bp' ? bp : null), querySelectorAll: (q) => (q === '#ch-r .chip' ? chips : q === '#ch-r-sub .chip.on' ? sub.filter((c) => c._on) : []) },
      cl: () => log.push('cl'), sv: (v) => log.push('sv:' + v), doSearch: () => log.push('search'), setTimeout: (f) => f(),
    };
    new Function('env', 'budget', 'region', `with(env){ ${fnSrc('_chatBudgetSearch')}; _chatBudgetSearch(budget, region); }`)(env, budget, region);
    return { bp: bp.value, on: chips.filter((c) => c._on).map((c) => c.textContent), sub: sub[0]._on, log };
  };
  assert.deepEqual(run(9, '서울'), { bp: 9, on: ['서울'], sub: false, log: ['cl', 'sv:list', 'search'] });
  assert.deepEqual(run(9, undefined), { bp: 9, on: ['경기'], sub: true, log: ['cl', 'sv:list', 'search'] }, '지역이 없으면 고른 지역을 그대로 둔다');
  assert.deepEqual(run(99999, '지방'), { bp: '', on: ['경기'], sub: true, log: ['cl', 'sv:list', 'search'] }, '범위 밖 금액과 허용되지 않은 지역은 채우지 않는다');
});

test('비교 담기 막대: 목록과 지도 화면에서만 보이고, 다른 화면에서는 숨긴다(담은 단지는 그대로)', () => {
  assert.ok(html.includes("try{ document.body.classList.toggle('cmp-off', !(v === 'list' || v === 'map')); }catch(_){}"));
  assert.ok(html.includes('body.cmp-off .cmp-bar{display:none!important}'));
  const sv = fnSrc('sv');
  assert.ok(sv.indexOf("classList.toggle('cmp-off'") > 0, '화면 전환 함수 안에서 건다');
  assert.ok(!/cmp-off[\s\S]{0,200}cmpSel\.clear\(\)/.test(sv), '숨길 때 담은 단지를 비우지 않는다');
});

// ── SIGNAL-COPY-1116 (plans/201 4번): 가격 신호 탭의 말을 쉬운 말로. 계산과 색은 그대로 ──
test('가격 신호 문구: 무엇을 센 것인지 밝히고, 어려운 말(데이터 부합, 성수기 영향 감쇄, RR, 신뢰 구간)을 쓰지 않는다', () => {
  assert.ok(html.includes('가지 기준 가운데 ${sig.metCount||0}가지에 해당해요'));
  assert.ok(html.includes('기준은 세 가지예요. 가격이 최근 6개월 거래의 낮은 쪽 30% 안인지, 최근 3개월 거래가 늘었는지, 전세가율이 60% 이상인지.'));
  assert.ok(html.includes('과거 거래를 센 것이고 매수 시점 추천이 아니에요.'));
  assert.ok(html.includes('같은 평형이어도 층과 방향에 따라 값이 달라요. 이 숫자는 그 차이를 반영하지 못해요.'));
  assert.ok(html.includes('이사철(3, 4, 9, 10월)이 비교 기간에 들어 있어 거래가 실제보다 많아 보일 수 있어요.'));
  assert.ok(html.includes('평형을 가리지 않고 최근 거래를 10건까지 평균한 값이에요'));
  for (const old of ['데이터 부합', '성수기 영향 감쇄', 'RR/저층', '95% 신뢰 구간', '이사 성수기(3·4·9·10월)가 비교 구간']) {
    assert.ok(!html.includes(old), `옛 문구가 남아 있다: ${old}`);
  }
  // 위험 고지는 그대로 둔다
  assert.ok(read('../services/analysisService.js').includes('역전세 위험 확인 필요'));
});

test('가격 신호 문구: 도움말에 적은 기준 숫자가 실제 계산식과 같다(30%, 60%, 거래 증가)', () => {
  const _in = require('../services/analysisService')._internals; const summarizeMarketSignal = _in.summarizeMarketSignal || _in.calcBuySignal;
  const green = (p, v, j) => summarizeMarketSignal(p, { signal: v, seasonalBias: false }, j).conditions.map((c) => c.status === 'green');
  assert.deepEqual(green(30, 'up', 60), [true, true, true]);
  assert.deepEqual(green(31, 'neutral', 59), [false, false, false]);
  const r = summarizeMarketSignal(20, { signal: 'up', seasonalBias: true }, 70);
  assert.equal(r.conditions[1].desc, '최근 3개월 거래가 늘었어요. 이사철이 끼어 있어 실제보다 많아 보일 수 있어요');
  assert.equal(r.summaryDesc, '', '가격대 안내가 없으면 요약 줄은 비운다');
  assert.equal(summarizeMarketSignal(80, { signal: 'up', seasonalBias: false }, 70).summaryDesc, '최근 6개월 거래 가운데 높은 가격대예요');
});

// ── RPT-FUND-1116, RPT-ORDER-1116 (plans/201 2번): 보고서 맨 위 자금 요약과 순서 ──
test('보고서 자금 요약: 숫자는 대출 계산과 같은 식에서 오고, 모자랄 때와 아닐 때와 자기 자본을 안 넣었을 때를 가려 말한다', () => {
  const src = fnSrc('_rptFundHtml');
  const mk = (calc) => new Function('calcLTV', '_escHtml', `${src}; return _rptFundHtml;`)(calc, (x) => String(x));
  const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const calls = [];
  const calc = (buy, cash, inc, mo, house, isF, region) => { calls.push([buy, cash, inc, mo, house, isF, region]); return { ltv: 0.4, lL: 3.6, dL: 3.68, fin: 3.6, need: Math.max(0, buy - cash - 3.6), isR: true }; };
  const a = text(mk(calc)({ buy: 9, cash: 0, inc: 8000, region: '서울', houseStatus: '무주택', isFirstBuyer: false }));
  assert.deepEqual(calls[0], [9, 0, 8000, 0, '무주택', false, '서울'], '대출 계산과 같은 인자로 calcLTV 를 부른다');
  assert.match(a, /매수가 9억이면 대출 한도는 최대 3\.60억쯤이에요\(무주택, 규제지역, LTV 40% 기준\)\./);
  assert.match(a, /자기 자본이 5\.40억보다 적으면 돈이 모자라요\. 지금 입력한 자기 자본은 0억이라 5\.40억이 모자라요\./);
  assert.match(a, /취득세와 중개보수 같은 사는 비용은 빼기 전이에요\./);
  const b = text(mk(calc)({ buy: 9, cash: 6, inc: 8000, region: '서울', houseStatus: '무주택', isFirstBuyer: false }));
  assert.match(b, /입력한 자기 자본 6억이면 매수가를 채울 수 있어요\./); assert.doesNotMatch(b, /모자라요/);
  const c = text(mk(calc)({ buy: 9, cash: null, inc: 0, region: '서울', houseStatus: '무주택', isFirstBuyer: false }));
  assert.match(c, /자기 자본이 5\.40억은 있어야 해요\. 자기 자본을 입력하면 모자라는지 알려 드려요\./); assert.match(c, /입력 안 함/);
  const dsr = text(mk(() => ({ ltv: 0.4, lL: 2, dL: 1.38, fin: 1.38, need: 2.62, isR: true }))({ buy: 5, cash: 1, inc: 3000, region: '서울', houseStatus: '무주택' }));
  assert.match(dsr, /연소득 기준\(DSR\)/, '소득 때문에 한도가 정해졌으면 그렇게 적는다');
  assert.equal(mk(calc)(null), ''); assert.equal(mk(calc)({ buy: 0 }), '');
  assert.doesNotMatch(src, /[—–→]/);
});

test('보고서 순서: 자금 요약, 요약, 단지 목록, 접어 둔 구역(지역 통계, 정책, 계약 전 확인 목록), 맨 끝에 출처', () => {
  const src = fnSrc('_renderReport');
  const order = ['${_rptFundHtml(window._rptInput)}', '내 상황 기준 요약', '조건에 드는 단지 ${(r.apartments || []).length}곳', '${aptsHtml}',
    '매수 예정가 안에 드는 단지를 먼저 보여 드려요. 수가 모자라면 매수 예정가보다 20%까지 비싼 단지도 함께 넣어요.',
    '지역 통계 (미분양, 월별 거래량, 준공 연차별 평당가)', '현재 부동산 정책 (', '계약 전 확인 목록', '갈아타기 관점 (장기)', '    ${_basisHtml}'];
  const tpl = src.slice(src.indexOf('result.innerHTML = `'));
  let last = -1;
  for (const k of order) { const i = tpl.indexOf(k); assert.ok(i > last, `순서가 어긋났다: ${k}`); last = i; }
  assert.ok(src.includes('const coreHtml = _aiBanner + (r.coreMessages || [])'), '요약 상자에는 요약만 넣는다');
  assert.ok(html.includes('window._rptInput = { buy, cash, inc, region, houseStatus, isFirstBuyer };'));
  // 안내 문구의 20% 는 서버의 실제 범위와 같아야 한다
  assert.ok(read('../routes/report.js').includes('const maxAmt = Math.round(buy * 1.2 * 10000);'));
});
