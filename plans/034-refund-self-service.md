# Plan 034: 환불 self-service 구현 — 결제내역 조회 + 환불 버튼

> **Executor instructions**: 단계별로 따르라. 각 단계의 검증 명령을 실행하고 기대 결과를 확인한 뒤
> 다음으로 넘어가라. "STOP conditions" 에 해당하면 **즉시 멈추고 보고**하라.
> 끝나면 `plans/README.md` 의 상태 행을 갱신하라.
>
> **Drift check (가장 먼저)**:
> `git diff --stat 472af0a..HEAD -- backend/routes/billing.js frontend/billing.html`
> 바뀌었으면 아래 "Current state" 인용과 대조하고, 다르면 STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MEDIUM (돈이 오가는 화면 — 단, 결제 오픈 전이라 실사용자 트래픽 0)
- **Depends on**: 033 (설계 결정 — Q1~Q5 답이 이 계획의 전제다. **먼저 읽어라**)
- **Category**: feature
- **Planned at**: commit `472af0a`, 2026-08-28

## Why this matters

환불 실행 코드(`POST /billing/payments/:id/refund`)는 **이미 완성돼 있고 테스트 10건으로 고정돼 있다** —
7일 청약철회 창, Toss 결제취소 연동, 멱등, CAS 업데이트까지. 그런데 **프론트가 그걸 호출할 방법이 없다**:
`GET /billing/me` 가 payment id 를 안 내려주고(`billing.js:77-84`), 프론트 전체에서 refund 호출이
**0건**(2026-08-28 실측)이다. 그래서 공식 환불 절차는 지금 "이메일 → 운영자 수기" 다(`refund.html:88-96`).

**지금이 붙이기 가장 좋은 시점**: `TOSS_SECRET_KEY` 미설정 + `payments` **0행**(실측)이라
실사용자 트래픽이 없다. 결제를 연 뒤에 환불 UI 를 만지는 것보다 리스크가 훨씬 낮다.

## Current state

### 1) `GET /billing/me` 는 payments 를 보지 않는다

`backend/routes/billing.js:77-84`:

```js
router.get('/me', async (req, res, next) => {
  try {
    const sb = userScopedClient(req.accessToken);
    const { data, error } = await sb
      .from('user_billing')
      .select('plan, status, current_period_start, current_period_end, canceled_at')
      .eq('user_id', req.user.id)
      .maybeSingle();
```

**이 패턴(`userScopedClient` + RLS)을 그대로 재사용한다.** 조회에 service-role 을 쓸 이유가 없다.

### 2) 라우트 목록 (2026-08-28 실측)

`config` · `plans` · `me` · `checkout` · `confirm` · `webhook` · `cancel` · `payments/:id/refund` —
**`GET /payments` 가 없다.** 이 계획이 추가하는 것은 그 하나뿐이다.

### 3) RLS 는 준비돼 있다

`pg_policies` 실조회(2026-08-28): `payments_select_own`(SELECT, `{authenticated}`) ·
`user_billing_select_own`(SELECT, `{authenticated}`).

### 4) 프론트 구조

`frontend/billing.html`(531줄): `#meCard`(현재 플랜/상태/다음 결제일 + `#cancelBtn`) →
`#plansView` → `#checkoutView`. `loadMe()`(326행)가 `/api/billing/me` 를 부른다.
**결제내역 카드는 `#meCard` 바로 아래**에 넣는 것이 정보 흐름상 자연스럽다.

## Commands you will need

| 목적 | 명령 | 성공 시 기대 |
|---|---|---|
| 문법(백) | `node -c backend/routes/billing.js` | exit 0 |
| 문법(프론트) | `node scripts/extract-inline-js.js` | 블록 추출 성공 |
| 백엔드 테스트 | `cd backend && npm test` | 전부 pass, 0 fail |
| 보안 가드 | `node scripts/security-regression-check.js` | 위반 0건 |
| 린트 | `npm run lint` | exit 0 |

## Scope

**In scope**:
- `backend/routes/billing.js` — **`GET /payments` 신규 추가만**
- `frontend/billing.html` — 결제내역 카드 + 환불 버튼 + 응답 문구 매핑
- `backend/test/characterization.test.js` — 신규 계약 테스트
- `plans/README.md` (상태 행)

**Out of scope** (건드리지 마라):
- `POST /billing/payments/:id/refund` — **테스트 10건으로 고정된 돈 경로다.** 한 줄도 바꾸지 마라.
- `frontend/refund.html` — 033 Q4 에서 **이번엔 손대지 않기로 결정**했다(전자상거래법 표시의무 문서.
  결제가 실제로 열린 뒤 별도 판단).
