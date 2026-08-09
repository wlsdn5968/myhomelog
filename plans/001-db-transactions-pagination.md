# Plan 001: 실거래 DB 조회에 1000행 페이징을 넣어 고거래량 월의 조용한 데이터 누락을 없앤다

> **Executor instructions**: 이 계획을 단계 순서대로 따르라. 각 단계의 검증 명령을 실행해
> 기대 결과를 확인한 뒤 다음 단계로 넘어가라. "STOP conditions" 가 발생하면 멈추고 보고하라 —
> 임의로 우회하지 마라. 완료하면 `plans/README.md` 의 이 계획 상태 행을 갱신하라.
>
> **Drift check (가장 먼저 실행)**: `git diff --stat b63da64..HEAD -- backend/services/transactionService.js backend/test/characterization.test.js`
> in-scope 파일이 이 계획 작성 이후 변경됐다면 "Current state" 발췌와 실제 코드를 대조하고,
> 불일치하면 STOP 조건으로 처리하라.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `b63da64`, 2026-08-09

## Why this matters

`getTransactionsFromDb(lawdCd, dealYm)` 는 한 달치 실거래를 `.limit(1000)` 단일 호출로 조회하는데,
Supabase PostgREST 는 응답당 1000행에서 서버가 자른다. **2026-08-09 DB 실측으로 1000건 초과
(lawd_cd, 월) 조합이 7개 실존함을 확인**했다 — 최대 화성동탄(41597) 2026-06 = 1,905건으로
905건(47%)이 조용히 누락된 채 정상 응답된다. 이 함수는 공개 API `GET /api/transactions` 와
가격 집계(`getTransactionsByApt` → analysis/report)의 소스라, 서비스의 핵심 가치인
"국토부 공식 실거래 정확 인용"을 직접 훼손한다. 같은 파일에 이미 검증된 페이징 패턴이 있어
수정은 그 패턴의 이식이다.

## Current state

- `backend/services/transactionService.js` — 실거래 조회 서비스.
  - **문제 지점** `getTransactionsFromDb`, 60~67행 (b63da64 기준):
    ```js
    const { data, error } = await admin
      .from('molit_transactions')
      .select('apt_name, sigungu, umd_nm, exclu_use_ar, build_year, floor, deal_year, deal_month, deal_day, deal_amount, lawd_cd, apt_seq')
      .eq('lawd_cd', lawdCd)
      .gte('deal_date', _mFrom)
      .lt('deal_date', _mNext)
      .order('deal_date', { ascending: false })
      .limit(1000);
    ```
  - **모범 패턴(같은 파일)** `getRegionRecentTransactions`, 113~127행 — 과거 같은 결함을
    "REST-CAP-FIX-2026-07-10" 주석과 함께 고친 코드. 이 모양을 그대로 따르라:
    ```js
    const PAGE = 1000;
    let data = [];
    for (let from = 0; from <= 11000; from += PAGE) {
      const { data: page, error } = await admin
        .from('molit_transactions')
        .select('...')                       // 동일 컬럼
        .eq('lawd_cd', lawdCd)
        .gte('deal_date', sinceStr)
        .order('deal_date', { ascending: false })
        .order('id', { ascending: false })   // ★ 2차 정렬키 — 동점 페이지 경계 중복/누락 차단
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (page && page.length) data = data.concat(page);
      if (!page || page.length < PAGE) break;
    }
    ```
- 레포 컨벤션: 수정부 상단에 한글 주석 헤더 `// REST-CAP-FIX-2026-XX-XX (Plan 001): ...` 형식으로
  근거(실측 수치 포함)를 남긴다. 기존 60행 위 주석(PERF-2026-06-13)은 유지.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| 테스트 | `cd backend && npm test` | 전부 pass (계획 작성 시점 12개) |
| 구문 확인 | `cd backend && node -c services/transactionService.js` | exit 0, 출력 없음 |

## Scope

**In scope** (수정 허용 파일):
- `backend/services/transactionService.js` — `getTransactionsFromDb` 내부 쿼리만
- `backend/test/characterization.test.js` — 테스트 추가(선택 단계)

