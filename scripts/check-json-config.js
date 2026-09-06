#!/usr/bin/env node
/**
 * JSON 설정 파일 검증 (Plan 049).
 *
 * [왜 이 게이트가 존재하는가]
 * vercel.json 의 `excludeFiles` 256자 한도 초과 시 배포가 통째로 거부되는데,
 * CI 빌드 로그에는 사유가 남지 않는다. 로컬에서 먼저 JSON 파싱 검사를 하면
 * 이 종류의 오류를 조기 발견할 수 있다.
 *
 * [하는 일] 3개 설정 파일의 JSON 유효성을 검증한다:
 *          - package.json
 *          - backend/package.json
 *          - vercel.json
 *
 * ⚠ CI 스텝 `.github/workflows/ci.yml` 의 `JSON config validate` 와
 *   동일한 검증을 로컬에서도 수행한다 (중복 제거는 나중에 가능).
 *
 * 종료 코드: 유효하면 0, 하나라도 실패하면 1.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILES = [
  path.join(ROOT, 'package.json'),
  path.join(ROOT, 'backend', 'package.json'),
  path.join(ROOT, 'vercel.json'),
];

function main() {
  let allOk = true;

  for (const f of FILES) {
    const rel = path.relative(ROOT, f);
    if (!fs.existsSync(f)) {
      console.log(`⊘ ${rel} — 파일이 없다 (선택사항 무시)`);
      continue;
    }

    try {
      const content = fs.readFileSync(f, 'utf8');
      JSON.parse(content);
      console.log(`✓ ok: ${rel}`);
    } catch (e) {
      console.error(`✗ FAIL: ${rel}`);
      console.error(`  ${e.message}`);
      allOk = false;
    }
  }

  if (allOk) {
    console.log('✓ check-json-config OK — 설정 파일 파싱 통과');
    process.exit(0);
  } else {
    console.error('✗ JSON 파싱 실패 — 위 파일들을 검토할 것');
    process.exit(1);
  }
}

main();
