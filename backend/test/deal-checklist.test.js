/**
 * DEAL-CHECKLIST-2026-10-30 (Plan 154): 거래 단계별 체크리스트(#view-deal).
 *  항목·숫자는 plans/154-deal-checklist-content.md 에서 법령 원문(law.go.kr)으로 확인한 것만 — 여기서 고정한다.
 *  ① 항목 규칙(라벨·근거·기한) ② 마감일 계산(원문: 거래신고 30일·등기 60일·취득세 60일·전입 14일·양도세 말일+2개월)
 *  ③ 단계 상태·배지 ④ 원문으로 바로잡은 문구 ⑤ 화면 연결
 * 실행: cd backend && TZ=UTC node --test test/deal-checklist.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
// 최상위 함수 하나를 다음 최상위 선언 전까지 떼어 낸다(한 줄 함수도 포함).
const fnSrc = (name) => {
  const i = html.indexOf(`\nfunction ${name}(`);
  assert.ok(i >= 0, `${name} 없음`);
  const rest = html.slice(i + 1);
  const m = rest.slice(1).search(/\n(?:function |const |let |\/\/ )/);
  return rest.slice(0, m + 1);
};
const NAMES = ['_dclData', '_dclParse', '_dclAdd', '_dclDiff', '_dclDue', '_dclFmt', '_dclWd', '_dclDd', '_dclStage'];
// eslint-disable-next-line no-new-func
const F = new Function(`${NAMES.map(fnSrc).join('\n')}\nreturn {${NAMES.join(',')}};`)();
const D = (s) => F._dclParse(s);
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const data = F._dclData();
const all = (r) => data[r].flatMap((s) => s.items);
const item = (id) => [...all('b'), ...all('s')].find((x) => x.id === id);

test('① 항목 규칙: 매수인 21·매도인 12(중개보수 주기 추가), id 중복 없음, 법정 기한만 마감일, 일반 안내만 근거 없음', () => {
  assert.equal(all('b').length, 21);
  assert.equal(all('s').length, 12);
  const ids = [...all('b'), ...all('s')].map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const it of [...all('b'), ...all('s')]) {
    assert.ok(['dl', 'law', 'off', 'gen'].includes(it.lb), it.id);
    assert.equal(!!it.due, it.lb === 'dl', `${it.id}: 마감일은 법정 기한 항목에만`);
    if (it.lb === 'gen') assert.ok(!it.src, `${it.id}: 일반 안내는 근거를 붙이지 않는다`);
    else assert.ok(it.src && it.src.length, `${it.id}: 근거 없음`);
    for (const s of it.src || []) {
      assert.match(s.u, /^https:\/\/www\.(law\.go\.kr\/법령\/|easylaw\.go\.kr(\/CSP\/CnpClsMain\.laf\?popMenu=ov&csmSeq=649&ccfNo=2&cciNo=2&cnpClsNo=2)?$|iros\.go\.kr$|fsc\.go\.kr\/po020201\/84825$|nts\.go\.kr$|gov\.kr$|hometax\.go\.kr$)/, `${it.id}: ${s.u}`);
    }
  }
  // 법령 링크는 원문을 열어 본 '법령/<이름>/<조>' 형식
  assert.equal(item('b_first').src[0].u, 'https://www.law.go.kr/법령/' + encodeURIComponent('지방세특례제한법') + '/' + encodeURIComponent('제36조의3'));
});

test('② 마감일: 계약 10-24·잔금 12-18 → 신고 11-23 · 등기·취득세 2027-02-16 · 전입 2027-01-01 · 양도세 2027-02-28', () => {
  const c = D('2026-10-24'), b = D('2026-12-18');
  assert.equal(ymd(F._dclDue(item('b_rpt'), c, b)), '2026-11-23');
  assert.equal(ymd(F._dclDue(item('s_rpt'), c, b)), '2026-11-23');
  assert.equal(ymd(F._dclDue(item('b_xfer'), c, b)), '2027-02-16');
  assert.equal(ymd(F._dclDue(item('b_acq'), c, b)), '2027-02-16');
  assert.equal(ymd(F._dclDue(item('b_move'), c, b)), '2027-01-01');
  assert.equal(ymd(F._dclDue(item('s_cgt'), c, b)), '2027-02-28');
  // 양도세: 양도일이 속한 달 말일부터 2개월 = 두 달 뒤 달의 말일
  assert.equal(ymd(F._dclDue(item('s_cgt'), null, D('2026-01-31'))), '2026-03-31');
  assert.equal(ymd(F._dclDue(item('s_cgt'), null, D('2027-12-01'))), '2028-02-29'); // 윤년
  // 날짜가 없으면 계산하지 않는다
  assert.equal(F._dclDue(item('b_rpt'), null, b), null);
  assert.equal(F._dclDue(item('b_xfer'), c, null), null);
  assert.equal(F._dclParse('2026-13-40'), null);
  assert.equal(F._dclParse(''), null);
});

test('③ 단계 상태·배지(기준일 10-30): 지난 단계=남은 항목 있음, 중도금=진행 중, 잔금 뒤=예정, 다 체크=완료', () => {
  const c = D('2026-10-24'), b = D('2026-12-18'), today = D('2026-10-30');
  const st = (r, k, done = {}) => F._dclStage(data[r].find((s) => s.k === k), c, b, today, done);
  const pre = st('b', 'pre');
  assert.equal(pre.st, 'late'); assert.equal(pre.txt, '10월 23일까지'); assert.deepEqual(pre.badge, { t: '계약 D+6', past: true });
  const day = st('b', 'day');
  assert.equal(day.st, 'late'); assert.equal(day.txt, '10월 24일 (토)');
  const mid = st('b', 'mid');
  assert.equal(mid.st, 'now'); assert.deepEqual(mid.badge, { t: '잔금 D-49', past: false });
  assert.equal(st('b', 'bal').txt, '12월 18일 (금)');
  assert.equal(st('b', 'bal').st, 'todo');
  const reg = st('b', 'reg');
  assert.equal(reg.txt, '2027년 2월 16일까지'); assert.equal(reg.badge.t, '마감 D-109'); assert.equal(reg.st, 'todo');
  assert.equal(st('s', 'tax').txt, '2027년 2월 28일까지'); // 매도인 세금 단계 날짜 = 양도세 마감일
  const allDone = Object.fromEntries(data.b.find((s) => s.k === 'pre').items.map((x) => [x.id, true]));
  assert.equal(st('b', 'pre', allDone).st, 'done');
  assert.equal(F._dclDd(0), 'D-day');
  // 날짜가 없으면 체크 여부로만
  const none = F._dclStage(data.b[0], null, null, today, {});
  assert.equal(none.st, 'todo'); assert.equal(none.badge, null);
});

test('④ 원문으로 바로잡은 문구가 화면 데이터에 있다', () => {
  // 소득세법 시행령 제155조 ① (시행 2026-10-01): 두 집 모두 조정대상지역이면 2년, 그 밖 3년
  assert.match(item('s_tmp').d, /3년 안에 기존 집을 팔아야 해요\. 두 집이 모두 조정대상지역이면 2년이에요\(2026년 10월 1일 시행\)/);
  // 제154조 ①: 취득 당시 조정대상지역이면 2년 거주
  assert.match(item('s_one').d, /조정대상지역이었다면 보유 기간 중 2년 이상 살아야 해요/);
  // 부동산등기규칙 제62조: 인감증명 3개월 — 제60조만으로는 기간 근거가 아니다
  assert.ok(item('b_seal').src.some((s) => s.n === '부동산등기규칙 제62조'));
  // 지특법 제36조의3: 아파트 200만 원(300만 원은 아파트 제외 소형·인구감소지역)
  assert.match(item('b_first').d, /아파트는 200만 원 한도/);
  assert.match(item('b_first').d, /인구감소지역이면 300만 원/);
  // 민법 제565조: 매도인은 배액 상환
  assert.match(item('s_resc').d, /두 배를 돌려주고 해제/);
  // 2차 소비자 점검 후속: 중개보수 지급 시기(§32③)·상한 요율 협의(시행규칙 §20①), 복비 계산 연결
  for (const id of ['b_comm', 's_comm']) { assert.deepEqual(item(id).btn, { t: '중개보수 계산', v: 'biz' }); assert.match(item(id).d, /약정이 없으면 거래대금을 다 치른 날에 줘요/); }
  // 근거 없는 옛 항목과 옛 요건은 화면에 없다
  assert.doesNotMatch(html, /잔금일을 월초~중순으로 정하기/);
  assert.doesNotMatch(html, /id="checkList"/);
  assert.match(html, /마감일이 토요일이나 공휴일이면 기한은 다음 날까지예요\(민법 제161조\)\. 표시한 날짜는 미루기 전 날짜예요\./);
});

test('⑤ 화면 연결: 뷰 등록, 헤더 도구 메뉴·모바일 도구 시트·대출 계산·타임라인 진입, 날짜 공유', () => {
  assert.match(html, /<div class="biz-view" id="view-deal">/);
  assert.match(html, /deal: {2}\{display:'flex', lp:false, rp:false\}/);
  assert.match(html, /<button class="htab" onclick="sv\('deal',this\)">/);
  assert.match(html, /class="ts-item" data-tool="deal"/);
  assert.equal((html.match(/\['clause','subs','calc','biz','deal','swap','guide'\]\.includes\(v\)/g) || []).length, 2);
  assert.match(html, /if\(v==='deal'\)\{try\{_dclOpen\(\);\}catch\(_\)\{\}\}/);
  assert.match(html, /onclick="sv\('deal'\)">거래 체크리스트<\/button>/);
  assert.match(html, /onclick="sv\('deal'\)">단계별 거래 체크리스트 보기<\/button>/);
  assert.match(fnSrc('renderDealDays'), /_dclFromTimeline\(\)/);
  assert.match(fnSrc('_dclDateChange'), /tc\.value=s\.c[\s\S]*renderDealDays\(\)/);
  // 리뷰 반영: 타임라인에서 지운 날짜도 따라가고, 열 때 타임라인 칸을 저장값으로 먼저 채운다
  assert.match(fnSrc('_dclFromTimeline'), /s\.c=ic\.value\|\|'';s\.b=ib\.value\|\|'';/);
  assert.match(fnSrc('_dclInitTimeline'), /ic\.value=s\.c;ib\.value=s\.b;/);
  // 체크 후 같은 체크박스로 포커스 복원, 펼친 근거는 다시 그려도 유지
  assert.match(fnSrc('_dclToggle'), /\.dcl-cb\[data-id="\$\{id\}"\][\s\S]*\.focus\(/);
  assert.match(fnSrc('_dclRender'), /so=has&&_dclSrcOpen\.has\(it\.id\)/);
  // 데스크톱 단계 머리는 버튼이 아니다(접히지 않으니 aria-expanded 를 주지 않는다)
  assert.match(fnSrc('_dclRender'), /<\$\{mob\?'button':'div'\} class="dcl-sh"/);
  // 다른 도구 화면과 같은 법적 고지 줄
  assert.match(html, /\['view-calc','view-clause','view-biz','view-deal','view-swap','view-news','view-subs','view-report','view-guide'\]\.forEach\(/);
  // 규제 요약(비뷰 버튼)은 도구 메뉴 마지막 유지
  const menu = html.slice(html.indexOf('id="htabToolMenu"'), html.indexOf('</div>', html.indexOf('openRegSummary()" title=')));
  assert.ok(menu.indexOf("sv('deal',this)") < menu.indexOf('openRegSummary()'));
});
