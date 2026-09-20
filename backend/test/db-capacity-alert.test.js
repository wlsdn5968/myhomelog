'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _dbCapacityLevel } = require('../routes/cron');

// DB-CAPACITY-2026-09-20 (Plan 105): DB 용량 임계 판정 로직
test('dbCapacityLevel(usedMb, limitMb) — 85%/93% 경계 판정', () => {
  assert.strictEqual(_dbCapacityLevel(424, 500), null, '85% 미만은 null');
  assert.strictEqual(_dbCapacityLevel(425, 500), 'warning', '85% 이상은 warning');
  assert.strictEqual(_dbCapacityLevel(464.9, 500), 'warning', '93% 미만은 warning');
  assert.strictEqual(_dbCapacityLevel(465, 500), 'error', '93% 이상은 error');
  assert.strictEqual(_dbCapacityLevel(0, 500), null, 'usedMb=0은 null');
  assert.strictEqual(_dbCapacityLevel(-10, 500), null, 'usedMb<0은 null');
  assert.strictEqual(_dbCapacityLevel(100, 0), null, 'limitMb=0은 null');
  assert.strictEqual(_dbCapacityLevel(100, -50), null, 'limitMb<0은 null');
  assert.strictEqual(_dbCapacityLevel(NaN, 500), null, 'usedMb=NaN은 null');
  assert.strictEqual(_dbCapacityLevel(100, NaN), null, 'limitMb=NaN은 null');
});
