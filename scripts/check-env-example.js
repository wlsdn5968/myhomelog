#!/usr/bin/env node
/**
 * `backend/.env.example` 드리프트 검사 (Plan 029).
 *
 * [왜 이 게이트가 존재하는가]
 * 코드가 읽는 환경변수가 `.env.example` 에 안 적히는 누락이 **세 번 재발**했다.
 * 이 저장소는 env 미설정 시 기능이 조용히 꺼지는 graceful-degrade 설계라,
 * 문서 누락이 **부팅 실패로 드러나지 않는다** — 아무 경고 없이 재발하고,
 * 새 환경(신규 기여자·새 배포)에서 해당 기능만 소리 없이 비활성화된 채로 돈다.
 * 계획 005 가 "grep 대조를 CI 로 올리자"는 후속을 적어뒀지만 만들어지지 않아 또 누락됐다.
 *
 * [하는 일] backend 코드가 읽는 `process.env.X` 이름을 모아 `.env.example` 선언과 대조하고,
 *          코드에만 있는 이름을 출력한다. 반대(예시에만 있음)는 무시한다 — 해가 없다.
 *
 * ⚠ 값은 절대 다루지 않는다. **이름만** 수집·출력하고 실제 `.env` 파일은 읽지 않는다.
 *   (CI 로그는 공개될 수 있다)
 *
 * 종료 코드: 누락 있으면 1, 없으면 0.
 * ⚠ 현재 CI 에서는 `|| true` 로 **비차단** 실행한다 — 이 저장소의 "게이트가 서로를 죽이지
 *   않게 분리" 원칙(ci.yml 의 CI-GATE-DECOUPLE 주석) 때문이다. 문서 누락이 문법 검사·테스트를
 *   막아선 안 된다. 차단 게이트로의 승격은 별도 결정 사항이다.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BACKEND = path.join(ROOT, 'backend');
const EXAMPLE = path.join(BACKEND, '.env.example');

/**
 * 플랫폼(Vercel/Node/CI)이 자동 주입하는 변수 — 사람이 `.env` 에 적을 대상이 아니다.
 * ⚠ 새 항목을 넣을 땐 **왜 제외하는지** 근거를 함께 적을 것. 근거 없는 제외가 쌓이면
 *   게이트가 조용히 무력해진다.
 */
const PLATFORM_PROVIDED = new Set([
  'NODE_ENV',                // Node 런타임 표준
  'PORT',                    // 호스팅 플랫폼이 주입
  'TZ',                      // 런타임 타임존
  'CI',                      // CI 러너가 주입
  'VERCEL',                  // 이하 Vercel 자동 주입 (.env.example 하단 주석에도 명시돼 있음)
  'VERCEL_ENV',
  'VERCEL_URL',
  'VERCEL_BRANCH_URL',       // server.js 프리뷰 자기출처 CORS(PREVIEW-CORS-2026-09-05)가 읽는다 — Vercel 자동 주입(system env). CI #911 이 이 누락으로 막혔다
  'VERCEL_REGION',           // logger.js 가 읽지만 Vercel 이 넣어준다
  'VERCEL_GIT_COMMIT_SHA',
]);

/** backend 하위 .js 를 모은다 (node_modules·숨김 디렉터리 제외) */
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

/**
 * `process.env.NAME` 에서 NAME 을 뽑는다.
 * ⚠ 대괄호 표기(`process.env['NAME']`)는 일부러 다루지 않는다 —
 *   2026-08-17 실측상 우리 코드에는 0건이고, node_modules(Anthropic SDK 등)에만 92건 있다.
 *   여기서 node_modules 는 walk 가 이미 제외한다. 나중에 우리 코드에 대괄호 표기가 생기면
 *   이 정규식을 넓혀야 한다.
 */
function collectFromCode(files) {
  const names = new Set();
  const re = /process\.env\.([A-Z0-9_]+)/g;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    let m;
    while ((m = re.exec(src)) !== null) names.add(m[1]);
  }
  return names;
}

/** `.env.example` 에서 `NAME=` 형태로 선언된 이름을 뽑는다 (값은 읽지 않는다) */
function collectFromExample(file) {
  const names = new Set();
  const src = fs.readFileSync(file, 'utf8');
  for (const line of src.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

function main() {
  if (!fs.existsSync(EXAMPLE)) {
    console.error(`✗ ${path.relative(ROOT, EXAMPLE)} 가 없다 — 경로가 바뀌었는지 확인할 것.`);
    process.exit(1);
  }

  const files = walk(BACKEND);
  const inCode = collectFromCode(files);
  const inExample = collectFromExample(EXAMPLE);

  const missing = [...inCode]
    .filter((n) => !inExample.has(n) && !PLATFORM_PROVIDED.has(n))
    .sort();

  console.log(
    `env-example 대조: 코드 참조 ${inCode.size}개 · 예시 선언 ${inExample.size}개 · ` +
    `플랫폼 제공 제외 ${PLATFORM_PROVIDED.size}개 (스캔 파일 ${files.length})`
  );

  if (!missing.length) {
    console.log('✓ check-env-example OK — 코드가 읽는데 .env.example 에 없는 변수: 0건');
    process.exit(0);
  }

  console.log(`✗ .env.example 에 누락된 변수 ${missing.length}건 (이름만 표시 — 값은 다루지 않는다):`);
  for (const n of missing) console.log(`   - ${n}`);
  console.log('→ backend/.env.example 에 자리표시자(`NAME=`)와 한 줄 설명을 추가할 것. **실값 기재 금지.**');
  process.exit(1);
}

main();
