# 106 — 데이터 손실 없는 공간 회수 ≈ 40 MB: 부풀은 인덱스 재구성 · apt_master 통째 upsert 중단 · 적재 실행 기록 보관 규칙

**작성 기준 커밋**: `3501c49` (2026-09-20) · 우선순위 P1(용량) · 작업량 M(코드 2 + 유지보수 명령 3 + DDL 1) · 의존: **101 적용 후**(REINDEX 의 일시 증가분 ≈ 26 MB 를 넣을 여유) · ⚠ DB 명령은 전부 운영자 승인 후 리뷰어가 실행

## 전제 확인 (계획자가 프로덕션·코드로 확인 — 2026-09-20)
- **부풀은 인덱스**(`molit_transactions`, 472,302행): `uq_molit_dedup` 34.8 MB(키 33 B → 이상 크기 ≈ 26.0) · `molit_transactions_pkey` 16.7 MB(이상 ≈ 10.0). 원인: 비-HOT 갱신 43만 회의 잔재. 둘 다 **읽기에 쓰이지 않는다**(pkey `idx_scan = 0`, dedup 은 upsert 충돌 검사 전용) → 적재 창(17:00~19:00 UTC) 밖이면 재구성 중 잠금 영향이 없다.
- **apt_master**: 힙 40.8 MB, 살아 있는 행 합계 21.5 MB → **19.3 MB 가 빈 공간**. `backend/jobs/aptMasterSync.js:240~261` 이 매주(월 20:00 UTC) 지역별 전 행 `{kapt_code, apt_name, lawd_cd, sigungu, umd_nm, source}` 을 `upsert(chunk, { onConflict:'kapt_code', ignoreDuplicates:false })` 한다(health `inserted: 14673`). 행마다 `facility` jsonb(평균 1.4 KB)가 같은 튜플에 있어 **이름이 안 바뀌어도 2.9 KB 튜플 전체가 새로 쓰인다**. 같은 함수가 이미 `:222~233` 에서 지역의 `kapt_code, apt_name` 을 읽어 `prevName` 을 만든다. 트리거 없음(`updated_at` 은 default 만). `refresh_molit_aliases` 는 이미 `IS DISTINCT FROM` 으로 바뀐 행만 갱신한다.
- **molit_ingest_runs**: 43,455행 · 9.6 MB. 일간 적재가 하루 ≈ 375행(125지역 × 3개월)을 만들고 `backend/jobs/retention.js:195~201` 이 **status='ok' 이고 90일 지난 행을 전부** 지운다. 그런데 `backend/services/transactionService.js:34~47` `getTransactionsFromDb` 는 그 (지역,월)의 **ok 기록이 하나도 없으면 `null` → MOLIT API 직접 호출**로 떨어진다. 실측: 2025-11·2025-12·2026-01 은 125지역 중 **84~85곳만** ok 기록이 남아 있다(나머지는 DB 에 데이터가 있는데도 API 로 나간다). 2025-05~2026-04 의 마지막 실행이 2026-08-16/08-30 이라 **2026-11 중순이면 3개월보다 오래된 모든 달이 같은 상태**가 된다.

## Step 1 — 코드 A: apt_master 는 바뀐 행만 upsert (`backend/jobs/aptMasterSync.js`)
1. `prevName` 을 만드는 조회(`:222~233`)의 `.select('kapt_code, apt_name')` 을 `.select('kapt_code, apt_name, lawd_cd, sigungu, umd_nm, source')` 로 바꾸고, 같은 루프에서 `const prevRow = new Map();` 에 `prevRow.set(r.kapt_code, r)` 도 채운다(`prevName` 은 그대로 유지 — 개명 감지가 쓴다). 조회가 실패하면(`catch`) `prevRow` 는 비어 있고 **기존처럼 전 행을 upsert** 한다(감지 생략 경고는 그대로).
2. `// 500개씩 batch upsert` **위**에:
   ```js
   // SKIP-UNCHANGED-2026-09-20 (Plan 106): 바뀐 행·새 행만 쓴다. 이 테이블은 facility jsonb(평균 1.4KB)가 같은 튜플에 있어
   //   이름이 같아도 upsert 하면 2.9KB 튜플 전체가 새로 쓰인다 — 매주 14,678행 전부를 다시 써 힙의 47%(19MB)가 빈 공간이었다.
   const _same = (a, b) => ['apt_name', 'lawd_cd', 'sigungu', 'umd_nm', 'source'].every(k => (a[k] ?? null) === (b[k] ?? null));
   const toWrite = prevRow.size ? rows.filter(r => { const p = prevRow.get(r.kapt_code); return !p || !_same(p, r); }) : rows;
   const unchanged = rows.length - toWrite.length;
   ```
   그리고 upsert 루프의 `rows` 를 `toWrite` 로 바꾼다(`rows.slice` 2곳 → `toWrite.slice`, 루프 조건 `rows.length` → `toWrite.length`). `renamed` 계산은 `rows` 기준 그대로.
