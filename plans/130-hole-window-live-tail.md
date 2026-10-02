# 130 — 구멍 탐지 창을 "아직 자르지 않은 가장 오래된 원본 달"까지 (Plan 119 의 빈틈)

**작성 기준 커밋**: `7e4bd92` (2026-10-02) · **출처**: 107c-2 사전 점검 P5 = 7 (`plans/107c-2-cut-202506.md` §2-1) · **운영자 승인 2026-10-02**("2번은 a 권고대로 진행해")
**성격**: 백엔드 1파일(`backend/jobs/molitIngest.js`) 로직 S + 기존 테스트 파일에 테스트 6개 추가. DB·프런트·의존성·환경변수 변경 0.
**계획자 사전 검증**(저장소 밖 사본): `ingest-silent-holes.test.js` 15/15(기존 9 + 신규 6) · 전체 backend 601 중 597(실패 4 는 사본에 node_modules 가 없어 생기는 OG 이미지 테스트 — 변경 무관) · ESLint 0 · check-env-example·security-regression 통과.

## 1. 사실 (계획자 실측 2026-10-02)
- `retryFailedGaps`(Plan 119)의 구멍 탐지 대상 = `recentYearMonths(16).slice(3)` — 최신 16개월 중 최신 3개월 제외. 오늘 기준 202607~202507.
- 원본 `molit_transactions` 의 가장 오래된 달은 202506 이다(107c-2 로 자를 예정, 아직 안 자름). 2026-10-01 에 달이 바뀌며 202506 이 탐지 창 밖이 됐다.
- 운영 `molit_ingest_runs`: 202506 = ok 118·archived 0 · 202505 = ok 0·archived 131(107c-1 로 자른 달) · 202504 이전 = 기록 없음.
- 실제 LAWD_CODES 125개 × (202607~202506) 에서 ok/archived 가 없는 쌍 = **정확히 7개, 전부 202506**: 28125·28155·28275·28290·41591·41593·41595. (SQL 로 계산 — 새 규칙이 고를 대상과 같다.)
- 구멍 후보 조회 행수: 지금 3,125행 → 변경 뒤 3,374행(`pageAll` 상한 20,000 의 17%).
- 적재는 `upsert(onConflict: dedup_key)` 라 같은 거래가 옛 코드로 이미 있으면 그 행의 지역 코드만 바뀐다(202507 이후 인천 신설 코드에서 실증 — apt_seq 접두어가 옛 코드 그대로).

## 2. 변경 — `backend/jobs/molitIngest.js` (실행자)
이 파일은 CRLF 줄 끝이다 — **Edit 도구로 부분 교체만**(통째 재작성 금지). 아래 네 곳, 글자 그대로.

### 2-1. `retryFailedGaps` 정의 바로 위에 상수·함수 추가
찾을 코드(파일 안에 정확히 1곳):
```js
async function retryFailedGaps(admin, {
```
바꿀 코드:
```js
// LIVE-TAIL-2026-10-02 (Plan 130): 표준 창 밖에서 "아직 자르지 않은 달"을 몇 달까지 따라갈지의 상한.
//   자르기는 달 M 을 (M+1)-01 + 15개월 이후에 하므로 정상 리듬이면 꼬리는 1개월이다. 자르기가 밀려도
//   따라가도록 여유를 둔다(DB 용량상 원본에 6개월 넘게 더 쌓일 수는 없다).
const LIVE_TAIL_MAX_MONTHS = 6;

/**
 * 표준 창보다 오래된 달(tailYms, 최신 → 과거) 중 아직 원본에 살아 있는 달을 고른다.
 * 살아 있음 = 그 달에 ok 기록이 1건 이상 있고 archived 기록이 0건(자르기는 그 달 기록을 전부 archived 로 바꾼다).
 * 최신 쪽부터 이어지는 동안만 — 자른 달이나 기록이 전혀 없는 달을 만나면 멈춘다(그보다 과거는 원본에 없다).
 */
function pickLiveTailYms(tailYms, coveredRows) {
  const byYm = new Map();
  for (const r of coveredRows) {
    const s = byYm.get(r.deal_ym) || { ok: 0, archived: 0 };
    if (r.status === 'archived') s.archived++; else s.ok++;
    byYm.set(r.deal_ym, s);
  }
  const live = [];
  for (const ym of tailYms) {
    const s = byYm.get(ym);
    if (!s || !s.ok || s.archived) break;
    live.push(ym);
  }
  return live;
}

async function retryFailedGaps(admin, {
```

