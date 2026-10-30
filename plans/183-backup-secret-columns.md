# Plan 183: 로컬 백업에서 결제 키·푸시 구독 키를 빼고, 남는 개인 데이터 보관 기간을 문서와 맞춘다

> **실행자 안내**: 단계마다 검증을 돌린다. "STOP 조건"이면 멈추고 보고. 끝나면 README 183 행 갱신.
>
> **Drift check (먼저 실행)**: `git diff --stat 24d2032..HEAD -- scripts/backup-db.js`
> 바뀌었으면 발췌와 비교하고 다르면 STOP.

## Status
- **Priority**: P2 (결제가 열리기 전에 반드시)
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `24d2032`, 2026-10-30

## Why this matters
`scripts/backup-db.js` 는 운영자 PC 에서 주 1회 돌려 운영 DB 표를 `.local-backups/YYYYMMDD/*.ndjson.gz` 로 내려받는다(폴더는 `.gitignore` 에 있음). 비밀 열은 카카오 토큰 두 열만 빼고 있다. 그래서 정기결제 키, 결제 키와 결제사 원본 응답, 웹 푸시 구독 키가 평문으로 PC 에 남는다. 2026-10-30 운영 기준 결제 키 행은 0개(결제 미오픈), 푸시 구독은 2건이다. 결제가 열리면 바로 결제 키가 백업에 쌓이기 시작한다. 이 키들은 다시 받을 수 있으므로(재등록·재구독) 백업에 둘 이유가 없다. PC 하나가 새면 결제와 알림 권한이 한꺼번에 노출된다.

## Current state
- `scripts/backup-db.js:36-47` — 덤프 표 목록(`TABLES`). 회원 데이터로 `push_subscriptions`, `kakao_notify_tokens`, `user_billing`, `payments`, `account_deletion_requests`, `audit_log` 등을 포함한다.
- `scripts/backup-db.js:60-66`:
```js
// 적대 리뷰 2026-10-30: 카카오 OAuth 토큰이 로컬 백업에 평문으로 남았다 — 재연결로 다시 받을 수 있으므로 백업에서 뺀다.
const SECRET_COLUMNS = { kakao_notify_tokens: ['access_token', 'refresh_token'] };
function _omitSecrets(table, row) {
  const cols = SECRET_COLUMNS[table];
  if (!cols) return row;
  const copy = { ...row };
  for (const c of cols) delete copy[c];
```
- `scripts/backup-db.js:80` — 모든 행이 `_omitSecrets(table, row)` 를 거쳐 기록된다.
- `supabase/schema.sql` 의 해당 열: `payments.toss_payment_key`(291행), `payments.raw_response`(298행), `push_subscriptions.p256dh`(312행), `user_billing.toss_billing_key`(348행). `push_subscriptions` 의 `auth` 열과 `user_billing` 의 고객 키 열(`toss_customer_key` 로 추정)은 실행자가 schema.sql 에서 정확한 이름을 확인한다.
- `scripts/backup-db.js:144-148` — 90일 지난 백업 폴더를 지운다.
- 스크립트는 맨 위에서 환경변수가 없으면 `process.exit(1)` 하므로 테스트에서 `require` 할 수 없다. 테스트는 파일을 문자열로 읽어 `SECRET_COLUMNS` 를 확인한다.
- 비밀값 원문은 어떤 파일·테스트·커밋 메시지에도 쓰지 않는다.

## Commands you will need
| Purpose | Command | Expected |
|---|---|---|
| 새 테스트 | `node --test backend/test/backup-secret-columns.test.js` | fail 0 |
| 전체 검증 | `npm run verify` | `ℹ fail 0` |

## Scope
**In scope**: `scripts/backup-db.js`(`SECRET_COLUMNS` 만), `backend/test/backup-secret-columns.test.js`(신규)
**Out of scope**: 백업 대상 표 목록, 복원 절차, 이미 만들어진 백업 폴더(운영자 PC — 실행자는 손대지 않는다), 개인정보처리방침 문구(아래 Maintenance 참고).

