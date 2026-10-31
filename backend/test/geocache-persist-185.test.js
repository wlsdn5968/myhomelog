/**
 * Plan 185 (2026-10-31, 운영자 승인): 카카오맵 1대1 대조 뒤 고친 좌표가 업데이트로 원점이 되지 않게.
 * ① 공식 단지 이름 = 신고 이름인 단지(헬리오시티·잠실엘스 등)는 좌표가 kapt: 한 행뿐이라 지도에 핀이 없었다 — 지도가 kapt: 도 읽는다.
 * ② 손 보정(source='manual') 좌표를 덮을 수 있는 쓰기 경로가 늘어나면 이 검사가 먼저 실패한다(새 경로는 manual 을 건너뛰는지 확인한 뒤 목록에 추가).
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

test('지도 영역: 공식 단지 키(kapt:) 좌표도 읽어 이름 좌표 뒤에 붙이고, 최종 핀은 거래 많은 순 limit 개', () => {
  const s = read('../routes/search.js');
  const body = s.slice(s.indexOf("router.get('/in-bounds'"));
  assert.match(body, /\.like\('apt_key', 'kapt:%'\)\.neq\('source', 'kakao-x'\)/);
  assert.match(body, /\.not\('sigungu', 'is', null\)\.not\('umd_nm', 'is', null\)/);
  assert.match(body, /const coords = \[\.\.\.\(_nameCoords \|\| \[\]\), \.\.\.\(_kaptCoords \|\| \[\]\)\.filter\(c => !_haveCombo\.has\(/, '이름 좌표가 먼저(별칭 묶음 우선), 같은 (이름·시군구·동)은 한 번만');
  assert.match(body, /if \(_kErr\) throw _kErr;/, '공식 단지 좌표 조회 실패를 빈 결과로 삼키면 핀이 조용히 빠진다');
  assert.match(body, /\.sort\(\(a, b\) => \(b\.dealCount \|\| 0\) - \(a\.dealCount \|\| 0\)\)\.slice\(0, limit\);/);
});

function geocacheWriters() {
  const out = {};
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) { if (!['node_modules', 'test', 'testSupport'].includes(f.name)) walk(p); continue; }
      if (!f.name.endsWith('.js')) continue;
      const src = fs.readFileSync(p, 'utf8');
      let i = 0, n = 0;
      while ((i = src.indexOf("from('apt_geocache')", i)) >= 0) {
        const stmt = src.slice(i, src.indexOf(';', i) + 1 || undefined);
        if (/\.(update|upsert|delete|insert)\(/.test(stmt)) n++;
        i += 10;
      }
      if (n) out[path.relative(path.join(__dirname, '..'), p).replace(/\\/g, '/')] = n;
    }
  };
  walk(path.join(__dirname, '..'));
  return out;
}

test('좌표 표 쓰기 경로가 늘지 않았다(늘면 manual 보호 확인 뒤 이 목록 갱신)', () => {
  assert.deepEqual(geocacheWriters(), {
    'jobs/geocacheBackfill.js': 8, // 모두 출처 kakao·kakao-sub·kakao-v·kakao-addr 로 고른 행만 쓴다(apt-identity-176 테스트가 출처 목록에 manual 없음을 확인)
    'services/geocodeCacheService.js': 1, // saveToDb — manual 이면 건너뛴다(MANUAL-COORD-2026-10-30)
  });
  const g = read('../services/geocodeCacheService.js');
  assert.match(g, /MANUAL_SOURCE/);
});

test('손 보정 보호 트리거 마이그레이션 파일(DB 수준 잠금, 운영 적용은 운영자 SQL Editor)', () => {
  const m = read('../../supabase/migrations/20261031_protect_manual_geocache.sql');
  assert.match(m, /IF OLD\.source = 'manual' AND NEW\.source IS DISTINCT FROM 'manual' THEN\s*RETURN NULL;/);
  assert.match(m, /IF OLD\.source = 'manual' THEN RETURN NULL; END IF;/);
  assert.match(m, /BEFORE UPDATE OR DELETE ON public\.apt_geocache/);
  assert.match(m, /myhomelog\.allow_manual_geocache_change/);
});

test('LOCK-GUARD: 좌표 작업의 모든 수정문은 고칠 때도 손 보정·숨김 행을 다시 확인한다(고른 뒤 사람이 바꾼 행 보호)', () => {
  const src = read('../jobs/geocacheBackfill.js');
  assert.match(src, /const LOCKED_SOURCES = '\(manual,kakao-x\)';/);
  let i = 0, n = 0, guarded = 0;
  while ((i = src.indexOf("from('apt_geocache')", i)) >= 0) {
    const stmt = src.slice(i, src.indexOf(';', i) + 1);
    if (/\.update\(/.test(stmt)) { n++; if (/\.not\('source', 'in', LOCKED_SOURCES\)/.test(stmt)) guarded++; }
    i += 10;
  }
  assert.equal(n, 8); assert.equal(guarded, n, '출처 재확인 없는 수정문이 생겼다');
  const g = read('../services/geocodeCacheService.js');
  assert.match(g, /cur\.source === MANUAL_SOURCE \|\| cur\.source === 'kakao-x'\)\) return;/, '저장 함수가 손 보정·숨김 행을 건너뛴다');
});

test('LOCK-CHECK: 매일 손 보정·숨김 행 수, 매주 별칭 보정표 누락 수를 남기고 health 로 보인다', () => {
  const g = read('../jobs/geocacheBackfill.js');
  assert.match(g, /lockedManual/); assert.match(g, /lockedHidden/);
  const a = read('../jobs/aptMasterSync.js');
  assert.match(a, /overridesMissing/);
  assert.match(a, /captureMessage\(`별칭 보정표 누락/);
  const { _pick } = require('../services/cronStats');
  assert.deepEqual(_pick({ lockedManual: 90, lockedHidden: 1200, overridesMissing: 0 }), { lockedManual: 90, lockedHidden: 1200, overridesMissing: 0 });
});
