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
