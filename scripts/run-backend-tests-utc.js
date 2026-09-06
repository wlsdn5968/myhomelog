#!/usr/bin/env node
/**
 * backend 테스트를 TZ=UTC 로 강제 실행한다 (Plan 050).
 *
 * [왜 이 게이트가 존재하는가]
 * 프로덕션(Vercel)의 런타임 TZ 는 **UTC** 로 고정인데, 이 저장소의 개발 호스트는
 * Asia/Seoul(KST, UTC+9) 이다. `getFullYear()/getMonth()` 처럼 호스트 로컬 TZ getter 를
 * 쓰는 회귀는 KST 호스트에서는 우연히 의도한 값과 같아 보여 테스트를 통과시키지만,
 * UTC 로 도는 프로덕션에서는 틀린 값을 낸다 — 실제로 `rentService.monthsWindow` 가
 * 이 함정에 걸렸었다(Plan 047, `backend/test/characterization.test.js` 의
 * `KST-SSOT-2026-09-06: rentService.monthsWindow …` 테스트 주석 참고).
 * `npm run verify` 가 호스트 TZ 로만 돌면 "로컬 초록"이 "CI/프로덕션 초록"을
 * 보장하지 못한다 — 이 저장소가 이미 겪은 사고 유형이다.
 *
 * [설계 — 왜 child_process 래퍼인가]
 * `TZ=UTC npm test` 는 POSIX 셸 문법이라 Windows cmd.exe(npm 의 Windows 기본
 * script-shell)에서 동작하지 않는다. 이 레포는 Windows 에서 개발하고 CI 는 ubuntu 라
 * 양쪽에서 다 돌아야 한다 — 셸 문법에 의존하지 않고 `process.env` 를 복사한 뒤
 * `TZ` 만 덮어써서 Node 를 직접 spawn 한다(`scripts/check-json-config.js` 와 같은
 * "작은 Node 래퍼" 패턴, 신규 npm 의존성 0).
 *
 * [왜 UTC 로만 도는가 — 호스트 TZ 로도 중복 실행하지 않는 이유]
 * 선택지는 두 가지였다: (a) 호스트 TZ 1회 + UTC 1회로 두 번 돈다, (b) UTC 로만 돈다.
 * (b) 를 택했다 — 프로덕션은 절대 호스트 TZ(KST 든 다른 무엇이든)로 실행되지 않으므로,
 * "호스트 TZ 에서만 깨지는 회귀"라는 범주 자체가 실질적 위험이 아니다. 이 SSOT 설계
 * (`utils/kstTime.js` + 명시적 오프셋 연산)가 지키려는 불변식은 "입력 절대시각이 같으면
 * 호스트 TZ 와 무관하게 같은 결과"이므로, 올바른 코드는 애초에 호스트 TZ 에 따라 결과가
 * 달라지면 안 된다. 즉:
 *   - 호스트 로컬 getter 를 쓰는 회귀는 UTC 실행이 잡는다(그게 이 게이트의 목적).
 *   - "UTC 에서만 통과하고 KST 에서는 깨지는" 정반대 방향의 버그가 있으려면, 코드가
 *     "호스트가 KST 일 때만" 성립하는 가정을 코드에 넣어야 하는데, 그런 가정은 프로덕션
 *     (UTC 고정)에서 애초에 틀린 가정이라 이 저장소의 SSOT 방침상 존재해서는 안 된다.
 * 기준선 실측(Plan 050): 248 개 테스트 전부 호스트 TZ(KST)·UTC 양쪽에서 pass — 현재
 * 시점에 "UTC 로만 도는 것"으로 인해 새로 놓치는 회귀는 없다. 시간 2배 비용을 내면서까지
 * 이중 실행할 근거가 없다고 판단했다. (b) 를 뒤집을 근거가 생기면(예: 실제로 KST 에서만
 * 깨지는 회귀가 재현되면) 이 스크립트에 두 번째 spawn 을 추가하면 된다.
 *
 * [검증 근거 — 추측 금지] 자식 프로세스가 실제로 UTC 로 도는지 스스로 찍게 한다.
 *
 * 종료 코드: 자식 테스트 프로세스의 exit code 를 그대로 전달.
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BACKEND_DIR = path.join(ROOT, 'backend');
const childEnv = Object.assign({}, process.env, { TZ: 'UTC' });

// 1. TZ=UTC 가 실제로 자식 프로세스에 적용됐는지 자식 스스로 증명한다(추측 금지).
const PROBE = "console.log('[run-backend-tests-utc] child timeZone=' + " +
  "Intl.DateTimeFormat().resolvedOptions().timeZone + ' getTimezoneOffset=' + " +
  'new Date().getTimezoneOffset())';
const probe = spawnSync(process.execPath, ['-e', PROBE], { env: childEnv, stdio: 'inherit' });
if (probe.error || probe.status !== 0) {
  console.error('✗ TZ 프로브 프로세스 실행 실패');
  process.exit(probe.status == null ? 1 : probe.status);
}

// 2. backend 테스트(backend/package.json 의 "test": "node --test")를 같은 TZ=UTC 환경에서 실행.
console.log('[run-backend-tests-utc] backend test 를 TZ=UTC 로 실행한다 (프로덕션 런타임과 일치)');
const result = spawnSync(process.execPath, ['--test'], {
  cwd: BACKEND_DIR,
  env: childEnv,
  stdio: 'inherit',
});

if (result.error) {
  console.error('✗ backend 테스트 프로세스 실행 실패:', result.error.message);
  process.exit(1);
}

process.exit(result.status == null ? 1 : result.status);
