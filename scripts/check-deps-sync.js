#!/usr/bin/env node
/**
 * 루트/백엔드 package.json 동기화 검증.
 *
 * Vercel 은 루트 package.json 만으로 함수 번들을 만든다 (@vercel/node).
 * 따라서 `api/**` 와 `backend/**` 에서 require 하는 외부 패키지는
 * 반드시 루트 package.json 의 dependencies 에 있어야 한다.
 *
 * 또한 두 package.json 에 모두 등장하는 패키지는 버전 레인지가 일치해야
 * 배포/로컬 테스트 간 동작 차이를 예방할 수 있다.
 *
 * 실패 조건:
 *   - 소스가 require 하는 npm 패키지가 루트 deps 에 없음
 *   - 루트·백엔드 공통 패키지인데 버전 레인지가 다름
 *
 * 성공 시 exit 0, 실패 시 exit 1 + 상세 메시지.
 *
 * 이 체크는 2026-04-23 프로덕션 사고
 *   (@supabase/supabase-js 를 backend/package.json 에만 추가했는데
 *    Vercel 이 설치 안 해서 /api/* 전체 500) 재발 방지 목적.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// require('pkg') 또는 require('pkg/sub') 에서 `pkg` (또는 `@scope/pkg`) 만 추출
function extractRequires(src) {
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  const set = new Set();
  let m;
  while ((m = re.exec(src)) !== null) {
    const spec = m[1];
    if (!spec) continue;
    // 상대/절대 경로는 무시
    if (spec.startsWith('.') || spec.startsWith('/')) continue;
    // node: 내장 모듈
    if (spec.startsWith('node:')) continue;
    // 외부 패키지명 추출 (@scope/name 또는 name)
    const parts = spec.split('/');
    const pkg = spec.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
    set.add(pkg);
  }
  return set;
}

const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns',
  'events', 'fs', 'http', 'http2', 'https', 'net', 'os', 'path', 'process',
  'querystring', 'readline', 'stream', 'string_decoder', 'timers', 'tls',
  'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
]);

function main() {
  const rootPkg = readJSON(path.join(ROOT, 'package.json'));
  const backendPkg = readJSON(path.join(ROOT, 'backend', 'package.json'));
  const rootDeps = { ...(rootPkg.dependencies || {}), ...(rootPkg.devDependencies || {}) };
  const backendDeps = { ...(backendPkg.dependencies || {}), ...(backendPkg.devDependencies || {}) };

  const files = [
    ...walk(path.join(ROOT, 'api')),
    ...walk(path.join(ROOT, 'backend')),
  ];

  const required = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const pkg of extractRequires(src)) {
      if (NODE_BUILTINS.has(pkg)) continue;
      required.add(pkg);
    }
  }

  const missingInRoot = [...required].filter(pkg => !rootDeps[pkg]);
  const versionMismatch = [];
  for (const pkg of required) {
    if (rootDeps[pkg] && backendDeps[pkg] && rootDeps[pkg] !== backendDeps[pkg]) {
      versionMismatch.push({ pkg, root: rootDeps[pkg], backend: backendDeps[pkg] });
    }
  }

  if (missingInRoot.length === 0 && versionMismatch.length === 0) {
    console.log(`✓ deps-sync OK — ${required.size} external packages, all present in root package.json`);
    process.exit(0);
  }

  if (missingInRoot.length) {
    console.error('✗ 다음 패키지가 `api/**` 또는 `backend/**` 에서 require 되지만');
    console.error('  루트 package.json 에 없음 (Vercel 빌드 시 MODULE_NOT_FOUND 발생):');
    for (const pkg of missingInRoot) {
      console.error(`    - ${pkg}${backendDeps[pkg] ? ` (backend: ${backendDeps[pkg]})` : ''}`);
    }
    console.error('  → 루트 package.json 의 dependencies 에 추가 후 `npm install` 실행.');
  }

  if (versionMismatch.length) {
    console.error('\n✗ 루트와 backend/package.json 버전 레인지 불일치:');
    for (const m of versionMismatch) {
      console.error(`    - ${m.pkg}: root=${m.root}, backend=${m.backend}`);
    }
    console.error('  → 두 파일의 버전을 일치시켜 로컬/프로덕션 동작 차이를 제거.');
  }

  process.exit(1);
}

main();