**Out of scope** (건드리지 마라):
- `getRegionRecentTransactions`(이미 정상)·MOLIT 외부 API 폴백 경로(`fetchRegionMonthFromApi` 등) —
  이미 자체 페이징이 있다.
- 캐시 키·TTL·함수 시그니처·응답 형태 — 호출부가 의존한다.
- `backend/jobs/molitIngest.js`, `backend/services/rentService.js` — 유사 패턴이 보여도 이 계획 범위 아님.

## Git workflow

- 커밋 메시지 스타일: `fix(tx): 실거래 DB 월 조회 1000행 페이징 - 고거래 월 최대 47% 누락 (Plan 001)`
  (레포 컨벤션: `fix(area): 한글 설명` — `git log --oneline -10` 으로 확인 가능)
- push 는 운영자 지시 없이 하지 마라.

## Steps

### Step 1: `getTransactionsFromDb` 쿼리를 range 페이징 루프로 교체

60~67행의 단일 `.limit(1000)` 쿼리를 위 "모범 패턴" 모양의 루프로 교체하라. 차이점만 주의:
- 필터는 기존 그대로 `.gte('deal_date', _mFrom).lt('deal_date', _mNext)` 유지(월 범위).
- `.order('id', { ascending: false })` 2차 정렬키를 반드시 추가.
- 루프 상한은 모범 패턴과 동일하게 `from <= 11000`(최대 12페이지 안전마진).
- 루프 결과가 빈 배열이면 기존 코드의 후속 처리(반환 형태)를 그대로 타게 하라 — 68행 이후
  `return (data || []).map(...)` 은 변경하지 않는다.

**Verify**: `cd backend && node -c services/transactionService.js` → exit 0

### Step 2: 로컬 스모크 — 함수 형태 회귀 없음

**Verify**: `cd backend && npm test` → 전부 pass (기존 테스트에 이 함수 직접 커버는 없지만
모듈 로드 회귀를 잡는다)

### Step 3 (선택·권장): 페이징 경계 계약 테스트 추가

`backend/test/characterization.test.js` 끝에, `getTransactionsFromDb` 를 직접 호출하는 대신
**페이지 병합 로직을 검증하는 순수 테스트**를 추가하라. DB 모킹이 부담스러우면 이 단계는
생략 가능하다(STOP 아님) — 그 경우 Done criteria 의 해당 항목을 건너뛴 사유와 함께
`plans/README.md` 상태에 "테스트 생략" 을 명기하라.

## Test plan

- (Step 3) 1000행 정확히 = 다음 페이지 계속 조회 / 999행 = 루프 종료 — 페이지 병합 헬퍼를
  함수로 추출했다면 그 함수에 대한 단위 테스트 2건. 구조 패턴은 같은 파일의
  `cronStats._pick` 테스트를 모범으로.
- 검증: `cd backend && npm test` → 전부 pass.

## Done criteria

- [ ] `cd backend && node -c services/transactionService.js` exit 0
- [ ] `cd backend && npm test` 전부 pass
- [ ] `getTransactionsFromDb` 내부에 `.range(` 와 `.order('id'` 가 존재하고 `.limit(1000)` 이 사라짐:
      `grep -n "limit(1000)" backend/services/transactionService.js` → `getTransactionsFromDb` 범위(약 40~100행)에 매치 없음
- [ ] in-scope 밖 파일 무변경 (`git status --short`)
- [ ] `plans/README.md` 상태 행 갱신

## STOP conditions

- "Current state" 발췌와 실제 코드가 불일치(드리프트).
- `npm test` 가 수정 전부터 실패(기준선 붕괴 — 이 계획의 문제가 아님).
- 수정이 함수 시그니처나 반환 형태 변경을 요구하는 것으로 보일 때 — 그럴 리 없다. 그렇게
  보이면 이해가 어긋난 것이니 멈추고 보고하라.

## Maintenance notes

- 향후 `molit_transactions` 가 월 12,000건을 넘는 지역이 생기면 루프 상한(11000)을 올려야 한다 —
  molitIngest 의 MAX_PAGES 경고 패턴처럼 상한 도달 시 logger.warn 을 남기는 개선은 후속 자유.
- 리뷰 포인트: 2차 정렬키 `id` 누락 여부(누락 시 페이지 경계 중복/누락 재발).
