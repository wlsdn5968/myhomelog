# 113 — health `dataSyncedAt`/`lastIngestedAt` 가 null 로 굳는 회귀 (랜딩·브리핑 "동기화" 표기 소실)

**작성 기준 커밋**: `591f5fa` (2026-09-26) · 성격: **사용자 노출 회귀** · 승인: 운영자 2026-09-26 "권고대로 진행"(후속표 1번 검증 중 발견)

## 전제 확인 (계획자가 프로덕션·코드로 직접 확인 — 2026-09-26 06:0xZ)
1. `/api/health` 를 10분 간격으로 **3회** 조회 — 매번 `dataSyncedAt: null`, `dataCounts.lastIngestedAt: null`. 같은 응답의 `dataCounts.tx` 는 476,716 으로 정상.
2. DB 실측: `select max(ingested_at) from molit_transactions` = **2026-09-25 17:45:08Z**(어제 적재 정상). 즉 데이터는 신선한데 health 만 모른다.
3. 산출 코드 `backend/server.js:488-518` `getDataCounts()`:
   ```js
   const [tx, apt, lastIngest] = await Promise.all([
     admin.from('molit_transactions').select('*', { count: 'exact', head: true }),
     admin.from('apt_master').select('*', { count: 'exact', head: true }),
     admin.from('molit_transactions').select('ingested_at').order('ingested_at', { ascending: false }).limit(1).maybeSingle(),
   ]);
   const out = { tx: tx.count || 0, apt: apt.count || 0, lastIngestedAt: lastIngest?.data?.ingested_at || null };
   cache.set(CK, out, 21600); // 6h
   redisCache.rset(CK, out, 21600).catch(() => {});
   ```
   supabase-js 는 쿼리 실패 시 **throw 하지 않고** `{ data: null, error }` 를 돌려준다 → `lastIngestedAt: null` 인 객체가 그대로 **6시간 메모리 캐시 + Redis(인스턴스 간 공유)** 에 저장된다. 한 번의 실패가 전체 인스턴스를 6시간 오염시킨다.
4. 왜 실패하나 — **`ingested_at` 에 인덱스가 없다**(`schema.sql` 선언 0건). `explain (analyze, buffers)` 실측:
   `Parallel Seq Scan on molit_transactions (actual rows=238358 loops=2)` · `Buffers: shared hit=13397 read=4`(= **웜 상태**) · **Execution Time: 3,945 ms**.
   PostgREST 접속 역할 `authenticator` 의 `statement_timeout = 8s`(`pg_db_role_setting` 실측, `service_role` 자체 설정은 없어 세션값을 따른다). 웜 3.9초가 콜드·동시부하에서 8초를 넘으면 실패 → 3번 경로. 코드 주석의 "975ms" 는 34만 행 시절 값이고 지금은 476,716행이다.
5. 소비처(전부 사용자 노출): `frontend/index.html:3872`(랜딩 "N월 N일 동기화")·`:5654`·`:8440`·`:12572`, `backend/services/briefingService.js:98`·`backend/routes/briefing.js:35`(브리핑 `syncedAt`). null 이면 표기가 **조용히 사라진다**.
6. 대체 소스 실측: `molit_ingest_runs`(7,181행, `idx_molit_runs_status` 있음) 의 `max(finished_at) where status='ok'` = **2026-09-25 17:45:12Z** — `max(ingested_at)` 과 **4초 차이**. 의미("마지막 성공 적재 시각")가 같다.

## 범위
**건드릴 파일**: `backend/server.js`(getDataCounts 만) · `backend/test/data-counts-sync.test.js`(신규)
**건드리지 말 것**: `getDbUsage()`·`getFacilityQuality()` 등 이웃 함수 · `frontend/index.html` · `briefingService.js` · **DDL(`ingested_at` 인덱스) — 하지 않는다**(≈4MB 를 쓰느니 무료 소스로 바꾼다) · `backend/jobs/pushNotify.js:131`(같은 클래스의 seq scan 이지만 구독자 2명이라 지금은 무해 — §참고에만 기록).

## Step 1 — 3번째 쿼리를 `molit_ingest_runs` 로 교체
```js
      // SYNC-SOURCE-2026-09-26 (Plan 113): 종전 `order('ingested_at', desc).limit(1)` 은 인덱스가 없어
      //   476K 행 병렬 seq scan(웜 3.9초 실측)이라 authenticator 의 statement_timeout 8s 에 걸리면
      //   null 이 6시간 캐시에 굳었다(2026-09-26 실사고 — 랜딩·브리핑 "동기화" 표기 소실).
      //   마지막 성공 적재 시각은 molit_ingest_runs 가 이미 갖고 있다(7K 행·status 인덱스, 4초 차).
      admin.from('molit_ingest_runs').select('finished_at').eq('status', 'ok')
        .order('finished_at', { ascending: false }).limit(1).maybeSingle(),
```
그리고 `lastIngestedAt: lastIngest?.data?.finished_at || null`.

