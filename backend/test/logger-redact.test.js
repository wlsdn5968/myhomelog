const test = require('node:test');
const assert = require('node:assert/strict');
const pino = require('pino');

test('REDACT-DEPTH (Plan 076): 1·2·3단계 중첩 비밀값이 가려지고 일반 필드는 남는다', () => {
  const { REDACT_PATHS } = require('../logger');
  const lines = [];
  const log = pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, { write: (s) => lines.push(s) });
  log.info({
    a: { apiKey: 'k1' }, b: { c: { token: 'k2' } }, d: { e: { f: { password: 'k3' } } },
    req: { headers: { authorization: 'Bearer x', 'user-agent': 'ua' } },
    keep: { nested: { value: 'ok' } }, aptSeq: '11350-183',
  }, 'probe');
  const o = JSON.parse(lines.join('').trim().split('\n').pop());
  assert.equal(o.a.apiKey, '[REDACTED]');
  assert.equal(o.b.c.token, '[REDACTED]');
  assert.equal(o.d.e.f.password, '[REDACTED]');
  assert.equal(o.req.headers.authorization, '[REDACTED]');
  assert.equal(o.req.headers['user-agent'], 'ua');
  assert.equal(o.keep.nested.value, 'ok');
  assert.equal(o.aptSeq, '11350-183');
  assert.ok(REDACT_PATHS.includes('req.headers.cookie') && REDACT_PATHS.includes('*.apiKey'), '기존 경로가 빠졌다');
});