3. 반환 객체에 `unchanged,` 추가. `runAptMasterSync` 가 지역 결과를 합산하는 곳(`inserted` 를 더하는 곳)에서 `unchanged` 도 같은 방식으로 합산해 summary 에 넣고, `backend/services/cronStats.js` 의 숫자 화이트리스트(`NUM` 배열, `'inserted'` 가 있는 줄)에 `'unchanged'` 추가.
4. 테스트(`backend/test/apt-master-skip-unchanged.test.js` 신규): `syncOneSgg` 가 export 되어 있지 않다(`module.exports = { runAptMasterSync }`) → `module.exports._syncOneSgg = syncOneSgg; // 테스트용` 을 추가하고, `aliases-cron.test.js` 의 스텁 방식(`dataGoKrClient`·`db/client` 를 `require.cache` 로 교체)을 따라: KAPT 목록 3건(A·B·C) 중 DB 에 A(동일)·B(이름 다름)가 있을 때 upsert 로 **B·C 2행만** 가고 `unchanged === 1`, `renamed === 1`; 기존 행 조회가 실패하면 3행 전부 upsert(fail-open). KAPT 응답 형태는 그 테스트 파일과 `aptMasterSync.js:120~166` 의 파싱부를 보고 맞춘다.

## Step 2 — 코드 B: 실행 기록 보관 규칙 (`backend/jobs/retention.js` + DDL)
DDL(운영자 승인 후 리뷰어 실행):
```sql
CREATE OR REPLACE FUNCTION public.prune_molit_ingest_runs(p_keep_days integer DEFAULT 14) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE n integer;
BEGIN
  -- (지역,월)별 가장 최근 ok 1건은 영구 보존 — getTransactionsFromDb 가 "이 달은 적재됐다" 를 이 기록으로 판단한다.
  DELETE FROM public.molit_ingest_runs r
  USING (SELECT lawd_cd, deal_ym, max(id) AS keep_id FROM public.molit_ingest_runs WHERE status = 'ok' GROUP BY 1, 2) k
  WHERE r.status = 'ok' AND r.lawd_cd = k.lawd_cd AND r.deal_ym = k.deal_ym AND r.id <> k.keep_id
    AND r.started_at < now() - make_interval(days => p_keep_days);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $function$;
REVOKE EXECUTE ON FUNCTION public.prune_molit_ingest_runs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_molit_ingest_runs(integer) TO service_role;
```
코드: `runIngestRunsRetention` 의 ok 삭제 블록(`okCut` 계산 ~ `out.okPruned = oc ?? 0;`)을 `const { data: pruned, error: e2 } = await admin.rpc('prune_molit_ingest_runs', { p_keep_days: INGEST_RUNS_OK_RETENTION_DAYS }); if (e2) throw e2; out.okPruned = Number(pruned) || 0;` 로 바꾸고 상수 기본값을 `'90'` → `'14'` 로. 함수 주석의 "2) 성공('ok') 90일 경과 로그 파기" 를 "2) ok 는 (지역,월)별 최신 1건 영구 보존 + 나머지 14일 — 최신 ok 가 사라지면 그 달 조회가 MOLIT API 로 떨어진다(2026-09-20 실측 40지역×3개월)" 로. `supabase/schema.sql` 에 함수 선언 추가(스키마 스냅샷 테스트가 코드의 `rpc('…')` 이름을 요구한다) + `supabase/migrations/20260920_prune_molit_ingest_runs.sql`(적용 기록). 테스트: 스텁 admin 으로 `rpc` 가 `('prune_molit_ingest_runs', { p_keep_days: 14 })` 로 1회 불리고 `okPruned` 가 반환값을 담는지, rpc 오류면 `out.error` 에 메시지가 남는지.

