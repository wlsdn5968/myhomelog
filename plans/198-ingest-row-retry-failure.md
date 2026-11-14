# Plan 198: 적재 중 행 단위 재시도가 실패하면 그 달을 실패로 기록한다

> 실행자 지침: 단계마다 확인 명령을 돌려 기대 결과를 본 뒤 다음으로 간다. STOP 조건이 생기면 멈추고 보고한다. 끝나면 `plans/README.md` 의 198 행을 고친다.
>
> 드리프트 확인: `git diff --stat b1cc128..HEAD -- backend/jobs/molitIngest.js backend/test/ingest-silent-holes.test.js`
> 바뀌었으면 아래 발췌와 대조하고 다르면 STOP.

## 상태

- 우선순위: P1
- 작업량: S
- 위험: LOW
- 선행: 없음
- 분류: bug
- 작성 기준: 커밋 `b1cc128`, 2026-11-14

## 왜 하나

매일 적재(`molit-ingest` cron)는 (지역, 월)마다 국토부 거래를 받아 `molit_transactions` 에 묶음 upsert 한다. 묶음 안에서 같은 키가 충돌(오류 코드 21000)하면 행 하나씩 다시 넣는데, 그 행 단위 upsert 의 오류를 버린다. 그래서 일부 행이 안 들어가도 그 달은 `molit_ingest_runs.status = 'ok'` 로 기록된다. 빈틈 재적재(`retryFailedGaps`)는 `status in ('error','timeout')` 인 달만 다시 하므로, 빠진 행은 영영 다시 채워지지 않는다. 이 저장소는 "기록이 비었다 ≠ 데이터가 없다" 사고를 여러 번 겪었다(Plan 110, 119).

## 현재 상태

`backend/jobs/molitIngest.js` (b1cc128 기준)

- `:248` `async function ingestOne(admin, lawdCd, dealYm)`. 시작할 때 `molit_ingest_runs` 에 `running` 행을 넣는다.
- `:293-317` 묶음 upsert 와 행 단위 재시도:
  ```js
    for (let i = 0; i < rows.length; i += BATCH_INSERT_SIZE) {
      const chunk = rows.slice(i, i + BATCH_INSERT_SIZE);
      const { error, count } = await admin
        .from('molit_transactions')
        .upsert(chunk, { onConflict: 'dedup_key', ignoreDuplicates: false, count: 'exact' });
      if (error) {
        if (error.code === '21000' || /affect row a second time/i.test(error.message || '')) {
          logger.warn({ lawdCd, dealYm, chunkSize: chunk.length }, 'molit-ingest: in-chunk dedup_key 충돌 → 행 단위 재시도');
          for (const row of chunk) {
            const { error: e1 } = await admin
              .from('molit_transactions')
              .upsert([row], { onConflict: 'dedup_key', ignoreDuplicates: false });
            if (!e1) inserted += 1;
          }
          continue;
        }
        throw error;
      }
      inserted += (count ?? chunk.length);
    }
  ```
- `:319-328` 성공이면 `status: 'ok'` 로 갱신. `:333-345` `catch (e)` 면 `status: 'error'`, `error_message` 500자 저장. 즉 던지기만 하면 실패로 기록된다.
- DB 제약: `molit_ingest_runs_status_chk` 는 `running, ok, error, skipped, timeout, archived` 만 허용(`supabase/schema.sql:419`). 새 상태 값을 만들지 말 것.
- upsert 는 `dedup_key` 기준이라 같은 달을 다시 적재해도 중복이 생기지 않는다(재시도 안전).
- 테스트 도우미: `backend/test/ingest-silent-holes.test.js` 의 `_fakeIngestAdmin(rows, opts)`(66행), `_loadMolitIngest(dgkGet)`(133행), `_dgkStub()`(50행). 그리고 499행 테스트가 `mod._ingestOne(admin, '11110', '202509')` 를 직접 부른다. 거래 항목 모양 예시는 `backend/test/molit-cancel-sync.test.js:11` (`aptNm, aptSeq, sggNm, umdNm, excluUseAr, ...`). 행 변환은 `molitIngest.js:175` `_toRow`, 유효 조건은 `:174` `_validRow` (이름, 계약일, 금액 > 0).

## 필요한 명령

| 목적 | 명령 | 성공 기준 |
|---|---|---|
| 관련 테스트 | `cd backend && node --test test/ingest-silent-holes.test.js test/molit-cancel-sync.test.js` | 전부 pass |
| 전체 검증 | 루트에서 `npm run verify` | exit 0 |

## 범위

