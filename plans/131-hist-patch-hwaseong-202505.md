# 131 — 화성 신설 3구의 2025-05 이력 보강 (이미 자른 달의 구멍 — 지정 대상 1회 적재 + 경신 기준선 재계산)

**작성 기준 커밋**: `93b4d83` (2026-10-02) · **출처**: Plan 130 조사 중 발견(`plans/107c-2-cut-202506.md` §2-1 "별도 발견") · **운영자 승인 2026-10-02**("4번 진행해")
**성격**: 백엔드 1파일(`backend/jobs/molitHistBackfill.js`) S + 기존 테스트 파일에 테스트 4개 추가. DB 스키마·프런트·의존성·환경변수 변경 0. 데이터 쓰기는 배포 뒤 기존 cron(`/api/cron/molit-hist-backfill`, 하루 10슬롯)이 한다.
**계획자 사전 검증**(저장소 밖 사본): `molit-hist-backfill.test.js` 9/9(기존 5 + 신규 4) · 전체 backend 605 중 601(실패 4 는 사본에 node_modules 가 없어 생기는 OG 이미지 테스트 — 변경 무관) · ESLint 0 · check-env-example·security-regression 통과.
**개정 1 (기록만)**: §5-1 의 해시 명령은 생성 과정에서 `\r\n` 이 실제 줄바꿈으로 박혀 한 줄로 실행되지 않는다(실행자 보고) — 같은 뜻의 `replace(/\\r\\n/g, 줄바꿈)` 로 풀어 실행하면 된다. 해시 값 자체는 맞다(실행자·계획자 양쪽 일치).

## 1. 사실 (계획자 실측 2026-10-02, 운영 DB)
- 이력 `molit_transactions_hist` 의 화성(apt_seq `41590-…`, 지역은 `molit_apt_dim.lawd_cd` 로 구분): 2025-03 = 만세 143·효행 160·병점 200·동탄 524 · 2025-04 = 113·130·168·420 · **2025-05 = 동탄 499 뿐**.
- 원인: 107c-1(2026-09-27)이 2025-05 를 원본에서 이력으로 옮길 때 화성 신설 3구(41591·41593·41595)는 원본에 그 달이 없었다(2026-08 편입 뒤 과거분 미적재 — 당시 자르기 전 구멍 점검 P5 없음). `molit_hist_runs` 는 이 코드들에 202009~202504 만 있다.
- 인천 신설 4구의 2025-05 는 옛 코드(apt_seq `28110-`·`28140-`·`28260-`)분 125·44·562행으로 이력에 **있다** — 대상 아님(넣으면 중복).
- `molit_hist_peaks`(경신 기준선) ≡ 이력의 (apt_seq, exclu_use_ar)별 max·min·count: 81,918키 전부 일치(양쪽 누락 0·값 불일치 0). 그래서 보강 뒤 기준선은 영향받은 단지를 이력에서 **다시 계산해 덮어쓰면** 정확하고 멱등이다.
- 이력에는 유일 제약이 없다(같은 행을 두 번 넣으면 중복). 기존 삭제 가드는 `apt_seq like '<지역코드>-%'` 인데 화성 신설구의 apt_seq 접두어는 `41590` 이라 이 가드로는 못 비운다.
- 이력 backfill cron 은 지금도 하루 10회 돈다(대상 0 → `complete`). `db_size_mb()` 현재 ≈409 < 정지선 470.
- Plan 130 은 자른 달을 원본에 다시 적재하지 않는다(의도) — 그래서 이 경로가 필요하다.

## 2. 변경 — `backend/jobs/molitHistBackfill.js` (실행자)
CRLF 줄 끝 파일 — **Edit 도구로 부분 교체만**. 아래 여섯 곳, 글자 그대로. "찾을 코드"는 전부 줄 전체다.

