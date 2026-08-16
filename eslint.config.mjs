// LINT-MINIMAL-2026-08-16 (Plan 020) — **정확성 규칙만** 켜는 최소 린트 설정
//
// 왜 도입하나:
//   계획 010 의 결함 B(`fetch` 옵션 객체에 `signal` 키가 두 번 → 90s 타임아웃 의도가 죽고
//   180s 가 적용)는 표준 규칙 `no-dupe-keys` 하나면 잡혔을 결함인데 CI 를 그냥 통과했다.
//   중복 키는 **문법적으로 합법**이라 `node --check` 도 `new Function()` 도 절대 못 잡는다.
//
// 도입 전에 실측했다 (2026-08-16, eslint 10.8.1):
//   · backend/routes·services·jobs·middleware + scripts + api  → **에러 0**
//   · frontend/index.html 인라인 JS(6블록)                      → **에러 1**(의도된 게이트, 아래 참조)
//   즉 "11,070행 프론트에서 위반이 대량으로 나올 것"이라던 사전 추정은 **틀렸다**.
//   고쳐야 할 기존 부채가 없으므로 baseline·점진 적용 전략 없이 바로 켤 수 있다.
//
// 설계 원칙:
//   1) **스타일 규칙은 켜지 않는다.** 들여쓰기·따옴표·세미콜론은 전부 무규칙 유지.
//      목적은 "코드 취향 통일"이 아니라 **버그 클래스 차단** 하나뿐이다.
//   2) 규칙을 추가할 때는 "이 규칙이 없어서 실제로 사고가 났는가"를 근거로 삼는다.
//      늘리고 싶으면 기존 코드에서 위반 수를 먼저 실측할 것(대량이면 도입 보류).
//   3) 경고는 CI 를 막지 않는다(에러만 막는다). 스타일 논쟁으로 배포가 멈추면 안 된다.
export default [
  {
    // ── 백엔드/스크립트/서버리스 진입점 (CommonJS) ──
    files: ['backend/**/*.js', 'scripts/**/*.js', 'api/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'writable', exports: 'writable',
        process: 'readonly', console: 'readonly', Buffer: 'readonly',
        __dirname: 'readonly', __filename: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        AbortSignal: 'readonly', fetch: 'readonly', URL: 'readonly',
      },
    },
    linterOptions: {
      // backend/jobs/retention.js 에 `no-console` 용 disable 주석이 남아 있는데 그 규칙을
      // 켜지 않아 "unused directive" 경고가 뜬다. 무해한 잔재라 프로덕션 파일을 건드리지
      // 않고 경고만 끈다(에러가 아니므로 CI 에는 애초에 영향이 없다).
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      // ★ 실사고 클래스 — 중복 키/인자/분기
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-else-if': 'error',
      'no-duplicate-case': 'error',
      // 죽은 코드·자기대입 — 의도와 실제가 갈린 신호
      'no-unreachable': 'error',
      'no-self-assign': 'error',
      'no-func-assign': 'error',
      // 조건문 실수
      'no-cond-assign': 'error',
      'no-unsafe-negation': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      // 호출/배열 실수
      'no-obj-calls': 'error',
      'no-sparse-arrays': 'error',
      'no-setter-return': 'error',
    },
  },
  {
    // ── frontend/index.html 에서 뽑아낸 인라인 <script> (scripts/extract-inline-js.js) ──
    //   .lint-tmp/*.js 는 원본 줄번호를 보존한다(앞을 개행으로 패딩) → 에러 줄번호를
    //   그대로 frontend/index.html 의 줄번호로 읽으면 된다.
    files: ['.lint-tmp/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        window: 'readonly', document: 'readonly', location: 'readonly',
        localStorage: 'readonly', sessionStorage: 'readonly', navigator: 'readonly',
        console: 'readonly', fetch: 'readonly', alert: 'readonly', confirm: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        requestAnimationFrame: 'readonly', AbortSignal: 'readonly', AbortController: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly', FormData: 'readonly', Blob: 'readonly',
        naver: 'readonly', kakao: 'readonly', Sentry: 'readonly',
      },
    },
    rules: {
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-else-if': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-self-assign': 'error',
      'no-func-assign': 'error',
      'no-cond-assign': 'error',
      'no-unsafe-negation': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-obj-calls': 'error',
      'no-sparse-arrays': 'error',
      'no-setter-return': 'error',
    },
  },
];
