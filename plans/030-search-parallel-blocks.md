# Plan 030: 검색 두 핫패스에서 서로 기다릴 이유가 없는 조회를 병렬로 돌린다

> **Executor instructions**: 단계별로 따르라. 각 단계의 검증 명령을 실제로 실행하고 기대 결과를
> 확인한 뒤 다음으로 넘어가라. "STOP conditions" 에 해당하면 **즉시 멈추고 보고**하라.
> 끝나면 `plans/README.md` 의 상태 행을 갱신하라.
>
> **Drift check (가장 먼저)**: `git diff --stat 530ca3c..HEAD -- backend/routes/search.js`
> 바뀌었으면 아래 "Current state" 인용과 실제 코드를 대조하고, 다르면 STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `530ca3c`, 2026-08-17

## Why this matters

`backend/routes/search.js` 의 두 핫패스에서, **서로의 결과를 전혀 쓰지 않는 조회가 순차로** 돈다.

- `/api/search/in-bounds` — 지도를 움직일 때마다 호출된다. 거래 조회와 단지 alias 조회가 순차다.
- `/api/search/facility` — 단지 상세 모달을 열 때 호출된다. 파일 주석이 이 경로를 "모달당 이중호출"
  로 명시하고 과거 실측 4.7~7.3s 를 언급한다. 학교/학원 조회와 alias 후보 조회가 순차다.

둘 다 앞 결과를 뒤에서 참조하지 않는다는 것을 코드로 확인했다. 즉 **의존관계가 없는데 기다리는**
구조이고, `Promise.all` 로 묶는 것만으로 그 구간의 대기가 겹쳐진다. 새 인프라도, 캐시 정책 결정도
필요 없다.

## Current state

### A) `/in-bounds` — 두 페이징 루프가 순차

`backend/routes/search.js:663` 부터 거래 페이징:

```js
    const txs = [];
    for (let _from = 0; _from <= 9000; _from += 1000) {
      let _q = admin
        .from('molit_transactions')
        .select('apt_name, sigungu, umd_nm, deal_amount, build_year, deal_date, lawd_cd')
        .in('apt_name', names);
      if (umds.length) _q = _q.in('umd_nm', umds); // 동 스코프 — 전국 동명 충돌 차단 + row budget 보호
      const { data: _page } = await _q
        .gte('deal_date', _cut180)
        .order('deal_date', { ascending: false })
        .order('id', { ascending: false })
        .range(_from, _from + 999);
      if (_page && _page.length) txs.push(..._page);
      if (!_page || _page.length < 1000) break;
    }
```

그 뒤 `backend/routes/search.js:700` 부터 단지 alias 페이징:

```js
      const masters = [];
      for (let _mf = 0; _mf <= 4000; _mf += 1000) {
        const { data: _mp } = await admin
          .from('apt_master')
          .select('apt_name, sigungu, umd_nm, kapt_code, molit_aliases')
          .in('umd_nm', umds)
          .not('molit_aliases', 'is', null)
          .order('kapt_code', { ascending: true })
          .range(_mf, _mf + 999);
        if (_mp && _mp.length) masters.push(..._mp);
        if (!_mp || _mp.length < 1000) break;
      }
```

**의존관계 확인**: 두 루프 모두 그 앞에서 이미 계산된 `names` / `umds` 만 쓴다.
`masters` 루프는 `txs` 를 참조하지 않고, `txs` 루프도 `masters` 를 참조하지 않는다.
두 결과를 합치는 코드는 **양쪽이 다 끝난 뒤**에 온다.

### B) `/facility` — 학교 블록과 alias 후보 블록이 순차

`backend/routes/search.js:831` 부터 학교/학구도/학원 블록(요약):

```js
    if (mode !== 'basic') try { // FACILITY-SPLIT (Sprint IIII): basic 은 Kakao/NEIS 콜 전부 스킵
      const coord = await resolveCoord({ ... });
      if (coord?.lat && coord?.lng) {
        const [schools, district, academies] = await Promise.all([ ... ]);
```

그 뒤 `backend/routes/search.js:866` 부터 alias 후보 블록:

```js
    let altCandidates = [];
    if (mode !== 'schools' && sigungu && umdNm) { // FACILITY-SPLIT: schools 는 alias DB 조회 불필요
      const { data: alts } = await admin
        .from('molit_transactions')
        .select('apt_name, build_year')
        .eq('sigungu', sigungu)
        .eq('umd_nm', umdNm)
        .neq('apt_name', aptName)
        .limit(500);
```