## Git workflow
- 커밋: `fix(backup): 결제 키·푸시 구독 키를 로컬 백업에서 제외 (Sprint XX)`. push 는 운영자 승인 후.

## Steps
### Step 1: 열 이름 확인
`grep -n "create table.*push_subscriptions\|create table.*user_billing\|create table.*payments" -i supabase/schema.sql` 로 세 표의 정의를 찾아, 키·토큰 성격의 열 이름을 모두 적는다(최소: `push_subscriptions` 의 `p256dh`·`auth`, `user_billing` 의 `toss_billing_key`·고객 키 열, `payments` 의 `toss_payment_key`·`raw_response`).
**Verify**: 적은 열 이름이 모두 schema.sql 에 있다(`grep -c` 각각 ≥1).

### Step 2: SECRET_COLUMNS 확장
```js
const SECRET_COLUMNS = {
  kakao_notify_tokens: ['access_token', 'refresh_token'],
  push_subscriptions: ['p256dh', 'auth'],
  user_billing: ['toss_billing_key', '<Step 1 에서 확인한 고객 키 열>'],
  payments: ['toss_payment_key', 'raw_response'],
};
```
위 주석에 한 줄: `// Plan 183: 결제·푸시 키도 재등록·재구독으로 다시 받는다 — 백업에 두지 않는다.`
**Verify**: `node -c scripts/backup-db.js` → 출력 없음

### Step 3: 테스트
`backend/test/backup-secret-columns.test.js` 를 만든다. `scripts/backup-db.js` 를 문자열로 읽어 `SECRET_COLUMNS = {` 부터 `};` 까지 잘라 `new Function('return ' + 객체문자열)()` 로 평가하고, 다음을 단언한다:
- 위 네 표가 키로 있다.
- 각 표의 배열에 Step 2 의 열 이름이 모두 있다.
- `TABLES` 에 있는 표 중 `push_subscriptions`, `user_billing`, `payments`, `kakao_notify_tokens` 는 모두 `SECRET_COLUMNS` 에도 있다.
패턴은 `backend/test/alias-year-178.test.js` 의 `read()` 헬퍼(파일을 문자열로 읽어 단언)를 따른다.
**Verify**: `node --test backend/test/backup-secret-columns.test.js` → fail 0

## Test plan
- 위 테스트 1개. 회귀 주입: `payments` 항목을 지우면 fail 하는지 확인 후 되돌린다.

## Done criteria
- [ ] `node --test backend/test/backup-secret-columns.test.js` → fail 0
- [ ] `npm run verify` → fail 0
- [ ] `git status --short` 에 in-scope 파일만
- [ ] README 183 행 갱신

## STOP conditions
- schema.sql 에 표의 키 열 이름이 계획과 다르고 무엇이 비밀인지 판단이 서지 않는다.
- `_omitSecrets` 가 행 기록 경로에서 빠져 있다(80행이 바뀌었다).
- 백업 복원 스크립트가 이 열들을 필수로 요구하는 것을 발견했다.

## Maintenance notes
- **운영자 확인 사항(실행자 범위 밖)**: 이미 만들어진 `.local-backups/` 폴더에는 푸시 구독 키 2건이 평문으로 있다. 결제 키는 0건이었다(2026-10-30). 폴더 위치가 클라우드 동기화 폴더가 아닌지 확인한다.
- 계정 삭제가 끝난 회원의 데이터가 로컬 백업에 최대 90일 남는다. 개인정보처리방침의 삭제·보관 문구와 맞는지 운영자가 확인한다(Plan 136·164 와 같은 검토 범위).
- 새 표에 키·토큰 열을 추가하면 `SECRET_COLUMNS` 와 이 테스트를 함께 갱신한다.