### 2-2. 탐지 대상 달 계산 + covered 조회
찾을 코드(파일 안에 정확히 1곳):
```js
  const windowYms = recentYearMonths(lookbackMonths); // 최신 → 과거
  const holeYms = windowYms.slice(3); // 최신 3개월 제외
  let holeCandidates = [];
  if (holeYms.length) {
    const oldestHoleYm = holeYms[holeYms.length - 1];
    const newestHoleYm = holeYms[0];
    const gapSet = new Set(gapAll); // 잘리기 전 전체 — 위 GAP-ALL-2026-09-27 주석 참고
    try {
      const covered = await pageAll(() => admin.from('molit_ingest_runs')
        .select('lawd_cd, deal_ym')
        .in('status', ['ok', 'archived'])
        .gte('deal_ym', oldestHoleYm)
        .lte('deal_ym', newestHoleYm));
      const coveredSet = new Set(covered.map(r => `${r.lawd_cd}|${r.deal_ym}`));
```
바꿀 코드:
```js
  const windowYms = recentYearMonths(lookbackMonths); // 최신 → 과거
  const holeYms = windowYms.slice(3); // 최신 3개월 제외
  // LIVE-TAIL-2026-10-02 (Plan 130): 표준 창(lookbackMonths)보다 오래됐지만 **아직 자르지 않은** 원본 달.
  //   달이 바뀌면 가장 오래된 원본 달이 표준 창 밖으로 밀리는데, 창 자르기(107c)는 그 뒤 며칠~몇 주 뒤에
  //   한다 — 그 사이 그 달의 구멍은 탐지되지 않았다(실측 2026-10-02: 202506 의 신설 코드 7곳이 남은 채
  //   10-01 에 창이 넘어가 gapHoles 0, 자르기 사전 점검 P5 = 7). 그래서 표준 창 바로 뒤 달부터 과거로
  //   "ok 기록이 있고 archived 가 하나도 없는 달"이 이어지는 동안만 탐지 대상에 더한다.
  const tailYms = recentYearMonths(lookbackMonths + LIVE_TAIL_MAX_MONTHS).slice(lookbackMonths); // 최신 → 과거
  let holeCandidates = [];
  if (holeYms.length) {
    const oldestQueryYm = tailYms.length ? tailYms[tailYms.length - 1] : holeYms[holeYms.length - 1];
    const newestHoleYm = holeYms[0];
    const gapSet = new Set(gapAll); // 잘리기 전 전체 — 위 GAP-ALL-2026-09-27 주석 참고
    try {
      const coveredAll = await pageAll(() => admin.from('molit_ingest_runs')
        .select('lawd_cd, deal_ym, status')
        .in('status', ['ok', 'archived'])
        .gte('deal_ym', oldestQueryYm)
        .lte('deal_ym', newestHoleYm));
      const targetYms = [...holeYms, ...pickLiveTailYms(tailYms, coveredAll)];
      const targetYmSet = new Set(targetYms);
      // 내부/신설 구멍 판정(coveredRangeByLawd)은 탐지 대상 달의 기록만으로 한다 — 이미 자른 달의
      //   archived 기록이 섞이면 범위 최소값이 달라져 표준 창의 재시도 순서가 바뀐다.
      const covered = coveredAll.filter(r => targetYmSet.has(r.deal_ym));
      const coveredSet = new Set(covered.map(r => `${r.lawd_cd}|${r.deal_ym}`));
```

