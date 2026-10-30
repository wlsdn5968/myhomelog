# Plan 182: 기준 스키마(schema.sql)를 2026-10-18~30 운영 적용분과 다시 맞춘다

> **실행자 안내**: 단계마다 검증을 돌린다. "STOP 조건"이면 멈추고 보고. 끝나면 README 182 행 갱신.
>
> **Drift check (먼저 실행)**: `git diff --stat 24d2032..HEAD -- supabase/schema.sql backend/test/schema-sql-prod-sync.test.js`
> 바뀌었으면 아래 "현재 상태"의 grep 결과를 다시 확인하고, 이미 반영된 항목은 건너뛴다.

## Status
- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (SQL 파일에 문장을 덧붙이고 테스트를 더할 뿐, 운영 DB 는 건드리지 않는다)
- **Depends on**: none
- **Category**: tech-debt (security 성격 포함)
- **Planned at**: commit `24d2032`, 2026-10-30

## Why this matters
`supabase/schema.sql` 은 "운영 DB 를 다시 만들 때 쓰는 기준 스키마"다. 이 저장소의 방침은 **덧붙이기만(append-only)** 하고, 마지막 정의가 운영본이 되게 하는 것이다(파일 1141행 안내 참고). 2026-10-18 이후 운영에 적용된 마이그레이션 일부가 이 파일에 반영되지 않았다. 이 파일로 재구축하면 다음 문제가 생긴다(2026-10-30 운영 카탈로그 읽기 전용 조회로 운영 쪽은 모두 적용 확인됨).
- 감사 기록이 90일에 지워져 개인정보처리방침의 "1년 이상 보관"과 충돌한다.
- 계정 삭제 요청과 매일 삭제 작업이 없는 열을 써서 실패한다.
- 내부 전용 함수와 표가 공개 키로 열린다(권한 회수 문장 누락).

## Current state
2026-10-30 운영 조회 결과(읽기 전용)와 schema.sql 상태:

| 항목 | 마이그레이션 원문 | 운영 | schema.sql |
|---|---|---|---|
| `prune_audit_log()` 보관 365일 | `supabase/migrations/20261018_audit_log_retain_1y.sql` | 365일 | 771행 함수가 `INTERVAL '90 days'`(792행) |
| `account_deletion_requests.hard_delete_attempts` 열 | `20261030_deletion_attempts.sql` | 있음(integer, 기본 0) | 없음(`grep -c hard_delete_attempts` = 0) |
| `apt_amenities.name` 열 | `20261030_amenities_station_name.sql` | 있음 | 없음 |
| 채팅 길이 CHECK 3개(`chat_messages_content_len_chk`, `chat_messages_meta_size_chk`, `chat_sessions_title_len_chk`) | `20261030_chat_size_checks.sql` | 있음 | 없음 |
| `ai_feedback_comment_len_chk`, `ai_feedback_reply_preview_len_chk` | `20261018_ai_feedback_close_direct_insert.sql` | 있음 | 실행자가 grep 으로 확인(있으면 건너뜀) |
| 가격 기록 함수의 "기간 안 앞선 거래" 판정 | `20261027_price_records_in_window_prior.sql` | 적용 | 실행자가 그 파일의 함수 이름으로 grep 해 마지막 정의가 이 판인지 확인 |
| `geocache_in_bounds` 실행 권한 회수 | `20261030_geocache_in_bounds.sql` 끝의 REVOKE/GRANT 2줄 | `{postgres, service_role}` | 1341행은 주석뿐, REVOKE/GRANT 문 없음 |
| `apt_alias_overrides` 권한 회수 | `20261030_alias_overrides_refresh_v8.sql:20` `REVOKE ALL ON public.apt_alias_overrides FROM anon, authenticated;` | anon·authenticated 권한 없음 | 1156-1157행은 RLS enable 과 주석뿐 |

- 파일 끝에는 이미 "REFRESH v9 (Plan 177)" 구역이 있다. 그 뒤에 새 구역을 덧붙인다.
- 기존 대조 테스트: `backend/test/schema-sql-prod-sync.test.js`(Plan 120). 같은 방식(파일을 읽어 문자열·개수 단언)을 따른다.

## Commands you will need
| Purpose | Command | Expected |
|---|---|---|
| 스키마 테스트 | `node --test backend/test/schema-sql-prod-sync.test.js` | fail 0 |
| 전체 검증 | `npm run verify` | `ℹ fail 0` |

## Scope
**In scope**: `supabase/schema.sql`(파일 끝에 덧붙이기만), `backend/test/schema-sql-prod-sync.test.js`(단언 추가)
**Out of scope**: 운영 DB(조회·적용 모두 금지 — 이미 적용됨), 기존 schema.sql 본문 수정(append-only), 마이그레이션 파일 수정, 별칭 함수 v4~v9 정리.

