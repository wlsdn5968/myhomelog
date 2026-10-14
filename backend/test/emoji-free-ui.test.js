/**
 * backend/test/emoji-free-ui.test.js
 *
 * Plan 143 (2026-10-14): 사용자에게 보이는 문자열에 컬러 이모지가 없어야 한다.
 *   근거 — plans/review-2026-10-14.md(이모지 552개, OS·폰트마다 렌더가 달라 통제 불가) + design-spec-v2 §4(선 아이콘).
 *   이모지만 있던 버튼은 Lucide(ISC) 선 아이콘 인라인 SVG 로 바뀌었다(index.html 상단 라이선스 주석).
 *
 * [검사 대상] frontend/*.html 전부, backend/routes·services 전부, backend/jobs/pushNotify.js(푸시 제목).
 *   주석(HTML 주석, CSS 블록 주석, JS 한 줄·블록 주석)은 제외하고 문자열·HTML 텍스트·템플릿만 본다.
 * [금지 문자] Extended_Pictographic 전부(뒤따르는 FE0F·ZWJ 시퀀스 포함). 허용 목록(SYMBOL_ALLOW)의 텍스트 기호만 남긴다.
 *   허용: 경고·체크·닫기·별·저작권·화살표·정보·도형·참고 기호(색약 cue·면책 표기에 쓰임). 허용 밖 기호가 필요하면 목록에 이유와 함께 추가한다.
 *   예) 경고 기호 뒤에 FE0F 를 붙이면 컬러 이모지로 그려지므로 붙이지 않는다.
 * [허용 목록 — H: LLM 프롬프트] aiService.js·report.js·clause.js 의 프롬프트 상수 안 U+26D4 는
 *   모델에게 주는 금지 규칙 표식이라 사용자 화면 문자열이 아니다(현재 aiService.js 52~61·64·65·127행,
 *   report.js 51~53·60·66~70행). 이 세 파일에서는 U+26D4 한 글자만 허용하고 다른 이모지는 막는다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
// Extended_Pictographic 전부(뒤따르는 FE0F·ZWJ 시퀀스 포함) 금지 — 아래 허용 목록의 텍스트 기호만 남긴다(Plan 143 확장).
const FE0F = String.fromCharCode(0xFE0F), ZWJ = String.fromCharCode(0x200D);
const R1 = new RegExp('\\p{Extended_Pictographic}(?:' + FE0F + '|' + ZWJ + '\\p{Extended_Pictographic}' + FE0F + '?)*', 'gu');
// 허용 목록: 경고 ⚠, 체크 ✓ ✔, 닫기 ✕ ✗, 별 ★ ☆, © ® ™, 화살표 ↔ ↗ ↘ ↻, 정보 ℹ, 도형 ▲ ▼ ▶ ◀ ● ○ ■ □, 참고 ※
const SYMBOL_ALLOW = new Set([0x26A0, 0x2713, 0x2714, 0x2715, 0x2717, 0x2605, 0x2606, 0xA9, 0xAE, 0x2122, 0x2194, 0x2197, 0x2198, 0x21BB, 0x2139, 0x25B2, 0x25BC, 0x25B6, 0x25C0, 0x25CF, 0x25CB, 0x25A0, 0x25A1, 0x203B].map(c => String.fromCodePoint(c)));
const _isSymbol = s => SYMBOL_ALLOW.has([...s][0]) && !s.includes(ZWJ) && !s.includes(FE0F);
// H(AI 프롬프트) 허용 목록: 파일 → 허용 문자
const PROMPT_ALLOW = {
  'backend/services/aiService.js': new Set(['⛔']),
  'backend/routes/report.js': new Set(['⛔']),
  'backend/routes/clause.js': new Set(['⛔']),
};

// 글자마다 주석/문자열/템플릿/HTML 텍스트를 판정하는 상태기계 (HTML 은 <script>·<style> 안까지 내려간다).
function _modes(src, isHtml) {
  const n = src.length; const m = new Array(n).fill('');
  let i = 0;
  function js(end) {
    while (i < n) {
      if (end !== undefined && src.startsWith('</script', i)) return;
      const c = src[i], d = src[i + 1];
      if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { m[i] = 'comment'; i++; } continue; }
      if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const stop = e < 0 ? n : e + 2; while (i < stop) { m[i] = 'comment'; i++; } continue; }
      if (c === "'" || c === '"') { const q = c; m[i] = 'str'; i++; while (i < n && src[i] !== q && src[i] !== '\n') { if (src[i] === '\\') { m[i] = 'str'; i++; } m[i] = 'str'; i++; } m[i] = 'str'; i++; continue; }
      if (c === '`') {
        m[i] = 'tpl'; i++;
        while (i < n && src[i] !== '`') {
          if (src[i] === '\\') { m[i] = 'tpl'; i++; m[i] = 'tpl'; i++; continue; }
          if (src[i] === '$' && src[i + 1] === '{') {
            m[i] = 'tpl'; m[i + 1] = 'tpl'; i += 2; let dep = 1;
            while (i < n && dep > 0) {
              if (src[i] === '{') dep++; else if (src[i] === '}') { dep--; if (dep === 0) { m[i] = 'tpl'; i++; break; } }
              else if (src[i] === "'" || src[i] === '"') { const q = src[i]; m[i] = 'tplexpr_str'; i++; while (i < n && src[i] !== q) { m[i] = 'tplexpr_str'; i++; } }
              m[i] = m[i] || 'tplexpr'; i++;
            }
            continue;
          }
          m[i] = 'tpl'; i++;
        }
        m[i] = 'tpl'; i++; continue;
      }
      if (c === '/') { // 정규식 리터럴 가능성: 직전 비공백 글자로 판정
        let j = i - 1; while (j >= 0 && /\s/.test(src[j])) j--;
        const pc = src[j];
        if (j < 0 || /[(,=:;!&|?{}[+\-*%<>~^]/.test(pc) || /(return|typeof|case)$/.test(src.slice(Math.max(0, j - 6), j + 1))) {
          m[i] = 'regex'; i++; let cls = false;
          while (i < n && src[i] !== '\n') {
            if (src[i] === '\\') { m[i] = 'regex'; i++; m[i] = 'regex'; i++; continue; }
            if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false;
            else if (src[i] === '/' && !cls) { m[i] = 'regex'; i++; break; }
            m[i] = 'regex'; i++;
          }
          while (i < n && /[a-z]/.test(src[i])) { m[i] = 'regex'; i++; }
          continue;
        }
      }
      m[i] = m[i] || 'code'; i++;
    }
  }
  if (!isHtml) { js(); return m; }
  while (i < n) {
    if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i); const stop = e < 0 ? n : e + 3; while (i < stop) { m[i] = 'comment'; i++; } continue; }
    if (/^<script\b/i.test(src.slice(i, i + 8))) {
      const gt = src.indexOf('>', i); while (i <= gt) { m[i] = 'htmltag'; i++; }
      js(1); continue;
    }
    if (/^<style\b/i.test(src.slice(i, i + 7))) {
      const gt = src.indexOf('>', i); while (i <= gt) { m[i] = 'htmltag'; i++; }
      const e = src.indexOf('</style', i); const stop = e < 0 ? n : e;
      while (i < stop) {
        if (src[i] === '/' && src[i + 1] === '*') { const e2 = src.indexOf('*/', i + 2); const s2 = e2 < 0 ? n : e2 + 2; while (i < s2) { m[i] = 'comment'; i++; } }
        else { m[i] = 'css'; i++; }
      }
      continue;
    }
    if (src[i] === '<' && /[a-zA-Z/]/.test(src[i + 1] || '')) { const gt = src.indexOf('>', i); const stop = gt < 0 ? n : gt + 1; while (i < stop) { m[i] = 'htmltag'; i++; } continue; }
    m[i] = 'htmltext'; i++;
  }
  return m;
}

