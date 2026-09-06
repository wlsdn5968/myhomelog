/**
 * backend/test/billing.test.js
 *
 * characterization.test.js(Plan 066, 10,056줄·327 test 단일 파일)를 도메인별로 분할한 조각.
 * 동작을 하나도 바꾸지 않는 이동이다 — 테스트 이름·개수·본문은 원본과 동일하다.
 * 공용 목/스텁 유틸은 ./_helpers 에서 가져온다. 새 테스트는 이 파일의 주제와 맞으면 여기에,
 * 아니면 backend/test/README.md 규칙대로 새 도메인 파일을 만든다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _billingHandler, _confirmOk, _hasFilter, _mockRes, _req, _withBillingStub, _withBillingStub2 } = require('../testSupport/_helpers');



// ── Plan 004: 결제 기간 이월 — P0(2026-05-04) "만료 전 재결제 시 잔여일 손실" 재발 방지 고정 ──
//   confirm/webhook 이 공유하는 단일 소스 computePeriodEnd 의 경계 4케이스를 고정한다.
test('computePeriodEnd — 잔여기간 이월 경계(미보유/과거/미래/정확히 현재)', () => {
  const { computePeriodEnd } = require('../services/planService');
  const now = new Date('2026-08-09T00:00:00Z');
  const D30 = 30 * 24 * 60 * 60 * 1000;
  // 미보유 → now+30일
  assert.equal(computePeriodEnd(null, now).getTime(), now.getTime() + D30);
  assert.equal(computePeriodEnd(undefined, now).getTime(), now.getTime() + D30);
  // 과거 만료 → now+30일 (이월 없음)
  assert.equal(computePeriodEnd('2026-08-08T00:00:00Z', now).getTime(), now.getTime() + D30);
  // 미래 만료(+5일) → 그 시점+30일 (잔여 5일 보존 — P0 의 핵심)
  assert.equal(computePeriodEnd('2026-08-14T00:00:00Z', now).getTime(),
    new Date('2026-08-14T00:00:00Z').getTime() + D30);
  // 정확히 현재 → now+30일 (`>` 비교 — 현재 동작 고정)
  assert.equal(computePeriodEnd('2026-08-09T00:00:00Z', now).getTime(), now.getTime() + D30);
});



test('billing/confirm — 결제 키 미설정이면 501 로 막고 결제를 진행하지 않는다', async () => {
  await _withBillingStub({ payRow: null, casRows: [], tossKey: undefined }, async () => {
    const h = _billingHandler('/confirm');
    const res = _mockRes();
    await h({ body: { paymentKey: 'pk', orderId: 'o1', amount: 9900 }, user: { id: 'u1' } }, res, () => {});
    assert.equal(res.statusCode, 501, '키가 없는데 결제 흐름이 진행됐다');
  });
});



test('billing/confirm — DB 금액과 다르면 400 + 해당 주문을 failed 로 막는다 (위조 차단)', async () => {
  // 저장된 주문은 9,900원인데 클라이언트가 100원을 주장하는 상황
  const payRow = { order_id: 'o1', user_id: 'u1', amount: 9900, status: 'requested', plan: 'pro' };
  await _withBillingStub({ payRow, casRows: [], tossKey: 'test' }, async (seen) => {
    const h = _billingHandler('/confirm');
    const res = _mockRes();
    await h({ body: { paymentKey: 'pk', orderId: 'o1', amount: 100 }, user: { id: 'u1' } }, res, () => {});
    assert.equal(res.statusCode, 400, '금액 불일치인데 400 이 아니다');
    // ★ 같은 orderId 재사용을 막기 위해 failed 로 전이해야 한다
    const failed = seen.updates.find((u) => u && u.status === 'failed');
    assert.ok(failed, '금액 불일치인데 주문을 failed 로 막지 않았다 — 동일 orderId 재시도가 가능해진다');
    assert.equal(failed.failure_reason, 'amount_mismatch');
    // PIPA 최소수집: 실패 사유에 정확한 금액을 남기지 않는다
    assert.ok(!/9900|100/.test(JSON.stringify(failed)), '실패 기록에 결제 금액이 남았다(PIPA 최소수집 위반)');
  });
});



test('billing/confirm — 이미 captured 면 Toss 재호출 없이 멱등 응답', async () => {
  const payRow = { order_id: 'o1', user_id: 'u1', amount: 9900, status: 'captured', plan: 'pro' };
  await _withBillingStub({ payRow, casRows: [], tossKey: 'test' }, async (seen) => {
    const h = _billingHandler('/confirm');
    const res = _mockRes();
    await h({ body: { paymentKey: 'pk', orderId: 'o1', amount: 9900 }, user: { id: 'u1' } }, res, () => {});
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'captured');
    // ★ 이미 처리된 주문에 update 를 또 날리면 안 된다(승인 상태를 덮어쓸 위험)
    assert.equal(seen.updates.length, 0, '이미 captured 인데 추가 update 가 발생했다');
    // ★★ MOCK-EQ-RECORD-2026-08-16: 조회가 **소유자 필터**를 걸었는지. 이게 빠지면 남의 주문을
    //   orderId 만 알면 조회·확정할 수 있다. 목이 인자를 버리던 시절엔 지워도 통과했다.
    assert.ok(_hasFilter(seen.selectFilters, 'order_id', 'o1'),
      `confirm 조회에 order_id 필터가 없다: ${JSON.stringify(seen.selectFilters)}`);
    assert.ok(_hasFilter(seen.selectFilters, 'user_id', 'u1'),
      `confirm 조회에 소유자(user_id) 필터가 없다 — 남의 주문을 조회할 수 있다: ${JSON.stringify(seen.selectFilters)}`);
  });
});



// ── Plan 025 (2026-08-16): 결제 CAS 가드가 **실제로 걸리는지** 단언 ──
//   [왜] 감사에서 나온 지적 — 목의 `.eq()` 가 인자를 버려서, 프로덕션에서 CAS 조건
//   (`.eq('status','requested')`, P0-5 동시처리 race 차단)을 지워도 결제 테스트가 전부 초록이었다.
//   목이 필터를 기록하도록 고쳤으니(위 _mockAdmin), 그 조건이 실제로 걸리는지 여기서 못 박는다.
test('billing/confirm — captured 전환은 status=requested CAS 로만 (webhook 과의 race 차단)', async () => {
  const payRow = { order_id: 'o1', user_id: 'u1', amount: 9900, status: 'requested', plan: 'pro' };
  const axiosImpl = { post: async () => ({ data: { orderId: 'o1', status: 'DONE', totalAmount: 9900, method: '카드', approvedAt: '2026-08-16T00:00:00Z' } }) };
  await _withBillingStub2({ payRow, casRows: [{ order_id: 'o1' }], tossKey: 'test', axiosImpl }, async (seen) => {
    const res = _mockRes();
    await _billingHandler('/confirm')({ body: { paymentKey: 'pk', orderId: 'o1', amount: 9900 }, user: { id: 'u1' } }, res, () => {});
    const cap = seen.updates.find((u) => u && u.status === 'captured');
    assert.ok(cap, `captured 전환 update 가 없다: ${JSON.stringify(seen.updates)}`);
    // ★ 핵심: 이 두 필터가 함께 걸려야 "requested 인 것만 captured 로" 가 성립한다.
    assert.ok(_hasFilter(seen.updateFilters, 'order_id', 'o1'),
      `CAS update 에 order_id 필터가 없다: ${JSON.stringify(seen.updateFilters)}`);
    assert.ok(_hasFilter(seen.updateFilters, 'status', 'requested'),
      'CAS 가드(.eq("status","requested")) 가 없다 — webhook 이 먼저 captured 시켜도 confirm 이 덮어쓴다: '
      + JSON.stringify(seen.updateFilters));
  });
});



test('billing/confirm 성공 — user_billing 에 plan·active·기간이 실제로 기록된다', async () => {
  await _withBillingStub2(_confirmOk({ billingRow: null }), async (seen) => {
    const res = _mockRes();
    let nextErr = null;
    await _billingHandler('/confirm')(
      { body: { paymentKey: 'pk', orderId: 'o1', amount: 9900 }, user: { id: 'u1' } }, res, (e) => { nextErr = e; });

    // ★ next(err) 를 삼키지 않는다 — 이걸 안 봐서 upsert 부재가 3개월 숨어 있었다
    assert.equal(nextErr, null, `confirm 성공 경로가 에러로 빠졌다: ${nextErr && nextErr.message}`);
    assert.equal(res.statusCode, 200);

    const up = seen.upserts.find((u) => u.table === 'user_billing');
    assert.ok(up, `user_billing upsert 가 없다 — 결제는 됐는데 이용권이 안 생긴다: ${JSON.stringify(seen.upserts)}`);
    assert.equal(up.row.user_id, 'u1');
    assert.equal(up.row.plan, 'pro', '결제한 플랜과 다른 플랜이 기록된다');
    assert.equal(up.row.status, 'active');
    assert.equal(up.row.canceled_at, null, '재결제인데 이전 해지 표시가 남는다');
    assert.ok(up.row.current_period_end, 'current_period_end 가 비어 있다');
  });
});



test('billing/confirm 성공 — 기존 구독이 남아 있으면 그 만료일 기준으로 이월된다', async () => {
  // 미래 만료가 남은 상태에서 재결제 → now+30 이 아니라 기존 만료+30 이어야 한다.
  // ⚠ TEST-DATE-ROT-2026-09-02 (감사 중 발견): 종전엔 `'2026-09-01T00:00:00.000Z'` 하드코딩이었다.
  //   그 날짜가 **2026-09-01 부로 과거가 되면서** computePeriodEnd 가 "기존 만료 기준 이월" 대신
  //   `now + 30일` 분기를 타기 시작했다 → ① 이 테스트가 검증하려던 이월 경로가 **무커버리지**가 되고
  //   ② 라우트의 new Date() 와 테스트의 new Date() 가 1ms 어긋나면 실패 → CI 가 무작위로 빨개졌다
  //   (실측: 16회 중 3회 실패, actual …040Z vs expected …041Z).
  //   → 절대 날짜를 쓰지 말고 **항상 미래**가 되도록 상대 시각으로 만든다.
  const existingEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await _withBillingStub2(_confirmOk({ billingRow: { current_period_end: existingEnd } }), async (seen) => {
    const res = _mockRes();
    await _billingHandler('/confirm')(
      { body: { paymentKey: 'pk', orderId: 'o1', amount: 9900 }, user: { id: 'u1' } }, res, () => {});
    const up = seen.upserts.find((u) => u.table === 'user_billing');
    assert.ok(up, 'user_billing upsert 가 없다');
    // 라우트가 쓴 값이 planService 의 단일 소스와 같은지 — 인라인 재구현으로 갈라지는 것을 막는다
    const expected = require('../services/planService').computePeriodEnd(existingEnd, new Date()).toISOString();
    assert.equal(up.row.current_period_end, expected,
      `이월 계산이 planService.computePeriodEnd 와 다르다 (기존 만료 ${existingEnd} 무시 의심)`);
    // 기존 만료보다 뒤여야 한다는 것도 못 박는다(계산식이 통째로 now 기준으로 바뀌면 여기서 걸린다)
    assert.ok(new Date(up.row.current_period_end) > new Date(existingEnd),
      '재결제인데 만료일이 기존보다 앞이다 — 사용자가 기간을 손해본다');
  });
});



test('billing/webhook — Toss 재조회 orderId 가 body 와 다르면 400 (위조 차단)', async () => {
  const axiosImpl = { get: async () => ({ data: { orderId: 'ATTACKER-ORDER', status: 'DONE', totalAmount: 9900 } }) };
  await _withBillingStub2({ payRow: null, casRows: [], tossKey: 'test', axiosImpl }, async () => {
    const h = _billingHandler('/webhook');
    const res = _mockRes();
    await h(_req({ body: { paymentKey: 'pk', orderId: 'o1' } }), res, () => {});
    assert.equal(res.statusCode, 400, 'orderId 불일치인데 통과했다 — 재조회 검증이 무력화됐다');
    assert.match(String(res.body && res.body.error), /mismatch/i);
  });
});



test('billing/webhook — 정적 시크릿이 설정돼 있는데 헤더가 틀리면 401', async () => {
  await _withBillingStub2({ payRow: null, casRows: [], tossKey: 'test', webhookSecret: 'expected-value' }, async () => {
    const h = _billingHandler('/webhook');
    const res = _mockRes();
    await h(_req({ body: { paymentKey: 'pk', orderId: 'o1' }, get: () => 'wrong-value' }), res, () => {});
    assert.equal(res.statusCode, 401, '시크릿 불일치인데 처리로 넘어갔다');
  });
});



test('billing/webhook — 금액 불일치라도 terminal 상태(captured)는 failed 로 덮지 않는다', async () => {
  // Toss 는 100원이라 하고 DB 는 9,900원 → 불일치. 단 이 주문은 이미 captured(terminal).
  const payRow = { order_id: 'o1', user_id: 'u1', amount: 9900, status: 'captured', plan: 'pro' };
  const axiosImpl = { get: async () => ({ data: { orderId: 'o1', status: 'CANCELED', totalAmount: 100 } }) };
  // CAS(.eq('status','requested'))가 0행을 돌려주는 상황 = terminal 보호가 작동한 경우
  await _withBillingStub2({ payRow, casRows: [], tossKey: 'test', axiosImpl }, async () => {
    const h = _billingHandler('/webhook');
    const res = _mockRes();
    await h(_req({ body: { paymentKey: 'pk', orderId: 'o1' } }), res, () => {});
    // 200 으로 응답해 Toss 재시도를 멈추되, 상태는 덮지 않는다
    assert.equal(res.statusCode, 200, 'terminal 보호 경로는 200 이어야 Toss 가 재시도를 멈춘다');
    assert.ok(/ignored|terminal/i.test(JSON.stringify(res.body)), `terminal 보호 응답이 아니다: ${JSON.stringify(res.body)}`);
  });
});



test('billing/refund — 7일 청약철회 창을 넘으면 400 으로 막는다 (경계 양쪽 확인)', async () => {
  const DAY = 24 * 60 * 60 * 1000;
  const mk = (daysAgo) => ({ id: 'p1', user_id: 'u1', order_id: 'o1', toss_payment_key: 'tk',
    amount: 9900, status: 'captured', plan: 'pro',
    approved_at: new Date(Date.now() - daysAgo * DAY).toISOString() });

  // (a) 8일 전 결제 → 창 만료. axios 가 호출되면 안 된다(그 전에 차단되어야 함).
  let tossCalled = false;
  const axiosImpl = { post: async () => { tossCalled = true; return { data: {} }; }, get: async () => ({ data: {} }) };
  await _withBillingStub2({ payRow: mk(8), casRows: [], tossKey: 'test', axiosImpl }, async () => {
    const h = _billingHandler('/payments/:id/refund');
    const res = _mockRes();
    await h(_req({ params: { id: 'p1' } }), res, () => {});
    assert.equal(res.statusCode, 400, '7일 초과인데 환불이 진행됐다');
    assert.equal(res.body.code, 'refund_window_expired');
    assert.equal(tossCalled, false, '창이 만료됐는데 Toss 취소 API 를 호출했다');
  });

  // (b) 6일 전 결제 → 창 안. 여기서는 Toss 호출까지 도달해야 한다(경계가 과하게 좁지 않은지).
  tossCalled = false;
  const axiosOk = { post: async () => { tossCalled = true; return { data: { status: 'CANCELED' } }; }, get: async () => ({ data: {} }) };
  await _withBillingStub2({ payRow: mk(6), casRows: [{}], tossKey: 'test', axiosImpl: axiosOk }, async () => {
    const h = _billingHandler('/payments/:id/refund');
    const res = _mockRes();
    await h(_req({ params: { id: 'p1' } }), res, () => {});
    assert.equal(tossCalled, true, '6일차(창 안)인데 환불이 차단됐다 — 경계가 잘못 좁혀졌다');
  });
});



test('billing/refund — captured 가 아니면 409, 이미 refunded 면 멱등 200', async () => {
  const base = { id: 'p1', user_id: 'u1', order_id: 'o1', toss_payment_key: 'tk', amount: 9900,
    plan: 'pro', approved_at: new Date().toISOString() };
  await _withBillingStub2({ payRow: { ...base, status: 'requested' }, casRows: [], tossKey: 'test' }, async () => {
    const res = _mockRes();
    await _billingHandler('/payments/:id/refund')(_req({ params: { id: 'p1' } }), res, () => {});
    assert.equal(res.statusCode, 409, '미승인(requested) 결제를 환불 가능으로 취급했다');
    assert.equal(res.body.code, 'not_refundable');
  });
  await _withBillingStub2({ payRow: { ...base, status: 'refunded' }, casRows: [], tossKey: 'test' }, async () => {
    const res = _mockRes();
    await _billingHandler('/payments/:id/refund')(_req({ params: { id: 'p1' } }), res, () => {});
    assert.equal(res.statusCode, 200, '이미 환불된 건은 멱등 200 이어야 한다');
    assert.equal(res.body.status, 'refunded');
  });
});



// ── Plan 034 (2026-08-28): GET /billing/payments 계약 ──────────────────────
//   왜 계약 테스트인가: payments 테이블이 **0행**(2026-08-28 실측)이라 라이브로는 RLS 도,
//   응답 필드도 증명할 수 없다. 그래서 "어느 클라이언트를 쓰는가 / 무엇을 select 하는가"를
//   목이 기록하고 여기서 단언한다 — Plan 025 가 `.eq()` 인자를 기록해 소유자 필터를 고정한 것과 같은 방식.
test('billing/payments — 본인 결제내역만, 내부 식별자·PG 원문은 내리지 않는다', async () => {
  const rows = [
    { id: 'p2', order_id: 'o2', amount: 9900, plan: 'pro', status: 'captured',
      approved_at: '2026-08-27T00:00:00Z', created_at: '2026-08-27T00:00:00Z' },
    { id: 'p1', order_id: 'o1', amount: 9900, plan: 'pro', status: 'refunded',
      approved_at: '2026-08-01T00:00:00Z', created_at: '2026-08-01T00:00:00Z' },
  ];
  await _withBillingStub2({ payRow: null, casRows: [], tossKey: 'test', listRows: rows }, async (seen) => {
    const res = _mockRes();
    await _billingHandler('/payments')(_req({}), res, (e) => { assert.fail(`next(err): ${e && e.message}`); });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { payments: rows }, '결제내역이 그대로 내려가야 한다');

    // ① RLS 를 타는 클라이언트여야 한다 — service-role 로 갈아타면 소유자 필터가 유일한 방어선이 된다
    assert.ok(seen.clientCalls.includes('userScoped'),
      'GET /payments 가 userScopedClient 를 쓰지 않는다 — RLS 우회');
    assert.ok(!seen.clientCalls.includes('admin'),
      'GET /payments 가 service-role(getSupabaseAdmin)을 쓴다 — RLS 를 우회하면 안 된다');

    // ② 소유자 필터(이중 방어) — RLS 가 꺼지거나 정책이 바뀌어도 남의 결제가 새면 안 된다
    assert.ok(_hasFilter(seen.selectFilters, 'user_id', 'u1'),
      "GET /payments 에 .eq('user_id', req.user.id) 가 없다");

    // ③ 응답에 새면 안 되는 컬럼 — select 문자열로 고정한다
    const cols = seen.selects.join(' ');
    assert.ok(seen.tables.includes('payments'), 'payments 테이블을 조회하지 않았다');
    for (const forbidden of ['toss_payment_key', 'raw_response', 'failure_reason']) {
      assert.ok(!cols.includes(forbidden),
        `GET /payments 응답에 ${forbidden} 이 포함됐다 — 내부 식별자/PG 원문은 내리지 않는다`);
    }
    // 환불 버튼이 서버와 같은 기준으로 판단하려면 이 둘이 반드시 있어야 한다(7일 창 = approved_at || created_at)
    for (const need of ['id', 'status', 'approved_at', 'created_at']) {
      assert.ok(cols.includes(need), `GET /payments 응답에 ${need} 이 빠졌다 — 환불 버튼 판정이 불가능해진다`);
    }
  });
});



// ── PG-MODE (2026-08-28): 결제 개방 판정을 서버가 소유한다 ────────────────────
//   왜 계약인가: 종전엔 프론트 상수(PG_LAUNCH_BLOCKED)가 차단을 담당해 **키 교체와 코드 변경이
//   따로 놀았다**. 이제 /config 의 mode 하나로 결정하는데, 이 판정이 틀리면 곧바로 금전 사고다
//   (라이브 키가 들어가자마자 실결제가 열리거나, ck/sk 가 섞여 결제는 되고 확정이 실패한다).
test('billing/config — mode 판정 5종 (none·test·live_locked·live·mismatch)', async () => {
  const cases = [
    { name: 'none', env: {}, mode: 'none', open: false },
    { name: 'test', env: { clientKey: 'test_ck_x', tossKey: 'test_sk_x' }, mode: 'test', open: true },
    { name: 'live_locked', env: { clientKey: 'live_ck_x', tossKey: 'live_sk_x' }, mode: 'live_locked', open: false },
    { name: 'live', env: { clientKey: 'live_ck_x', tossKey: 'live_sk_x', liveEnabled: 'true' }, mode: 'live', open: true },
    { name: 'mismatch(ck test + sk live)', env: { clientKey: 'test_ck_x', tossKey: 'live_sk_x' }, mode: 'mismatch', open: false },
    { name: 'mismatch(ck live + sk test)', env: { clientKey: 'live_ck_x', tossKey: 'test_sk_x', liveEnabled: 'true' }, mode: 'mismatch', open: false },
  ];
  for (const c of cases) {
    await _withBillingStub2({ payRow: null, casRows: [], ...c.env }, async () => {
      const res = _mockRes();
      _billingHandler('/config')(_req({}), res, () => {});
      assert.equal(res.body.mode, c.mode, `${c.name}: mode 오판 (${res.body.mode})`);
      assert.equal(res.body.checkoutEnabled, c.open, `${c.name}: checkoutEnabled 오판`);
    });
  }
});



test('billing/checkout — 라이브 키만 있고 플래그가 없으면(live_locked) 주문을 발급하지 않는다', async () => {
  // 프론트 차단은 API 직접 호출로 우회된다 → 서버가 같은 판정으로 막아야 한다.
  const blocked = [
    { name: 'live_locked', env: { clientKey: 'live_ck_x', tossKey: 'live_sk_x' } },
    { name: 'mismatch', env: { clientKey: 'test_ck_x', tossKey: 'live_sk_x' } },
  ];
  for (const c of blocked) {
    await _withBillingStub2({ payRow: null, casRows: [], ...c.env }, async (seen) => {
      const res = _mockRes();
      await _billingHandler('/checkout')(_req({ body: { plan: 'pro' } }), res, () => {});
      assert.equal(res.statusCode, 503, `${c.name}: 주문이 발급됐다`);
      assert.equal(res.body.code, 'pg_not_ready');
      assert.equal(seen.upserts.length, 0, `${c.name}: 차단 상태인데 DB 쓰기가 일어났다`);
    });
  }
  // 반대로 test 모드에서는 게이트를 통과해야 한다(여기서 막히면 리허설 자체가 불가능해진다).
  await _withBillingStub2({ payRow: null, casRows: [], clientKey: 'test_ck_x', tossKey: 'test_sk_x' }, async () => {
    const res = _mockRes();
    await _billingHandler('/checkout')(_req({ body: { plan: 'pro' } }), res, () => {});
    assert.notEqual(res.body && res.body.code, 'pg_not_ready', 'test 모드인데 결제 게이트가 막았다');
  });
});



// PIPA-PARITY (Plan 012-2): confirm 과 webhook 이 **같은 개인정보 정책**을 갖는지 고정한다.
//   confirm 은 P2-5(2026-05-04)로 실패 기록에서 정확한 결제 금액을 뺐는데 webhook 만 그대로였다
//   — 같은 방어선의 "한쪽만 고침". 이 테스트가 두 경로를 묶는다.
test('billing/webhook — 금액 불일치 기록에 정확한 결제 금액을 남기지 않는다 (PIPA 최소수집)', async () => {
  // requested 상태여야 failed 전이 경로(CAS 성공)를 탄다
  const payRow = { order_id: 'o1', user_id: 'u1', amount: 9900, status: 'requested', plan: 'pro' };
  const axiosImpl = { get: async () => ({ data: { orderId: 'o1', status: 'DONE', totalAmount: 100 } }) };
  await _withBillingStub2({ payRow, casRows: [{ order_id: 'o1' }], tossKey: 'test', axiosImpl }, async (seen) => {
    const res = _mockRes();
    await _billingHandler('/webhook')(_req({ body: { paymentKey: 'pk', orderId: 'o1' } }), res, () => {});
    assert.equal(res.statusCode, 400, '금액 불일치인데 400 이 아니다');
    const failed = seen.updates.find((u) => u && u.status === 'failed');
    assert.ok(failed, '금액 불일치인데 requested 주문을 failed 로 막지 않았다');
    assert.ok(!/9900|100/.test(JSON.stringify(failed)),
      `실패 기록에 결제 금액이 남았다(PIPA 최소수집 위반, confirm 경로와 불일치): ${JSON.stringify(failed)}`);
  });
});



// ── 감사 #2 (2026-08-16): billing 인증 **배선** 계약 ──────────────────────────
//   [왜] 위 cron 배선 계약은 Plan 023-2 에서 만들었는데 **billing 에는 같은 방어가 없었다**.
//   결제 테스트는 `router.stack` 에서 route 레이어의 핸들러만 꺼내 직접 호출하므로
//   (`l.route` 가 있는 레이어만 찾는다 — `router.use` 미들웨어는 `l.route` 가 undefined)
//   인증 게이트를 통째로 지워도 결제 테스트가 전부 초록이다. 실제로 테스트 req 에
//   `user: { id: 'u1' }` 을 손으로 주입하는 것 자체가 게이트를 안 거친다는 증거다.
//   ★ 특히 이 파일은 게이트(router.use)가 파일 **중간**에 있고 그 앞에 공개 라우트 2개가 있다.
//     새 라우트를 무심코 그 위에 추가하면 무인증으로 열린다 — 그걸 여기서 막는다.
test('billing 라우터 배선 — requireAuth 게이트가 보호 대상 라우트 앞에 있고, 그 앞은 공개 허용 라우트뿐', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/billing.js'), 'utf8');
  const lines = src.split('\n');

  // 1) 게이트 존재 — router.use(...) 블록 안에서 requireAuth 를 호출한다
  const useIdx = lines.findIndex((l) => /^\s*router\.use\(/.test(l));
  assert.ok(useIdx >= 0, 'billing.js 에 router.use 게이트가 없다 — 결제 라우트가 무인증으로 열린다');
  const gateBlock = lines.slice(useIdx, useIdx + 6).join('\n');
  assert.match(gateBlock, /requireAuth\s*\(/,
    `router.use 블록이 requireAuth 를 호출하지 않는다:\n${gateBlock}`);

  // 2) webhook 예외는 **POST + 경로 끝이 /webhook** 일 때만. 조건이 느슨해지면 인증이 뚫린다.
  //    (Toss 서버가 JWT 없이 호출하므로 이 예외 자체는 의도된 설계 — AUTH-FIX-2026-05-21)
  assert.match(gateBlock, /req\.method\s*===\s*'POST'/,
    'webhook 예외에 method 조건이 없다 — GET 으로도 인증을 우회할 수 있다');
  assert.match(gateBlock, /req\.path\.endsWith\('\/webhook'\)/,
    "webhook 예외가 endsWith('/webhook') 가 아니다 — 경로 조건이 느슨하면 다른 라우트도 열린다");

  // 3) 게이트보다 **앞에** 정의된 라우트는 공개가 의도된 것만이어야 한다.
  //    새 라우트를 위쪽에 추가하면 조용히 무인증이 되므로 허용 목록으로 못 박는다.
  const PUBLIC_OK = ['/config', '/plans'];
  const routeRe = /^\s*router\.(get|post|put|patch|delete)\s*\(\s*'([^']+)'/;
  const before = [];
  const after = [];
  lines.forEach((l, i) => {
    const m = l.match(routeRe);
    if (!m) return;
    (i < useIdx ? before : after).push(m[2]);
  });
  assert.ok(after.length >= 4, `게이트 뒤 라우트가 ${after.length}개뿐 — 파일 구조가 바뀌었는지 확인할 것`);
  const unexpected = before.filter((p) => !PUBLIC_OK.includes(p));
  assert.deepEqual(unexpected, [],
    `인증 게이트보다 앞에 있는 비공개 라우트: ${JSON.stringify(unexpected)} — 무인증으로 열려 있다. `
    + `공개가 맞다면 PUBLIC_OK 에 근거와 함께 추가할 것 (현재 허용: ${JSON.stringify(PUBLIC_OK)})`);

  // 4) 돈이 움직이는 라우트는 반드시 게이트 뒤에 있어야 한다
  for (const p of ['/confirm', '/cancel', '/checkout']) {
    assert.ok(after.includes(p), `${p} 가 인증 게이트 뒤에 없다 — 결제 경로가 무인증이다`);
  }
});



// ── BILLING-REPAIR-2026-09-02 (감사 P1-6) ──────────────────────────────────────
//   [왜] confirm·webhook 은 ① payments CAS ② user_billing upsert 를 별개 await 로 한다.
//     ①만 되고 ②가 안 되면 **결제는 됐는데 이용권이 없다**. 게다가 ②의 error 를 아무도 확인하지
//     않아 크래시 없이도 같은 증상이 났고, 재시도는 "이미 처리됨" 조기반환에 걸려 ②를 영영 안 했다.
//   [왜 무조건 보정하면 안 되나] 그 지점에서 그냥 채워주면 **지난달 주문서로 confirm 을 다시 부르는
//     것만으로 30일이 공짜 연장**된다. 그래서 approved_at 과 user_billing.updated_at 을 비교한다
//     (updated_at 은 trg_user_billing_updated 트리거가 갱신 — 프로덕션 실측).
test('billing/confirm — captured 인데 이용권이 없으면 보정한다', async () => {
  const payRow = { order_id: 'o1', user_id: 'u1', amount: 9900, status: 'captured', plan: 'pro',
    approved_at: new Date(Date.now() - 60 * 1000).toISOString() };
  // user_billing 행이 아예 없다 = 지급이 한 번도 반영되지 않았다.
  await _withBillingStub2({ payRow, casRows: [], tossKey: 'test', billingRow: null }, async (seen) => {
    const res = _mockRes();
    await _billingHandler('/confirm')(
      { body: { paymentKey: 'pk', orderId: 'o1', amount: 9900 }, user: { id: 'u1' } }, res, (e) => { assert.fail(`next(err): ${e && e.message}`); });
    assert.equal(res.statusCode, 200, '멱등 응답이어야 한다');
    const up = seen.upserts.find((u) => u.table === 'user_billing');
    assert.ok(up, '이용권이 비어 있는데 보정 upsert 가 없다 — 결제됐는데 플랜이 없는 상태가 영구히 남는다');
    assert.equal(up.row.plan, 'pro');
    assert.equal(up.row.status, 'active');
  });
});



test('billing/confirm — 옛 주문 재요청은 보정하지 않는다 (무료 연장 차단)', async () => {
  // 승인은 30일 전, 이용권은 그 직후 정상 반영(=updated_at 이 approved_at 보다 뒤).
  const approved = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const updated = new Date(approved.getTime() + 1000);
  const payRow = { order_id: 'oOld', user_id: 'u1', amount: 9900, status: 'captured', plan: 'pro',
    approved_at: approved.toISOString() };
  const billingRow = { plan: 'pro', status: 'active', current_period_end: new Date(Date.now() - 1000).toISOString(),
    updated_at: updated.toISOString() };
  await _withBillingStub2({ payRow, casRows: [], tossKey: 'test', billingRow }, async (seen) => {
    const res = _mockRes();
    await _billingHandler('/confirm')(
      { body: { paymentKey: 'pk', orderId: 'oOld', amount: 9900 }, user: { id: 'u1' } }, res, () => {});
    const up = seen.upserts.find((u) => u.table === 'user_billing');
    assert.equal(up, undefined,
      '이미 반영된 옛 결제인데 이용권을 다시 연장했다 — 주문서 재사용만으로 30일이 공짜가 된다');
  });
});



test('billing/confirm — user_billing 저장 실패를 성공으로 응답하지 않는다', async () => {
  const payRow = { order_id: 'o1', user_id: 'u1', amount: 9900, status: 'requested', plan: 'pro' };
  const axiosImpl = { post: async () => ({ data: { orderId: 'o1', status: 'DONE', totalAmount: 9900, method: '카드', approvedAt: new Date().toISOString() } }) };
  await _withBillingStub2({ payRow, casRows: [{ order_id: 'o1' }], tossKey: 'test', axiosImpl,
    upsertError: { message: 'db down' } }, async (seen) => {
    const res = _mockRes();
    let passedErr = null;
    await _billingHandler('/confirm')(
      { body: { paymentKey: 'pk', orderId: 'o1', amount: 9900 }, user: { id: 'u1' } }, res, (e) => { passedErr = e; });
    assert.ok(passedErr, '이용권 저장이 실패했는데 오류로 처리되지 않았다 — 사용자는 성공으로 알고 떠난다');
    assert.notEqual(res.body && res.body.status, 'captured',
      '저장 실패인데 captured 성공 응답을 돌려줬다');
  });
});



// ── WEBHOOK-TSE-2026-09-05 (감사 H-LOW) ───────────────────────────────────────────
test('Toss 웹훅 정적 시크릿 — 상수 시간 비교 (길이 선검사 + timingSafeEqual)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../routes/billing.js'), 'utf8');
  assert.equal(src.includes('got !== expectedSecret'), false, '문자열 !== 비교로 되돌아갔다');
  assert.match(src, /_gotBuf\.length !== _expBuf\.length \|\| !require\('crypto'\)\.timingSafeEqual\(_gotBuf, _expBuf\)/);
});



// ── 결제 안내 스코프 (2026-09-05) ─────────────────────────────────────────────────
test('billing.html — "PG 심사 진행 중" 안내는 서버 mode 차단(body.pg-blocked)일 때만, 표시의무 항목은 항상', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../frontend/billing.html'), 'utf8');
  assert.match(html, /class="pg-blocked-only"[^>]*>⚠ 결제 시스템 준비 중/, '심사 안내 제목이 pg-blocked-only 스코프가 아니다');
  assert.match(html, /class="pg-blocked-only"[^>]*>PG 가맹 심사가 완료되기 전까지 결제 처리를 받지 않습니다\./, '"결제 처리를 받지 않습니다" 문구가 스코프 밖이다(결제가 열려도 보인다)');
  assert.match(html, /body:not\(\.pg-blocked\) \.pg-blocked-only \{ display:none \}/, '스코프 CSS 규칙이 없다');
  assert.match(html, /<div(?: style="[^"]*")?>· 상호: <span id="bizName">/, '표시의무 항목(상호)이 조건부로 바뀌었다 — 항상 노출이어야 한다');
  assert.doesNotMatch(html, /class="pg-blocked-only"[^>]*>· (상호|대표자|사업장 소재지|고객센터)/, '표시의무 항목이 pg-blocked-only 안에 들어갔다');
});
