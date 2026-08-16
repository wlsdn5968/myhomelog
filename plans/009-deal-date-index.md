# Plan 009: `molit_transactions.deal_date` 인덱스 추가로 "최신 거래일" 조회 2.2초 제거

> **Executor instructions**: 이 계획을 단계대로 따르라. 각 단계의 검증 명령을 실행해
> 기대 결과를 확인한 뒤 다음 단계로 가라. "STOP conditions" 에 해당하면 멈추고 보고하라.
> 완료하면 `plans/README.md` 의 이 계획 행 Status 를 갱신하라.
>
> ⚠ **이 계획은 코드 변경이 아니라 DB 스키마(DDL) 변경이다.** 아래 "실행 게이트" 를 반드시 읽어라.
>
> **Drift check (가장 먼저 실행)**:
> `git diff --stat 9031f65..HEAD -- backend/routes/news.js backend/routes/report.js`
> 바뀌었다면 아래 "Current state" 발췌와 실제 코드를 대조하라. 다르면 STOP 조건이다.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `9031f65`, 2026-08-16

## ⚠ 실행 게이트 (먼저 읽어라)

이 저장소의 절대 룰: **공유 production DB 를 임의로 수정하지 않는다.**
`CLAUDE.md` 에 "공유 production DB 직접 수정 금지 (auto-mode classifier 차단 정상) —
운영자 명시 승인 후만 적용" 으로 명시돼 있고, 실제로 자동 차단이 걸린다.

따라서 Step 2(DDL 실행)는 **운영자의 명시 승인 없이는 실행하지 마라.**
승인이 없으면 Step 1(근거 재확인)까지만 하고, SQL 을 제시한 뒤 STOP 하라.

## Why this matters

"실거래 최신 반영월" 1건을 얻는 단순 조회가 **2,236ms** 걸린다. 이 값은 보고서의 데이터 기준
표기와 뉴스 3줄 시황에 쓰이며, 두 경로 모두 **공개키(anon) 로 조회**한다.

anon 역할의 `statement_timeout` 은 **3초**다. 즉 지금은 정상 동작하지만 여유가 0.8초뿐이라,
DB 부하가 조금만 올라가면 타임아웃으로 넘어간다. 실제로 같은 표(`molit_transactions`)에서
2026-08-16 에 검색 경로가 이 3초 컷에 반복적으로 걸린 이력이 있다.

원인은 인덱스 부재다. 기존 `idx_molit_lawd_date` 는 `(lawd_cd, deal_date DESC)` 복합 인덱스라
**선행 컬럼(lawd_cd) 조건이 없는 전역 정렬에는 쓸 수 없어**, 인덱스 전체(435,613행)를 훑은 뒤
top-N 정렬한다. `deal_date` 단독 인덱스 하나면 이 조회는 인덱스 끝에서 1행만 읽고 끝난다.

## Current state

### 실측 (2026-08-16, 프로덕션 DB)

```
EXPLAIN (ANALYZE, TIMING OFF, SUMMARY ON)
SELECT deal_date FROM molit_transactions ORDER BY deal_date DESC LIMIT 1;

Limit  (cost=10577.00..10577.11 rows=1) (actual rows=1 loops=1)
  ->  Gather Merge  (rows=256243) (actual rows=1 loops=1)
        ->  Sort  (rows=256243) (actual rows=1 loops=2)
              Sort Key: deal_date DESC
              Sort Method: top-N heapsort  Memory: 25kB
              ->  Parallel Index Only Scan using idx_molit_lawd_date
                    (actual rows=217806 loops=2)
                    Heap Fetches: 82613
Execution Time: 2236.517 ms
```

**행 217,806 × 2 워커 = 전체를 훑고 있다.** `Heap Fetches: 82613` 도 비용에 더해진다.

### 이 쿼리를 쓰는 곳 — 2곳 (둘 다 필터 없는 전역 정렬)

`backend/routes/news.js:169-175` — 뉴스 3줄 시황의 "실거래 반영월" 라인:

```js
      const CK = 'news:txlatest';
      let latest = cache.get(CK);
      if (latest === undefined) {
        const { data } = await admin.from('molit_transactions').select('deal_date').order('deal_date', { ascending: false }).limit(1);
        latest = data && data[0] && data[0].deal_date ? String(data[0].deal_date) : null;
        cache.set(CK, latest, 21600);
      }
```