- `POST /billing/cancel` — 구독 해지는 환불과 다른 동작이다. 기존 버튼 유지.
- 부분 환불·일할 정산 UI — 범위 밖(이메일 경로가 담당).
- 결제 오픈(`TOSS_SECRET_KEY` 설정) — 운영자 영역이다.

## Git workflow

- 이 저장소는 master 직접 커밋 + Vercel 자동배포다(최근 스프린트 전부 그 방식).
- 커밋 메시지: `feat(billing): <한글 설명> (Sprint XX, Plan 034)`
- body 에 `[근본 원인] [Fix 내용] [회귀 위험]`

## Steps

### Step 1: `GET /billing/payments` 추가

`GET /me` 바로 아래(`billing.js:92` 근처)에 넣는다. **`userScopedClient` 를 쓴다** — `getSupabaseAdmin()`
을 쓰면 RLS 를 우회하므로 소유자 필터를 손으로 걸어야 하고, 그건 실수의 여지다.

내릴 필드는 033 Q1 의 결정 그대로 **6개 + order_id**:
`id, order_id, amount, plan, status, approved_at, created_at`

```js
// ── GET /billing/payments — 본인 결제내역 (환불 self-service 용) ──
//   REFUND-UI-2026-08-28 (Plan 034): refund 라우트는 있는데 프론트가 payment id 를 얻을 방법이 없었다.
//   userScopedClient + RLS(payments_select_own, authenticated)로 본인 행만. service-role 안 쓴다.
//   ⚠ toss_payment_key / raw_response / failure_reason 은 **내리지 않는다**(내부 식별자·PG 원문).
router.get('/payments', async (req, res, next) => {
  try {
    const sb = userScopedClient(req.accessToken);
    const { data, error } = await sb
      .from('payments')
      .select('id, order_id, amount, plan, status, approved_at, created_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json({ payments: data || [] });
  } catch (e) { next(e); }
});
```

- `.eq('user_id')` 는 RLS 와 **중복이지만 남긴다** — `/me` 도 같은 이중 방어를 한다(`billing.js:83`).
- `.limit(50)` 은 [[postgrest-silent-row-cap]] 관례. 1인 구독 서비스에서 50건이면 충분하고,
  넘으면 페이징이 아니라 설계를 다시 봐야 한다.

**Verify**: `node -c backend/routes/billing.js` → exit 0

### Step 2: 계약 테스트 — 금지 필드가 새지 않는지 고정

`backend/test/characterization.test.js` 에 추가한다. **`payments` 가 0행이라 라이브로는 증명이 안 되므로**
(033 Q5) 목으로 `.select()` 인자를 기록해 단언한다 — `plans/025` 가 결제 목에서 `.eq()` 인자를 기록한
선례를 그대로 따르라.

단언할 것:
1. `select()` 문자열에 `toss_payment_key` · `raw_response` · `failure_reason` 이 **없다**
2. `userScopedClient` 로 만든 클라이언트를 쓴다(= `getSupabaseAdmin` 을 쓰지 않는다)
3. `.eq('user_id', <요청자 id>)` 가 호출된다

**Verify**: `cd backend && npm test` → 신규 테스트 pass

### Step 3: 프론트 결제내역 카드

`#meCard` 아래에 `#payHistCard`(기본 `display:none`)를 추가하고, `loadMe()` 성공 뒤에
`loadPayments()` 를 부른다. 결제내역이 0건이면 카드를 **띄우지 않는다**(빈 카드는 노이즈).

행마다 표시: 결제일시(`approved_at ?? created_at`) · 금액 · 플랜 · 상태 배지.
`order_id` 는 **작게** 표시한다(수기 신청 시 복사용 — 033 Q1).

### Step 4: 환불 버튼 노출 조건

033 Q2 의 확정 규칙을 그대로 구현한다:

```js
const paidAt = new Date(p.approved_at || p.created_at);
const inWindow = (Date.now() - paidAt.getTime()) <= 7 * 24 * 60 * 60 * 1000;
const canRefund = (p.status === 'captured') && inWindow;
```

- `status === 'refunded'` → 버튼 대신 **"환불 완료"** 배지
- `captured` + 창 밖 → 버튼 숨기고 그 자리에 **"청약철회 기간(7일)이 지났어요 — 이메일로 신청"** 안내
- 그 외 상태 → 버튼 없음

⚠ **7일 계산은 서버와 같은 기준이어야 한다.** `approved_at` 우선·`created_at` 폴백을 **반드시** 지켜라
(`billing.js:518` 과 동일). 하나만 봐도 대부분 맞지만, 가상계좌처럼 승인이 늦는 결제에서 갈린다.