### 2-3. 후보 루프의 달 목록
찾을 코드(파일 안에 정확히 1곳):
```js
        for (const ym of holeYms) {
          const key = `${lawd}|${ym}`;
```
바꿀 코드:
```js
        for (const ym of targetYms) {
          const key = `${lawd}|${ym}`;
```

### 2-4. 테스트용 export
찾을 코드(파일 안에 정확히 1곳):
```js
module.exports._retryFailedGaps = retryFailedGaps;
```
바꿀 코드:
```js
module.exports._retryFailedGaps = retryFailedGaps;
// TEST-EXPORT-2026-10-02 (Plan 130)
module.exports._pickLiveTailYms = pickLiveTailYms;
module.exports._LIVE_TAIL_MAX_MONTHS = LIVE_TAIL_MAX_MONTHS;
```

그 밖의 줄(`minYm`·오류 기반 갭·재시도 루프·반환값)은 바꾸지 않는다.

## 3. 테스트 — `backend/test/ingest-silent-holes.test.js` 파일 **끝에** 아래를 그대로 덧붙인다(기존 내용 수정 금지)
```js
// ══════════════════════════════════════════════════════════════════════════
// LIVE-TAIL-2026-10-02 (Plan 130) — 표준 창보다 오래됐지만 아직 자르지 않은 원본 달의 구멍.
//   실사례: 202506 의 신설 코드 7곳이 채워지기 전에 2026-10-01 로 달이 넘어가 탐지 창(16개월) 밖으로
//   밀렸다 → gapHoles 0 인데 창 자르기 사전 점검 P5 = 7. 아래 테스트는 "꼬리 달" 판정을 고정한다.
//   공통 설정: LB=6 → 표준 구멍-대상 달 3개(yms[3..5]), 꼬리 후보는 그보다 오래된 달(tail[0] 이 가장 최신).
// ══════════════════════════════════════════════════════════════════════════
function _tailSetup(LB) {
  const { mod, restore } = _loadMolitIngest(() => Promise.resolve({ data: {} }));
  const maxTail = mod._LIVE_TAIL_MAX_MONTHS;
  restore();
  const all = _recentYms(LB + maxTail);
  return { holeYms: all.slice(3, LB), tail: all.slice(LB), maxTail };
}
/** 표준 창의 구멍-대상 달을 3지역 모두 ok 로 채운 기록(표준 창 구멍 0 — 꼬리 달만 보려는 것). */
function _coverStandard(holeYms, startId = 1) {
  const rows = [];
  let id = startId;
  for (const code of Object.values(STUB_LAWD_CODES)) for (const ym of holeYms) rows.push({ id: id++, lawd_cd: code, deal_ym: ym, status: 'ok' });
  return rows;
}

test('retryFailedGaps — 표준 창 밖이어도 아직 자르지 않은 달(ok 있음·archived 0)의 구멍은 재시도된다 (Plan 130)', async () => {
  const LB = 6;
  const { holeYms, tail } = _tailSetup(LB);
  const A = STUB_LAWD_CODES['A동'], B = STUB_LAWD_CODES['B동'], C = STUB_LAWD_CODES['C동'];
  const dgk = _dgkStub();
  const admin = _fakeIngestAdmin([
    ..._coverStandard(holeYms),
    { id: 101, lawd_cd: A, deal_ym: tail[0], status: 'ok' },
    { id: 102, lawd_cd: B, deal_ym: tail[0], status: 'ok' },
  ]);
  const result = await _run(admin, dgk, { maxGaps: 15, lookbackMonths: LB });

  assert.equal(result.holes, 1, `꼬리 달의 C동 1건만 구멍이어야 한다(실제 ${result.holes})`);
  assert.deepEqual(dgk.calls, [{ lawdCd: C, dealYm: tail[0] }], `실제 재시도: ${JSON.stringify(dgk.calls)}`);
  assert.equal(result.filled, 1);
});

test('retryFailedGaps — 이미 자른 달(archived 기록이 하나라도 있음)은 표준 창 밖에서 구멍 후보가 아니다 (Plan 130)', async () => {
  const LB = 6;
  const { holeYms, tail } = _tailSetup(LB);
  const A = STUB_LAWD_CODES['A동'], B = STUB_LAWD_CODES['B동'];
  for (const statuses of [['archived', 'archived'], ['ok', 'archived']]) {
    const dgk = _dgkStub();
    const admin = _fakeIngestAdmin([
      ..._coverStandard(holeYms),
      { id: 101, lawd_cd: A, deal_ym: tail[0], status: statuses[0] },
      { id: 102, lawd_cd: B, deal_ym: tail[0], status: statuses[1] },
    ]);
    const result = await _run(admin, dgk, { maxGaps: 15, lookbackMonths: LB });
    assert.equal(result.holes, 0, `자른 달(${statuses.join('+')})이 구멍 후보가 됐다 — 자른 달을 원본에 다시 적재하게 된다`);
    assert.equal(dgk.calls.length, 0);
  }
});

test('retryFailedGaps — 표준 창 밖에서 기록이 전혀 없는 달은 구멍 후보가 아니다 (Plan 130)', async () => {
  const LB = 6;
  const { holeYms } = _tailSetup(LB);
  const dgk = _dgkStub();
  const admin = _fakeIngestAdmin(_coverStandard(holeYms)); // 꼬리 달 기록 0
  const result = await _run(admin, dgk, { maxGaps: 15, lookbackMonths: LB });
  assert.equal(result.holes, 0, '한 번도 적재한 적 없는 과거 달까지 구멍으로 세면 원본 창 밖 과거를 끝없이 적재한다');
  assert.equal(dgk.calls.length, 0);
});

test('retryFailedGaps — 꼬리는 최신 쪽부터 이어지는 동안만: 자른 달보다 과거의 달은 ok 가 있어도 제외 (Plan 130)', async () => {
  const LB = 6;
  const { holeYms, tail } = _tailSetup(LB);
  const A = STUB_LAWD_CODES['A동'];
  const dgk = _dgkStub();
  const admin = _fakeIngestAdmin([
    ..._coverStandard(holeYms),
    { id: 101, lawd_cd: A, deal_ym: tail[0], status: 'archived' }, // 자른 달
    { id: 102, lawd_cd: A, deal_ym: tail[1], status: 'ok' },       // 그보다 과거 — 원본에 없다
  ]);
  const result = await _run(admin, dgk, { maxGaps: 15, lookbackMonths: LB });
  assert.equal(result.holes, 0);
  assert.equal(dgk.calls.length, 0);
});

test('retryFailedGaps — 자르기가 밀려 꼬리가 2개월이면 둘 다 탐지하고, 표준 창의 구멍이 꼬리보다 먼저 뽑힌다 (Plan 130)', async () => {
  const LB = 6;
  const { holeYms, tail } = _tailSetup(LB);
  const A = STUB_LAWD_CODES['A동'], B = STUB_LAWD_CODES['B동'], C = STUB_LAWD_CODES['C동'];
  const dgk = _dgkStub();
  // 표준 창: C동의 가장 오래된 달 1건만 비워 둔다(신설 구멍). 꼬리 2개월: A동만 ok → B·C 가 구멍.
  const standard = _coverStandard(holeYms).filter(r => !(r.lawd_cd === C && r.deal_ym === holeYms[holeYms.length - 1]));
  const admin = _fakeIngestAdmin([
    ...standard,
    { id: 101, lawd_cd: A, deal_ym: tail[0], status: 'ok' },
    { id: 102, lawd_cd: A, deal_ym: tail[1], status: 'ok' },
  ]);
  const result = await _run(admin, dgk, { maxGaps: 15, lookbackMonths: LB });
  assert.equal(result.holes, 5, `표준 창 1 + 꼬리 2개월 × 2지역 = 5 (실제 ${result.holes})`);
  // B동은 표준 창에 기록이 있고 꼬리 달은 그 범위 밖(더 과거)이라 신설 구멍, C동도 범위 밖 → 전부 같은 묶음, 최신 달 먼저.
  assert.deepEqual(dgk.calls, [
    { lawdCd: C, dealYm: holeYms[holeYms.length - 1] },
    { lawdCd: B, dealYm: tail[0] }, { lawdCd: C, dealYm: tail[0] },
    { lawdCd: B, dealYm: tail[1] }, { lawdCd: C, dealYm: tail[1] },
  ], `실제 재시도 순서: ${JSON.stringify(dgk.calls)}`);
});

test('pickLiveTailYms — 상한(LIVE_TAIL_MAX_MONTHS)과 판정 규칙 (Plan 130)', () => {
  const { mod, restore } = _loadMolitIngest(() => Promise.resolve({ data: {} }));
  try {
    const pick = mod._pickLiveTailYms;
    assert.equal(mod._LIVE_TAIL_MAX_MONTHS, 6);
    const ok = (ym) => ({ lawd_cd: '11111', deal_ym: ym, status: 'ok' });
    const ar = (ym) => ({ lawd_cd: '11111', deal_ym: ym, status: 'archived' });
    assert.deepEqual(pick(['202506', '202505'], [ok('202506'), ar('202505')]), ['202506']);
    assert.deepEqual(pick(['202506', '202505'], [ok('202506'), ok('202505')]), ['202506', '202505']);
    assert.deepEqual(pick(['202506', '202505'], [ar('202506'), ok('202505')]), []);
    assert.deepEqual(pick(['202506', '202505'], [ok('202505')]), []);
    assert.deepEqual(pick([], [ok('202506')]), []);
  } finally { restore(); }
});
```

