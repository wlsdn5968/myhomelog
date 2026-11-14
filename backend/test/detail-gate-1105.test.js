/**
 * 2026-11-05 기능별 불일치 전수조사(운영자 실측: 관심 단지로 연 공릉풍림아이원 헤더 8.12억, 실거래 탭 0건).
 * 단지 상세로 가는 길을 하나로 모으고, 같은 단지가 기능마다 다른 거래를 세던 곳을 고정한다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');

function fnBody(name) {
  const i = html.search(new RegExp(`(async )?function ${name}\\(`));
  assert.ok(i >= 0, name);
  return html.slice(i, html.indexOf('\n}', i));
}

test('관심 단지, 목록 카드, 지도 더블클릭, 맞춤 목록은 거래 없는 항목을 그대로 열지 않는다', () => {
  const gate = fnBody('_openProp');
  assert.match(gate, /p\.txHistory\.length\)return showDetail\(p\)/);
  assert.match(gate, /return openAptDetail\(p\)/);
  const bk = fnBody('openBookmark');
  assert.match(bk, /return openAptDetail\(\{aptName:b\.aptName,sigungu:a\.sigungu,umdNm:a\.umdNm,lawdCd,/);
  assert.match(bk, /_txFailed:true/, '지역을 몰라 못 읽으면 0건처럼 보이면 안 된다');
  assert.match(bk, /p\.umdNm===a\.umdNm/, '같은 이름의 다른 동 단지를 집으면 안 된다');
  assert.match(fnBody('selP'), /_openProp\(p\);/);
  assert.match(html, /m\.on\('dblclick',\(\)=>_openProp\(p\)\)/);
  const at = html.indexOf('class="ld-card" role="link"');
  assert.match(html.slice(at, at + 200), /onclick="_openProp\(props\[\$\{i\}\]\)"/);
  // showDetail 을 직접 부르는 곳이 늘면 여기서 걸린다(새 경로는 _openProp 또는 openAptDetail 로)
  const code = html.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  const direct = (code.match(/(?<!function )\bshowDetail\(/g) || []).length;
  assert.equal(direct, 7, `showDetail 직접 호출 수가 바뀌었다: ${direct}`);
});

test('호출자가 안 넘긴 준공 연도와 신고 번호는 받아 온 거래에서 채운다', () => {
  const o = fnBody('openAptDetail');
  assert.match(o, /buildYear: r\.buildYear \|\| txHistory\[0\]\?\.buildYear \|\| 0/);
  assert.match(o, /aptSeq: r\.aptSeq \|\| txHistory\[0\]\?\.aptSeq \|\| null/);
});

test('조회할 번호가 없을 때 "불러오지 못해"라고 말하지 않는다', () => {
  assert.match(html, /if\(!key\)\{ window\._curTrendLong=\{state:'none',key:''\}/);
  assert.match(html, /const note=\(longOk\|\|\(L&&L\.state==='none'\)\)\?''/);
});

test('옛 주소 관심 단지: 시도가 붙어도 시군구와 동을 바르게 읽는다', () => {
  const f = new Function(`${fnBody('_bookmarkToApt')}\n}; return _bookmarkToApt;`.replace('}\n};', '}\n'))();
  const r = (area) => { const o = f({ aptName: 'x', area }); return [o.sigungu, o.umdNm]; };
  assert.deepEqual(r('서울 노원구 공릉동'), ['노원구', '공릉동']);
  assert.deepEqual(r('노원구 공릉동'), ['노원구', '공릉동']);
  assert.deepEqual(r('경기 성남시 분당구 금곡동'), ['성남시분당구', '금곡동']);
  assert.deepEqual(r('평택시 팽성읍 송화리'), ['평택시', '팽성읍 송화리']);
});

test('같은 이름 공식 단지는 지역 코드와 동으로 고른다(신도림현대 재현), 별칭은 전부 읽는다', () => {
  const { _pickMasterRow: pick } = require('../services/transactionService');
  const rows = [
    { lawd_cd: '11530', sigungu: '구로구', umd_nm: '구로동', molit_aliases: ['신도림현대'] },
    { lawd_cd: '11530', sigungu: '구로구', umd_nm: '신도림동', molit_aliases: ['현대홈타운아파트'] },
    { lawd_cd: '27140', sigungu: '동구', umd_nm: '신서동', molit_aliases: ['대경넥스빌'] },
    { lawd_cd: '31170', sigungu: '동구', umd_nm: '전하동', molit_aliases: ['대경'] },
  ];
  assert.deepEqual(pick(rows, '11530', '신도림동').molit_aliases, ['현대홈타운아파트']);
  assert.deepEqual(pick(rows, '11530', '구로동').molit_aliases, ['신도림현대']);
  assert.equal(pick(rows, '11530', '개봉동'), null, '그 동의 공식 단지가 없으면 다른 동 별칭을 쓰지 않는다');
  assert.deepEqual(pick(rows, '31170', '전하동').molit_aliases, ['대경'], '시군구 이름이 같아도 지역 코드로 구분');
  assert.equal(pick(rows, '11530').umd_nm, '구로동', '동을 모르면 예전처럼 첫 행');
  assert.equal(pick([], '11530', '구로동'), null);
  const src = fs.readFileSync(path.join(__dirname, '../services/transactionService.js'), 'utf8');
  assert.match(src, /aliases\.slice\(0, 20\)\.map/, '별칭을 앞 5개만 읽으면 안 된다(당정한솔솔파크 (601,602동) 누락 재현)');
  assert.match(src, /if \(!_failedMonths\.length\) cache\.setRows\(cacheKey, sorted, 1800\);/);
  const route = fs.readFileSync(path.join(__dirname, '../routes/transactions.js'), 'utf8');
  assert.match(route, /getTransactionsByAptInclAliases\(lawdCd, aptName, _mb, \{ umdNm \}\)/);
  const ana = fs.readFileSync(path.join(__dirname, '../services/analysisService.js'), 'utf8');
  assert.equal((ana.match(/_CONTEXT_MONTHS, \{ umdNm \}\)/g) || []).length, 2, '가격 분석과 비교도 동을 넘긴다');
});

test('도우미: 같은 동만 세고 상세와 같은 6개월 창을 쓴다', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/chatDataRouter.js'), 'utf8');
  assert.match(src, /async function _fetchTx\(names, sigunguVal, umdVal\)/);
  assert.match(src, /_fetchTx\(a\.names, a\.c\.sigungu, a\.c\.umdNm\)/);
  assert.match(src, /_fetchTx\(names, am\.sigungu \|\| null, am\.umd_nm \|\| null\)/);
  assert.match(src, /txWindowStart\(6\)/);
});

test('공식 단지 별칭으로 묶인 거래는 준공 연도가 달라도 한 줄, 별칭 없는 같은 이름은 예전처럼 나눈다', () => {
  const { analyzeTransactions: an } = require('../services/transactionService');
  const tx = (name, by, extra) => ({ aptName: name, lawdCd: '11530', umdNm: '신도림동', sigungu: '구로구', buildYear: by, dealAmount: 90000, excluUseAr: 84, dealYear: 2026, dealMonth: 9, dealDay: 1, floor: 5, ...extra });
  assert.equal(an([tx('신도림대림1,2차', 1999, { _aliased: true }), tx('신도림대림1,2차', 2001, { _aliased: true })]).length, 1);
  assert.equal(an([tx('주공', 1995), tx('주공', 2006)]).length, 2);
  const rep = fs.readFileSync(path.join(__dirname, '../routes/report.js'), 'utf8');
  assert.match(rep, /\$\{_canonHit \? '' : \(t\.build_year \|\| ''\)\}/);
  const prop = fs.readFileSync(path.join(__dirname, '../services/propertyService.js'), 'utf8');
  assert.match(prop, /aptName: c, _aliased: true/);
});

test('도우미 평균은 상세 헤더와 같은 대표 평형 규칙, 지도는 상세와 같은 6개월 창', () => {
  const { _repAreaLine: f } = require('../services/chatDataRouter');
  const tx = (ar, amt) => ({ exclu_use_ar: ar, deal_amount: amt });
  assert.equal(f([tx(84.99, 98500), tx(31, 32000), tx(59.94, 80000), tx(59.94, 82000)]), '60㎡(18평) 최근 2건 평균 8.10억');
  assert.equal(f([tx(84.99, 90000), tx(59.94, 80000)]), '85㎡(26평) 최근 1건 평균 9.00억', '동률이면 가장 최근 거래의 평형');
  assert.equal(f([]), null);
  const s = fs.readFileSync(path.join(__dirname, '../routes/search.js'), 'utf8');
  assert.match(s, /const _cut180 = require\('\.\.\/utils\/txWindow'\)\.txWindowStart\(6\);/);
  assert.match(html, /최근 6개월 실거래 <b[^\n]*전 평형 평균/);
});

test('단지 페이지: 공식 단지의 다른 신고 번호 거래도 합친다', () => {
  const a = fs.readFileSync(path.join(__dirname, '../routes/aptPage.js'), 'utf8');
  assert.match(a, /await _aliasSiblingSeqs\(seq, idx, txs\)/);
  assert.match(a, /aptName: _sib\.name, _aliased: true/);
  assert.match(a, /if \(!ok\.some\(d => d\.apt_seq === seq\)\) return none;/);
});