### 2-1. 상수
찾을 코드(줄 전체, 파일에 정확히 1곳):
```js
const CHUNK = 1000;
```
바꿀 코드:
```js
const CHUNK = 1000;
// HIST-PATCH-2026-10-02 (Plan 131): 이미 자른 달 가운데 이력에 빠진 (지역, 월) — 지정 보강 대상.
//   107c-1 이 2025-05 를 이력으로 옮길 때 화성 신설 3구(만세 41591·효행 41593·병점 41595)는 원본에 그 달이
//   없었다(그때는 자르기 전 적재 구멍 점검 P5 가 없었다). 실측 2026-10-02: 이력의 화성(apt_seq 41590-…)
//   2025-04 = 만세 113·효행 130·병점 168·동탄 420 인데 2025-05 = 동탄 499 뿐. Plan 130 은 자른 달을 원본에
//   다시 적재하지 않으므로 이 경로(이력 직접 적재)로 한 번 채운다. 끝나면 molit_hist_runs 에 기록돼 다시
//   돌지 않는다. LAWD_CODES 에 없는 코드는 무시한다.
//   ⚠ 인천 신설 4구의 2025-05 는 넣지 말 것 — 옛 코드(28110·28140·28260)분으로 이미 이력에 있어 중복된다.
const EXTRA_TARGETS = [['41591', '202505'], ['41593', '202505'], ['41595', '202505']];
const SEQ_CHUNK = 100;                     // apt_seq IN 목록은 URL 에 실린다 — 길이 제한 회피
```

### 2-2. `nextTargets` — 지정 대상을 먼저
찾을 코드(줄 전체, 파일에 정확히 1곳):
```js
  const regions = [...new Set(Object.values(LAWD_CODES))];
  const out = [];
```
바꿀 코드:
```js
  const regions = [...new Set(Object.values(LAWD_CODES))];
  const out = [];
  // HIST-PATCH-2026-10-02 (Plan 131): 지정 보강 대상을 먼저 — 완료됐거나 LAWD_CODES 에 없는 코드는 건너뛴다.
  for (const [lawdCd, ym] of EXTRA_TARGETS) {
    if (!regions.includes(lawdCd) || done.has(`${lawdCd}|${ym}`)) continue;
    out.push([lawdCd, ym]);
    if (out.length >= limit) return out;
  }
```

### 2-3. 삽입 전 삭제 가드
찾을 코드(줄 전체, 파일에 정확히 1곳):
```js
      const { first, last } = monthRange(ym);
      const { error: eDel } = await admin.from('molit_transactions_hist')
        .delete()
        .like('apt_seq', `${lawdCd}-%`)
        .gte('deal_date', first)
        .lte('deal_date', last);
      if (eDel) throw eDel;
```
바꿀 코드:
```js
      const { first, last } = monthRange(ym);
      // HIST-PATCH-2026-10-02 (Plan 131): 지정 보강 대상은 apt_seq 접두어가 지역 코드와 다르다(화성 신설구 →
      //   41590-…) — 접두어 삭제로는 재시도 때 앞선 삽입분을 못 비운다. 가져온 단지의 그 달 행만 비운다.
      const isExtra = EXTRA_TARGETS.some(([l, y]) => l === lawdCd && y === ym);
      const seqs = isExtra ? [...new Set(hist.map((h) => h.apt_seq))] : [];
      if (isExtra) {
        for (let i = 0; i < seqs.length; i += SEQ_CHUNK) {
          const { error: eDelSeq } = await admin.from('molit_transactions_hist')
            .delete()
            .in('apt_seq', seqs.slice(i, i + SEQ_CHUNK))
            .gte('deal_date', first)
            .lte('deal_date', last);
          if (eDelSeq) throw eDelSeq;
        }
      } else {
        const { error: eDel } = await admin.from('molit_transactions_hist')
          .delete()
          .like('apt_seq', `${lawdCd}-%`)
          .gte('deal_date', first)
          .lte('deal_date', last);
        if (eDel) throw eDel;
      }
```

### 2-4. 기록 직전에 기준선 재계산
찾을 코드(줄 전체, 파일에 정확히 1곳):
```js
      const { error: e2 } = await admin.from('molit_hist_runs').upsert({ lawd_cd: lawdCd, deal_ym: ym, rows: hist.length });
```
바꿀 코드:
```js
      if (isExtra) await recomputeHistPeaks(admin, seqs);
      const { error: e2 } = await admin.from('molit_hist_runs').upsert({ lawd_cd: lawdCd, deal_ym: ym, rows: hist.length });
```

