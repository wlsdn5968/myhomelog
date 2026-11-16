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

module.exports = { readFrontend, readIndexHtml, readFrontendJs, frontendJsFiles };
