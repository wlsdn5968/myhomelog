/**
 * Plan 178 (2026-10-30, 운영자 승인 "권고대로"): 연도 별칭 "이름#연도".
 * 시흥 능곡동 국토부 신고 이름 "우남퍼스트빌" 하나에 1차(2008년, 802번지, 41390-1926)와 2차(2011년, 493번지, 41390-1994)가 섞여 있었다.
 * 별칭이 1차에만 붙어 2차 거래 9건이 1차로 묶였다. 연도를 아는 곳은 연도별로 각 공식 단지에, 모르는 곳은 신고 이름 그대로.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

function withStubAdmin(admin, modPath, fn) {
  const dbPath = require.resolve('../db/client');
  const svcPath = require.resolve(modPath);
  const saved = { db: require.cache[dbPath], svc: require.cache[svcPath] };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getSupabaseAdmin: () => admin, hasAdminEnv: () => true } };
  delete require.cache[svcPath];
  return Promise.resolve().then(() => fn(require(modPath))).finally(() => {
    if (saved.db) require.cache[dbPath] = saved.db; else delete require.cache[dbPath];
    if (saved.svc) require.cache[svcPath] = saved.svc; else delete require.cache[svcPath];
  });
}

const MASTERS = [
  { kapt_code: 'A42924002', apt_name: '우남퍼스트빌', umd_nm: '능곡동', molit_aliases: ['우남퍼스트빌#2008'] },
  { kapt_code: 'A42924018', apt_name: '시흥능곡우남퍼스트빌2차', umd_nm: '능곡동', molit_aliases: ['우남퍼스트빌#2011'] },
  { kapt_code: 'A1', apt_name: '공릉풍림아이원', umd_nm: '공릉동', molit_aliases: ['풍림아파트A', '풍림아파트B'] },
];

test('연도 별칭 읽기: 끝이 #+숫자 네 자리만 연도("평택the#" 는 이름), 대응표는 연도 키 우선', () => {
  const { parseAlias, aliasCanon } = require('../services/transactionService');
  assert.deepEqual(parseAlias('우남퍼스트빌#2008'), { name: '우남퍼스트빌', year: 2008 });
  assert.deepEqual(parseAlias('평택the#'), { name: '평택the#', year: null });
  const m = new Map([['우남퍼스트빌|능곡동|2008', '우남퍼스트빌'], ['우남퍼스트빌|능곡동|2011', '시흥능곡우남퍼스트빌2차'], ['풍림아파트A|공릉동', '공릉풍림아이원']]);
  assert.equal(aliasCanon(m, '우남퍼스트빌', '능곡동', 2008), '우남퍼스트빌');
  assert.equal(aliasCanon(m, '우남퍼스트빌', '능곡동', '2011'), '시흥능곡우남퍼스트빌2차');
  assert.equal(aliasCanon(m, '우남퍼스트빌', '능곡동', 2015), null, '연도 별칭에 없는 연도는 신고 이름 그대로');
  assert.equal(aliasCanon(m, '우남퍼스트빌', '능곡동'), null, '연도를 모르면 묶지 않는다');
  assert.equal(aliasCanon(m, '풍림아파트A', '공릉동', 2001), '공릉풍림아이원', '보통 별칭은 연도와 무관');
});

test('지역 별칭 대응표: 연도 별칭은 이름|동|연도 키로만 들어간다', async () => {
  const q = { select() { return q; }, in() { return q; }, not() { return q; }, neq() { return q; }, order() { return q; },
    range() { return Promise.resolve({ data: MASTERS, error: null }); } };
  await withStubAdmin({ from: () => q }, '../services/transactionService', async (tx) => {
    const m = await tx.getAliasCanonicalMap(['41390', '11350']);
    assert.equal(m.get('우남퍼스트빌|능곡동|2008'), '우남퍼스트빌');
    assert.equal(m.get('우남퍼스트빌|능곡동|2011'), '시흥능곡우남퍼스트빌2차');
    assert.equal(m.has('우남퍼스트빌|능곡동'), false);
    assert.equal(m.has('우남퍼스트빌#2008|능곡동'), false);
    assert.equal(m.get('풍림아파트B|공릉동'), '공릉풍림아이원');
  });
});

test('구별 순위: 같은 신고 이름의 두 연도 거래가 각 공식 단지로 나뉜다', () => {
  const { rankLawd } = require('../services/regionPopularService');
  const m = new Map([['우남퍼스트빌|능곡동|2008', '우남퍼스트빌'], ['우남퍼스트빌|능곡동|2011', '시흥능곡우남퍼스트빌2차']]);
  const row = (y, d, seq) => ({ apt_name: '우남퍼스트빌', umd_nm: '능곡동', sigungu: '시흥시', lawd_cd: '41390', build_year: y,
    jibun: y === 2008 ? '802' : '493', deal_date: d, deal_amount: 50000, apt_seq: seq });
  const rows = [row(2008, '2026-10-01', '41390-1926'), row(2011, '2026-10-02', '41390-1994'), row(2011, '2026-10-03', '41390-1994'), row(2011, '2026-10-04', '41390-1994')];
  const out = rankLawd(rows, m, 10);
  const by = Object.fromEntries(out.map(e => [e.aptName, e.dealCount60d]));
  assert.equal(by['시흥능곡우남퍼스트빌2차'], 3);
  assert.equal(by['우남퍼스트빌'], 1);
});

test('단지 공개 페이지: 연도 별칭은 그 준공 연도 페이지에서만, 연도가 안 맞으면 이름 완전일치로도 고르지 않는다', () => {
  const pick = require('../routes/aptPage')._pickAptMasterMatch;
  assert.equal(pick(MASTERS, '우남퍼스트빌', 2008).kapt_code, 'A42924002');
  assert.equal(pick(MASTERS, '우남퍼스트빌', 2011).kapt_code, 'A42924018');
  assert.equal(pick(MASTERS, '우남퍼스트빌', 2015), null);
  assert.equal(pick(MASTERS, '우남퍼스트빌'), null);
  assert.equal(pick(MASTERS, '풍림아파트A', 2001).kapt_code, 'A1');
});

test('배선: 거래 병합·지도·자동완성·인기·보고서·추천·알림·가격 기록·지역 페이지·도우미가 연도를 넘긴다', () => {
  const tx = read('../services/transactionService.js');
  const inc = tx.slice(tx.indexOf('async function getTransactionsByAptInclAliases'), tx.indexOf('// (b) 지역 단위'));
  assert.match(inc, /_filterExactAlias\(arr, p\.name\)\.filter\(t => !p\.year \|\| Number\(t\.buildYear\) === p\.year\)/);
  assert.match(inc, /return _yr\.length \? base\.filter\(/, '별칭 거래 0건일 때의 대체 결과에도 다른 연도 단지 거래가 섞이면 안 된다');
  const s = read('../routes/search.js');
  assert.match(s, /const _canon = aliasCanon\(_canonMap, row\.apt_name, row\.umd_nm, row\.build_year\)/);
  // 공식 단지 결과: 별칭이 있으면 molit_apt_index 의 그 별칭(연도 별칭은 그 연도) 건수만, 이름 조각 맞추기는 별칭 없는 단지에만
  assert.match(s, /const _masterSel = 'apt_name, sigungu, umd_nm, lawd_cd, kapt_code, molit_aliases';/);
  assert.match(s, /if \(p\.year && Number\(x\.build_year\) !== p\.year\) continue;/);
  assert.match(s, /const masterEmpty = out\.filter\(r => r\.source === 'master' && !r\.buildYear && r\.lawdCd && r\.umdNm && !r\._aliasChecked\);/);
  assert.match(s, /for \(const r of out\) \{ delete r\._aliases; delete r\._aliasChecked; \}/, '내부 필드가 응답에 나가면 안 된다');
  // Plan 181: 보충 조회 실패는 열화 응답(캐시 금지)으로 알린다
  assert.match(s, /const \{ data: _ix, error: _ixErr \} = await _softQuery\(/);
  assert.match(s, /if \(_ixErr\) _enrichFailed = true;/);
  assert.match(s, /const _degradedOut = _degraded \|\| _enrichFailed;/);
  assert.match(s, /if \(p\.year\) \(aliasYearToMaster\[/);
  assert.match(s, /const _ys = aliasYearToMaster\[`\$\{c\.apt_name\}\|\$\{c\.umd_nm\}`\];/);
  assert.match(s, /const st = _mStats\[_pa\.year \? /);
  assert.match(read('../services/popularService.js'), /aliasCanon\(_amap, t\.apt_name, t\.umd_nm, t\.build_year\)/);
  const rep = read('../routes/report.js');
  assert.equal((rep.match(/aliasCanon\(_aliasMap, t\.apt_name, t\.umd_nm, t\.build_year\)/g) || []).length, 2);
  assert.match(rep, /\.select\('apt_name, sigungu, umd_nm, exclu_use_ar, deal_amount, deal_date, floor, build_year'\)/);
  assert.match(read('../services/propertyService.js'), /aliasCanon\(aliasMap, t\.aptName, t\.umdNm, t\.buildYear\)/);
  const push = read('../jobs/pushNotify.js');
  assert.equal((push.match(/aliasCanon\(aliasMap, r\.apt_name, r\.umd_nm, r\.build_year\)/g) || []).length, 2);
  assert.match(push, /ingested_at, apt_seq, build_year'\)/);
  assert.match(read('../services/priceRecordsService.js'), /aliasCanon\(map, r\.aptName, r\.umdNm, r\.buildYear\)/);
  const rp = read('../routes/regionPage.js');
  assert.match(rp, /showName\(it\.aptName, it\.umdNm, it\.buildYear\)/);
  assert.match(rp, /showName\(a\.apt_name, a\.umd_nm, a\.build_year\)/);
  const chat = read('../services/chatDataRouter.js');
  assert.match(chat, /const data = \(_txRaw \|\| \[\]\)\.filter\(r => !_yearOf\[r\.apt_name\] \|\| Number\(r\.build_year\) === _yearOf\[r\.apt_name\]\);/);
  // 대응표를 이름|동 으로 직접 읽는 곳이 남아 있으면 연도 별칭이 그곳에서만 무시된다
  for (const f of ['../services/popularService.js', '../services/regionPopularService.js', '../services/priceRecordsService.js', '../routes/report.js',
    '../services/propertyService.js', '../jobs/pushNotify.js', '../routes/regionPage.js']) {
    assert.doesNotMatch(read(f), /(aliasMap|_amap|_aliasMap|canon|map)\.get\(`\$\{[a-z]+\.(apt_name|aptName)\}\|/, f);
  }
});
