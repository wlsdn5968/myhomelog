/**
 * backend/testSupport/readFrontend.js
 *
 * SPLIT-1116 (plans/202): 화면 코드가 frontend/index.html 과 frontend/js/*.js 로 나뉜다.
 * 화면 코드를 글자로 읽는 검사는 이 도우미를 쓴다. index.html 뒤에 js 파일을 이름 순서로 이어 붙여 돌려준다.
 * 함수가 어느 파일로 옮겨 가도 검사를 고치지 않아도 되게 하려는 것이다.
 * 한 파일 안의 위치(앞뒤 순서, 거리)를 보는 검사는 readIndexHtml() 이나 readFrontendJs(name) 로 그 파일만 읽는다.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const FRONT = path.join(__dirname, '../../frontend');

function readIndexHtml() { return fs.readFileSync(path.join(FRONT, 'index.html'), 'utf8'); }
function frontendJsFiles() {
  const dir = path.join(FRONT, 'js');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort() : [];
}
function readFrontendJs(name) { return fs.readFileSync(path.join(FRONT, 'js', name), 'utf8'); }
function readFrontend() {
  return [readIndexHtml()].concat(frontendJsFiles().map((f) => `\n// ── frontend/js/${f} ──\n` + readFrontendJs(f))).join('');
}

// SPLIT-1117b (plans/202 3단계): 화면 함수를 잘라 new Function 으로 실행하는 검사가 앞에 붙여 쓰는 평 환산 두 줄.
//   calc.js 에서 그대로 읽어 온다(검사 안에 숫자를 따로 적지 않는다).
function pyeongPrelude() {
  const src = readFrontendJs('calc.js');
  const a = src.match(/^const PYEONG_M2 = [0-9.]+;$/m);
  const b = src.match(/^function _sqmToPy\(sqm\)\{[^\n]*\}$/m);
  if (!a || !b) throw new Error('calc.js 에서 평 환산을 찾지 못했다');
  return a[0] + b[0] + ';';
}

module.exports = { readFrontend, readIndexHtml, readFrontendJs, frontendJsFiles, pyeongPrelude };