### 2-5. `recomputeHistPeaks` 함수(`runHistBackfill` 바로 위)
찾을 코드(줄 전체, 파일에 정확히 1곳):
```js
async function runHistBackfill(opts = {}) {
```
바꿀 코드:
```js
// HIST-PATCH-2026-10-02 (Plan 131): 지정 보강 뒤 경신 기준선(molit_hist_peaks) 맞추기.
//   molit_hist_peaks 는 이력의 (apt_seq, exclu_use_ar)별 최고·최저·건수와 같다(2026-10-02 운영 실측: 81,918키
//   전부 일치). 그래서 더하지 않고, 영향받은 단지의 요약을 이력 전체에서 **다시 계산해 덮어쓴다** — 같은
//   대상을 다시 돌려도 결과가 같다(건수 이중 계상 없음). 이력에는 유일 키가 없어 페이지 경계가 흔들리지
//   않도록 전 컬럼으로 정렬한다(완전히 같은 행끼리는 순서가 바뀌어도 집계가 같다).
async function recomputeHistPeaks(admin, aptSeqs) {
  const PAGE = 1000;
  for (let i = 0; i < aptSeqs.length; i += SEQ_CHUNK) {
    const chunk = aptSeqs.slice(i, i + SEQ_CHUNK);
    const agg = new Map();
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await admin.from('molit_transactions_hist')
        .select('apt_seq, exclu_use_ar, deal_amount')
        .in('apt_seq', chunk)
        .order('apt_seq', { ascending: true })
        .order('deal_date', { ascending: true })
        .order('exclu_use_ar', { ascending: true })
        .order('deal_amount', { ascending: true })
        .order('floor', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data || !data.length) break;
      for (const r of data) {
        const key = `${r.apt_seq}|${r.exclu_use_ar}`;
        const a = agg.get(key);
        if (!a) agg.set(key, { apt_seq: r.apt_seq, exclu_use_ar: r.exclu_use_ar, mx: r.deal_amount, mn: r.deal_amount, n: 1 });
        else {
          if (r.deal_amount > a.mx) a.mx = r.deal_amount;
          if (r.deal_amount < a.mn) a.mn = r.deal_amount;
          a.n++;
        }
      }
      if (data.length < PAGE) break;
    }
    const rows = [...agg.values()];
    for (let j = 0; j < rows.length; j += CHUNK) {
      const { error } = await admin.from('molit_hist_peaks').upsert(rows.slice(j, j + CHUNK), { onConflict: 'apt_seq,exclu_use_ar' });
      if (error) throw error;
    }
  }
}

async function runHistBackfill(opts = {}) {
```

### 2-6. export
찾을 코드(줄 전체, 파일에 정확히 1곳):
```js
module.exports = { runHistBackfill, toHistRow, prevYm, START_YM, FLOOR_YM, DB_STOP_MB, TIME_BUDGET_MS, REGION_MONTHS_PER_RUN };
```
바꿀 코드:
```js
module.exports = { runHistBackfill, toHistRow, prevYm, START_YM, FLOOR_YM, DB_STOP_MB, TIME_BUDGET_MS, REGION_MONTHS_PER_RUN, EXTRA_TARGETS };
```


