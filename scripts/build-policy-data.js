#!/usr/bin/env node
/**
 * scripts/build-policy-data.js
 *
 * POLICY-CHANGES-1116 (plans/203): 정책 변화 자료의 원본은 backend/data/policy-changes.json 하나다.
 * 화면은 정적 파일로 받아야 하므로(요청마다 서버 함수를 쓰지 않는다) 여기서 frontend/js/policy-data.js 를 만든다.
 * 서버가 만드는 /policy 페이지는 원본 JSON 을 직접 읽는다.
 *
 * 사용: node scripts/build-policy-data.js          (파일을 다시 쓴다)
 *       node scripts/build-policy-data.js --check  (원본과 다르면 실패. backend/test/policy-changes-1116.test.js 가 같은 대조를 한다)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'backend', 'data', 'policy-changes.json');
const OUT = path.join(ROOT, 'frontend', 'js', 'policy-data.js');

const CATS = ['loan', 'zone', 'tax', 'supply', 'rent'];
const STATUSES = ['시행', '예정', '안', '계획', '종료'];
const SRC_HOSTS = ['www.korea.kr', 'www.fsc.go.kr', 'www.law.go.kr', 'www.molit.go.kr', 'www.mois.go.kr', 'www.nts.go.kr', 'www.mofe.go.kr'];

/** 자료 모양 검사. 문제를 문자열 배열로 돌려준다(비어 있으면 통과). */
function validate(data) {
  const errs = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data.checked || ''))) errs.push('checked(마지막 원문 확인일)가 없다');
  if (!Array.isArray(data.items) || !data.items.length) return errs.concat('items 가 비었다');
  const seen = new Set();
  data.items.forEach((it, i) => {
    const at = `items[${i}] ${it && it.date} ${it && it.title}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(it.date || ''))) errs.push(`${at}: date 형식`);
    if (it.effective != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(it.effective))) errs.push(`${at}: effective 형식`);
    if (!CATS.includes(it.cat)) errs.push(`${at}: cat`);
    if (!STATUSES.includes(it.status)) errs.push(`${at}: status`);
    for (const k of ['org', 'title', 'after', 'who']) if (typeof it[k] !== 'string' || !it[k].trim()) errs.push(`${at}: ${k} 없음`);
    if (it.before != null && (typeof it.before !== 'string' || !it.before.trim())) errs.push(`${at}: before 는 글자거나 null`);
    if (!Array.isArray(it.src) || !it.src.length) errs.push(`${at}: 출처 없음`);
    else for (const u of it.src) {
      let host = '';
      try { host = new URL(u).host; } catch (_) { /* 아래에서 잡는다 */ }
      if (!SRC_HOSTS.includes(host) || !u.startsWith('https://')) errs.push(`${at}: 공식 출처가 아닌 주소 ${u}`);
    }
    const key = `${it.date}|${it.title}`;
    if (seen.has(key)) errs.push(`${at}: 같은 항목이 두 번`);
    seen.add(key);
    // 권하는 말과 전망을 쓰지 않는다(저장소 절대 규칙)
    const text = [it.title, it.before, it.after, it.who, it.note].filter(Boolean).join(' ');
    if (/사세요|파세요|오를|내릴|전망|추천|유리해|기회/.test(text)) errs.push(`${at}: 권유나 전망으로 읽히는 낱말`);
  });
  return errs;
}

function render(data) {
  const pub = { checked: data.checked, items: data.items };
  return [
    '// frontend/js/policy-data.js',
    '// 직접 고치지 말 것. 원본은 backend/data/policy-changes.json 이고 scripts/build-policy-data.js 가 만든다.',
    '// 정책 변화 한 장 요약의 자료(plans/203). 항목마다 정부 공개 페이지 원문과 대조했고 확인일은 checked 에 있다.',
    'window.MHL_POLICY = ' + JSON.stringify(pub, null, 1) + ';',
    '',
  ].join('\n');
}

function main() {
  const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const errs = validate(data);
  if (errs.length) { console.error('policy-changes.json 문제:\n  ' + errs.join('\n  ')); process.exit(1); }
  const out = render(data);
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
    if (cur !== out) { console.error('frontend/js/policy-data.js 가 원본과 달라요. node scripts/build-policy-data.js 를 실행하세요.'); process.exit(1); }
    console.log(`✓ policy-data OK — ${data.items.length}건, 확인일 ${data.checked}`);
    return;
  }
  fs.writeFileSync(OUT, out);
  console.log(`policy-data.js 를 썼어요 (${data.items.length}건)`);
}

if (require.main === module) main();
module.exports = { validate, render, CATS, STATUSES, SRC_HOSTS };