## Step 3 — 유지보수 명령 (리뷰어, 코드 배포 **후**, 17:00~19:00 UTC 밖에서 하나씩 · 매번 합계 크기 재측정)
```sql
REINDEX INDEX CONCURRENTLY public.uq_molit_dedup;            -- 34.8 → ≈ 26
REINDEX INDEX CONCURRENTLY public.molit_transactions_pkey;   -- 16.7 → ≈ 10
SELECT public.prune_molit_ingest_runs(14);                   -- 43k → ≈ 7.5k 행
VACUUM FULL public.molit_ingest_runs;                        -- 9.6 → ≈ 2~3 (쓰는 쪽은 적재 창에만)
VACUUM FULL public.apt_master;                               -- 49.9 → ≈ 31 (Step 1 배포 뒤에만 — 아니면 다음 월요일에 다시 부푼다). 잠금 수 초
ALTER TABLE public.molit_transactions SET (autovacuum_vacuum_scale_factor = 0.02);  -- 아래 "가시성 맵" 항목
```
- **가시성 맵(성능)**: 원본은 일간 적재가 최근 3개월 전 행을 매일 다시 upsert 한다(갱신 669만 회 · 삽입 24만 회). 기본 autovacuum 임계(행의 20% ≈ 9.4만 죽은 튜플)에 못 미쳐 **2026-08-22 이후 autovacuum 이 한 번도 돌지 않았고**(죽은 튜플 35,379), 가시성 맵이 낡아 경신 집계의 index-only scan 이 힙을 **29,233번** 읽는다 — 2026-09-20 실측: 콜드 9.3초(PostgREST 8초 제한 초과), 웜 0.1초. 임계를 2% 로 낮추면 하루 한 번꼴로 돌아 힙 조회가 0 에 가까워진다(2026-09-05 PERF 기록: VACUUM 직후 1.26초).
- SQL 실행 도구가 문장을 트랜잭션으로 감싸 `CONCURRENTLY`·`VACUUM` 이 거부되면: REINDEX 는 `CONCURRENTLY` 없이(두 인덱스는 읽기 미사용이라 무해), VACUUM FULL 은 pg_cron 1회성 작업으로(`SELECT cron.schedule('once-vacuum-full-apt-master', '<분> <시> <일> <월> *', 'VACUUM FULL public.apt_master');` → 실행 확인 후 `SELECT cron.unschedule('once-vacuum-full-apt-master');`). pg_cron 설치 확인됨.
- `REINDEX CONCURRENTLY` 가 중간에 실패하면 `_ccnew` 접미 invalid 인덱스가 남는다 → `DROP INDEX` 로 치우고 보고.

## 검증·완료 기준
- `npm run verify` `fail 0`. 회귀 주입: (1) `toWrite` 대신 `rows` 를 upsert 하면 새 테스트 fail (2) rpc 이름을 바꾸면 스키마 스냅샷·retention 테스트 fail.
- 라이브: 다음 apt-master-sync(월 20:00 UTC) 뒤 health `crons['apt-master-sync']` 에 `unchanged` 가 1만 이상·`inserted` 가 수십~수백. 합계 크기가 Step 3 전후로 ≈ −40 MB.
- 커밋 2개: `perf(apt_master): 주간 동기화는 바뀐 행만 upsert — 힙 47% 빈 공간의 원인 (Plan 106)` · `fix(적재기록): (지역,월)별 최신 ok 는 영구 보존, 나머지 14일 — 오래된 달 조회의 API 추락 방지 + 표 80% 감소 (Plan 106)`.

## STOP 조건
- `aptMasterSync.js` 의 upsert 루프·`prevName` 조회가 위 설명과 다르다 → 보고 후 STOP.
- `runAptMasterSync` 의 합산 구조에 `unchanged` 를 넣을 자리가 불명확하다 → 지역 결과 배열에서 합산하는 코드를 보고하고 STOP.
