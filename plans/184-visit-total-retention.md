# Plan 184: "누적 방문" 숫자가 180일 정리 작업 때문에 줄어들지 않게 한다

> **실행자 안내**: 단계마다 검증을 돌린다. "STOP 조건"이면 멈추고 보고. 끝나면 README 184 행 갱신.
>
> **Drift check (먼저 실행)**: `git diff --stat 24d2032..HEAD -- backend/jobs/retention.js backend/routes/visits.js backend/test/visits-live.test.js backend/test/retention-observability.test.js`
> 바뀌었으면 발췌와 비교하고 다르면 STOP.

## Status
- **Priority**: P2 (2027-04-18 전에)
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `24d2032`, 2026-10-30

## Why this matters
첫 화면과 데이터 상태 창은 "2026-10-20 이후 누적 방문" 숫자를 보여 준다. 이 숫자는 `visit_attribution` 표의 `event='daily_visit'` 행 **전체 개수**다. 그런데 매일 도는 정리 작업이 같은 표에서 180일 지난 행을 이벤트 구분 없이 지운다. 그래서 2027-04-18 무렵부터 누적이 매일 줄어든다. 화면 문구("이후 누적")는 그대로라 사실과 다른 숫자가 된다. 이 서비스는 허위 신뢰 지표를 금지한다. 해결 방식은 **방문 행만 정리 대상에서 빼는 것**이다. 행은 브라우저당 하루 1행이라 작다(2026-10-20 이후 행 수는 실행자가 확인하지 않아도 된다 — 아래 용량 메모 참고).

## Current state
- `backend/routes/visits.js:29, 43-45`:
```js
const TOTAL_SINCE = '2026-10-20'; // 운영 도메인 daily_visit 첫 기록(2026-10-20 23:43 KST)
...
        admin.from('visit_attribution').select('id', { count: 'exact', head: true }).eq('event', 'daily_visit'),
```
- `backend/jobs/retention.js:259-270`:
```js
// ATTRIBUTION-RETENTION-2026-08-29 (Sprint NNNNNNN-31): 유입 집계는 개인정보가 아니지만(식별자 미저장)
//   무료 DB 500MB 중 이미 60% 를 쓰고 있어 무한 증식을 두면 안 된다. 채널 비교엔 반년이면 충분하다.
const ATTRIBUTION_RETENTION_DAYS = 180;
async function runAttributionRetention(admin) {
  const out = { pruned: 0, error: null };
  try {
    const cut = new Date(Date.now() - ATTRIBUTION_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { count, error } = await admin.from('visit_attribution')
      .delete({ count: 'exact' })
      .lt('created_at', cut);
    if (error) throw error;
```
- 운영 `visit_attribution.event` 값(2026-10-30 조회): `daily_visit`, `first_load`, `report`, `search`, `signup`.
- `runAttributionRetention` 은 `module.exports` 로 내보내져 있다(306행). 테스트는 `backend/test/retention-observability.test.js` 가 retention 함수들을 가짜 admin 으로 부르는 방식을 따른다(실행자가 그 파일에서 `runAttributionRetention` 또는 비슷한 함수의 가짜 체인 패턴을 찾아 쓴다).

## Commands you will need
| Purpose | Command | Expected |
|---|---|---|
| 관련 테스트 | `node --test backend/test/retention-observability.test.js backend/test/visits-live.test.js` | fail 0 |
| 전체 검증 | `npm run verify` | `ℹ fail 0` |

## Scope
**In scope**: `backend/jobs/retention.js`(`runAttributionRetention` 한 곳), 테스트 1개 추가(`backend/test/retention-observability.test.js` 에 추가 또는 새 파일 `backend/test/attribution-retention-visits.test.js`)
**Out of scope**: `visits.js` 의 누적 계산 방식, 프런트 문구, DB 스키마(새 표·인덱스 만들지 않음), 다른 이벤트의 보관 기간.

## Git workflow
- 커밋: `fix(retention): 누적 방문(daily_visit)은 유입 정리 대상에서 제외 (Sprint XX)`. push 는 운영자 승인 후.

## Steps
### Step 1: 삭제 조건에 이벤트 제외 추가
`.lt('created_at', cut)` 뒤에 `.neq('event', 'daily_visit')` 를 추가한다. 주석 한 줄: `// Plan 184: daily_visit 은 화면의 "2026-10-20 이후 누적" 이 센다 — 지우면 누적이 줄어든다. 브라우저당 하루 1행이라 작다.`
**Verify**: `grep -n "neq('event', 'daily_visit')" backend/jobs/retention.js` → 1줄

### Step 2: 테스트
가짜 admin 의 `from('visit_attribution').delete(...)` 체인이 받은 필터를 기록하게 하고, `runAttributionRetention(admin)` 을 부른 뒤 다음을 단언한다:
- `lt('created_at', ...)` 가 호출됐다.
- `neq('event', 'daily_visit')` 가 호출됐다.
**Verify**: 테스트 파일 실행 → fail 0. 회귀 주입: Step 1 줄을 지우면 fail 1, 되돌리면 fail 0.

## Test plan
- 위 테스트 1개.

## Done criteria
- [ ] Step 1 grep 1줄
- [ ] 새 테스트 pass, 회귀 주입 시 fail
- [ ] `npm run verify` → fail 0
- [ ] `git status --short` 에 in-scope 파일만
- [ ] README 184 행 갱신

## STOP conditions
- 가짜 체인에 `neq` 가 없어 기존 테스트 여러 개를 고쳐야 한다(가짜 체인에 통과 메서드 1개 추가는 허용, 그 이상은 보고).
- `daily_visit` 외에 누적·통계로 전체 행 수를 세는 다른 이벤트를 발견했다(예: 화면이 `first_load` 전체를 센다). 보고한다.

## Maintenance notes
- 용량: `daily_visit` 은 브라우저당 하루 1행이다. 행이 크게 늘면(예: 하루 수천) 일별 집계 표로 옮기고 원본은 180일 정리에 다시 넣는다 — 그때는 `visits.js` 누적 계산도 함께 바꾼다.
- 인증 없는 `POST /api/attribution` 으로 숫자를 부풀릴 수 있다는 지적이 있었다(서버 측 중복 제거 없음). 분당 한도(30/분)만 있다. 이 계획 범위 밖이며, 숫자를 "브라우저 수"로 설명하는 현재 문구(visits.js 머리 주석)는 유지한다.
