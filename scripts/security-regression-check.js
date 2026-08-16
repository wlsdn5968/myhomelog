#!/usr/bin/env node
/**
 * 보안 회귀 가드 — 2026-05 보안 라운드(커밋 e177c1b, bc027ff, 034b9b9, 컨텍스트 무결성)에서 닫은
 * raw/위험 패턴이 코드에 재유입되는지 정적 검사. node 내장만 사용(신규 의존성 0).
 *
 * 검사 대상:
 *   [frontend/index.html — XSS]
 *   1. field-note memo 가 escape 없이 <textarea> 에 raw 삽입  → ${_escHtml(memo)} 사용해야 함
 *   2. exportClausePDF 의 <title>/<h1> 에 title 이 raw 삽입     → ${safeTitle} 사용해야 함
 *   3. inline onclick JSON 인자에 JSON.stringify(..).replace(/'/g,"&#39;") 패턴 재사용
 *      (데이터에 &quot; 등 entity 문자열일 때 attribute decode 로 JS 변형 가능 →
 *       _jsonAttr() / _escHtml(JSON.stringify(..)) 이중 인코딩으로 통일했음)
 *   4. setAlert 의 _aptNameJs 가 _escHtml 없이 raw JSON.stringify  → _escHtml(JSON.stringify(..)) 사용해야 함
 *   [backend — AI 컨텍스트 무결성]
 *   5. chat.js 가 클라이언트 context.history 를 role messages 로 prepend (history spread) 재유입
 *   6. chatSessions.js ALLOWED_ROLES 에 system 재유입 (클라이언트가 system 권위 메시지 저장 가능)
 *   7. chat.js 가 클라이언트 context.session 을 systemAppend(시스템 프롬프트)로 주입 재유입 (+ <session_context> 격리 블록 존재 필수)
 *
 * 정확히 raw 형태만 매칭하므로 안전 형태(_escHtml / _jsonAttr / safeTitle)는 통과(false positive 방지).
 * 통과: exit 0 / 위반: exit 1 + 위반 라인 출력.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const CHECKS = [
  {
    name: 'field-note memo raw in <textarea> — ${_escHtml(memo)} 로 감싸야 함',
    file: 'frontend/index.html',
    re: /<textarea[^>]*>\$\{\s*memo\s*\}/,
  },
  {
    name: 'exportClausePDF <title> raw — ${safeTitle} 사용',
    file: 'frontend/index.html',
    re: /<title>\$\{\s*title\s*\}<\/title>/,
  },
  {
    name: 'exportClausePDF <h1> raw — ${safeTitle} 사용',
    file: 'frontend/index.html',
    re: /<h1>\$\{\s*title\s*\}<\/h1>/,
  },
  {
    // JSON.stringify(..) 직후의 .replace(/'/g,"&#39;") 만 매칭 — _escHtml 정의의 .replace(/'/g,'&#39;') 오탐 방지
    name: 'inline JSON 인자 JSON.stringify(..).replace(/\'/g,"&#39;") — _jsonAttr() / _escHtml(JSON.stringify(..)) 사용',
    file: 'frontend/index.html',
    re: /JSON\.stringify\([^)]*\)\.replace\(\/'\/g,\s*["']&#39;["']\)/,
  },
  {
    name: 'setAlert _aptNameJs raw JSON.stringify — _escHtml(JSON.stringify(..)) 사용',
    file: 'frontend/index.html',
    re: /_aptNameJs\s*=\s*JSON\.stringify\(/,
  },
  {
    // 컨텍스트 무결성: 클라이언트 history 를 role messages 로 prepend 금지 (단일 untrusted user 블록으로 격리)
    name: 'chat.js context.history role-prepend 재유입 — 단일 user transcript 블록으로 격리해야 함',
    file: 'backend/routes/chat.js',
    re: /\.\.\.\(\s*context\??\.history\s*\|\|\s*\[\]\s*\)/,
  },
  {
    // 컨텍스트 무결성: 클라이언트가 저장 가능한 role 에 system 재유입 금지
    name: 'chatSessions.js ALLOWED_ROLES 에 system 재유입 — user|assistant 만 허용',
    file: 'backend/routes/chatSessions.js',
    re: /ALLOWED_ROLES\s*=\s*new Set\(\[[^\]]*['"]system['"]/,
  },
  {
    // 컨텍스트 무결성: 클라이언트 session 을 systemAppend(시스템 프롬프트)로 보내면 안 됨
    name: 'chat.js systemAppend: sessionContext 재유입 — 클라이언트 session 은 system 프롬프트로 주입 금지',
    file: 'backend/routes/chat.js',
    re: /systemAppend\s*:\s*sessionContext/,
  },
  {
    // CHAT-ZERO-COST-2026-08-12 (Sprint KKKKKKK-16): 챗은 룰베이스 데이터 라우터로 전환 — LLM 호출이
    //   구조적으로 제거됐다. 종전 가드(<session_context> 격리 블록 존재 필수)는 "LLM 프롬프트에
    //   클라이언트 세션을 격리해 넣어라"는 규칙이라 **보호 대상 코드 자체가 사라져** 전제가 소멸.
    //   대신 새 불변식을 CI 로 강제한다: **chat.js 에 LLM 호출(callAI) 재유입 금지** — 운영자
    //   "챗 비용 0원 영구" 방침의 회귀 가드이자, 프롬프트 인젝션 표면의 원천 제거 상태 유지.
    //   (LLM 을 다시 붙이는 결정은 운영자 승인 + 이 가드의 의도적 갱신을 함께 요구하게 된다.)
    name: 'chat.js 에 callAI(LLM 유료 호출) 재유입 — 챗은 룰베이스 데이터 라우터(비용 0)여야 함',
    file: 'backend/routes/chat.js',
    re: /callAI/,
  },
  {
    // REG-ZERO-COST-2026-08-16 (Sprint LLLLLLL — Sentry NODE-7): 규제 감시 cron 이 매일 Anthropic
    //   유료 호출을 시도해 29일간 100% 실패(크레딧 0)하며 매일 error 이슈를 만들었다. 룰베이스로
    //   전환했고, 되돌아오면 **운영자 모르게 다시 과금이 시작되는 경로**라 CI 로 차단한다.
    //   (cron 은 사용자 트리거가 아니라 자동 실행이므로 재유입을 알아채기가 특히 어렵다.)
    name: 'regulationsAiCheck.js 에 callAI(LLM 유료 호출) 재유입 — 규제 감시 cron 은 룰베이스(비용 0)여야 함',
    file: 'backend/jobs/regulationsAiCheck.js',
    re: /callAI/,
  },
  {
    // NEWS-ZERO-COST-2026-08-16 (Sprint PPPPPPP — Sentry NODE-7 의 마지막 활성 유입구):
    //   3줄 시황이 뉴스 탭 진입마다 Anthropic 유료 호출을 시도했고, 크레딧 0 이라 28일간 100% 실패해
    //   데이터 폴백(ECOS·KOSIS·실거래)이 사실상 주 경로였다. 폴백을 주 경로로 승격하고 호출을 제거했다.
    //   ⚠ 이 경로는 **사용자 클릭이 아니라 탭 진입으로 자동 발화**한다 — 되돌아오면 운영자 모르게
    //   호출이 재개되므로 CI 로 차단한다(chat·regulations cron 과 같은 이유·같은 형태의 가드).
    name: 'news.js 에 callAI(LLM 유료 호출) 재유입 — 3줄 시황은 공식 통계 조회(비용 0)여야 함',
    file: 'backend/routes/news.js',
    re: /callAI/,
  },
  {
    // XSS-DEALCARD-2026-08-16 (Plan 010): 계약 타임라인 단지명은 **자유 입력**(드롭다운 아님)이고
    //   localStorage 에 저장됐다가 renderSavedDeals() 가 innerHTML 로 다시 그린다. 이 저장소는
    //   사용자 입력 렌더링을 예외 없이 _escHtml() 로 감싸는데 **여기 한 곳만 누락**돼 있었다.
    //   CSP 가 script-src 'unsafe-inline' 을 허용하므로(인라인 스크립트 구조상 기존 트레이드오프)
    //   CSP 백스톱이 작동하지 않는다 — 코드 레벨 escape 가 유일한 방어라 가드로 고정한다.
    //   ⚠ 안전 형태(`${_escHtml(d.apt||'')}`)는 이 패턴에 걸리지 않는다(raw `${d.apt}` 만 매칭).
    name: 'deal-apt 단지명 raw 삽입 — ${_escHtml(d.apt||\'\')} 로 감싸야 함 (저장형 XSS)',
    file: 'frontend/index.html',
    re: /class="deal-apt">\$\{d\.apt\}/,
  },
  {
    // 챗 응답은 반드시 데이터 라우터를 거쳐야 함 (존재 확인) — 라우터 우회 직접 응답 생성 회귀 차단
    name: 'chat.js 데이터 라우터(chatDataRouter) 연결 부재 — 룰베이스 경로가 제거됨',
    file: 'backend/routes/chat.js',
    re: /require\(['"]\.\.\/services\/chatDataRouter['"]\)/,
    mustExist: true,
  },
  {
    // PII 최소수집: AI 전송 텍스트 전수(message+history+session) PII 검사 유지 — message 단독 검사로 회귀 금지
    name: 'chat.js PII 검사가 context 전수(collectClientPIIText) 없이 message 단독으로 회귀',
    file: 'backend/routes/chat.js',
    re: /detectPII\(\s*collectClientPIIText\(/,
    mustExist: true,
  },
];

function main() {
  const cache = {};
  const violations = [];

  for (const c of CHECKS) {
    if (!cache[c.file]) {
      const abs = path.join(ROOT, c.file);
      if (!fs.existsSync(abs)) {
        console.error(`✗ 대상 파일 없음: ${c.file} (체커가 깨졌거나 경로 변경됨)`);
        process.exit(1);
      }
      cache[c.file] = fs.readFileSync(abs, 'utf8').split('\n');
    }
    const isComment = (ln) => { const t = ln.trim(); return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'); };
    if (c.mustExist) {
      // 존재 필수 패턴: 코드(주석 제외) 어디에도 없으면 위반 — 격리 수정이 되돌려진 것
      const found = cache[c.file].some((ln) => !isComment(ln) && c.re.test(ln));
      if (!found) {
        violations.push({ file: c.file, line: 0, name: '[필수 패턴 누락] ' + c.name, text: '(기대한 안전 패턴이 코드에 없음)' });
      }
    } else {
      cache[c.file].forEach((ln, i) => {
        // 순수 주석 라인은 건너뜀 — 문서/설명에서 패턴을 인용해도 오탐 안 나게 (실제 코드 라인만 검사)
        if (isComment(ln)) return;
        if (c.re.test(ln)) {
          violations.push({ file: c.file, line: i + 1, name: c.name, text: ln.trim().slice(0, 140) });
        }
      });
    }
  }

  if (violations.length === 0) {
    console.log(`✓ security-regression-check OK — ${CHECKS.length} 보안 회귀 패턴 검사, 위반 0건`);
    process.exit(0);
  }

  console.error('✗ 보안 회귀 감지 — 다음 raw 패턴이 재유입됨 (지정 escape 헬퍼로 감싸야 함):');
  for (const v of violations) {
    console.error(`    [${v.file}:${v.line}] ${v.name}`);
    console.error(`      ${v.text}`);
  }
  process.exit(1);
}

main();
