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
    // 컨텍스트 무결성: session 은 단일 user 메시지의 <session_context> 신뢰불가 블록으로 격리되어야 함 (존재 확인)
    name: 'chat.js <session_context data_source="client_supplied_untrusted"> 블록 부재 — session 격리가 되돌려짐',
    file: 'backend/routes/chat.js',
    re: /<session_context data_source="client_supplied_untrusted">/,
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
