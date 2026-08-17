# Plan 033: 환불 self-service — 설계·스파이크 (구현 전 결정할 것을 먼저 확정한다)

> **Executor instructions**: 이것은 **설계 플랜이다. 프로덕션 코드를 바꾸지 마라.**
> 산출물은 이 파일 안의 "Open questions" 를 조사해 답을 채운 **설계 결정 문서**이고,
> 결과는 `plans/034-*.md`(구현 플랜)로 이어진다. 조사 중 "STOP conditions" 에 해당하면 멈추고 보고하라.
> 끝나면 `plans/README.md` 의 상태 행을 갱신하라.
>
> **Drift check**: `git diff --stat 530ca3c..HEAD -- backend/routes/billing.js frontend/billing.html`

## Status

- **Priority**: P2
- **Effort**: S (조사) — 후속 구현은 별도 산정
- **Risk**: LOW (이 플랜 자체는 코드 무변경)
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `530ca3c`, 2026-08-17

## Why this matters

환불 실행 코드는 **이미 완성돼 있고 테스트로 고정돼 있다** — 7일 청약철회 창 경계 양쪽,
Toss 결제취소 연동, 멱등 처리까지. 그런데 **프론트가 그걸 호출할 방법이 원천적으로 없다.**

`GET /billing/me` 가 payment id 를 안 내려주기 때문이다. 그래서 공식 환불 절차는 지금
"이메일로 신청 → 운영자가 수기 처리" 다. 1인 운영에서 이건 결제가 열리는 순간 반복 노동이 된다.

**지금이 붙이기 가장 좋은 시점인 이유**: 결제가 아직 오픈 전(`TOSS_SECRET_KEY` 미설정)이라
실사용자 트래픽이 없다. 결제를 연 뒤에 환불 UI 를 만지는 것보다 리스크가 훨씬 낮다.

이 플랜이 **설계 먼저**인 이유: 돈이 오가는 화면이라 "일단 만들고 고치자" 가 가장 비싼 선택이다.
결정해야 할 것들(무엇을 보여줄지, 언제 버튼을 감출지, 실패를 어떻게 말할지)을 코드 쓰기 전에 못 박는다.

## Current state

### 1) 환불 실행 코드는 있다

`backend/routes/billing.js:479`:

```js
router.post('/payments/:id/refund', async (req, res, next) => {
  try {
    if (!TOSS_SECRET_KEY) {
      return res.status(501).json({ error: '환불 시스템 설정 미완료', hint: 'TOSS_SECRET_KEY 미설정', code: 'refund_unavailable' });
    }
    const admin = getSupabaseAdmin();
    if (!admin) return res.status(503).json({ error: '결제 시스템 초기화 중' });

    // 1) 본인 payment 조회 (service-role + user_id 명시 필터)
    const { data: pay, error: selErr } = await admin
      .from('payments')
      .select('id, user_id, order_id, toss_payment_key, amount, status, plan, approved_at, created_at')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    ...
    // 2) 멱등 — 이미 환불됨
    if (pay.status === 'refunded') {
      return res.status(200).json({ status: 'refunded', note: 'already refunded' });
    }
```

소유자 필터(`.eq('user_id', req.user.id)`)와 멱등 처리가 이미 있다.

### 2) 그런데 프론트가 id 를 얻을 수 없다

`backend/routes/billing.js:77`:

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

`payments` 테이블을 보지 않고, id 도 없다.
`frontend/` 전체에서 `payments/.../refund` 호출 **0건**(실측).

### 3) 현재 공식 절차는 수기다

`frontend/refund.html:82-83`:

```
      <li>환불 신청 이메일: <code>wlsdn5968@gmail.com</code></li>
      <li>신청 시 포함 정보: 결제 시 사용한 이메일, 주문번호, 환불 사유</li>
```

### 4) RLS 가 이미 준비돼 있다 (중요)

프로덕션 `pg_policies` 실측(2026-08-17):

| 테이블 | 정책 | 명령 | 대상 role |
|---|---|---|---|
| `payments` | `payments_select_own` | SELECT | `authenticated` |
| `user_billing` | `user_billing_select_own` | SELECT | `authenticated` |

→ **조회 엔드포인트를 `userScopedClient(req.accessToken)` 로 만들면 RLS 가 본인 행만 내려준다.**
`/me` 가 이미 그 패턴을 쓴다. service-role(`getSupabaseAdmin`)을 조회에 쓸 이유가 없다.

## Open questions — 이 플랜의 산출물

각 질문에 **코드/DB 근거와 함께** 답을 채워라. 추측으로 채우지 마라.

### Q1. 목록에 무엇을 보여줄 것인가

`payments` 테이블의 실제 컬럼을 확인하고(아래 명령), 화면에 **필요한 최소 필드만** 고른다.

```
mcp Supabase execute_sql:
select column_name, data_type from information_schema.columns
where table_name = 'payments' order by ordinal_position;
```

- 후보: 결제일시, 금액, 플랜명, 상태, (환불 버튼용) id
- **`toss_payment_key` 는 화면에 내리지 마라** — 결제 시스템 내부 식별자다. 필요 없다.
- 답: _(채울 것)_

### Q2. 환불 버튼을 언제 보여줄 것인가

`billing.js` 의 refund 라우트가 **거부하는 조건**을 코드에서 전부 찾아 나열하고, 그 조건은
프론트에서도 **미리** 버튼을 감추는 근거가 된다(서버가 최종 판단이지만, 못 누르게 하는 게 친절하다).

- 확인할 것: 7일 창 계산 기준이 `approved_at` 인가 `created_at` 인가 (코드에서 확정)
- 확인할 것: `status` 가 어떤 값일 때만 환불 가능한가
- 답: _(채울 것)_