function _listTargets() {
  const out = [];
  const add = (dir, re) => {
    for (const nm of fs.readdirSync(path.join(ROOT, dir)).sort()) if (re.test(nm)) out.push(dir + '/' + nm);
  };
  add('frontend', /\.html$/);
  add('backend/routes', /\.js$/);
  add('backend/services', /\.js$/);
  out.push('backend/jobs/pushNotify.js');
  return out;
}

function _findEmoji(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const mode = _modes(src, rel.endsWith('.html'));
  const allow = PROMPT_ALLOW[rel];
  const hits = [];
  R1.lastIndex = 0;
  let m;
  while ((m = R1.exec(src))) {
    if (mode[m.index] === 'comment') continue;
    if (_isSymbol(m[0])) continue;
    if (allow && allow.has(m[0])) continue;
    const line = src.slice(0, m.index).split('\n').length;
    hits.push(rel + ':' + line + ' U+' + [...m[0]].map(c => c.codePointAt(0).toString(16).toUpperCase()).join('+'));
  }
  return hits;
}

test('UI 이모지 제거(Plan 143) — frontend/*.html · backend/routes·services · pushNotify 의 주석 밖 문자열에 컬러 이모지 0', () => {
  const targets = _listTargets();
  assert.ok(targets.length >= 40, '검사 대상 파일 수집이 비정상이다: ' + targets.length);
  const hits = [];
  for (const rel of targets) hits.push(..._findEmoji(rel));
  assert.deepEqual(hits, [], '컬러 이모지가 남아 있다(주석 밖):\n' + hits.slice(0, 20).join('\n'));
});

