/**
 * SENTRY-CORE-2026-11-10: @sentry/node-core/light 로 바꾼 뒤 요청 분리(scope isolation)가 실제로 되는지 확인한다.
 * README 원문: 일반 node-core 는 OpenTelemetry 설정 없이 "without proper scope isolation". light 는 Node 22+ 에서 자동 분리.
 * 동시에 들어온 두 요청이 각자 태그를 달고 예외를 보내면, 각 이벤트에는 자기 요청의 태그만 있어야 한다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const SENTRY_JS = path.join(__dirname, '..', 'sentry.js');

const CHILD = `
const [sentryJsPath] = process.argv.slice(1);
const Sentry = require(sentryJsPath);
const express = require('express');
const app = express();
app.get('/r/:id', async (req, res) => {
  Sentry.setTag('rid', req.params.id);
  await new Promise((r) => setTimeout(r, req.params.id === 'a' ? 300 : 50));
  Sentry.captureException(new Error('iso-' + req.params.id));
  res.json({ ok: true });
});
const server = app.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const get = (id) => new Promise((resolve) => http.get('http://127.0.0.1:' + port + '/r/' + id, (r) => { r.resume(); r.on('end', resolve); }));
  const http = require('http');
  await Promise.all([get('a'), get('b')]);
  await Sentry.flush(5000);
  server.close();
  process.exit(0);
});
`;

test('light 판: 동시에 들어온 두 요청의 태그가 섞이지 않는다', { timeout: 60000 }, async () => {
  const received = [];
  const ingest = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let buf = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
      received.push(buf.toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => ingest.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, SENTRY_DSN: `http://e2epublickey@127.0.0.1:${ingest.address().port}/1`, VERCEL_ENV: 'test' };
  delete env.NODE_TEST_CONTEXT;
  let stderr = '';
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', CHILD, SENTRY_JS], { cwd: path.join(__dirname, '..'), env });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', resolve);
  });
  await new Promise((resolve) => ingest.close(resolve));
  assert.equal(code, 0, stderr.slice(0, 2000));
  const events = received.flatMap((t) => t.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }))
    .filter((o) => o && o.exception && o.exception.values);
  const byMsg = (m) => events.find((e) => e.exception.values.some((v) => v.value === m));
  const ea = byMsg('iso-a'), eb = byMsg('iso-b');
  assert.ok(ea && eb, `두 오류 이벤트가 모두 와야 한다(받은 수 ${events.length})`);
  assert.equal(ea.tags && ea.tags.rid, 'a', `a 요청 이벤트의 태그가 섞였다: ${JSON.stringify(ea.tags)}`);
  assert.equal(eb.tags && eb.tags.rid, 'b', `b 요청 이벤트의 태그가 섞였다: ${JSON.stringify(eb.tags)}`);
});

test('Sentry 는 light 판을 쓰고, 백엔드 코드가 @sentry/node 를 직접 부르지 않는다, light 판 번호는 정확히 고정', () => {
  const src = fs.readFileSync(SENTRY_JS, 'utf8');
  assert.match(src, /require\('@sentry\/node-core\/light'\)/);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) return ['node_modules', 'test', 'testSupport'].includes(e.name) ? [] : walk(p);
    return p.endsWith('.js') ? [p] : [];
  });
  const offenders = walk(path.join(__dirname, '..')).filter((p) => /require\(['"]@sentry\/node['"]\)/.test(fs.readFileSync(p, 'utf8')));
  assert.deepEqual(offenders, [], '무거운 판을 직접 부르면 시작 CPU 절감이 사라진다');
  for (const pkg of ['../package.json', '../../package.json']) {
    const v = require(pkg).dependencies['@sentry/node-core'];
    assert.match(String(v), /^\d+\.\d+\.\d+$/, `${pkg} 의 @sentry/node-core 는 정확한 판이어야 한다(light 는 실험 기능): ${v}`);
  }
});