## Step 2 — 실패값을 6시간 굳히지 않는다 (Redis 오염분 복구 포함)
`out.lastIngestedAt` 가 **null 이면**: 메모리 캐시 TTL 을 **60초**로, **Redis 에는 쓰지 않는다**. 그리고 Redis 에서 읽어온 값(`rHit`)의 `lastIngestedAt` 이 null 이면 **히트로 취급하지 말고 DB 를 다시 조회**한다 — 이 줄이 없으면 배포 후에도 Redis 에 이미 박힌 null 이 최대 6시간 더 나간다.
```js
    if (rHit && rHit.lastIngestedAt) { cache.set(CK, rHit, 21600); return rHit; }   // ← null 이면 미스로
    ...
    const ttl = out.lastIngestedAt ? 21600 : 60;
    cache.set(CK, out, ttl);
    if (out.lastIngestedAt) redisCache.rset(CK, out, 21600).catch(() => {});
```
`tx`/`apt` 가 0 인 경우는 종전 동작 그대로 둔다(이 계획의 범위 밖).

## Step 3 — 낡은 주석 정정
`server.js:485-487` 의 "MAX(ingested_at) 은 인덱스가 없어 975ms" 문단을 지금 사실로 바꿔라(3,945ms 실측·8s 타임아웃·소스 교체). 사실이 아닌 주석을 남기지 마라.

## Step 4 — 테스트 (신규 `backend/test/data-counts-sync.test.js`)
`getDataCounts` 가 export 돼 있지 않으면 `module.exports._getDataCounts = getDataCounts;` 를 **테스트용으로만** 추가하라(저장소 관례 `TEST-EXPORT-…` 태그, `_dbCapacityLevel`·`_dbSetAmenityCount` 와 같은 방식). `db/client`·`services/redisCache` 는 `require.cache` 스텁(`backend/test/unused-column-reclaim.test.js` 의 `_withFakeAdminKakao` 패턴). 고정할 것:
1. 3번째 조회가 **`molit_ingest_runs`** 를 `eq('status','ok')` 로 부르고 `molit_transactions` 에 `order('ingested_at'…)` 를 걸지 **않는다**(스텁이 `from()` 호출 테이블과 체인을 기록).
2. 성공 시 `lastIngestedAt` 이 `finished_at` 값이고 캐시 TTL 이 21600, Redis `rset` 이 1회.
3. 3번째 조회가 `{ data: null, error: {...} }` 를 돌려주면 `lastIngestedAt` 은 null 이되 **TTL ≤ 60**, `rset` 은 **0회**.
4. Redis `rget` 이 `{ tx: 1, apt: 1, lastIngestedAt: null }` 을 돌려주면 그것을 쓰지 않고 DB 를 조회한다(**오염 복구**).

## 완료 기준
```
npm run verify                                   → tests 460 이상 / fail 0   (기준선 456 + 신규 4)
grep -c "molit_ingest_runs" backend/server.js    → 1 이상
grep -c "order('ingested_at'" backend/server.js  → 0
```
배포 후 리뷰어: `/api/health` 의 `dataSyncedAt` 이 **09-25T17:45:12Z**(또는 그 뒤 회차)로 돌아오는지. Redis 오염분은 Step 2 의 미스 처리로 첫 요청에서 복구돼야 한다 — 6시간 기다릴 필요가 없어야 정상이다.

## STOP 조건
1. `getDataCounts` 의 구조가 위 인용과 다르면 추측하지 말고 멈춰라.
2. 기존 테스트가 깨지면 고치지 말고 보고하라.
3. DDL 을 실행하지 마라. 인덱스를 만들고 싶어지면 멈춰라 — 결정은 "무료 소스로 대체" 로 끝났다.

## 참고(범위 밖, 기록)
`backend/jobs/pushNotify.js:124-133` 도 `ingested_at >= minSince` + `order('ingested_at')` 로 같은 seq scan 을 한다. 구독자가 2명이라 지금은 무해하지만, 구독자가 늘면 같은 8초 컷에 걸린다. 그때는 `idx_molit_deal_date` 처럼 ≈4MB 짜리 인덱스를 살지, 적재 run 단위로 바꿀지 결정해야 한다.