**의존관계 확인**: alias 블록은 `req.query` 에서 온 `aptName` / `sigungu` / `umdNm` 만 쓴다.
앞 블록이 만든 `facility` / `coord` / `nearbySchools` 를 **전혀 참조하지 않는다.**

### 이 저장소의 관련 관례 (지켜야 한다)

- 병렬 조회의 개별 실패가 서로를 죽이지 않게 **각 promise 에 `.catch` 를 단다.** 같은 파일
  `backend/routes/search.js:842-846` 이 이미 그 패턴이다(`.catch(e => { logger.debug(...); return []; })`).
- 강등(degrade)은 조용히 넘어가지 않고 카운터로 관측한다 — 같은 파일의 `_observeDegrade`.
  **이 계획에서 새 강등 종류를 만들지는 마라.** 동작을 바꾸지 않는 것이 목표다.

## Commands you will need

| 목적 | 명령 | 성공 시 기대 |
|---|---|---|
| 문법 | `node -c backend/routes/search.js` | exit 0 |
| 백엔드 테스트 | `cd backend && npm test` | 72 pass, 0 fail |
| 보안 가드 | `node scripts/security-regression-check.js` | 위반 0건 |
| lint | `node scripts/extract-inline-js.js && npx eslint backend scripts api .lint-tmp` | exit 0 |

## Scope

**In scope**:
- `backend/routes/search.js`
- `plans/README.md` (상태 행)

**Out of scope** (건드리지 마라):
- **캐시 도입 금지.** `/in-bounds` 나 `/facility` 에 `cache.get/set` 을 추가하지 마라.
  감사에서 검토했고 **의도적으로 기각**했다 — 지도 bounds 는 연속값이라 격자 키 없이는 히트율이
  사실상 0이고, 격자를 쓰면 마커 누락/과다라는 정확도 리스크가 생긴다. 트래픽 실측 없이 넣으면 손해다.
- `_observeDegrade`, abort 상한, `_softQuery` — 오늘 별도 계획으로 다뤘다. 손대지 마라.
- 응답 JSON 의 필드 이름·구조 — 프론트가 의존한다. **한 글자도 바꾸지 마라.**
- `backend/routes/report.js` — 다른 계획(032)이 다룬다.

## Git workflow

- 브랜치: `advisor/030-search-parallel-blocks`
- 커밋 메시지: `perf(search): <한글 설명>` — 본문에 [근본 원인] [Fix 내용] [회귀 위험] 명시
- **push·PR 금지.** 운영자가 별도로 지시한다.

## Steps

### Step 1: `/in-bounds` 두 페이징 루프를 함수로 추출

각 루프를 **로직 변경 없이** 지역 async 함수로 감싼다. 페이지 크기·상한(`9000`, `4000`)·정렬 키·
필터 조건을 **하나도 바꾸지 마라** — 그 값들은 각각 주석에 근거가 적혀 있다.

목표 형태:

```js
    const _fetchTxs = async () => {
      const txs = [];
      // (기존 루프 본문 그대로)
      return txs;
    };
    const _fetchMasters = async () => {
      const masters = [];
      // (기존 루프 본문 그대로)
      return masters;
    };
```

**Verify**: `node -c backend/routes/search.js` → exit 0

### Step 2: 두 함수를 `Promise.all` 로 묶기

```js
    const [txs, masters] = await Promise.all([_fetchTxs(), _fetchMasters()]);
```

주의:
- `masters` 루프가 원래 **조건문 안**에 있었다면(예: `umds.length` 가 있을 때만) 그 조건을
  **그대로 유지**하라. 조건이 거짓일 때는 빈 배열을 돌려주면 된다.
- 두 결과를 쓰는 뒤쪽 코드는 **그대로 둔다.**

**Verify**:
- `node -c backend/routes/search.js` → exit 0
- `cd backend && npm test` → 72 pass

### Step 3: `/facility` 의 alias 후보 블록을 앞 블록과 병렬로

alias 블록을 async 함수로 감싸고, 학교 블록과 `Promise.all` 로 묶는다.

```js
    const _fetchAltCandidates = async () => {
      if (!(mode !== 'schools' && sigungu && umdNm)) return [];
      // (기존 본문 그대로 — 마지막에 altCandidates 배열을 return)
    };
```

그리고 학교 블록도 async 함수로 감싼 뒤:

```js
    const [, altCandidates] = await Promise.all([_schoolsBlock(), _fetchAltCandidates()]);
```

**중요**:
- 두 블록 모두 **기존 try/catch 를 유지**하라. 한쪽 실패가 다른 쪽을 죽이면 안 된다
  (그게 지금 동작이다 — 병렬화로 실패 격리가 약해지면 회귀다).
