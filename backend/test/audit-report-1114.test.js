/**
 * AUDIT-REPORT-1114: 제3자 방식 감사(AUDIT_REPORT.md)에서 운영 화면으로 재현한 것의 회귀 검사.
 *   6번 원칙과 어긋나는 문구, 7번 대출 계산 입력 범위, 9번 현장 메모 방문일과 평점.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'index.html'), 'utf8');
const rd = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// 실제 소스에서 함수를 꺼내 실행한다
function grab(name) {
  const i = html.indexOf(`function ${name}(`);
  assert.ok(i > 0, `${name} 가 없다`);
  let depth = 0; let j = html.indexOf('{', i);
  for (; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') { depth--; if (depth === 0) break; }
  }
  return new Function(`${html.slice(i, j + 1)}; return ${name};`)();
}

test('대출 계산: 음수와 범위를 넘는 값은 계산 전에 걸러진다', () => {
  const p = grab('calcInputProblem');
  const ok = { buy: 6, inc: 6000, ratePct: 4, yrs: 30, ex: 0, cash: 2, cl: 0, jl: 0 };
  assert.equal(p(ok), '');
  // 빈 칸은 NaN 으로 온다. 문제로 보지 않는다
  assert.equal(p({ buy: 6, inc: NaN, ratePct: NaN, yrs: NaN, ex: NaN, cash: NaN, cl: NaN, jl: NaN }), '');
  // 운영에서 재현한 입력: 매수가 -5, 연소득 -3000, 금리 -1
  assert.match(p({ ...ok, buy: -5, inc: -3000, ratePct: -1 }), /0보다 작은 값/);
  for (const k of ['inc', 'ratePct', 'yrs', 'ex', 'cash', 'cl', 'jl']) {
    assert.match(p({ ...ok, [k]: -1 }), /0보다 작은 값/, `${k} 음수를 통과시킨다`);
  }
  assert.match(p({ ...ok, buy: 99999999 }), /1,000억 이하/);
  assert.equal(p({ ...ok, buy: 1000 }), '');
  assert.match(p({ ...ok, ratePct: 500 }), /30% 이하/);
  assert.equal(p({ ...ok, ratePct: 30 }), '');
  assert.match(p({ ...ok, yrs: 999 }), /50년 이하/);
  assert.equal(p({ ...ok, yrs: 50 }), '');
});

test('대출 계산: dc() 가 계산 전에 입력 범위를 보고, 문제면 결과를 숨기고 안내한다', () => {
  // dc() 본문 전체를 중괄호 짝으로 잘라 본다(길이에 기대지 않는다)
  const i = html.indexOf('function dc(');
  let depth = 0; let j = html.indexOf('{', i);
  for (; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') { depth--; if (depth === 0) break; }
  }
  const body = html.slice(i, j + 1);
  const iProb = body.indexOf('calcInputProblem(');
  const iPure = body.indexOf('calcLoanLimitsPure(');
  assert.ok(iProb > 0, 'dc() 가 입력 범위를 보지 않는다');
  assert.ok(iPure > 0 && iProb < iPure, '입력 확인이 계산보다 뒤에 있다');
  // 입력 칸 8개를 모두 넘긴다
  const call = body.slice(iProb, body.indexOf(');', iProb));
  for (const id of ['c_i', 'c_r', 'c_y', 'c_e', 'c_c', 'c_cl', 'c_jl']) assert.ok(call.includes(`_num('${id}')`), `${id} 를 확인하지 않는다`);
  assert.match(call, /\{buy,/);
  assert.match(body, /if\(_prob\)\{document\.getElementById\('co'\)\.style\.display='none';/);
  assert.match(html, /<div id="c_err" role="alert"/);
});

test('문구: 추천과 예측으로 읽히는 표현이 화면 소스에 없다', () => {
  assert.doesNotMatch(html, /추천 1위/);
  assert.doesNotMatch(html, /가격이 잠시 내려갈 수/);
  assert.doesNotMatch(html, /5년 이상 보유를 염두/);
  assert.doesNotMatch(html, /시세 하락 위험/);
  // 가격 신호 요약 줄은 서버의 중립 문구(summaryDesc)를 쓴다
  assert.match(html, /sig\.summaryDesc\|\|sig\.signalDesc/);
  assert.match(rd('services/analysisService.js'), /summaryDesc: signalDesc\.replace\('긍정', '데이터 부합'\)/);
});

test('현장 메모: 방문일은 실제 날짜만, 평점은 숫자만 받는다', () => {
  const { isValidVisitDate } = require('../routes/fieldNotes');
  assert.equal(isValidVisitDate('2026-11-14'), true);
  assert.equal(isValidVisitDate('abc'), false);          // 운영에서 500 이 났던 값
  assert.equal(isValidVisitDate('2026-02-30'), false);
  assert.equal(isValidVisitDate('2026-1-5'), false);
  assert.equal(isValidVisitDate(20261114), false);
  const s = rd('routes/fieldNotes.js');
  const put = s.slice(s.indexOf("router.put('/:aptName'"));
  const iCheck = put.indexOf('isValidVisitDate(visitDate)');
  const iUpsert = put.indexOf('.upsert(');
  assert.ok(iCheck > 0 && iCheck < iUpsert, '방문일 확인이 저장보다 뒤에 있다');
  // 평점 확인 식을 실제 소스에서 꺼내 실행한다
  const m = put.match(/if \(rating != null && rating !== '' && (.+)\) \{\s*return res\.status\(400\)/);
  assert.ok(m, '평점 확인이 없다');
  const bad = new Function('rating', `return rating != null && rating !== '' && ${m[1]};`);
  for (const v of ['abc', '3abc', [3], 99, -1, 2.5, {}, true]) assert.equal(bad(v), true, `${JSON.stringify(v)} 를 통과시킨다`);
  for (const v of [0, 3, 5, '3', ' 4 ', null, undefined, '']) assert.equal(bad(v), false, `${JSON.stringify(v)} 를 거절한다`);
  assert.ok(put.indexOf(m[0]) < put.indexOf('.upsert('), '평점 확인이 저장보다 뒤에 있다');
});

test('도우미: 구 이름이 아닌 낱말은 시군구 조회를 건너뛴다(운영 누적 통계 평균 1,982ms 조회)', () => {
  const s = rd('services/chatDataRouter.js');
  const m = s.match(/function _matchesKnownSigungu\(safe\) \{[\s\S]*?\n\}/);
  assert.ok(m, '_matchesKnownSigungu 가 없다');
  // 실제 지역 코드 표로 실행한다
  const tx = require('../services/transactionService');
  const names = Object.values(tx.LAWD_CODE_TO_NAME);
  assert.ok(names.length >= 100, '지역 이름 표가 비었다');
  const fn = new Function('require', `${m[0]}; return _matchesKnownSigungu;`)(() => tx);
  for (const q of ['은마', '잠실엘스', '공덕', '래미안']) assert.equal(fn(q), false, `${q} 가 시군구로 판정된다`);
  for (const q of ['강남', '강남구', '노원구', '수원시', '중구', '해운대', '세종']) assert.equal(fn(q), true, `${q} 가 시군구가 아니라고 판정된다`);
  // 표에 있는 이름은 전부 자기 자신과 앞 두 글자로 통과한다(ilike '낱말%' 와 같은 판정)
  for (const n of names) { assert.equal(fn(n), true); assert.equal(fn(n.slice(0, 2)), true); }
  // 표를 못 읽으면 종전대로 DB 에 묻는다
  const fnBroken = new Function('require', `${m[0]}; return _matchesKnownSigungu;`)(() => ({}));
  assert.equal(fnBroken('은마'), true);
  assert.match(s, /let rows = _matchesKnownSigungu\(safe\) \? await fetchBy\('sigungu'\) : \[\];/);
});

test('보고서: 단계별 소요를 한 줄로 남긴다(동작은 그대로)', () => {
  const s = rd('routes/report.js');
  const m = s.match(/function _stageTimer\(\) \{[\s\S]*?\n\}/);
  assert.ok(m);
  const t = new Function(`${m[0]}; return _stageTimer;`)()();
  t.mark('a'); t.mark('b'); t.mark('a');
  const d = t.done();
  assert.deepEqual(Object.keys(d).sort(), ['a', 'b', 'totalMs']);
  assert.ok(d.a >= 0 && d.b >= 0 && d.totalMs >= d.a + d.b - 1);
  for (const k of ['pool', 'aliasAndGroup', 'facility', 'building', 'coord', 'amenity', 'reaggAndSelect', 'rent']) {
    assert.equal(s.split(`_st.mark('${k}');`).length - 1, 1, `${k} 계측이 한 번이 아니다`);
  }
  assert.match(s, /source: 'report-stages', stages: _rt\.done\(\), candidateStages: candidates\._stages \|\| null/);
  // 단계 기록은 응답 JSON 에 섞이지 않는다(열거되지 않는 속성)
  assert.match(s, /Object\.defineProperty\(finalOut, '_stages', \{ value: _st\.done\(\), enumerable: false \}\);/);
});

test('서버 렌더 제목에 긴 줄표가 없다', () => {
  for (const f of ['routes/aptPage.js', 'routes/regionPage.js', 'routes/briefing.js']) {
    const titles = rd(f).split('\n').filter((l) => /^\s*(const title = |title: )`/.test(l));
    assert.ok(titles.length >= 1, `${f} 에서 제목 줄을 못 찾았다`);
    for (const l of titles) assert.doesNotMatch(l, /[—–]/, `${f}: ${l.trim().slice(0, 60)}`);
  }
});

test('단지 페이지: 이동 경로 구조화 데이터가 실리고 script 블록이 끊기지 않는다', () => {
  const ap = require('../routes/aptPage');
  const ld = ap._aptBreadcrumb({ displayName: '은마', region: '강남구', lawdCd: '11680', canonical: 'https://x.test/apt/11680-1' });
  assert.equal(ld['@type'], 'BreadcrumbList');
  assert.deepEqual(ld.itemListElement.map((i) => i.position), [1, 2, 3, 4]);
  assert.equal(ld.itemListElement[3].name, '은마');
  assert.match(ld.itemListElement[2].item, /\/region\/11680$/);
  // 지역 코드가 없으면 지역 단계를 빼고 번호를 다시 매긴다
  const ld2 = ap._aptBreadcrumb({ displayName: 'A', region: '', lawdCd: '', canonical: 'c' });
  assert.deepEqual(ld2.itemListElement.map((i) => i.position), [1, 2, 3]);
  // 이름에 </script> 가 들어 있어도 블록이 닫히지 않고, 다시 읽으면 원래 값이다
  const evil = '</script><script>alert(1)</script>';
  const tag = ap._jsonLdTag(ap._aptBreadcrumb({ displayName: evil, region: 'r', lawdCd: '1', canonical: 'c' }));
  assert.equal(tag.split('</script>').length - 1, 1, 'script 블록이 중간에 닫힌다');
  assert.ok(!tag.slice(0, -9).includes('<script>alert'));
  const inner = tag.replace(/^<script type="application\/ld\+json">/, '').replace(/<\/script>$/, '');
  assert.equal(JSON.parse(inner).itemListElement[3].name, evil);
  assert.equal(ap._jsonLdTag(null), '');
  // 거래 없는 얇은 페이지에는 싣지 않는다
  assert.match(rd('routes/aptPage.js'), /jsonLd: thin \? null : aptBreadcrumb\(/);
});
