/**
 * AUDIT3-1120 (AUDIT_REPORT.md 18절, 전면 감사 3차 뒤 첫 수정 묶음, 운영자 승인 "권고대로 진행해줘. 승인할게").
 *  1. 임장 기록 삭제가 서버에도 반영된다(FN-DELETE-1120). 종전에는 브라우저만 지워 서버 기록이 되살아났다(운영 재현).
 *  2. 검색어의 따옴표, 세미콜론, 줄표 두 개를 빼고, 외부 방어벽이 막은 응답은 500 이 아니라 빈 결과(SEARCH-WAF-1120).
 *  6. 대출 계산 상자의 출처 줄이 기관 셋을 고정해 적지 않는다(POLICY-SRC-LINE-1120).
 *  7. 약관, 자동 결정 설명, 대화 이력 창이 Escape 로 닫힌다(ESC-1120).
 *  8. 로고 링크에 이름이 있다.
 *  16. 결제 웹훅 인증 예외는 billing.test.js 가 지킨다.
 * 실행: cd backend && TZ=UTC node --test test/audit3-1120.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readIndexHtml } = require('../testSupport/readFrontend');

const html = readIndexHtml();
const searchSrc = fs.readFileSync(path.join(__dirname, '../routes/search.js'), 'utf8');

function extractFn(src, name, prefix = 'function') {
  const start = src.indexOf(`${prefix} ${name}(`);
  assert.ok(start >= 0, `${name} 함수를 찾지 못했다`);
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name} 의 닫는 중괄호를 찾지 못했다`);
}

async function runClear({ loggedIn, fetchOk, fetchThrows }) {
  const calls = { fetch: [], deleted: [], toast: [], render: 0 };
  const sb = {
    window: { MHL: { auth: loggedIn ? { user: { id: 'u' }, session: { access_token: 't' } } : {} } },
    CFG: { api: '/api' },
    confirm: () => true,
    AbortSignal: { timeout: () => undefined },
    _authHdr: async (h) => ({ ...h, Authorization: 'Bearer x' }),
    fetch: async (url, opt) => { calls.fetch.push([url, opt && opt.method]); if (fetchThrows) throw new Error('net'); return { ok: !!fetchOk }; },
    deleteNoteForApt: (n) => calls.deleted.push(n),
    toast: (m) => calls.toast.push(m),
    currentDetail: null,
    renderFieldNote: () => {},
    renderBookmarks: () => { calls.render++; },
    encodeURIComponent,
  };
  vm.runInNewContext(extractFn(html, 'clearFieldNote', 'async function') + '\nthis.f = clearFieldNote;', sb);
  await sb.f('상계벽산');
  return calls;
}

test('1. 로그인 상태 임장 기록 삭제: 서버 DELETE 가 성공해야 이 기기 기록을 지운다', async () => {
  const ok = await runClear({ loggedIn: true, fetchOk: true });
  assert.deepEqual(ok.fetch, [['/api/field-notes/' + encodeURIComponent('상계벽산'), 'DELETE']]);
  assert.deepEqual(ok.deleted, ['상계벽산']);
  assert.deepEqual(ok.toast, ['임장 기록을 삭제했어요']);

  const fail = await runClear({ loggedIn: true, fetchOk: false });
  assert.deepEqual(fail.deleted, [], '서버가 실패하면 지웠다고 하지 않는다(지우면 다음 열기 때 서버 기록이 되살아난다)');
  assert.match(fail.toast[0], /삭제하지 못했어요/);

  const net = await runClear({ loggedIn: true, fetchThrows: true });
  assert.deepEqual(net.deleted, []);
  assert.match(net.toast[0], /삭제하지 못했어요/);
});

test('1. 로그아웃 상태는 서버를 부르지 않고 이 기기 기록만 지운다', async () => {
  const c = await runClear({ loggedIn: false });
  assert.deepEqual(c.fetch, []);
  assert.deepEqual(c.deleted, ['상계벽산']);
});

test('2. 검색어 정리: 따옴표, 세미콜론, 백틱, 줄표 두 개를 빼고 와일드카드 제거는 그대로', () => {
  const line = searchSrc.split(/\r?\n/).find((l) => /^\s*const q = String\(req\.query\.q/.test(l));
  assert.ok(line, '검색어 정리 줄');
  const clean = new Function('req', line.replace(/\/\/.*$/, '') + '\nreturn q;');
  const q = (s) => clean({ query: { q: s } });
  assert.equal(q(`"'; drop table x;--`), 'drop table x');
  assert.equal(q('은마'), '은마');
  assert.equal(q('한일(A,B)'), '한일(A,B)', '괄호와 쉼표는 단지명에 쓰인다');
  assert.equal(q('a%_*b'), 'ab');
  assert.equal(q('래미안-원베일리'), '래미안-원베일리', '줄표 하나는 남긴다');
  assert.equal(q('x'.repeat(300)).length, 100);
});

test('2. 외부 방어벽 HTML 은 빈 결과로 답하고 Sentry 로 보내지 않는다', () => {
  const f = new Function(extractFn(searchSrc, 'isUpstreamBlock') + '\nreturn isUpstreamBlock;')();
  const cf = '<!DOCTYPE html>\n<html><head><title>Attention Required! | Cloudflare</title></head><body><h1>Sorry, you have been blocked</h1> supabase.co';
  assert.equal(f(new Error(cf)), true);
  assert.equal(f(new Error('statement timeout')), false);
  assert.equal(f(new Error('<!DOCTYPE html><title>Bad Gateway</title>')), false, '다른 HTML 오류는 그대로 오류로 다룬다');
  const catchBlock = searchSrc.slice(searchSrc.indexOf('if (isUpstreamBlock(e))'), searchSrc.indexOf("'단지 검색 실패'"));
  assert.ok(catchBlock.includes("res.set('Cache-Control', 'no-store')") && catchBlock.includes('return res.json({ results: [], query: q })'));
  assert.ok(!catchBlock.includes('captureRouteError'), '막힌 검색어는 Sentry 로 보내지 않는다');
});

test('6. 대출 계산 상자의 출처 줄이 기관 셋을 고정해 적지 않는다', () => {
  assert.ok(!html.includes("'출처: 정책브리핑, 금융위원회, 국가법령정보센터."));
  assert.ok(html.includes('출처: 정책브리핑과 각 부처 누리집, 국가법령정보센터.'));
});

test('7. 약관, 자동 결정 설명, 대화 이력 창이 Escape 닫기 목록에 있고 닫는 함수가 있다', () => {
  const block = html.slice(html.indexOf('const closers = ['), html.indexOf('for (const { id, fn, present } of closers)'));
  for (const [id, fn] of [['TM', 'closeTerms'], ['ADM', 'closeAutomatedDecisionModal'], ['CH', 'closeChatHistory']]) {
    assert.ok(block.includes(`{ id: '${id}', fn: '${fn}' }`), `${id} 가 닫기 목록에 없다`);
    assert.ok(new RegExp(`function ${fn}\\(\\)`).test(html), `${fn} 함수가 없다`);
    assert.ok(html.includes(`class="smbg" id="${id}"`), `${id} 창이 없다`);
  }
});

test('8. 로고 링크는 글자가 숨는 폭에서도 이름이 있다', () => {
  assert.ok(html.includes('<a class="logo" href="/" aria-label="내집로그 처음 화면">'));
});