### Q3. 실패를 사용자에게 어떻게 말할 것인가

refund 라우트가 돌려주는 **에러 코드/상태**를 전부 수집하고, 각각에 대한 한국어 문구를 정한다.
예: `501 refund_unavailable`(설정 미완료)은 사용자에게 "지금은 신청이 안 된다" 로 보여야 하고,
**내부 hint(`TOSS_SECRET_KEY 미설정`)를 화면에 노출하면 안 된다.**

- 답: _(채울 것)_

### Q4. 수기 절차를 없앨 것인가 남길 것인가

`frontend/refund.html` 의 이메일 안내를 **지울지, 남길지** 정한다.
권고: **남긴다.** self-service 가 실패하는 경우(창 초과, 시스템 오류)의 최후 경로가 필요하다.
다만 "버튼으로 즉시 신청" 이 1순위로 보이게 순서를 바꾼다.

- 답: _(채울 것)_

### Q5. 결제 미오픈 상태에서 어떻게 검증할 것인가

`TOSS_SECRET_KEY` 가 없으면 refund 는 501 을 돌려준다. 즉 **실제 환불 흐름을 끝까지 볼 수 없다.**
그래도 검증 가능한 것을 나열하라:
- 목록 조회가 본인 행만 내려주는가(RLS) — 이건 검증 가능
- 버튼 노출/숨김 조건이 의도대로인가 — 목 데이터로 검증 가능
- 501 응답을 사용자 문구로 잘 바꾸는가 — 검증 가능

- 답: _(채울 것)_

## 조사 방법 (읽기 전용)

| 목적 | 명령 |
|---|---|
| payments 스키마 | Supabase MCP `execute_sql` (위 Q1) |
| refund 거부 조건 | `sed -n '479,560p' backend/routes/billing.js` |
| 기존 조회 패턴 | `sed -n '77,90p' backend/routes/billing.js` (`userScopedClient` 사용례) |
| 프론트 결제 화면 | `frontend/billing.html` 전체 |
| 기존 테스트 | `grep -n "refund" backend/test/characterization.test.js` |

## Scope

**In scope**:
- `plans/033-refund-self-service-design.md` (이 파일 — Open questions 를 답으로 채움)
- `plans/034-*.md` (조사 결과로 도출된 구현 플랜 신규 작성)
- `plans/README.md` (상태 행)

**Out of scope** — **이 플랜에서는 코드를 한 줄도 바꾸지 마라**:
- `backend/routes/billing.js` — refund 로직은 테스트로 고정돼 있다. 조사만 하라.
- `frontend/billing.html`, `frontend/refund.html`
- 결제 오픈(키 설정) — 운영자 영역이다.

## Steps

### Step 1: Q1~Q5 를 근거와 함께 답한다

각 답에 **파일:줄 또는 SQL 결과**를 붙여라. "아마 이럴 것" 은 답이 아니다.

**Verify**: 이 파일의 Open questions 5개가 전부 채워졌고, 각 답에 근거 인용이 있다.

### Step 2: 구현 플랜(034)을 쓴다

`plans/034-refund-self-service.md` 를 `plans/` 의 다른 계획과 **같은 템플릿**으로 작성한다
(`plans/029-env-example-sync-guard.md` 를 구조 예시로 삼아라).

구현 범위는 최소로 잡아라:
- `GET /billing/payments` 신규 (userScopedClient + RLS, Q1 에서 정한 필드만)
- `frontend/billing.html` 에 결제내역 + 환불 버튼
- 기존 refund 라우트는 **건드리지 않는다**

**Verify**: `plans/034-*.md` 가 존재하고, Done criteria 가 전부 기계 검증 가능한 형태다.

### Step 3: 상태 갱신

`plans/README.md` 에 033(DONE) · 034(TODO) 행을 추가한다.

## Done criteria

- [ ] Open questions Q1~Q5 가 **근거 인용과 함께** 채워졌다
- [ ] `plans/034-refund-self-service.md` 가 작성됐다
- [ ] 이 플랜 실행 중 **프로덕션 코드가 한 줄도 바뀌지 않았다** (`git status` 로 확인 —
      `plans/` 외 파일이 변경됐으면 실패다)
- [ ] `plans/README.md` 에 033·034 행이 있다

## STOP conditions

- `payments` 테이블에 **RLS 정책이 없거나** `authenticated` 가 아닌 role 을 대상으로 한다.
  → 조회 엔드포인트 설계가 달라진다. 실측 결과를 보고하라.
- refund 라우트가 7일 창을 **`created_at` 기준으로 계산**하는데 결제 승인이 나중에 일어나는
  구조라면(예: 가상계좌), 창 계산이 사용자에게 불리해질 수 있다. → 그 사실을 보고하라.
- 조사 중 결제 관련 **보안 결함**을 발견했다(소유자 필터 누락 등). → 설계를 계속하지 말고
  즉시 보고하라. 그건 별도 P1 이다.
- 구현 플랜을 쓰다가 refund 라우트를 고쳐야 한다는 결론이 난다 → STOP. 테스트로 고정된 돈 경로다.

## Maintenance notes

- 결제가 실제로 열린 뒤에는 이 화면이 **금전 분쟁의 1차 접점**이 된다. 문구 하나가 분쟁 소지를
  만들 수 있으므로, 구현 플랜의 문구는 `frontend/refund.html` 의 기존 환불정책 표현과
  **용어를 일치**시켜라(같은 것을 다르게 부르면 안 된다).
- 이 플랜은 의도적으로 **조회 + 버튼**까지만 다룬다. 부분 환불·일할 정산 UI 는 범위 밖이다
  (환불정책 문서에 일할 정산 언급이 있으므로, 필요해지면 별도 판단).