`backend/routes/report.js:576-581` — 보고서의 데이터 기준 표기:

```js
    const { data } = await admin
      .from('molit_transactions')
      .select('deal_date')
      .order('deal_date', { ascending: false })
      .limit(1);
    const latest = data && data[0] && data[0].deal_date ? String(data[0].deal_date) : null;
```

두 곳 모두 로컬 캐시(6h)가 있지만 **서버리스라 인스턴스마다 별개**이므로, 콜드 인스턴스는 매번
2.2초를 지불한다.

### 기존 인덱스 (2026-08-16 실측)

```
idx_molit_apt_seq        btree (apt_seq) WHERE apt_seq IS NOT NULL
idx_molit_aptname_trgm   gin (apt_name gin_trgm_ops)
idx_molit_lawd_date      btree (lawd_cd, deal_date DESC)     ← 선행 컬럼 때문에 전역 정렬 불가
idx_molit_umdnm_trgm     gin (umd_nm gin_trgm_ops)
molit_transactions_pkey  btree (id)
uq_molit_dedup           btree (dedup_key)
```

`deal_date` **단독** 인덱스가 없다.

## Commands you will need

| 목적 | 명령 | 성공 시 기대 결과 |
|---|---|---|
| 백엔드 테스트 | `cd backend && npm test` | exit 0, 41 pass (이 계획은 코드 무변경이라 그대로여야 함) |
| 프로덕션 health | `GET https://myhomelog.vercel.app/api/health` | `status: "ok"` |

DB 접근은 Supabase MCP(`execute_sql`) 또는 Supabase 콘솔 SQL Editor 를 쓴다.
프로젝트 id: `brxorvxdfrbxcavufspe` (이 값은 `CLAUDE.md` 에 공개 기재된 프로젝트 식별자다).

## Scope

**In scope**:
- DB 스키마: `molit_transactions` 에 인덱스 1개 추가
- `plans/README.md` 상태 갱신

**Out of scope** (손대지 마라):
- `backend/routes/news.js`, `backend/routes/report.js` — **코드는 바꾸지 않는다.** 인덱스만으로
  해결된다. 쿼리를 "최적화" 한다며 고쳐 쓰지 마라.
- 기존 인덱스 삭제·변경 — 특히 `idx_molit_lawd_date` 는 지역별 조회가 쓰고 있다.
- Redis 2차 캐시 도입 — 별개 사안이고, 인덱스가 들어가면 이 경로에서는 이득이 거의 없다.

## Steps

### Step 1: 현재 비용을 재측정해 계획의 전제를 확인한다

아래를 실행한다(읽기 전용):

```sql
EXPLAIN (ANALYZE, TIMING OFF, SUMMARY ON)
SELECT deal_date FROM molit_transactions ORDER BY deal_date DESC LIMIT 1;
```

**Verify**: `Execution Time` 이 **1000ms 이상**이고, 계획에 `Sort` + `Index Only Scan using
idx_molit_lawd_date`(또는 Seq Scan)가 보인다.

> 만약 이미 1ms 수준이거나 `idx_molit_deal_date` 를 쓰고 있다면 **누군가 이미 인덱스를 만든 것**이다 —
> STOP 하고 보고하라.

### Step 2: 인덱스를 생성한다 (⚠ 운영자 승인 필수)

위 "실행 게이트" 를 다시 확인하라. 승인이 없으면 여기서 멈추고 이 SQL 을 제시만 하라.

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_molit_deal_date
  ON molit_transactions (deal_date DESC);