## Git workflow
- 커밋: `docs(schema): 10-18~30 운영 적용분(보관 365일·열 2·CHECK 5·권한 회수 2)을 기준 스키마에 덧붙임 (Sprint XX)`. push 는 운영자 승인 후.

## Steps
### Step 1: 덧붙일 문장을 마이그레이션 원문에서 그대로 복사한다
schema.sql 끝에 아래 머리 주석으로 새 구역을 만들고, 표의 각 항목을 해당 마이그레이션 파일의 **실행 문장 그대로** 복사한다(설명 주석은 줄여도 된다).
```
-- ============================================================================
-- CATCH-UP 2026-10-18~30 (Plan 182) — 운영 적용 확인(2026-10-30 카탈로그 조회) 뒤 기준 스키마에 덧붙임.
-- ============================================================================
```
- `prune_audit_log`: `20261018_audit_log_retain_1y.sql` 의 `CREATE OR REPLACE FUNCTION public.prune_audit_log()` 전체.
- 열 2개: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` 형태로(원문이 `if not exists` 가 아니면 붙여서 재실행 안전하게).
- CHECK: 원문 그대로. 재실행 안전이 필요하면 각 제약 앞에 `ALTER TABLE ... DROP CONSTRAINT IF EXISTS <이름>;` 를 둔다.
- 가격 기록 함수: 마지막 정의가 이미 이 판이면 건너뛴다. 아니면 `20261027_price_records_in_window_prior.sql` 의 함수 정의를 복사한다.
- 권한: `geocache_in_bounds` 의 REVOKE/GRANT 2줄, `REVOKE ALL ON public.apt_alias_overrides FROM anon, authenticated;`.
**Verify**:
- `grep -c "hard_delete_attempts" supabase/schema.sql` → ≥1
- `grep -c "INTERVAL '365 days'" supabase/schema.sql` → ≥1
- `grep -c "chat_messages_content_len_chk" supabase/schema.sql` → ≥1
- `grep -c "REVOKE ALL ON FUNCTION public.geocache_in_bounds" supabase/schema.sql` → 1

### Step 2: 마지막 정의가 운영본인지 확인한다
`prune_audit_log` 는 파일에 두 번 나온다. 마지막(가장 아래) 정의가 365일인지 확인한다.
**Verify**: `node -e "const s=require('fs').readFileSync('supabase/schema.sql','utf8');const i=s.lastIndexOf('FUNCTION public.prune_audit_log');console.log(s.slice(i,i+1500).includes(\"'365 days'\"))"` → `true`

### Step 3: 대조 테스트 추가
`backend/test/schema-sql-prod-sync.test.js` 에 테스트 1개("10-18~30 운영 적용분")를 추가하고 Step 1·2 의 조건을 단언한다(위 grep 4개 + 마지막 prune_audit_log 365일 + `REVOKE ALL ON public.apt_alias_overrides FROM anon, authenticated` 존재). 파일 머리 주석에 "운영 값은 2026-10-30 pg_catalog 조회" 한 줄을 추가한다.
**Verify**: `node --test backend/test/schema-sql-prod-sync.test.js` → fail 0

## Test plan
- 위 테스트 1개(문자열 단언). 패턴은 같은 파일의 "schema.sql 단언 2" 테스트.

## Done criteria
- [ ] Step 1 grep 4개가 기대값
- [ ] Step 2 출력 `true`
- [ ] `npm run verify` → fail 0
- [ ] `git diff --stat` 에서 schema.sql 은 추가 줄만(삭제 0): `git diff --numstat -- supabase/schema.sql` 의 두 번째 숫자 = 0
- [ ] README 182 행 갱신

## STOP conditions
- 마이그레이션 파일의 실행 문장이 표의 설명과 다르다(예: 열 이름이 다름).
- 기존 테스트가 "schema.sql 에 X 가 정확히 N번" 같은 개수 단언으로 깨진다(예: `prune_audit_log` 정의 개수). 개수를 바꾸지 말고 보고한다.
- 운영 DB 에 접속해야 할 것 같은 단계가 생긴다(이 계획은 파일만 다룬다).

## Maintenance notes
- 같은 드리프트가 반복된다(Plan 120 에 이어 두 번째). 앞으로 운영에 마이그레이션을 적용하는 커밋은 schema.sql 덧붙이기를 같은 커밋에 넣는다. 리뷰에서 `supabase/migrations/` 가 바뀌었는데 `supabase/schema.sql` 이 안 바뀐 커밋을 잡는다.
- SECURITY DEFINER 함수는 운영에 13개다. 이 계획은 이번 기간의 2건만 다룬다. 나머지 함수의 권한 문장 전수 대조는 별도 후속(운영 `pg_proc.proacl` 조회 필요).