## 4. 하지 말 것 / STOP
- `WINDOW_MONTHS`·`maxGaps`·최신 3개월 제외·오류 기반 갭 로직 변경 금지. `cron.js`·`cronStats.js` 변경 금지(`gapHoles` 는 그대로 `holes` 를 싣는다).
- DB·관리자 API 호출 금지. 적재를 직접 실행하지 말 것(다음 cron 이 한다).
- 테스트가 실패하면 고치지 말고 출력 그대로 보고하고 STOP.

## 5. 완료 기준
1. LF 정규화 sha256: `backend/jobs/molitIngest.js` = `314248d8d59d77d38b323407d1007ff6a4ba3c8273e061ca07be2c05031fb7bf` · `backend/test/ingest-silent-holes.test.js` = `bbf61ad9b303fc26c48c5a29daf1f92b0e1dc1370772743b8d1234ea9b6e4e90`
   - 명령(Git Bash, 워크트리 루트): `node -e "const fs=require('fs'),c=require('crypto');for(const p of process.argv.slice(1))console.log(p,c.createHash('sha256').update(fs.readFileSync(p,'utf8').replace(/\r\n/g,'\n')).digest('hex'))" backend/jobs/molitIngest.js backend/test/ingest-silent-holes.test.js`
2. `npm run verify` 체인 전체 exit 0 — backend 테스트 595 → **601**.
3. `git diff master --stat` = `backend/jobs/molitIngest.js` · `backend/test/ingest-silent-holes.test.js` · `plans/130-hole-window-live-tail.md` 뿐.
4. 배포 후(계획자): 다음 molit-ingest cron(17:45 UTC 전후 슬롯) 뒤 `molit_ingest_runs` 에 위 7쌍의 202506 ok 행 · 107c-2 P5 = 0 · `/api/health` `gapHoles`(그 회차 탐지 수) · Sentry 신규 0.

## 6. 유지보수
- "살아 있는 달" 판정은 `molit_ingest_runs` 의 archived 표시에 의존한다 — 창 자르기(107c) 절차의 e+f 단계(삭제와 같은 마이그레이션에서 그 달 기록을 archived 로)가 빠지면 자른 달을 원본에 다시 적재하게 된다. 절차를 바꾸면 이 규칙도 같이 볼 것.
- 자른 뒤 그 달에 새 지역 코드가 추가돼도 다시 적재하지 않는다(archived 가 있으면 제외) — 이력 쪽 보강은 별도.
