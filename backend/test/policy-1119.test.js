/**
 * POLICY-1119 (2026-11-19): 원문을 직접 읽어 확인한 두 건을 정책 변화 자료에 넣었다.
 *  - 금융위 2026-11-13 「제3차 주택공급 정례브리핑」 보도자료 본문(fsc.go.kr/no010101/88140): 고양창릉 지분적립형 공공분양 284호, 입주 때 25%, 나머지 20년.
 *  - 국토교통부 2026-11-17 「주택법 시행령」 개정안 보도자료와 첨부 pdf(3쪽): 리모델링 동의율 75%에서 70%, 2027.1.1 시행. 국가법령정보센터는 11-19 에 공포 전.
 * 실행: cd backend && TZ=UTC node --test test/policy-1119.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/policy-changes.json'), 'utf8'));
const find = (date, word) => data.items.filter((i) => i.date === date && i.title.includes(word));

test('고양창릉 지분적립형 공공분양: 계획, 금융위 원문, 숫자는 원문 그대로', () => {
  const [it, ...rest] = find('2026-11-13', '지분적립형');
  assert.ok(it); assert.equal(rest.length, 0);
  assert.equal(it.status, '계획');
  assert.equal(it.cat, 'supply');
  assert.deepEqual(it.src, ['https://www.fsc.go.kr/no010101/88140']);
  for (const w of ['284호', '25%', '20년', '12월']) assert.ok((it.title + it.after).includes(w), w);
});

test('리모델링 동의율: 예정, 시행일 2027-01-01, 국토부 원문, 공포 전이라는 안내', () => {
  const [it, ...rest] = find('2026-11-17', '리모델링 동의율');
  assert.ok(it); assert.equal(rest.length, 0);
  assert.equal(it.status, '예정', '국무회의 의결 뒤 공포 전');
  assert.equal(it.effective, '2027-01-01');
  assert.deepEqual(it.src, ['https://www.molit.go.kr/USR/NEWS/m_71/dtl.jsp?id=95092610']);
  assert.ok(it.before.includes('75%') && it.after.includes('70%'));
  assert.ok(it.after.includes('50%'), '각 동 50% 요건은 그대로라는 원문 문장');
  assert.ok(it.note.includes('공포 전'), '공포 전이라는 사실을 숨기지 않는다');
});

test('두 항목은 자기 원문 확인일(2026-11-19)을 갖고, 검증 함수는 발표일보다 앞선 확인일을 막는다', () => {
  const { validate } = require('../../scripts/build-policy-data');
  for (const it of [...find('2026-11-13', '지분적립형'), ...find('2026-11-17', '리모델링 동의율')]) assert.equal(it.checked, '2026-11-19');
  const one = JSON.parse(JSON.stringify(find('2026-11-17', '리모델링 동의율')[0]));
  assert.deepEqual(validate({ checked: data.checked, items: [one] }), []);
  one.checked = '2026-11-16';
  assert.ok(validate({ checked: data.checked, items: [one] }).some((e) => e.includes('checked')), '발표(11-17) 전에 확인했다는 기록은 틀렸다');
});

test('카드의 확인일: 항목 확인일이 있으면 그것, 없으면 전체 대조일(화면과 서버 페이지 둘 다)', () => {
  const vm = require('node:vm');
  const { readFrontendJs } = require('../testSupport/readFrontend');
  const root = { innerHTML: '' };
  const sb = { window: { MHL_POLICY: { checked: data.checked, items: data.items } }, URL, document: { getElementById: (id) => (id === 'polRoot' ? root : null) }, location: { reload() {} } };
  vm.runInNewContext(readFrontendJs('policy.js') + '\n;this.api={_polOpen,_polToggle};', sb, { filename: 'policy.js' });
  sb.api._polOpen();
  const cards = root.innerHTML.split('<article ').slice(1);
  const remodel = cards.find((c) => c.includes('리모델링 동의율 70%로 완화'));
  assert.ok(remodel.includes('확인 2026.11.19'));
  const old = cards.find((c) => c.includes('중도상환수수료율 인하'));
  assert.ok(old.includes('확인 ' + data.checked.replace(/-/g, '.')));
  // 서버 페이지
  const src = fs.readFileSync(path.join(__dirname, '../routes/policyPage.js'), 'utf8');
  assert.ok(src.includes('확인 ${esc(dot(it.checked || DATA.checked))}'));
  assert.ok(src.includes("'www.molit.go.kr': '국토교통부'"));
});

test('화면 자료 파일이 원본과 같다(두 건이 화면에도 간다)', () => {
  const js = fs.readFileSync(path.join(__dirname, '../../frontend/js/policy-data.js'), 'utf8');
  assert.ok(js.includes('지분적립형 공공분양 공급 계획(고양창릉 284호)'));
  // 원문에 없는 "첫" 공급이라는 말을 붙였다가 반증 검토에서 걸려 뺐다(2026-11-19)
  assert.ok(!js.includes('지분적립형 공공분양 첫'));
  assert.ok(js.includes('리모델링 동의율 70%로 완화(주택법 시행령 개정)'));
});
