/**
 * 소비자 체험 점검(2026-10-30, 크롬 실제 클릭) 후속 수정 고정.
 *  ① 대출 한도 두 계산(calcLTV 4% 고정 vs dc 시중 평균) 불일치 3.01억 vs 2.76억
 *  ② 한도를 스트레스 DSR 이 정했는데 "DSR 29%로 여유가 있어요"
 *  ③ 목록 카드 '최대 대출'이 소득(DSR)을 반영하지 않음
 *  ④ 비교 화면 기본 면적이 고른 평형과 다름
 *  ⑤ 접힌 선택 칸의 적용 조건이 보이지 않음
 *  ⑥ 단지명 자리에 '입주자대표회의·관리사무소'
 *  ⑦ '신혼부부' 예시가 정책자금 기준 밖
 *  ⑧ 가격 신호 표본 문구 상충
 *  ⑨ 규제 시행일이 UTC 날짜로 하루 앞당겨 보임 ⑩ 서버 처분조건부 LTV 70%(공식 40%)는 regulation-tax.test.js
 * 실행: cd backend && TZ=UTC node --test test/consumer-fixes-1030.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
const fnSrc = (name) => {
  const i = html.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} 없음`);
  return html.slice(i, html.indexOf('\n}', i) + 2);
};

function loanFns(win) {
  // eslint-disable-next-line no-new-func
  return new Function('window', `const isRegFront=()=>true;\n${fnSrc('_loanBaseRate')}\n${fnSrc('calcLTV')}\n${fnSrc('calcLoanLimitsPure')}\nreturn {calcLTV, calcLoanLimitsPure, _loanBaseRate};`)(win);
}

test('① 같은 입력이면 목록·상세 계산(calcLTV)과 대출 계산(dc 의 calcLoanLimitsPure)의 DSR 한도가 같다', () => {
  for (const ecos of [4.88, null]) {
    const f = loanFns({ _ecosMortgageRate: ecos });
    const a = f.calcLTV(7, 2, 6000, 0, '무주택', true, '서울 노원구');
    const rate = ecos ? ecos / 100 : 0.04; // dc: c_r 미입력 → _ecosMortgageRate → 4
    const b = f.calcLoanLimitsPure({ buy: 7, inc: 6000, rate, yrs: 30, exAdded: 0, cash: 2, ltv: 0.7, cap: 6, isLoc: false });
    assert.equal(a.dL, b.dL, `시중금리 ${ecos}: calcLTV ${a.dL} vs dc ${b.dL}`);
  }
  // 운영 실측값(연소득 6천만·서울·시중 4.88%) = 2.76억
  assert.equal(loanFns({ _ecosMortgageRate: 4.88 }).calcLTV(7, 2, 6000, 0, '무주택', true, '서울').dL, 2.76);
});

test('② 스트레스 DSR 이 한도를 정하면 그 사실을 먼저 말한다(“여유가 있어요”만 말하지 않는다)', () => {
  const dc = fnSrc('dc');
  assert.match(dc, /\(dsrState==='ok'&&dL<lL&&dsr>0\)\?` · 소득 기준\(스트레스 DSR, 금리 \+\$\{isLoc\?'0\.75':'3\.0'\}%p 가정\)으로 한도가 정해졌어요/);
  // 그 분기가 '여유' 문구보다 앞
  assert.ok(dc.indexOf('스트레스 DSR, 금리') < dc.indexOf('` · DSR ${dsr}%로 여유가 있어요`'));
});

test('③ 목록 카드 최대 대출: 연소득이 있으면 DSR 한도로 낮추고 "소득 기준"을 붙인다', () => {
  const f = fnSrc('_cardMaxLoan');
  assert.match(f, /calcLTV\(ltvEok,0,inc,0,'무주택',false,getRegionForSearch\(\)\)/);
  assert.match(f, /r\.dL<ltvEok\)\?`\$\{r\.dL\.toFixed\(2\)\}억 · 소득 기준`/);
  assert.match(html, /최대 대출 \$\{_escHtml\(_cardMaxLoan\(p\.maxLoan\)\)\}/);
});

test('④ 비교 화면: 고른 평형 범위의 면적 묶음을 먼저 연다', () => {
  const i = html.indexOf('function renderCompareModal(');
  const body = html.slice(i, i + 1500);
  assert.match(body, /c\.pyeong >= pr\.minArea && c\.pyeong <= pr\.maxArea && c\.presentCount === results\.length/);
  assert.ok(html.includes('함께 비교할 거래가 없어, 거래가 가장 많은 면적으로 보여 드려요'), '범위 안 비교 불가 안내 없음');
});

test('⑤ 접힌 선택 칸 제목 아래에 적용 중인 평형·생애최초·연소득을 보여 준다', () => {
  assert.match(html, /<span id="wizOptActive"/);
  const f = fnSrc('_updWizOptActive');
  for (const k of ["gct('ch-py')", "'생애최초'", '연소득']) assert.ok(f.includes(k), k);
  assert.match(html, /new MutationObserver\(_updWizOptActive\)\.observe\(o,\{subtree:true,attributes:true,attributeFilter:\['class'\]\}\)/);
});

test('⑥ 관리 조직 꼬리말은 표시에서만 뗀다 — 서버·화면 같은 규칙', () => {
  const { stripOrgSuffix, displayAptName, ORG_SUFFIX_RE } = require('../utils/aptDisplayName');
  const cases = [
    ['동탄역 포레너스 입주자대표회의', '동탄역 포레너스'],
    ['금호베스트빌아파트 제2관리사무소', '금호베스트빌아파트'],
    ['청계벽산아파트제2관리사무소', '청계벽산아파트'],
    ['상도건영제2 관리사무소', '상도건영제2'], // 띄어 쓴 '제2'는 이름의 일부일 수 있어 남긴다
    ['작전중앙하이츠아파트(부평하이츠A입주자대표회의)', '작전중앙하이츠아파트'],
    ['공릉풍림아이원', '공릉풍림아이원'],
    ['관리사무소', '관리사무소'], // 다 지우면 빈 이름 — 원문 유지
  ];
  for (const [a, b] of cases) assert.equal(stripOrgSuffix(a), b, a);
  assert.equal(displayAptName('x', { kaptName: '녹원아파트관리사무소' }), '녹원아파트');
  // 화면 정규식이 서버와 같은 문자열
  const m = fnSrc('_dispAptName').match(/const _ORG_SUFFIX_RE = (\/.*\/);/);
  assert.ok(m, '화면 정규식 없음');
  assert.equal(m[1], String(ORG_SUFFIX_RE));
  assert.match(fnSrc('_dispAptName'), /return _stripOrgSuffix\(kaptName\)/);
});

test('⑦ 신혼부부 예시는 신혼 디딤돌 기준 안 값이라 정책자금 대상이 나온다', () => {
  const pol = fnSrc('computePolicyLoan');
  const m = html.match(/newlywed: \{[^}]*bp:(\d+(?:\.\d+)?),\s*mc:[\d.]+,\s*inc:(\d+)/);
  assert.ok(m, '신혼부부 예시 없음');
  // eslint-disable-next-line no-new-func
  const computePolicyLoan = new Function(`${pol}\nreturn computePolicyLoan;`)();
  const r = computePolicyLoan({ buy: Number(m[1]), income: Number(m[2]), isFirstBuyer: true, isNewlywed: true, hasNewborn: false, houseStatus: '무주택', region: '서울' });
  assert.ok(r.eligible.some(e => e.name === '신혼 디딤돌'), JSON.stringify(r).slice(0, 200));
});

test('⑧ 가격 신호: 표본 보통 경고와 아래 "N건 분석 · 표본 보통"이 같은 기준을 말한다', () => {
  assert.match(html, /⚠ 표본 보통: 거래 \$\{d\.txCount\}건\$\{d\.anomalyCount>0\?` 중 동떨어진 거래 \$\{d\.anomalyCount\}건을 빼고 \$\{d\.filteredTxCount\|\|d\.txCount\}건`:''\}으로 분석해/);
  assert.doesNotMatch(html, /건 기준이라 표본이 적어 오차가 있을 수 있어요/);
});

test('⑨ 규제 시행일은 한국 날짜 — KST 자정 저장값(전날 15:00 UTC)을 하루 앞당기지 않는다', () => {
  const { _kstDay } = require('../services/regulationsService');
  assert.equal(_kstDay('2025-10-14 15:00:00+00'), '2025-10-15');
  assert.equal(_kstDay('2025-10-14T15:00:00+00:00'), '2025-10-15');
  assert.equal(_kstDay('2024-12-31T15:00:00Z'), '2025-01-01');
  assert.equal(_kstDay(null), null);
});

test('⑨-2 옛 브리핑 저장본의 시행일은 같은 이벤트의 현재 기록이 정확히 하루 뒤일 때만 바로잡는다', async () => {
  const regPath = require.resolve('../services/regulationsService');
  const saved = require.cache[regPath];
  const real = require(regPath);
  require.cache[regPath] = { id: regPath, filename: regPath, loaded: true, exports: { ...real, getChangeLog: async () => ({ items: [
    { key: 'housing_loan_2025', effectiveFrom: '2025-10-15' }, { key: 'acquisition_tax_2025', effectiveFrom: '2025-01-01' } ] }) } };
  const bp = require.resolve('../routes/briefing');
  delete require.cache[bp];
  try {
    const { _fixRegLogDates } = require('../routes/briefing');
    const out = await _fixRegLogDates({ regLog: [
      { key: 'housing_loan_2025', effectiveFrom: '2025-10-14' },   // UTC 로 하루 앞당겨진 옛 값 → 10-15
      { key: 'acquisition_tax_2025', effectiveFrom: '2024-12-31' }, // → 2025-01-01
      { key: 'housing_loan_2025', effectiveFrom: '2025-06-01' },   // 하루 차이가 아니면 그대로
      { key: 'other', effectiveFrom: '2025-03-03' },
    ] });
    assert.deepEqual(out.regLog.map((x) => x.effectiveFrom), ['2025-10-15', '2025-01-01', '2025-06-01', '2025-03-03']);
  } finally {
    if (saved) require.cache[regPath] = saved; else delete require.cache[regPath];
    delete require.cache[bp];
  }
});