- `nearbySchools` / `schoolDistrict` / `nearbyAcademies` 는 상위 스코프 변수다. 함수 안에서
  그 변수들에 대입하는 현재 방식을 유지해도 된다 — **응답 조립 코드를 바꾸지 않는 것이 우선**이다.

**Verify**:
- `node -c backend/routes/search.js` → exit 0
- `cd backend && npm test` → 72 pass

### Step 4: 전체 게이트

**Verify** (전부 통과):
- `cd backend && npm test` → 72 pass, 0 fail
- `node scripts/security-regression-check.js` → 위반 0건
- `node scripts/extract-inline-js.js && npx eslint backend scripts api .lint-tmp` → exit 0

### Step 5: 응답 구조가 안 바뀌었음을 스스로 증명

이 계획의 유일한 진짜 위험은 **응답이 미묘하게 달라지는 것**이다. 코드로 확인하라:

- `git diff backend/routes/search.js` 를 열어, `res.json(...)` 에 들어가는 **키 이름과 값 표현식이
  하나도 바뀌지 않았는지** 직접 대조하라.
- 바뀐 줄이 "함수로 감싸기 / `Promise.all` / 들여쓰기" 외의 것을 포함하면 STOP.

**Verify**: `git diff --stat backend/routes/search.js` → 변경이 `search.js` 1개 파일에만 있고,
diff 를 읽었을 때 응답 조립부에 **의미 변경이 없음**을 확인.

## Test plan

- **새 단위 테스트는 만들지 않는다.** 이유: 이 두 라우트는 Supabase 실 연결과 외부 API(Kakao/NEIS)에
  의존해 로컬에서 의미 있게 돌릴 수 없고, 이 계획은 **동작을 바꾸지 않는 리팩터**다.
  기존 72개가 전부 통과하는 것이 회귀 없음의 1차 근거다.
- **배포 후 라이브 검증이 실제 검증이다.** 운영자가 배포한 뒤 아래를 확인하도록 보고서에 적어라:
  - 지도를 움직여 `/api/search/in-bounds` 가 마커를 이전과 같은 개수로 그리는지
  - 단지 상세 모달에서 학교·학원·"다른 이름 후보(alias)" 가 이전과 같이 나오는지
  - `/api/health` 의 `searchDegrade` 카운터가 **새로 늘지 않는지**(늘면 병렬화가 실패를 유발한 것)

## Done criteria

- [ ] `node -c backend/routes/search.js` → exit 0
- [ ] `cd backend && npm test` → **72 pass, 0 fail** (증감 없음)
- [ ] `node scripts/security-regression-check.js` → 위반 0건
- [ ] eslint exit 0
- [ ] `git diff` 상 응답 조립부(키 이름·값 표현식)에 변경이 없다
- [ ] `cache.get` / `cache.set` 이 `/in-bounds`·`/facility` 핸들러에 **추가되지 않았다**
      (`git diff` 로 확인 — 추가됐다면 Out of scope 위반)
- [ ] In scope 외 파일 무변경 (`git status`)
- [ ] `plans/README.md` 상태 행 갱신

## STOP conditions

- 두 루프/블록 사이에 **내가 못 본 의존관계**가 있다(뒤 블록이 앞 블록의 변수를 읽는다).
  → 병렬화하면 안 된다. 어떤 변수인지 보고하라.
- `Promise.all` 로 묶은 뒤 테스트가 깨진다. → 한 번 고쳐보고 또 깨지면 STOP.
- 페이지 상한(`9000`/`4000`)이나 `limit(500)` 을 바꿔야 할 것 같다는 판단이 든다.
  → **바꾸지 마라.** 그건 이 계획의 범위가 아니다.
- 응답에 새 필드를 넣거나 기존 필드 이름을 바꿔야 할 것 같다. → STOP.

## Maintenance notes

- 앞으로 이 두 핸들러에 조회를 추가할 때, **앞 결과를 쓰지 않는 조회라면 `Promise.all` 배열에
  넣는 것이 기본**이다. 순차로 붙이면 이 계획이 되돌려진다.
- 리뷰 포인트: 병렬화한 각 promise 에 `.catch` 가 있는지. 없으면 하나의 실패가 전체를 500 으로
  만들어 **강등 설계가 무너진다** — 이 저장소가 여러 번 겪은 사고 유형이다.
- 캐시는 의도적으로 넣지 않았다. 나중에 검토한다면 **먼저 히트율을 실측**할 것 —
  bounds 가 연속값이라 그냥 넣으면 메모리만 쓰고 히트가 안 난다.
