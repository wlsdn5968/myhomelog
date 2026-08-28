#!/usr/bin/env node
/**
 * frontend/index.html 의 인라인 <script> 블록을 .lint-tmp/ 로 뽑아낸다 (LINT-MINIMAL-2026-08-16).
 *
 * 왜 필요한가:
 *   이 프로젝트의 프론트는 단일 HTML 파일이고 JS 가 전부 인라인이다. ESLint 는 .js 만 읽으므로
 *   HTML 플러그인을 추가하지 않는 한 **프론트 코드가 통째로 린트 사각지대**가 된다.
 *   실사고(계획 010 결함 B: `signal` 키 중복으로 90s 타임아웃이 죽고 180s 적용)가 바로 여기서 났다.
 *
 * 줄번호 보존:
 *   각 블록 앞을 개행으로 패딩해 **추출 파일의 줄번호 = frontend/index.html 의 줄번호**가 되게 한다.
 *   그래야 ESLint 가 찍는 위치를 그대로 원본에서 열 수 있다(오프셋 암산 금지).
 *
 * 제외 대상:
 *   - `src=` 가 있는 외부 스크립트(내용 없음)
 *   - `type` 이 JS 가 아닌 블록. 실제로 이 파일 첫 블록은 `application/ld+json`(구조화 데이터)이라
 *     JS 로 파싱하면 `Unexpected token ':'` 이 난다 — JSON 을 JS 로 검사하던 오판 이력 있음.
 *
 * 산출물은 .lint-tmp/ (gitignore) 이며 매 실행마다 갈아엎는다.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// MULTI-HTML-2026-08-28: index.html 하나만 읽던 것을 frontend/*.html 전체로 넓혔다.
//   왜: billing/terms/privacy/refund.html 의 인라인 <script> 는 로컬 lint 도 CI 도 **한 번도 검사하지
//   않았다**. 그 안에 결제·환불 코드가 들어 있어(billing.html 4블록) 문법 오류를 넣어도 게이트가
//   전부 초록이고 브라우저에서만 죽는다 — Plan 034 작업 중 실측으로 드러난 구멍이다.
const SRC_DIR = path.join(ROOT, 'frontend');
const OUT = path.join(ROOT, '.lint-tmp');

const JS_TYPE = /type\s*=\s*["']?(text\/javascript|module|application\/javascript)/i;

/** 한 HTML 에서 인라인 JS 블록을 뽑아 .lint-tmp/<base>-block<N>.js 로 쓴다. */
function extractOne(file) {
  const base = path.basename(file, '.html');
  const html = fs.readFileSync(file, 'utf8');
  const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  let index = 0;
  let written = 0;
  const skipped = [];

  while ((m = re.exec(html)) !== null) {
    index += 1;
    const attrs = (m[1] || '').trim();
    const hasType = /type\s*=/.test(attrs);
    if (hasType && !JS_TYPE.test(attrs)) {
      skipped.push(`#${index}(${attrs.slice(0, 40)})`);
      continue;
    }
    // 여는 태그의 '>' 위치까지가 앞부분 → 그 시점의 줄 수만큼 개행을 채운다
    const openEnd = m.index + m[0].indexOf('>') + 1;
    const startLine = html.slice(0, openEnd).split('\n').length;
    const padded = '\n'.repeat(startLine - 1) + m[2];
    fs.writeFileSync(path.join(OUT, `${base}-block${index}.js`), padded, 'utf8');
    written += 1;
  }
  return { base, written, skipped };
}

function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`[extract-inline-js] 원본 디렉터리를 찾지 못했다: ${SRC_DIR}`);
    process.exit(1);
  }
  const files = fs.readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.html'))
    .sort()
    .map((f) => path.join(SRC_DIR, f));
  if (!files.length) {
    console.error(`[extract-inline-js] frontend/*.html 이 하나도 없다: ${SRC_DIR}`);
    process.exit(1);
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  let total = 0;
  const parts = [];
  for (const file of files) {
    const r = extractOne(file);
    total += r.written;
    parts.push(`${r.base}:${r.written}` + (r.skipped.length ? `(건너뜀 ${r.skipped.join(',')})` : ''));
  }

  if (total === 0) {
    console.error('[extract-inline-js] 인라인 JS 블록을 하나도 찾지 못했다 — 셀렉터가 깨졌을 수 있다');
    process.exit(1);
  }
  // index.html 은 이 저장소의 본체다. 여기서 0 이 나오면 정규식이 깨진 것이므로 별도로 막는다.
  if (!parts.some((p) => p.startsWith('index:') && !p.startsWith('index:0'))) {
    console.error('[extract-inline-js] index.html 에서 블록을 뽑지 못했다 — 셀렉터 확인 필요');
    process.exit(1);
  }
  console.log(`[extract-inline-js] ${total}개 블록 → .lint-tmp/ (줄번호 = 각 원본 HTML 의 줄번호) · ${parts.join(' · ')}`);
}

main();
