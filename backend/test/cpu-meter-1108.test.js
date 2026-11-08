'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { cpuMeter, routeKey } = require('../middleware/cpuMeter');

test('경로 묶기: 숫자 칸은 :id, 질의 문자열은 남기지 않는다', () => {
  assert.equal(routeKey('/apt/11350-183'), '/apt/:id');
  assert.equal(routeKey('/api/og/apt?seq=11350-183'), '/api/og/apt');
  assert.equal(routeKey('/api/search/in-bounds?south=37.6&west=127'), '/api/search/in-bounds');
  assert.equal(routeKey('/api/cron/molit-ingest?slot=0&slotCount=3'), '/api/cron/molit-ingest');
  assert.equal(routeKey('/'), '/');
});

test('봇 이름만 뽑고 UA 전체는 남기지 않는다', () => {
  const { botName } = require('../middleware/cpuMeter');
  assert.equal(botName('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), 'Googlebot');
  assert.equal(botName('Mozilla/5.0 (compatible; Yeti/1.1; +https://naver.me/spd)'), 'Yeti');
  assert.equal(botName('Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)'), 'AhrefsBot');
  assert.equal(botName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36'), null);
  assert.equal(botName(''), null);
});

test('응답이 끝나면 한 줄 남기고, finish 와 close 가 둘 다 와도 한 번만', () => {
  const lines = [];
  const logger = { info: (o, m) => lines.push([o, m]) };
  const res = new EventEmitter(); res.statusCode = 200;
  const req = { originalUrl: '/apt/1?x=1', get: () => 'Googlebot/2.1' };
  let called = false;
  cpuMeter(logger)(req, res, () => { called = true; });
  assert.ok(called);
  res.emit('finish'); res.emit('close');
  assert.equal(lines.length, 1);
  const [o, m] = lines[0];
  assert.equal(m, 'cpu-meter');
  assert.equal(o.cpuMeter.route, '/apt/:id');
  assert.equal(o.cpuMeter.bot, true);
  assert.equal(o.cpuMeter.status, 200);
  assert.ok(Number.isInteger(o.cpuMeter.ms) && o.cpuMeter.ms >= 0);
  assert.equal(o.cpuMeter.inflight, 1);
});

test('서버 진입부 가장 앞에 붙어 있다', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../server.js'), 'utf8');
  const i = src.indexOf("app.use(require('./middleware/cpuMeter').cpuMeter(");
  assert.ok(i > 0 && i < src.indexOf('app.use((req, res, next) => {'), '다른 미들웨어보다 앞이어야 한다');
});