## 3. 테스트 — `backend/test/molit-hist-backfill.test.js` 파일 끝에 덧붙인다
기존 내용은 바꾸지 않는다. **기존 마지막 줄 뒤에 빈 줄 2개**를 두고 아래를 그대로 잇는다(해시 기준).
```js
// ══════════════════════════════════════════════════════════════════════════
// HIST-PATCH-2026-10-02 (Plan 131) — 이미 자른 달 가운데 이력에 빠진 (지역, 월) 지정 보강.
//   실사례: 107c-1 이 2025-05 를 자를 때 화성 신설 3구는 원본에 그 달이 없어 이력에도 없다.
//   아래 스텁은 이력·경신 기준선을 메모리 배열로 흉내 낸다(in/like 삭제, 정렬+range 조회, peaks upsert).
// ══════════════════════════════════════════════════════════════════════════
function _makeMemAdmin({ histRows = [], peaks = [], doneRuns = [], failRunsUpsertOnce = false } = {}) {
  const state = {
    hist: histRows.map((r) => ({ ...r })),
    peaks: new Map(peaks.map((p) => [`${p.apt_seq}|${p.exclu_use_ar}`, { ...p }])),
    runs: [],
    peaksUpserts: 0,
  };
  let runsFail = failRunsUpsertOnce;
  const inMonth = (r, first, last) => r.deal_date >= first && r.deal_date <= last;
  const client = {
    rpc: async (name) => (name === 'db_size_mb' ? { data: 100, error: null } : { data: null, error: new Error('예상 밖 rpc ' + name) }),
    from(table) {
      if (table === 'molit_hist_runs') {
        return {
          select: () => ({ order: () => ({ range: async (from) => (from === 0 ? { data: [...doneRuns, ...state.runs], error: null } : { data: [], error: null }) }) }),
          upsert: async (row) => {
            if (runsFail) { runsFail = false; return { error: new Error('runs upsert 실패(테스트)') }; }
            state.runs.push(row); return { error: null };
          },
        };
      }
      if (table === 'molit_transactions_hist') {
        return {
          delete: () => ({
            like: (_c, pat) => ({ gte: (_c2, first) => ({ lte: async (_c3, last) => {
              const prefix = pat.replace(/%$/, '');
              state.hist = state.hist.filter((r) => !(r.apt_seq.startsWith(prefix) && inMonth(r, first, last)));
              return { error: null };
            } }) }),
            in: (_c, vals) => ({ gte: (_c2, first) => ({ lte: async (_c3, last) => {
              state.hist = state.hist.filter((r) => !(vals.includes(r.apt_seq) && inMonth(r, first, last)));
              return { error: null };
            } }) }),
          }),
          insert: async (rows) => { state.hist.push(...rows.map((r) => ({ ...r }))); return { error: null }; },
          select: () => {
            let vals = [];
            const chain = {
              in(_c, v) { vals = v; return chain; },
              order() { return chain; },
              range: async (from, to) => {
                const out = state.hist.filter((r) => vals.includes(r.apt_seq))
                  .sort((a, b) => (a.apt_seq < b.apt_seq ? -1 : a.apt_seq > b.apt_seq ? 1 : a.deal_date < b.deal_date ? -1 : a.deal_date > b.deal_date ? 1 : a.deal_amount - b.deal_amount));
                return { data: out.slice(from, to + 1).map((r) => ({ apt_seq: r.apt_seq, exclu_use_ar: r.exclu_use_ar, deal_amount: r.deal_amount })), error: null };
              },
            };
            return chain;
          },
        };
      }
      if (table === 'molit_hist_peaks') {
        return {
          upsert: async (rows, opts) => {
            assert.equal(opts && opts.onConflict, 'apt_seq,exclu_use_ar', 'peaks upsert 의 충돌 키가 PK 와 다르다');
            state.peaksUpserts++;
            for (const p of rows) state.peaks.set(`${p.apt_seq}|${p.exclu_use_ar}`, { ...p });
            return { error: null };
          },
        };
      }
      throw new Error('molit-hist-backfill 메모리 스텁: 예상 밖 테이블 ' + table);
    },
  };
  return { client, state };
}

// 화성 만세구(41591) 2025-05 — MOLIT 이 돌려주는 원천 행(apt_seq 접두어는 옛 통합코드 41590).
const _EXTRA_FETCH = [
  { apt_seq: '41590-100', deal_date: '2025-05-03', exclu_use_ar: 84.99, deal_amount: 52000, floor: 5 },
  { apt_seq: '41590-100', deal_date: '2025-05-20', exclu_use_ar: 84.99, deal_amount: 47000, floor: 9 },
  { apt_seq: '41590-200', deal_date: '2025-05-11', exclu_use_ar: 59.5, deal_amount: 31000, floor: 2 },
];
// 이미 이력에 있는 행: 같은 단지의 다른 달(2025-04) · 같은 달의 다른 단지(동탄, 건드리면 안 됨).
const _EXTRA_EXISTING = [
  { apt_seq: '41590-100', deal_date: '2025-04-10', exclu_use_ar: 8499, deal_amount: 50000, floor: 3 },
  { apt_seq: '41590-900', deal_date: '2025-05-07', exclu_use_ar: 8400, deal_amount: 90000, floor: 11 },
];
const _EXTRA_EXISTING_PEAKS = [
  { apt_seq: '41590-100', exclu_use_ar: 8499, mx: 50000, mn: 50000, n: 1 },
  { apt_seq: '41590-900', exclu_use_ar: 8400, mx: 90000, mn: 90000, n: 1 },
];

test('지정 보강(Plan 131) — 대상 목록은 화성 신설 3구의 2025-05 뿐이고, LAWD_CODES 에 없는 코드는 무시한다', async () => {
  const { EXTRA_TARGETS } = require('../jobs/molitHistBackfill');
  assert.deepEqual(EXTRA_TARGETS, [['41591', '202505'], ['41593', '202505'], ['41595', '202505']],
    '인천 신설구 등을 넣으면 옛 코드분으로 이미 이력에 있는 행이 중복된다');
  const { client } = _makeMemAdmin();
  const fetchCalls = [];
  await _runWithStubs({ limit: 2 }, client, async (l, y) => { fetchCalls.push([l, y]); return []; }, { '테스트구': '11111' });
  assert.ok(fetchCalls.every(([, ym]) => ym !== '202505'), 'LAWD_CODES 에 없는 지정 대상이 처리됐다');
});

test('지정 보강(Plan 131) — 먼저 처리되고, 가져온 단지의 그 달 행만 바꾸며, 경신 기준선을 이력 전체에서 다시 계산한다', async () => {
  const { client, state } = _makeMemAdmin({ histRows: _EXTRA_EXISTING, peaks: _EXTRA_EXISTING_PEAKS });
  const fetchCalls = [];
  const fetchImpl = async (l, y) => { fetchCalls.push([l, y]); return l === '41591' && y === '202505' ? _EXTRA_FETCH : []; };
  const res = await _runWithStubs({ limit: 1 }, client, fetchImpl, { '화성만세': '41591', '테스트구': '11111' });

  assert.deepEqual(fetchCalls, [['41591', '202505']], '지정 대상이 START_YM 대상보다 먼저여야 한다');
  assert.equal(res.done, 1);
  assert.equal(res.rows, 3);
  assert.deepEqual(state.runs, [{ lawd_cd: '41591', deal_ym: '202505', rows: 3 }]);
  assert.equal(state.hist.length, 5, '기존 2행 + 새 3행');
  assert.ok(state.hist.some((r) => r.apt_seq === '41590-900' && r.deal_date === '2025-05-07'), '같은 달의 다른 단지(동탄) 행이 지워졌다');
  assert.ok(state.hist.some((r) => r.apt_seq === '41590-100' && r.deal_date === '2025-04-10'), '같은 단지의 다른 달 행이 지워졌다');
  assert.deepEqual(state.peaks.get('41590-100|8499'), { apt_seq: '41590-100', exclu_use_ar: 8499, mx: 52000, mn: 47000, n: 3 },
    '기준선 = 이력 전체(4월 1건 + 5월 2건)의 최고·최저·건수');
  assert.deepEqual(state.peaks.get('41590-200|5950'), { apt_seq: '41590-200', exclu_use_ar: 5950, mx: 31000, mn: 31000, n: 1 });
  assert.deepEqual(state.peaks.get('41590-900|8400'), { apt_seq: '41590-900', exclu_use_ar: 8400, mx: 90000, mn: 90000, n: 1 }, '가져오지 않은 단지의 기준선이 바뀌었다');
});

test('지정 보강(Plan 131) — 기록 실패로 다시 돌아도 이력 중복·건수 이중 계상이 없다', async () => {
  const { client, state } = _makeMemAdmin({ histRows: _EXTRA_EXISTING, peaks: _EXTRA_EXISTING_PEAKS, failRunsUpsertOnce: true });
  const fetchImpl = async (l, y) => (l === '41591' && y === '202505' ? _EXTRA_FETCH : []);
  const first = await _runWithStubs({ limit: 1 }, client, fetchImpl, { '화성만세': '41591' });
  assert.equal(first.err, 1, '첫 회차는 runs 기록 실패로 err 여야 한다');
  assert.equal(state.runs.length, 0);
  const second = await _runWithStubs({ limit: 1 }, client, fetchImpl, { '화성만세': '41591' });
  assert.equal(second.done, 1);
  assert.equal(state.hist.filter((r) => r.apt_seq === '41590-100' && r.deal_date >= '2025-05-01').length, 2, '재시도로 5월 행이 중복됐다');
  assert.equal(state.hist.length, 5);
  assert.equal(state.peaks.get('41590-100|8499').n, 3, '재시도로 건수가 이중 계상됐다');
});

test('지정 보강(Plan 131) — 이미 기록된 대상은 건너뛰고, 일반 대상의 접두어 삭제 경로는 그대로다', async () => {
  const { client, state } = _makeMemAdmin({
    doneRuns: [{ lawd_cd: '41591', deal_ym: '202505' }],
    histRows: [{ apt_seq: '41591-7', deal_date: '2025-04-02', exclu_use_ar: 8400, deal_amount: 1, floor: 1 }],
  });
  const fetchCalls = [];
  const res = await _runWithStubs({ limit: 1 }, client, async (l, y) => { fetchCalls.push([l, y]); return []; }, { '화성만세': '41591' });
  assert.deepEqual(fetchCalls, [['41591', '202504']], '완료된 지정 대상을 다시 처리했거나 일반 대상 순서가 바뀌었다');
  assert.equal(res.done, 1);
  assert.equal(state.hist.length, 0, '일반 대상은 종전처럼 접두어(lawd-%)로 그 달을 비워야 한다');
  assert.equal(state.peaksUpserts, 0, '일반 대상은 기준선을 건드리지 않는다');
});
```