```

`CONCURRENTLY` 를 쓰는 이유: 이 표는 서비스가 상시 읽는다. 일반 `CREATE INDEX` 는 쓰기 락을 걸어
적재 cron 과 충돌할 수 있다.

⚠ `CREATE INDEX CONCURRENTLY` 는 **트랜잭션 블록 안에서 실행할 수 없다.** 다른 문장과 묶어
한 번에 보내지 말고 **이 문장만 단독으로** 실행하라.

**Verify**:

```sql
SELECT indexname, indexdef FROM pg_indexes
WHERE tablename = 'molit_transactions' AND indexname = 'idx_molit_deal_date';
```
→ 1행이 나오고 `indexdef` 에 `(deal_date DESC)` 가 포함된다.

그리고 인덱스가 **유효한지** 확인한다(CONCURRENTLY 는 실패 시 무효 인덱스를 남긴다):

```sql
SELECT c.relname, i.indisvalid
FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE c.relname = 'idx_molit_deal_date';
```
→ `indisvalid = true`

> `indisvalid = false` 면 인덱스 생성이 중간에 실패한 것이다. `DROP INDEX idx_molit_deal_date;`
> 로 지우고 STOP 후 보고하라 — 재시도 여부는 운영자가 정한다.

### Step 3: 효과를 실측한다

Step 1 과 **완전히 같은** EXPLAIN 을 다시 실행한다.

**Verify**: `Execution Time` 이 **10ms 미만**이고, 계획에 `Index Only Scan using
idx_molit_deal_date` 가 나타나며 `Sort` 노드가 사라진다.

> 인덱스를 만들었는데도 플래너가 안 쓴다면 통계가 오래된 것일 수 있다.
> `ANALYZE molit_transactions;` 를 한 번 실행하고 다시 측정하라. 그래도 안 쓰면 STOP 후 보고.

### Step 4: 실제 엔드포인트가 정상인지 확인한다

인덱스는 읽기 경로만 바꾸므로 응답 내용은 동일해야 한다.

```
GET https://myhomelog.vercel.app/api/news/summary
```

**Verify**: HTTP 200, 응답의 `summary` 배열에 `실거래 YYYY.MM월분까지 반영` 문구가 포함된
줄이 있고, 그 연월이 Step 1/3 의 EXPLAIN 대상 데이터와 모순되지 않는다(최신 거래월).

또한 `cd backend && npm test` → exit 0, **41 pass**(코드를 안 바꿨으므로 테스트 수 변화 없음).

## Test plan

이 계획은 **코드 변경이 없어 새 단위 테스트를 추가하지 않는다.** 검증은 다음 3가지다:

1. EXPLAIN 전/후 비교(Step 1 vs Step 3) — 2,236ms → 10ms 미만, `Sort` 노드 소멸.
2. 인덱스 유효성(`indisvalid = true`).
3. 엔드포인트 응답 동일성(Step 4).

기존 41개 테스트는 그대로 통과해야 한다(회귀 없음 확인용).

## Done criteria

전부 만족해야 한다:

- [ ] `idx_molit_deal_date` 가 존재하고 `indisvalid = true`
- [ ] Step 3 EXPLAIN 의 `Execution Time` < 10ms, 계획에 `Index Only Scan using idx_molit_deal_date`
- [ ] `GET /api/news/summary` → 200, "실거래 …월분까지 반영" 문구 정상
- [ ] `cd backend && npm test` exit 0, 41 pass
- [ ] `git status` — **코드 변경 0** (`plans/README.md` 외 수정 파일 없음)
- [ ] `plans/README.md` 의 009 행 Status 갱신

## STOP conditions

멈추고 보고하라:

- 운영자 승인 없이 Step 2 에 도달했다 → 승인 없이 실행 금지.
- Step 1 측정이 이미 빠르다(1ms 수준) → 인덱스가 이미 있거나 전제가 틀렸다.
- `indisvalid = false` (CONCURRENTLY 실패).
- `ANALYZE` 후에도 플래너가 새 인덱스를 안 쓴다.
- 인덱스 생성 후 `/api/health` 또는 적재 cron 에 에러가 관측된다.
- 인덱스 생성이 5분 넘게 끝나지 않는다 → 락 경합 가능성. 중단하고 보고.

## Maintenance notes

- **되돌리기**: `DROP INDEX CONCURRENTLY IF EXISTS idx_molit_deal_date;` — 추가만 하는 변경이라
  기존 데이터·쿼리에 영향이 없다.
- 인덱스는 쓰기(적재 cron) 비용을 아주 조금 늘린다. `molit_transactions` 는 하루 1회 배치 적재라
  실질 영향은 무시할 수준이지만, 향후 실시간 쓰기가 늘면 재평가할 것.
- 이 표에는 이미 GIN 2개 + btree 3개가 있다. **인덱스를 더 늘리기 전에는 항상 EXPLAIN 으로
  근거를 만들어라** — 이 저장소에는 "GIN trgm 을 추가했더니 오히려 느려진" 실측 이력이 있다
  (`backend/routes/search.js` 의 SEARCH-ABORT 주석 참조).
- 리뷰어가 볼 곳: 코드가 정말 안 바뀌었는지(`git status`), 인덱스 정의가 `DESC` 인지.
