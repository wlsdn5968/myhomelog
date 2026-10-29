/**
 * SEC-1030 C4~C9 — 계정 수명주기 보안 결함 회귀 고정.
 * 실행: cd backend && TZ=UTC node --test test/sec-1030-lifecycle.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const clientPath = require.resolve('../db/client');
const auditPath = require.resolve('../middleware/auditLog');
const authPath = require.resolve('../middleware/auth');

/** 호출 기록을 남기는 가짜 admin. */
function makeAdmin({ failTables = [], authFail = false, authErr = null, pages = {} } = {}) {
  const log = { deleted: [], adrUpdates: [], pageCalls: [] };
  return {
    log,
    from(table) {
      return {
        update(payload) {
          return { eq: async () => { if (table === 'account_deletion_requests') log.adrUpdates.push(payload); return { error: null }; } };
        },
        delete() {
          return { eq: async () => {
            log.deleted.push(table);
            return failTables.includes(table) ? { error: { message: 'boom' } } : { error: null, count: 1 };
          } };
        },
        select() {
          return { range: async (a, b) => {
            log.pageCalls.push([table, a, b]);
            return { data: (pages[table] || []).slice(a, b + 1), error: null };
          } };
        },
      };
    },
    auth: { admin: { deleteUser: async () => (authErr ? { error: authErr } : authFail ? { error: { message: 'authfail' } } : { error: null }) } },
  };
}

function fresh(rel) {
  const p = require.resolve(rel);
  delete require.cache[p];
  return require(p);
}

test('C4/C7: 전부 성공하면 hard_deleted + 개인정보 4열 null', async () => {
  const { hardDeleteUser } = fresh('../jobs/retention');
  const admin = makeAdmin();
  const r = await hardDeleteUser(admin, 'u1');
  assert.equal(r.failed, false);
  assert.equal(admin.log.adrUpdates.length, 1);
  const u = admin.log.adrUpdates[0];
  assert.equal(u.status, 'hard_deleted');
  for (const k of ['email_at_request', 'ip_masked', 'user_agent', 'reason']) assert.ok(k in u && u[k] === null, k);
});

test('C7: 삭제 대상에 user_budget 포함', async () => {
  const { hardDeleteUser } = fresh('../jobs/retention');
  const admin = makeAdmin();
  await hardDeleteUser(admin, 'u1');
  assert.ok(admin.log.deleted.includes('user_budget'));
});

test('C4: 표 삭제 실패 시 status 를 바꾸지 않는다(pending 유지)', async () => {
  const { hardDeleteUser } = fresh('../jobs/retention');
  const admin = makeAdmin({ failTables: ['bookmarks'] });
  const r = await hardDeleteUser(admin, 'u1');
  assert.equal(r.failed, true);
  assert.ok(r.errors.bookmarks);
  assert.equal(admin.log.adrUpdates.length, 0);
});

test('C4: auth.users 삭제 실패 시에도 pending 유지', async () => {
  const { hardDeleteUser } = fresh('../jobs/retention');
  const admin = makeAdmin({ authFail: true });
  const r = await hardDeleteUser(admin, 'u1');
  assert.equal(r.authDeleted, false);
  assert.equal(r.failed, true);
  assert.equal(admin.log.adrUpdates.length, 0);
});

test('C4: 재시도 회차에서 auth 사용자가 이미 없으면(404) 삭제 완료로 보고 hard_deleted 로 전환', async () => {
  const { hardDeleteUser } = fresh('../jobs/retention');
  const admin = makeAdmin({ authErr: { status: 404, code: 'user_not_found', message: 'User not found' } });
  const r = await hardDeleteUser(admin, 'u1');
  assert.equal(r.authDeleted, true);
  assert.equal(r.failed, false);
  assert.equal(admin.log.adrUpdates[0].status, 'hard_deleted');
});

test('C4: 메시지에 not found 가 있어도 code 가 user_not_found 가 아니면(서버 오류·게이트웨이 404) pending 유지', async () => {
  const { hardDeleteUser } = fresh('../jobs/retention');
  for (const authErr of [{ status: 500, message: 'Database error deleting user: row not found' }, { status: 404, message: 'Not Found' }]) {
    const admin = makeAdmin({ authErr });
    const r = await hardDeleteUser(admin, 'u1');
    assert.equal(r.authDeleted, false, authErr.message);
    assert.equal(r.failed, true);
    assert.equal(admin.log.adrUpdates.length, 0);
  }
});

