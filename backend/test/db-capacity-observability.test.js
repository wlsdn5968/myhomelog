/**
 * Plan 111 1단계 — DB 용량 시계열을 health 에 남긴다.
 *
 * [배경] checkDbCapacity() 가 recordCronRun('retention', summary) **뒤**에 호출되고 있어
 *   `{ usedMb, limitMb, level }` 을 재도 그 값이 retention 요약에 실릴 자리가 없이 그대로
 *   버려졌다(plans/104 §8.4). 임계(85/93%)를 넘어야만 Sentry 가 울리므로, 그 전에
 *   "얼마나 빨리 차고 있는가" 를 볼 수단이 아예 없었다.
 *
 * [이 파일이 고정하는 것]
 *   1. cronStats._pick 이 dbUsedMb·dbPct 를 통과시킨다(NUM 화이트리스트 등록 확인).
 *   2. 중첩된 형태(예: { db: { usedMb } })는 통과되지 않는다 — Plan 110 과 같은 회귀 패턴.
 *   3. backend/routes/cron.js 소스 정적 단언: POST·GET 쌍둥이 핸들러 각각에서
 *      checkDbCapacity() 호출이 정확히 1회씩 등장하고, 그 호출이 recordCronRun('retention'
 *      보다 앞선 위치에 있다 — 이 저장소는 쌍둥이 한쪽만 고쳐 라이브에 안 먹은 사고가
 *      반복됐다(094·105 기록).
 *
 * [파일 분리 이유] backend/test/retention-observability.test.js 는 Plan 110(molit_ingest_runs
 *   정리) 회귀를 고정하는 파일이라 건드리지 않는다(이 작업의 범위 밖). 이 파일은 Plan 111
 *   범위(DB 용량 시계열 배선)만 새로 고정한다.
 *
 * 실행: cd backend && npm test   (node:test 내장 러너)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { _pick } = require('../services/cronStats');

test('cronStats._pick — dbUsedMb·dbPct 를 통과시킨다', () => {
  const out = _pick({ dbUsedMb: 405.4, dbPct: 81 });
  assert.equal(out.dbUsedMb, 405.4, 'dbUsedMb 는 NUM 화이트리스트를 통과해야 한다');
  assert.equal(out.dbPct, 81, 'dbPct 는 NUM 화이트리스트를 통과해야 한다');
});

test('cronStats._pick — 중첩된 db.usedMb 는 통과되지 않는다(평탄화 키만 인식)', () => {
  const out = _pick({ db: { usedMb: 405.4 } });
  assert.equal(out.usedMb, undefined, '중첩 객체 안의 usedMb 는 통과되면 안 된다 — 110 과 같은 회귀 패턴');
  assert.equal(out.dbUsedMb, undefined, '평탄화 키 자체가 없으면 dbUsedMb 도 당연히 없어야 한다');
});

test('cron.js 소스 정적 단언 — POST/GET 쌍둥이 각각에서 checkDbCapacity() 가 recordCronRun(\'retention\' 보다 앞에 정확히 1회씩 등장한다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'cron.js'), 'utf8');

  const postStart = src.indexOf("router.post('/retention'");
  const getStart = src.indexOf("router.get('/retention'");
  const getEnd = src.indexOf('// ── MOLIT 실거래가 ETL');
  assert.ok(postStart > -1, 'POST /retention 핸들러를 찾을 수 없다 — 쌍둥이 구조가 바뀌었는지 확인 필요');
  assert.ok(getStart > postStart, 'GET /retention 핸들러를 찾을 수 없거나 POST 보다 앞에 있다');
  assert.ok(getEnd > getStart, 'GET /retention 핸들러의 끝 경계(molit-ingest 섹션 시작)를 찾을 수 없다');

  const postSection = src.slice(postStart, getStart);
  const getSection = src.slice(getStart, getEnd);

  for (const [label, section] of [['POST', postSection], ['GET', getSection]]) {
    const capCount = (section.match(/checkDbCapacity\(\)/g) || []).length;
    assert.equal(capCount, 1, `${label} /retention 안에서 checkDbCapacity() 호출은 정확히 1회여야 한다(쌍둥이 배선 누락 방지)`);

    const capIdx = section.indexOf('checkDbCapacity()');
    const recordIdx = section.indexOf("recordCronRun('retention'");
    assert.ok(capIdx > -1 && recordIdx > -1, `${label} /retention 에서 checkDbCapacity()·recordCronRun('retention' 를 모두 찾을 수 있어야 한다`);
    assert.ok(capIdx < recordIdx, `${label} /retention: checkDbCapacity() 가 recordCronRun('retention' 보다 앞에 와야 측정값이 요약에 실린다`);
  }
});
