# 077 — `refresh_molit_aliases()` v2(MATERIALIZED CTE) 적용 기록: 마이그레이션 파일 + schema.sql

**작성 기준 커밋**: `75f39ad` (2026-09-10) · 우선순위 P1 · 작업량 XS · 의존: **리뷰어가 운영자 승인 후 프로덕션에 적용한 뒤에만 실행** (적용 전이면 STOP)

## 전제 (계획자가 실제로 확인한 것)
- 067 이 붙인 cron 호출(`backend/jobs/aptMasterSync.js:328~333`, `admin.rpc('refresh_molit_aliases').abortSignal(AbortSignal.timeout(ALIAS_REFRESH_ABORT_MS=30000))`)이 2026-09-07 회차에서 `TimeoutError: The operation was aborted due to timeout` 로 실패했다(`/api/health` crons.apt-master-sync, Sentry NODE-D).
- 원인은 DB 함수 본문 실행 시간 **108.5초**(EXPLAIN ANALYZE 실측): `mj` LEFT JOIN 조건이 apt_master 의 표현식이라 인라인 CTE 로는 해시 조인이 안 되고 Nested Loop 가 7.7억 행을 필터한다.
- CTE 3개(`mj`·`m`·`i`)를 `AS MATERIALIZED` 로 바꾸면 **9.5초**(같은 SELECT, 결과 125행 동일). 30초 중단 안에 끝나므로 **코드 변경은 없다**. 실행 결과 기대치: 첫 회차 `aliasRefreshed` ≈ 125(현재 별칭 보유 10,506행 → 계산상 10,626행).
- 이 저장소 관례(Plan 026·`supabase/migrations/20260906_aliases_fn_and_mv_timeout.sql`): 적용된 DDL 은 **적용 후** `pg_get_functiondef()` 원문을 마이그레이션 파일에 기록하고, `supabase/schema.sql` 의 같은 함수 블록을 교체한다. 스키마 스냅샷 계약 테스트(`backend/test/frontend-contracts.test.js`)는 `^CREATE OR REPLACE FUNCTION public.<name>` **존재**만 본다 — 중복 선언은 못 잡으니 `grep -c` 로 따로 센다.

## 범위
- 신규: `supabase/migrations/20260910_refresh_molit_aliases_materialized.sql`
- 수정: `supabase/schema.sql` 의 `refresh_molit_aliases` 함수 블록 1개 교체(다른 줄 변경 금지)
- 금지: 코드·테스트·다른 마이그레이션 파일. **DB 에 접속하지 않는다.**

## Step 1 — 마이그레이션 파일
리뷰어가 실행자 프롬프트에 붙여 주는 **적용 후 `pg_get_functiondef()` 원문**을 아래 머리말 뒤에 그대로 넣는다(한 글자도 고치지 않는다):
```sql
-- ============================================================================
-- 2026-09-10 — 이미 프로덕션에 적용됨(운영자 명시 승인 후 execute_sql 로 실행). 이 파일은 **적용 기록**이다(Plan 026 관례).
--   아래 정의는 적용 후 pg_get_functiondef() 로 다시 읽은 원문이다.
-- ============================================================================
--
-- refresh_molit_aliases v2 — 로직 동일, CTE mj·m·i 를 MATERIALIZED 로 고정 (Plan 077)
--   [왜] 067 의 cron 호출이 30초 클라이언트 중단에 걸려 2026-09-07 회차 실패(Sentry NODE-D).
--        본문이 108.5초 걸렸다: mj LEFT JOIN 조건이 apt_master 의 표현식이라 인라인 CTE 로는 해시 조인이
--        안 되고 Nested Loop 가 7.7억 행을 필터했다(EXPLAIN ANALYZE 실측).
--   [실측] MATERIALIZED 후 9.5초(같은 SELECT, 결과 125행 동일). 코드 변경 없음(ALIAS_REFRESH_ABORT_MS=30s 유지).
```

## Step 2 — schema.sql 교체 (스크립트로만)
`supabase/schema.sql` 에서 `CREATE OR REPLACE FUNCTION public.refresh_molit_aliases()` 로 시작해 `$function$` + 줄바꿈 + `;` 로 끝나는 블록(정확히 1개)을 마이그레이션 파일의 같은 블록으로 바꾼다. **치환 인자는 반드시 함수**(`() => text`) — 본문에 `$'` 가 있어 문자열 치환은 파일 꼬리를 복제한다(2026-09-06 실사고). 스크립트 골격:
```js
const fs = require('fs');
const schemaPath = 'supabase/schema.sql', migPath = 'supabase/migrations/20260910_refresh_molit_aliases_materialized.sql';
let schema = fs.readFileSync(schemaPath, 'utf8'); const mig = fs.readFileSync(migPath, 'utf8');
const eol = schema.includes('\r\n') ? '\r\n' : '\n'; const before = schema.split(/\r?\n/).length;
const re = /CREATE OR REPLACE FUNCTION public\.refresh_molit_aliases\(\)[\s\S]*?\$function\$\r?\n;/;
const m = mig.match(re); if (!m) { console.error('마이그레이션에서 블록 못 찾음'); process.exit(1); }
if ((schema.match(new RegExp(re.source, 'g')) || []).length !== 1) { console.error('schema.sql 블록 매치 수 이상'); process.exit(1); }
schema = schema.replace(re, () => m[0].replace(/\r?\n/g, eol));
const after = schema.split(/\r?\n/).length;
const dup = (schema.match(/^CREATE OR REPLACE FUNCTION public\.refresh_molit_aliases/gm) || []).length;
console.log(`줄수 ${before} → ${after} (+${after - before}), 선언 ${dup}회, MATERIALIZED ${(schema.match(/AS MATERIALIZED/g) || []).length}회`);
if (Math.abs(after - before) > 10 || dup !== 1) { console.error('⚠ 이상 — 커밋 금지'); process.exit(1); }
fs.writeFileSync(schemaPath, schema, 'utf8');
```
기대: 줄수 변화 **+3 이내**(WHERE rn=1 재구성 분), 선언 1회, `AS MATERIALIZED` 3회.

## 검증·완료 기준
- `git diff --stat` → `supabase/schema.sql` 변경 줄이 함수 블록 범위 안(±60줄), 마이그레이션 파일 신규 1개. 그 외 파일 0.
- `grep -c "^CREATE OR REPLACE FUNCTION public.refresh_molit_aliases" supabase/schema.sql` → 1 · `grep -c "AS MATERIALIZED" supabase/schema.sql` → 3.
- `npm run verify` → `fail 0`.
- 커밋 1개: `chore(db): refresh_molit_aliases v2(MATERIALIZED CTE, 108.5s→9.5s) 적용 기록 (Plan 077)`.

## STOP 조건
- 리뷰어 프롬프트에 `pg_get_functiondef()` 원문이 없다 → 적용 전이므로 멈추고 보고.
- 스크립트의 줄수·선언 횟수 검증이 실패 → 커밋하지 말고 출력 그대로 보고.