수정: `backend/jobs/molitIngest.js` 의 위 루프와 그 바로 뒤, `backend/test/ingest-silent-holes.test.js`(도우미 확장과 테스트 2개 추가).

건드리지 말 것: `retryFailedGaps`, 상태 값 목록, `BATCH_INSERT_SIZE`, 해제 정리(`_removeCanceled`), cron 일정.

## 단계

### 1단계: 행 실패를 모아서 묶음 루프가 끝난 뒤 던진다

루프 전에 `let rowFailed = 0; let rowFailSample = null;` 을 둔다. 행 단위 재시도의 `if (!e1) inserted += 1;` 를 다음으로 바꾼다:
```js
            if (e1) { rowFailed += 1; if (!rowFailSample) rowFailSample = e1.message || String(e1); }
            else inserted += 1;
``` 묶음 루프가 다 끝난 뒤(다른 묶음은 계속 넣는다), 성공 기록 전에:
```js
    if (rowFailed > 0) {
      throw new Error(`행 단위 재시도 ${rowFailed}건 실패: ${String(rowFailSample).slice(0, 200)}`);
    }
```
이러면 기존 `catch` 가 `status: 'error'` 로 기록하고, 다음 회차의 `retryFailedGaps` 가 그 달을 다시 적재한다. 이미 들어간 행은 upsert 라 다시 넣어도 안전하다.

확인: `grep -n "행 단위 재시도 \${rowFailed}건 실패" backend/jobs/molitIngest.js` → 1줄. `grep -n "if (!e1) inserted += 1;" backend/jobs/molitIngest.js` → 0줄이어야 하고 대신 `if (e1)` 분기가 있다.

### 2단계: 테스트 2개

`ingest-silent-holes.test.js` 의 `_fakeIngestAdmin` 에 옵션 `opts.txUpsert` 를 더한다. 있으면 `molit_transactions` 의 `upsert(chunk, o)` 가 그 함수를 부른다(없으면 지금처럼 `{error:null,count:0}`). 기존 테스트는 옵션을 안 주므로 동작이 같다.

`_dgkStub` 와 같은 모양으로 항목 2개를 돌려주는 스텁을 만든다(같은 단지, 같은 면적, 같은 계약일, 같은 층, 금액만 다른 2건이면 JS 쪽 중복 제거로 1건이 된다. 그러니 층을 다르게 2건을 만든다). `molit-cancel-sync.test.js:11` 의 항목 모양을 복사해 쓴다.

1. 묶음 upsert 는 `{ error: { code: '21000', message: 'x' } }`, 행 upsert 는 첫 행만 `{ error: { message: 'row fail' } }` → `_ingestOne` 결과 `ok === false`, 가짜 `molit_ingest_runs` 의 그 행 `status === 'error'`, `error_message` 에 `행 단위 재시도 1건 실패` 포함.
2. 묶음 upsert 는 21000, 행 upsert 는 모두 성공 → `ok === true`, 기록 `status === 'ok'`, `inserted === 2`.

회귀 주입: 1단계의 `throw` 줄을 주석 처리하면 1번 테스트가 fail 하는지 확인하고 되돌린다.

확인: 두 파일 테스트 전부 pass. 주입 시 1번 fail.

## 완료 기준

- [ ] `npm run verify` exit 0
- [ ] 새 테스트 2개 pass, 회귀 주입 때 fail
- [ ] `git status --short` 에 범위 밖 파일 없음
- [ ] README 198 행 갱신

## STOP 조건

- 행 단위 재시도 코드가 발췌와 다르다.
- 가짜 DB 로 21000 분기에 들어가게 만들 수 없다(항목이 `_validRow` 를 통과하지 못하는 등). 이때 도우미를 크게 고치지 말고 보고한다.
- `retryFailedGaps` 가 `error` 상태를 다시 적재하지 않는다는 것을 발견한다(그러면 이 계획의 전제가 틀렸다).

## 유지보수 메모

- 같은 행이 매일 계속 실패하면 그 달이 매일 `error` 로 남고 빈틈 재적재 15칸 중 하나를 쓴다. 그것이 의도다(조용히 빠지는 것보다 보이는 것이 낫다). `/api/health` 의 molit-ingest 오류 수와 `molit_ingest_runs.error_message` 로 원인을 본다.
- 배포 뒤 첫 02시 적재 결과에서 `status='error'` 이고 `error_message like '행 단위 재시도%'` 인 행 수를 읽기 전용으로 센다. 0이면 지금까지 실제로 빠진 적이 없었다는 뜻이다.