## 4. 하지 말 것 / STOP
- `EXTRA_TARGETS` 에 다른 쌍을 넣지 말 것(특히 인천 신설구 — 중복 발생). `START_YM`·`FLOOR_YM`·`DB_STOP_MB`·일반 대상의 접두어 삭제 경로 변경 금지.
- DB·외부 API·cron 을 직접 호출하지 말 것. `cron.js`·`vercel.json` 변경 금지.
- 테스트가 실패하면 고치지 말고 출력 그대로 보고하고 STOP.

## 5. 완료 기준
1. LF 정규화 sha256: `backend/jobs/molitHistBackfill.js` = `900c7f8d6e3bb262a9c66aadc111a51c4e6197c6aae8380ad7b7cfc8b89fc590` · `backend/test/molit-hist-backfill.test.js` = `bed47a78b92226e68189bed8e5467f55290851187aef50227275d661de9adafb`
   - 명령(Git Bash, 워크트리 루트): `node -e "const fs=require('fs'),c=require('crypto');for(const p of process.argv.slice(1))console.log(p,c.createHash('sha256').update(fs.readFileSync(p,'utf8').replace(/
/g,'
')).digest('hex'))" backend/jobs/molitHistBackfill.js backend/test/molit-hist-backfill.test.js`
2. `npm run verify` 체인 전체 exit 0 — backend 테스트 601 → **605**.
3. `git diff master --stat` = `backend/jobs/molitHistBackfill.js` · `backend/test/molit-hist-backfill.test.js` · `plans/131-hist-patch-hwaseong-202505.md` 뿐.
4. 배포 후(계획자, 다음 이력 cron 슬롯 뒤 — 읽기 전용 실측): `molit_hist_runs` 에 3쌍(rows 값) · 이력 2025-05 화성 지역별 행수(만세·효행·병점 > 0, 동탄 499 유지) · 이력 전체에서 (apt_seq, deal_date, exclu_use_ar, deal_amount, floor) 완전 중복이 늘지 않음 · 기준선 ≡ 이력 집계(불일치 0) · Sentry 신규 0.

## 6. 유지보수
- 세 쌍이 `molit_hist_runs` 에 기록되면 이 경로는 더 돌지 않는다(상수는 실행 기록으로 남긴다).
- 같은 유형이 다시 생기지 않게 하는 장치는 Plan 130(자르기 전 구멍 0 보장)과 107c 절차의 P5 다.