test('UI 이모지 제거(Plan 143) — 검사기 자체 확인: 주석 안은 무시하고 문자열 안은 잡는다', () => {
  const html = '<!-- \u{1F3E0} -->\n<p>\u{1F3E0} x</p>';
  const mh = _modes(html, true);
  assert.equal(mh[html.indexOf('\u{1F3E0}')], 'comment');
  assert.equal(mh[html.lastIndexOf('\u{1F3E0}')], 'htmltext');
  const js = "// \u{1F525}\nconst a = '\u{1F525}';";
  const mj = _modes(js, false);
  assert.equal(mj[js.indexOf('\u{1F525}')], 'comment');
  assert.equal(mj[js.lastIndexOf('\u{1F525}')], 'str');
  // 허용 기호는 통과, 확장 대상(집·톱니·인쇄·FE0F 붙은 경고 등)은 걸린다
  const hit = t => { R1.lastIndex = 0; const out = []; let x; while ((x = R1.exec(t))) if (!_isSymbol(x[0])) out.push(x[0]); return out; };
  assert.deepEqual(hit(String.fromCodePoint(0x26A0, 0x20, 0x2713, 0x20, 0x2605, 0x20, 0x203B, 0x20, 0xA9, 0x20, 0x21BB)), []);
  assert.equal(hit(String.fromCodePoint(0x26A0, 0xFE0F)).length, 1);
  assert.equal(hit(String.fromCodePoint(0x1F3D8)).length, 1); // 집(FE0F 없음) — 종전 R1 은 놓쳤다
  assert.equal(hit(String.fromCodePoint(0x2699)).length, 1);  // 톱니
  assert.equal(hit(String.fromCodePoint(0x1F5A8)).length, 1); // 프린터
});

test('UI 이모지 제거(Plan 143) — 허용 목록(AI 프롬프트 H)은 U+26D4 한 글자뿐이고 파일이 실제로 있다', () => {
  for (const rel of Object.keys(PROMPT_ALLOW)) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), '허용 목록 파일이 없다: ' + rel);
  }
  // 허용 목록이 슬그머니 넓어지는 회귀 방지 — 다른 이모지는 첫 번째 테스트가 그대로 잡는다.
  for (const set of Object.values(PROMPT_ALLOW)) assert.deepEqual([...set], ['⛔']);
});