### Step 5: 응답 문구 매핑

033 Q3 의 표를 그대로 구현한다. **`error`/`hint` 원문을 화면에 그대로 뿌리지 마라** — `code` 로 분기한다.
`refund_db_failed` 는 **"다시 누르지 마세요" + 버튼 비활성화**가 필수다(Toss 취소 성공/DB 미반영 상태).

확인 다이얼로그를 먼저 띄운다: "결제 후 7일 이내 청약철회로 전액 환불합니다. 진행할까요?"
— 용어는 `refund.html` 과 일치시킨다("청약철회"·"환불 신청").

### Step 6: 전체 게이트

- `cd backend && npm test` → 전부 pass, 0 fail
- `node scripts/security-regression-check.js` → 위반 0건
- `npm run lint` → exit 0

## Test plan

**지금 검증 가능한 것** (033 Q5):
- 응답에 금지 필드 3개가 없다 — 계약 테스트(Step 2)
- 버튼 노출/숨김 4가지 상태 — 목 데이터로 렌더 확인
- 501(`refund_unavailable`) → 사용자 문구 변환 — 목 응답으로 확인
  (`TOSS_SECRET_KEY` 미설정이라 라이브에서도 501 이 그대로 재현된다)

**지금 검증할 수 없는 것 — Done criteria 에 넣지 마라**:
- Toss 실호출 취소 · 502 · `refund_db_failed` 경로
- 환불 후 `user_billing` 즉시 다운그레이드

## 결제가 열린 뒤 수행할 사후 검증 (별도 절)

`TOSS_SECRET_KEY` 가 설정되면 다음을 순서대로 확인한다:
1. 테스트 결제 1건 → `GET /billing/payments` 에 `captured` 로 뜨는가
2. 환불 버튼 → Toss 콘솔에서 취소 확인 → 목록이 `refunded` 로 바뀌는가
3. 같은 결제에 환불을 두 번 요청 → 200 `already refunded`(멱등)
4. 다른 계정 토큰으로 `GET /billing/payments` → 남의 결제가 **0건**인가(RLS)

## Done criteria

- [ ] `GET /billing/payments` 가 `userScopedClient` 로 구현됐다(`getSupabaseAdmin` 미사용)
- [ ] 응답에 `toss_payment_key`·`raw_response`·`failure_reason` 이 **없다** (계약 테스트로 고정)
- [ ] 프론트가 `error`/`hint` 원문이 아니라 `code` 로 문구를 고른다
- [ ] 7일 창 계산이 `approved_at ?? created_at` 기준이다 (서버와 동일)
- [ ] `refund_db_failed` 문구에 "다시 누르지 마세요" 가 있고 버튼이 비활성화된다
- [ ] `refund` 라우트 파일 diff **0줄**
- [ ] `frontend/refund.html` diff **0줄**
- [ ] `cd backend && npm test` → 전부 pass, 0 fail
- [ ] `node scripts/security-regression-check.js` → 위반 0건
- [ ] `npm run lint` → exit 0
- [ ] `plans/README.md` 상태 행 갱신

## STOP conditions

- `refund` 라우트를 고쳐야 한다는 결론이 난다 → **STOP.** 테스트 10건으로 고정된 돈 경로다.
- `userScopedClient` 로 `payments` 조회가 안 된다(권한 오류) → RLS 정책이 바뀐 것이다.
  `pg_policies` 를 다시 읽고 **보고하라.** service-role 로 우회하지 마라.
- 화면에 남의 결제가 보인다 → **즉시 STOP.** P1 보안 결함이다.
- 문구를 쓰다가 `refund.html` 의 환불정책과 **다른 조건**을 안내하게 된다(예: 창 길이·환불 비율)
  → STOP. 정책 문서가 기준이고, 다르면 그 자체가 분쟁 소지다.

## Maintenance notes

- 결제가 열리면 이 화면이 **금전 분쟁의 1차 접점**이 된다. 문구 변경은 `refund.html` 과 **같이** 본다.
- `refund.html` 5항(환불 신청 방법)의 순서 조정 — self-service 를 1순위로 올리는 것은
  **결제가 실제로 열린 뒤** 별도 판단(033 Q4).
- 부분 환불·일할 정산이 필요해지면 그건 새 계획이다. 이 화면에 끼워 넣지 마라.
- 리뷰 포인트: `payments` 를 읽는 새 코드가 들어오면 `toss_payment_key` 가 응답에 섞이지 않는지 볼 것.
