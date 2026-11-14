/**
 * UMD-RENAME-2026-11-14: 국토부 원본이 2025-10 부터 달성군 구지면을 구지읍으로 바꿔 보내,
 * 지도 집계(/api/search/in-bounds)에서 같은 단지 거래가 두 동 이름으로 나뉘었다(운영 실측 구지면 93행, 구지읍 191행).
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../routes/search.js'), 'utf8');
const { umdCanon: _umdCanon, umdWithLegacy: _umdWithLegacy } = require('../utils/umdRename');

test('상세 거래 조회의 동 필터도 같은 규칙을 쓴다(지도 핀과 상세 건수 일치)', () => {
  const tx = fs.readFileSync(path.join(__dirname, '../routes/transactions.js'), 'utf8');
  assert.match(tx, /_umdCanon\(t\.sigungu, t\.umdNm\) !== _umdCanon\(t\.sigungu, umdNm\)/);
  assert.match(src, /require\('\.\.\/utils\/umdRename'\)/);
});

test('옛 이름은 새 이름으로 맞추고 다른 지역과 다른 이름은 그대로 둔다', () => {
  assert.equal(_umdCanon('달성군', '구지면 창리'), '구지읍 창리');
  assert.equal(_umdCanon('달성군', '구지읍 창리'), '구지읍 창리');
  assert.equal(_umdCanon('달성군', '현풍읍 중리'), '현풍읍 중리');
  assert.equal(_umdCanon('노원구', '공릉동'), '공릉동');
  assert.equal(_umdCanon('달성군', null), null);
});

test('조회 목록에는 새 이름과 옛 이름을 함께 넣는다', () => {
  assert.deepEqual(_umdWithLegacy(['구지읍 응암리', '공릉동']).sort(), ['공릉동', '구지면 응암리', '구지읍 응암리'].sort());
});

test('이름을 맞춘 뒤 같은 단지 좌표가 둘이면 하나만 남긴다(원래 새 이름 행 우선)', () => {
  // 실제 소스 블록을 꺼내 운영과 같은 모양(옛 이름 행과 새 이름 행이 함께)으로 돌린다
  const i = src.indexOf('      const _seen = new Map();');
  const j = src.indexOf('    const umds = [...new Set(coords.map(c => c.umd_nm)', i);
  const body = src.slice(i, j).replace(/\n    \}\s*$/, '');
  const run = new Function('coords', '_umdCanon', `{\n${body}\n}\nreturn coords;`);
  const out = run([
    { apt_name: '과학마을청아람', sigungu: '달성군', umd_nm: '구지면 응암리', tag: 'old' },
    { apt_name: '과학마을청아람', sigungu: '달성군', umd_nm: '구지읍 응암리', tag: 'new' },
    { apt_name: '공릉풍림아이원', sigungu: '노원구', umd_nm: '공릉동', tag: 'other' },
  ], _umdCanon);
  assert.deepEqual(out.map((c) => c.tag).sort(), ['new', 'other']);
  assert.ok(out.every((c) => c.umd_nm !== '구지면 응암리'));
});

test('지도 집계는 좌표, 거래, 마스터, 보충 거래 모두 맞춘 이름을 쓴다', () => {
  assert.match(src, /const canon = _umdCanon\(c\.sigungu, c\.umd_nm\);/);
  assert.match(src, /for \(const t of \(txs \|\| \[\]\)\) t\.umd_nm = _umdCanon\(t\.sigungu, t\.umd_nm\);/);
  assert.match(src, /for \(const m of \(_masters \|\| \[\]\)\) m\.umd_nm = _umdCanon\(m\.sigungu, m\.umd_nm\);/);
  assert.match(src, /_q = _q\.in\('umd_nm', umdsQ\);/);
  assert.match(src, /_q = _q\.in\('umd_nm', _umdWithLegacy\(_mUmds\)\);/);
});
