#!/usr/bin/env node
/**
 * REGEXP-RATCHET-2026-11-11 (plans/194): 긴 입력에서 제곱 시간으로 느려질 수 있는 정규식이 새로 늘지 않게 막는다.
 *
 * 왜: 2026-11-10~11 보안 점검에서 같은 종류가 세 번 나왔다(채팅 개인정보 검사 요청당 약 2.4초, CPU 측정 미들웨어 140ms,
 *   단지 이름 비교 행당 4ms). 전부 사람이 찾았다. Vercel 무료 CPU 한도를 쓰는 서비스라 느린 정규식은 곧 비용이다.
 * 어떻게: eslint-plugin-regexp 의 두 규칙(no-super-linear-backtracking, no-super-linear-move)을 돌려 파일별 건수를 세고
 *   scripts/regexp-baseline.json 과 비교한다. 파일의 건수가 기준선보다 늘면 실패한다. 줄어드는 것은 통과한다.
 *   기존 건수(도입 시점 운영 코드 74건)는 입력 길이가 이미 묶여 있는지 하나씩 봐야 해서 한 번에 고치지 않았다.
 * 기준선을 내릴 때: 정규식을 고쳐 건수가 줄었으면 `node scripts/check-regexp-ratchet.js --update` 로 다시 쓴다.
 * 새 정규식이 걸렸을 때: 입력 길이를 먼저 자르거나(.slice), 반복을 상한 있는 형태({0,3})로 바꾼다. 정말 안전하면 그 줄에
 *   eslint-disable-next-line 과 이유를 적는다.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASELINE = path.join(__dirname, 'regexp-baseline.json');
const RULES = ['regexp/no-super-linear-backtracking', 'regexp/no-super-linear-move'];

async function count() {
  const { ESLint } = require('eslint');
  const regexp = require('eslint-plugin-regexp');
  const eslint = new ESLint({
    cwd: ROOT,
    overrideConfigFile: true,
    overrideConfig: [{
      files: ['backend/**/*.js', 'scripts/**/*.js', 'api/**/*.js', '.lint-tmp/**/*.js'],
      ignores: ['**/node_modules/**', 'backend/test/**', 'backend/testSupport/**'],
      languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs' },
      linterOptions: { reportUnusedDisableDirectives: 'off' },
      plugins: { regexp },
      rules: Object.fromEntries(RULES.map((r) => [r, 'error'])),
    }],
  });
  const results = await eslint.lintFiles(['backend', 'scripts', 'api', '.lint-tmp']);
  const byFile = {};
  for (const r of results) {
    const rel = path.relative(ROOT, r.filePath).split(path.sep).join('/');
    const n = r.messages.filter((m) => RULES.includes(m.ruleId)).length;
    if (n) byFile[rel] = n;
  }
  return byFile;
}

(async () => {
  const cur = await count();
  const total = Object.values(cur).reduce((a, b) => a + b, 0);
  if (process.argv.includes('--update')) {
    const sorted = Object.fromEntries(Object.keys(cur).sort().map((k) => [k, cur[k]]));
    fs.writeFileSync(BASELINE, JSON.stringify({ total, files: sorted }, null, 2) + '\n');
    console.log(`regexp-ratchet: 기준선을 다시 썼어요 (총 ${total}건, 파일 ${Object.keys(cur).length}개)`);
    return;
  }
  if (!fs.existsSync(BASELINE)) { console.error('regexp-ratchet: 기준선 파일이 없어요. --update 로 만드세요.'); process.exit(1); }
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).files || {};
  const worse = Object.entries(cur).filter(([f, n]) => n > (base[f] || 0));
  if (worse.length) {
    console.error('regexp-ratchet: 느려질 수 있는 정규식이 새로 늘었어요.');
    for (const [f, n] of worse) console.error(`  ${f}: ${base[f] || 0}건 -> ${n}건`);
    console.error('  입력 길이를 먼저 자르거나 반복에 상한을 두세요. 어느 줄인지는 아래 명령으로 볼 수 있어요.');
    console.error('  npx eslint --no-config-lookup --plugin regexp --rule "regexp/no-super-linear-move: error" --rule "regexp/no-super-linear-backtracking: error" <파일>');
    process.exit(1);
  }
  console.log(`regexp-ratchet: 통과 (지금 ${total}건, 기준선 이하)`);
})().catch((e) => { console.error('regexp-ratchet: 실행 실패', e && e.message); process.exit(1); });