test('C9: loadRows 가 1000행 페이지를 반복해 전체를 읽는다 / 5000 상한', async () => {
  const mk = n => Array.from({ length: n }, (_, i) => ({ id: i }));
  const { _loadRows } = fresh('../jobs/pushNotify');
  const a1 = makeAdmin({ pages: { t: mk(2300) } });
  const r1 = await _loadRows(a1, 't');
  assert.equal(r1.rows.length, 2300);
  assert.equal(a1.log.pageCalls.length, 3);
  const a2 = makeAdmin({ pages: { t: mk(7000) } });
  const r2 = await _loadRows(a2, 't');
  assert.equal(r2.rows.length, 5000);
});

// ── account.js 라우트: 가짜 admin + audit 스텁으로 핸들러 직접 호출 ──
function loadAccountRouter(admin, audits) {
  const stub = (p, exports) => { require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  const realClient = require(clientPath);
  stub(clientPath, { ...realClient, requireSupabaseAdmin: () => admin, getSupabaseAdmin: () => admin });
  stub(auditPath, { writeAudit: async (...a) => { audits.push(a); }, writeSystemAudit: async () => {} });
  stub(authPath, { requireAuth: (_q, _s, n) => n() });
  return fresh('../routes/account');
}
function findHandler(router, method, p) {
  const layer = router.stack.find(l => l.route && l.route.path === p && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function mkRes() { return { body: null, code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; }

function deleteAdmin({ deleted, upserts, kakaoThrows = false }) {
  return {
    from(table) {
      return {
        select() { return { eq() { return { maybeSingle: async () => ({ data: null }) }; } }; },
        upsert(row) { upserts.push(row); return { select() { return { single: async () => ({ data: { scheduled_hard_delete_at: 'S' }, error: null }) }; } }; },
        delete() { return { eq: async () => { if (kakaoThrows) throw new Error('down'); deleted.push(table); return { error: null }; } }; },
      };
    },
    auth: { admin: { signOut: async () => ({}) } },
  };
}

test('C6/C7/C8: /delete — audit meta 에 email 없음·reason 500자·문자열만, kakao 토큰 삭제', async () => {
  const audits = [], deleted = [], upserts = [];
  const router = loadAccountRouter(deleteAdmin({ deleted, upserts }), audits);
  const h = findHandler(router, 'post', '/delete');
  const req = { body: { confirm: 'DELETE', reason: 'x'.repeat(900) }, user: { id: 'u1', email: 'a@b.c' }, headers: {}, ip: '1.2.3.4', accessToken: 't' };
  const res = mkRes();
  await h(req, res, e => { throw e; });
  assert.equal(res.body.ok, true);
  const meta = audits.find(a => a[1] === 'account.delete.request')[4];
  assert.equal('email' in meta, false);
  assert.equal(meta.reason.length, 500);
  assert.ok(deleted.includes('kakao_notify_tokens'));

  audits.length = 0;
  const res2 = mkRes();
  await h({ ...req, body: { confirm: 'DELETE', reason: { a: 1 } } }, res2, e => { throw e; });
  assert.equal(audits.find(a => a[1] === 'account.delete.request')[4].reason, null);
  assert.equal(upserts[1].reason, null);
});

test('C8: kakao 토큰 삭제가 실패해도 삭제 예약은 진행', async () => {
  const router = loadAccountRouter(deleteAdmin({ deleted: [], upserts: [], kakaoThrows: true }), []);
  const h = findHandler(router, 'post', '/delete');
  const res = mkRes();
  await h({ body: { confirm: 'DELETE' }, user: { id: 'u1' }, headers: {}, ip: '1.1.1.1', accessToken: 't' }, res, e => { throw e; });
  assert.equal(res.body.ok, true);
});

test('C5: /consent — 같은 IP 의 다른 사람은 기록하되 IP 당 10분 30건 상한, 같은 사람 반복은 건너뛴다', async () => {
  const audits = [];
  const router = loadAccountRouter({}, audits);
  const h = findHandler(router, 'post', '/consent');
  const body = { age14Plus: true, terms: true, privacy: true, intlTransfer: true };
  const call = async (ua, ip, version = 'v1') => { const r = mkRes(); await h({ body: { ...body, version }, headers: { 'user-agent': ua }, ip }, r); return r.body; };
  assert.equal((await call('A', '9.9.9.9')).deduped, undefined);
  assert.equal((await call('A', '9.9.9.9')).deduped, true);        // 같은 사람 반복
  for (let i = 0; i < 29; i++) assert.equal((await call('U' + i, '9.9.9.9')).deduped, undefined); // 공용 IP 의 다른 사람 29명
  assert.equal((await call('F', '9.9.9.9')).deduped, true);        // 31번째 — IP 상한
  assert.equal((await call('G', '9.9.9.9', 'v9')).deduped, true);  // UA·version 을 바꿔도 상한
  assert.equal((await call('A', '8.8.8.8')).deduped, undefined);   // 다른 IP 는 별개
  assert.equal(audits.filter(a => a[1] === 'consent.accept').length, 31);
});
