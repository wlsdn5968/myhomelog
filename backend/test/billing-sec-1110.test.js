/**
 * 2026-11-10 보안 점검 run-1 (C:/Users/Woo/security-audit-skill/myhomelog/run-1) 후속 수정의 회귀 검사.
 *  - billing/cancel-overwrites-refunded-restores-entitlement
 *  - billing/confirm-cas-loser-repair-double-extension
 *  - billing/refund-status-check-constraint-mismatch-keeps-entitlement
 *  - frontend/index.html:onclick-single-quote-escHtml-openRegionSummary-sigungu
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _billingHandler, _hasFilter, _mockRes, _withBillingStub2 } = require('../testSupport/_helpers');

const okToss = { post: async () => ({ data: { orderId: 'o1', status: 'DONE', totalAmount: 9900, method: '카드', approvedAt: new Date().toISOString() } }) };

test('해지는 진행 중인(active) 구독에만 걸리고, 없으면 409 로 끝난다(환불된 이용권을 되살리지 않는다)', async () => {
  await _withBillingStub2({ payRow: null, casRows: [], tossKey: 'test' }, async (seen) => {
    const res = _mockRes();
    await _billingHandler('/cancel')({ body: {}, user: { id: 'u1' } }, res, (e) => assert.fail(e && e.message));
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'no_active_subscription');
    assert.ok(_hasFilter(seen.updateFilters, 'status', 'active'), '해지 갱신에 status=active 조건이 없다');
    assert.ok(_hasFilter(seen.updateFilters, 'user_id', 'u1'));
  });
  await _withBillingStub2({ payRow: null, casRows: [{ user_id: 'u1' }], tossKey: 'test' }, async () => {
    const res = _mockRes();
    await _billingHandler('/cancel')({ body: {}, user: { id: 'u1' } }, res, (e) => assert.fail(e && e.message));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
  });
});

test('승인 경쟁에서 진 confirm 은 다시 읽은 상태가 captured 가 아니면 보정하지 않고 409 로 알린다(현재 시각 보정과 거짓 성공 차단)', async () => {
  const payRow = { order_id: 'o1', user_id: 'u1', amount: 9900, status: 'requested', plan: 'pro' };
  await _withBillingStub2({ payRow, casRows: [], tossKey: 'test', axiosImpl: okToss, billingRow: null }, async (seen) => {
    const res = _mockRes();
    await _billingHandler('/confirm')({ body: { paymentKey: 'pk', orderId: 'o1', amount: 9900 }, user: { id: 'u1' } }, res, (e) => assert.fail(e && e.message));
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'payment_state_conflict');
    assert.equal(seen.upserts.filter((u) => u.table === 'user_billing').length, 0, '승자를 확인하지 않고 보정했다');
  });
});

test('confirm 의 승인 CAS 는 실패 기록(failed) 주문도 captured 로 바꾼다(시간 초과 뒤 실제 승인된 결제의 이용권 누락 차단)', async () => {
  const payRow = { order_id: 'o1', user_id: 'u1', amount: 9900, status: 'failed', plan: 'pro' };
  await _withBillingStub2({ payRow, casRows: [{ order_id: 'o1' }], tossKey: 'test', axiosImpl: okToss, billingRow: null }, async (seen) => {
    const res = _mockRes();
    await _billingHandler('/confirm')({ body: { paymentKey: 'pk', orderId: 'o1', amount: 9900 }, user: { id: 'u1' } }, res, (e) => assert.fail(e && e.message));
    assert.equal(res.statusCode, 200);
    const st = seen.updateFilters.find(([c, v]) => c === 'status' && Array.isArray(v));
    assert.deepEqual(st && st[1], ['requested', 'failed']);
    assert.equal(seen.upserts.filter((u) => u.table === 'user_billing').length, 1, '승인된 결제의 이용권을 쓰지 않았다');
  });
});

test('승인 직후(30초 안) 보정은 이긴 쪽 기록을 기다린 뒤, 끝내 없을 때만 채운다', async () => {
  const fresh = { order_id: 'o1', user_id: 'u1', amount: 9900, status: 'captured', plan: 'pro', approved_at: new Date(Date.now() - 5000).toISOString() };
  const savedWait = process.env.BILLING_REPAIR_WAIT_MS;
  process.env.BILLING_REPAIR_WAIT_MS = '1000';
  try {
    // 이긴 쪽이 이미 기록(updated_at 이 승인 뒤) → 보정 없음
    const applied = { plan: 'pro', status: 'active', current_period_end: new Date(Date.now() + 29 * 86400000).toISOString(), updated_at: new Date().toISOString() };
    await _withBillingStub2({ payRow: fresh, casRows: [], tossKey: 'test', billingRow: applied }, async (seen) => {
      const res = _mockRes();
      await _billingHandler('/confirm')({ body: { paymentKey: 'pk', orderId: 'o1', amount: 9900 }, user: { id: 'u1' } }, res, (e) => assert.fail(e && e.message));
      assert.equal(seen.upserts.filter((u) => u.table === 'user_billing').length, 0, '이미 반영된 결제에 30일을 또 더했다');
    });
    // 끝내 기록이 없음(이긴 쪽이 죽음) → 기다린 뒤 보정
    const t0 = Date.now();
    await _withBillingStub2({ payRow: fresh, casRows: [], tossKey: 'test', billingRow: null }, async (seen) => {
      const res = _mockRes();
      await _billingHandler('/confirm')({ body: { paymentKey: 'pk', orderId: 'o1', amount: 9900 }, user: { id: 'u1' } }, res, (e) => assert.fail(e && e.message));
      assert.equal(seen.upserts.filter((u) => u.table === 'user_billing').length, 1, '이긴 쪽이 죽은 경우 이용권이 영영 비었다');
    });
    assert.ok(Date.now() - t0 >= 900, '기다리지 않고 바로 보정했다');
  } finally {
    if (savedWait === undefined) delete process.env.BILLING_REPAIR_WAIT_MS; else process.env.BILLING_REPAIR_WAIT_MS = savedWait;
  }
  const later = { ...fresh, approved_at: new Date(Date.now() - 60000).toISOString() };
  await _withBillingStub2({ payRow: later, casRows: [], tossKey: 'test', billingRow: null }, async (seen) => {
    const res = _mockRes();
    await _billingHandler('/confirm')({ body: { paymentKey: 'pk', orderId: 'o1', amount: 9900 }, user: { id: 'u1' } }, res, (e) => assert.fail(e && e.message));
    assert.equal(seen.upserts.filter((u) => u.table === 'user_billing').length, 1);
  });
});

test('승인 실패와 금액 불일치는 requested 인 주문만 failed 로 바꾼다', async () => {
  const payRow = { order_id: 'o1', user_id: 'u1', amount: 9900, status: 'requested', plan: 'pro' };
  await _withBillingStub2({ payRow, casRows: [], tossKey: 'test' }, async (seen) => {
    const res = _mockRes();
    await _billingHandler('/confirm')({ body: { paymentKey: 'pk', orderId: 'o1', amount: 1 }, user: { id: 'u1' } }, res, () => {});
    assert.equal(res.statusCode, 400);
    assert.ok(_hasFilter(seen.updateFilters, 'status', 'requested'), '금액 불일치 failed 갱신에 status=requested 조건이 없다');
  });
  const failToss = { post: async () => { const e = new Error('x'); e.response = { status: 400, data: { message: 'bad', code: 'X' } }; throw e; } };
  await _withBillingStub2({ payRow, casRows: [], tossKey: 'test', axiosImpl: failToss }, async (seen) => {
    const res = _mockRes();
    await _billingHandler('/confirm')({ body: { paymentKey: 'pk', orderId: 'o1', amount: 9900 }, user: { id: 'u1' } }, res, () => {});
    assert.equal(res.statusCode, 400);
    assert.ok(_hasFilter(seen.updateFilters, 'status', 'requested'), 'Toss 실패 failed 갱신에 status=requested 조건이 없다');
  });
});

test('환불과 웹훅 정합은 이용권 갱신 오류를 숨기지 않는다, 마이그레이션과 스키마 기록에 refunded 가 있다', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/billing.js'), 'utf8');
  assert.match(src, /const \{ error: _rbErr \} = await admin\.from\('user_billing'\)\.update\(\{\s*status: 'refunded'/);
  assert.match(src, /if \(_rbErr\) \{[\s\S]{0,400}code: 'refund_billing_failed'/);
  assert.match(src, /const \{ error: _wbErr \} = await admin\.from\('user_billing'\)\.update\(\{\s*status: 'refunded'/);
  assert.match(src, /if \(_wpErr \|\| _wbErr\) \{/);
  const mig = fs.readFileSync(path.join(__dirname, '../../supabase/migrations/20261110_billing_refunded_status.sql'), 'utf8');
  assert.equal((mig.match(/'refunded'::text\]\)\)/g) || []).length, 2);
  const schema = fs.readFileSync(path.join(__dirname, '../../supabase/schema.sql'), 'utf8');
  assert.match(schema, /payments_status_check CHECK \(\(status = ANY \(ARRAY\[[^\]]*'refunded'::text\]/);
  assert.match(schema, /user_billing_status_check CHECK \(\(status = ANY \(ARRAY\[[^\]]*'refunded'::text\]/);
});

test('지역 요약 버튼 onclick 은 JSON 인코딩(_jsonAttr)으로 인자를 넘긴다(작은따옴표 탈출 차단)', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  assert.match(html, /onclick="openRegionSummary\(\$\{_jsonAttr\(code\)\},\$\{_jsonAttr\(v\.nm\)\}\)"/);
  assert.doesNotMatch(html, /openRegionSummary\('\$\{_escHtml/);
  // 화면의 두 함수를 그대로 꺼내 따옴표가 든 이름을 넣어도 속성을 디코드한 뒤 JS 문자열이 깨지지 않는지 확인
  const pick = (name) => { const i = html.indexOf(`function ${name}(`); return html.slice(i, html.indexOf('\n', i)); };
  const fn = new Function(`${pick('_escHtml')}\n${pick('_jsonAttr')}\nreturn {_escHtml,_jsonAttr};`)();
  const nm = "');window.__x=1;//";
  const attr = `openRegionSummary(${fn._jsonAttr('11350')},${fn._jsonAttr(nm)})`;
  const decoded = attr.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const calls = [];
  new Function('openRegionSummary', decoded)((a, b) => calls.push([a, b]));
  assert.deepEqual(calls, [['11350', nm]], '이름이 문자열 그대로 전달되지 않았다');
});
