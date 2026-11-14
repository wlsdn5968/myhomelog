/**
 * backend/test/alias-merge-geo-pin.test.js
 *
 * 2026-10-29 운영 실측(공릉풍림아이원 = 풍림아파트A 725번지 + 풍림아파트B 727번지) 회귀 고정.
 *   ① 별칭 거래를 "A 전부 → B 전부"로 이어 붙여 화면(앞 30건)에서 B 거래 8건이 통째로 빠졌다 → 계약일 최신순 정렬.
 *   ② 좌표 API 가 단지 코드 키(kapt:…) 좌표를 보지 않고 카카오 '지역' 주소 결과(동 중심점)를 단지 좌표로 답해
 *      핀이 본체에서 약 800m 떨어진 공릉동 한가운데 찍혔다 → 단지 코드 키 조회 + 지역 이름뿐 결과 거부.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

test('별칭 거래 병합 — 계약일 최신순 정렬·중복 제거(B 거래가 앞 30건에서 빠지지 않는다)', () => {
  const { _mergeAliasTx } = require('../services/transactionService');
  const tx = (aptName, y, m, d, ar, amt) => ({ aptName, dealYear: y, dealMonth: m, dealDay: d, excluUseAr: ar, floor: 5, dealAmount: amt });
  // 운영 응답 재현: A 31건(2026-10-02 ~ 2026-05-01) 뒤에 B 8건(2026-08-14 ~ 2026-05-09)
  const A = [];
  for (let i = 0; i < 31; i++) A.push(tx('풍림아파트A', 2026, 10 - Math.floor(i / 6), 28 - (i % 6) * 4, 59.94, 80000 + i));
  const B = [tx('풍림아파트B', 2026, 8, 14, 31.32, 31800), tx('풍림아파트B', 2026, 7, 3, 31.32, 30500)];
  const merged = _mergeAliasTx([A, B, [A[0]]]); // 마지막 배열은 중복 — 지워져야 한다
  assert.equal(merged.length, 33);
  const key = (t) => t.dealYear * 10000 + t.dealMonth * 100 + t.dealDay;
  for (let i = 1; i < merged.length; i++) assert.ok(key(merged[i - 1]) >= key(merged[i]), `정렬 깨짐 at ${i}`);
  const top30 = merged.slice(0, 30);
  assert.ok(top30.some((t) => t.aptName === '풍림아파트B' && t.dealMonth === 8 && t.dealDay === 14), '8/14 B 거래가 앞 30건에 있어야 한다');
  assert.deepEqual(_mergeAliasTx(null), []);
  assert.deepEqual(_mergeAliasTx([null, undefined]), []);
});

test('getTransactionsByAptInclAliases 는 병합 결과를 _mergeAliasTx 로 만든다(이어 붙이기 회귀 차단)', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '../services/transactionService.js'), 'utf8');
  const body = src.slice(src.indexOf('async function getTransactionsByAptInclAliases'), src.indexOf('// (b) 지역 단위'));
  assert.match(body, /const merged = _mergeAliasTx\(aliasArrays\);/);
});

test('좌표 API — 지역 이름뿐인 주소 결과(동 중심점)는 단지 좌표로 받지 않는다', () => {
  const { _isRegionOnly } = require('../routes/geocode');
  assert.equal(_isRegionOnly({}, '서울 노원구 공릉동'), true);           // 운영 실측: 공릉풍림아이원 → 동 중심점
  assert.equal(_isRegionOnly({}, '서울 노원구'), true);
  assert.equal(_isRegionOnly({}, '서울 노원구 상계1동'), true);          // 숫자가 든 동 이름도 번지가 아니다
  assert.equal(_isRegionOnly({}, '서울 노원구 공릉동 725'), false);      // 번지 주소는 받는다
  assert.equal(_isRegionOnly({}, '경기 안양시 동안구 호계동 946-13'), false);
  assert.equal(_isRegionOnly({ place_name: '공릉풍림아파트' }, '서울 노원구 공릉동'), false); // 장소 결과는 기존 채점에 맡긴다
});

function withStubDb(tables, fn) {
  const dbPath = require.resolve('../db/client');
  const svcPath = require.resolve('../services/geocodeCacheService');
  const saved = { db: require.cache[dbPath], svc: require.cache[svcPath] };
  const calls = [];
  const admin = {
    from(table) {
      const f = {};
      const q = {
        select() { return q; },
        eq(k, v) { f[k] = v; return q; },
        is(k, v) { f[k] = v; return q; },
        limit() { calls.push({ table, f: { ...f } }); return Promise.resolve({ data: tables[table](f) }); },
        maybeSingle() { calls.push({ table, f: { ...f } }); const r = tables[table](f); return Promise.resolve({ data: Array.isArray(r) ? (r[0] || null) : r }); },
      };
      return q;
    },
  };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getSupabaseAdmin: () => admin, hasAdminEnv: () => true } };
  delete require.cache[svcPath];
  return Promise.resolve()
    .then(() => fn(require('../services/geocodeCacheService'), calls))
    .finally(() => {
      if (saved.db) require.cache[dbPath] = saved.db; else delete require.cache[dbPath];
      if (saved.svc) require.cache[svcPath] = saved.svc; else delete require.cache[svcPath];
    });
}

test('좌표 캐시 — 이름 키가 없으면 같은 시군구·동의 단지 코드 키 좌표를 쓴다(공릉풍림아이원 재현)', async () => {
  const geocache = {
    'kapt:A13980513': { lat: '37.6291648', lng: '127.0668155', address: '서울 노원구 공릉동 725', place_name: '공릉풍림아파트', source: 'kakao-v' },
  };
  await withStubDb({
    apt_geocache: (f) => (f.apt_key ? (geocache[f.apt_key] || null) : null), // 이름 키·이름 조합은 없음(운영과 같음)
    apt_master: (f) => (f.apt_name === '공릉풍림아이원' && f.sigungu === '노원구' && f.umd_nm === '공릉동' ? [{ kapt_code: 'A13980513' }] : []),
  }, async (svc) => {
    const r = await svc.resolveCoordFromCacheOnly({ aptName: '공릉풍림아이원', sigungu: '노원구', umdNm: '공릉동' });
    assert.ok(r && Math.abs(r.lat - 37.6291648) < 1e-9 && Math.abs(r.lng - 127.0668155) < 1e-9, JSON.stringify(r));
    assert.equal(r.placeName, '공릉풍림아파트');
  });
});

test('좌표 캐시 — 같은 동에 같은 이름 단지가 둘이면 코드 키를 추측하지 않는다', async () => {
  await withStubDb({
    apt_geocache: () => null,
    apt_master: () => [{ kapt_code: 'A1' }, { kapt_code: 'A2' }],
  }, async (svc) => {
    assert.equal(await svc.resolveCoordFromCacheOnly({ aptName: '현대', sigungu: '노원구', umdNm: '상계동' }), null);
    assert.equal(await svc.getFromDbByMasterKapt({ aptName: '현대', sigungu: '노원구', umdNm: '' }), null); // 동 없으면 조회 안 함
  });
});

test('상세 헤더 평균가 — 전 평형 섞지 않고 거래 최다 평형만(공릉풍림 30건 재현), 라벨에 평형 표기', () => {
  const fs = require('fs');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const src = html.match(/function _repAreaOf\(tx\)\{[\s\S]*?\n\}/)[0];
  const f = new Function(`${src}; return _repAreaOf;`)();
  const t = (ar, n, m, d) => Array.from({ length: n }, () => ({ excluUseAr: ar, dealAmount: 80000, dealYear: 2026, dealMonth: m, dealDay: d }));
  // 운영 실측 구성: 31㎡ 5 · 60㎡ 16 · 85㎡ 7 · 115㎡ 2
  const tx = [...t(31.32, 5, 8, 14), ...t(59.94, 16, 9, 19), ...t(84.99, 7, 10, 2), ...t(114.78, 2, 7, 28)];
  assert.deepEqual(f(tx), { sqm: 60, py: 18, n: 16 });
  // 동률이면 가장 최근 거래의 평형
  assert.equal(f([...t(59.94, 3, 5, 1), ...t(84.99, 3, 9, 1)]).sqm, 85);
  assert.equal(f([]), null);
  assert.equal(f([{ excluUseAr: 0, dealAmount: 1 }]), null);
  assert.match(html, /_repArea \? `\$\{_repArea\.sqm\}㎡\(전용 \$\{_repArea\.py\}평\) 최근 \$\{_repArea\.n\}건 평균`/);
  assert.doesNotMatch(html, /`전 평형 최근 \$\{txHistory\.length\}건 평균`/);
});

test('경신 목록 — 신고 원본 이름을 정식 이름으로(하늘(주공3) → 하늘아파트), 원본은 rawName, 대응표 실패 시 원본 그대로', async () => {
  const txPath = require.resolve('../services/transactionService');
  const routePath = require.resolve('../services/priceRecordsService');
  const saved = require.cache[txPath];
  const real = require('../services/transactionService');
  let fail = false;
  require.cache[txPath] = { id: txPath, filename: txPath, loaded: true, exports: { ...real, getAliasCanonicalMap: async (l) => {
    if (fail) throw new Error('DB 오류');
    assert.deepEqual(l.sort(), ['30140', '41390']);
    return new Map([['하늘(주공3)|중촌동', '하늘아파트']]);
  } } };
  delete require.cache[routePath];
  try {
    const { canonRecords: _canonRecords } = require('../services/priceRecordsService');
    const data = { high: [{ aptName: '동진', umdNm: '복현동', lawdCd: '41390' }], low: [{ aptName: '하늘(주공3)', umdNm: '중촌동', lawdCd: '30140' }], highCount: 1 };
    const out = await _canonRecords(data);
    assert.equal(out.low[0].aptName, '하늘아파트');
    assert.equal(out.low[0].rawName, '하늘(주공3)');
    assert.equal(out.high[0].aptName, '동진'); assert.equal(out.high[0].rawName, undefined);
    assert.equal(out.highCount, 1);
    fail = true;
    assert.deepEqual(await _canonRecords(data), data, '대응표 실패 시 원본 그대로');
    assert.deepEqual(await _canonRecords({ high: [], low: [] }), { high: [], low: [] });
  } finally {
    if (saved) require.cache[txPath] = saved; else delete require.cache[txPath];
    delete require.cache[routePath];
  }
});

// SAFE-STEM (Plan 185 검토 반영, 2026-10-31): 동 번호·괄호 지번 이름은 그 동의 신고 이름 전체(molit_apt_dim)를 상세와 같은 일치 함수로
//   대조한 안전 판정(_jibunSafeStems)을 통과해야 합친다. 아래 msafe 는 목록 이름만 있는 동(= 안전)을 가짜 DB 로 만들어 판정을 거친다.
async function msafe(list, extraDims = [], masters = []) {
  const { _mergeNearDuplicateGroups: m, _jibunSafeStems: safeOf } = require('../routes/search');
  const dims = [...list.map(x => ({ lawd_cd: x.lawdCd, umd_nm: x.umdNm, apt_name: x.aptName, build_year: x.buildYear })), ...extraDims];
  return m(list, { jibunSafe: await safeOf(fakeAdmin(dims, masters), list) });
}
test('지도 핀 — 동 번호만 다른 신고 이름(같은 동·같은 해·150m 안·공통 이름 3자+, 안전 판정 통과)은 공통 이름 핀 하나로', async () => {
  const { _mergeNearDuplicateGroups: m } = require('../routes/search');
  const g = (n, lat, lng, by, c, src) => ({ aptName: n, umdNm: '죽전동', lawdCd: '41465', lat, lng, sum: c * 50000, n: c, source: src || 'molit', buildYear: by || 2001 });
  let r = await msafe([g('한솔노블(104동)', 37.3200, 127.1000, 0, 2), g('한솔노블(105동)', 37.3205, 127.1003, 0, 1), g('한솔노블(101,102동)', 37.3203, 127.1001, 0, 3)]);
  assert.equal(r.length, 1); assert.equal(r[0].aptName, '한솔노블'); assert.equal(r[0].n, 6);
  assert.deepEqual(r[0]._mergedNames.sort(), ['한솔노블(101,102동)', '한솔노블(104동)', '한솔노블(105동)']);
  assert.equal(m([g('한솔노블(104동)', 37.32, 127.1, 0, 2), g('한솔노블(105동)', 37.3201, 127.1, 0, 1)]).length, 2, '안전 판정이 없으면 합치지 않는다');
  assert.equal((await msafe([g('한솔노블(104동)', 37.32, 127.1, 0, 1), g('한솔노블(105동)', 37.33, 127.1, 0, 1)])).length, 2, '150m 밖은 합치지 않는다');
  assert.equal((await msafe([g('우일(101동)', 37.32, 127.1, 0, 1), g('우일(102동)', 37.3201, 127.1, 0, 1)])).length, 2, '공통 이름 2자는 합치지 않는다');
  assert.equal((await msafe([g('한솔노블(104동)', 37.32, 127.1, 2001, 1), g('한솔노블(105동)', 37.3201, 127.1, 2003, 1)])).length, 2, '건축년도 다르면 합치지 않는다');
  assert.equal((await msafe([g('관저더샵2차', 37.32, 127.1, 0, 1), g('관저더샵', 37.3201, 127.1, 0, 1)])).length, 2, '기존 규칙(숫자 다르면 별개) 유지');
  const master = await msafe([g('당정한솔솔파크', 37.32, 127.1, 2008, 5, 'master'), g('한솔솔파크(101,102동)', 37.3201, 127.1, 2008, 1)]);
  assert.equal(master[0].aptName, '당정한솔솔파크', '정식 단지 이름은 바꾸지 않는다');
  // 검토 재현(2026-10-31): 같은 동에 뼈대로 걸리는 다른 단지가 있으면 동 번호 이름도 합치지 않는다
  const d = (n, by) => ({ lawd_cd: '41465', umd_nm: '죽전동', apt_name: n, build_year: by });
  assert.equal((await msafe([g('롯데캐슬101동', 37.32, 127.1, 2010, 30), g('롯데캐슬102동', 37.3201, 127.1, 2010, 2)], [d('수명산롯데캐슬', 2008)])).length, 2);
  assert.equal((await msafe([g('감삼용궁101동', 37.32, 127.1, 2003, 3), g('감삼용궁102동', 37.3201, 127.1, 2003, 2)], [d('감삼용궁103동', 2002)])).length, 2, '같은 뼈대라도 다른 해 이름이 걸리면(핀 건수와 상세 건수가 어긋남) 합치지 않는다');
  // 뼈대와 같은 이름의 공식 단지가 같은 시군구(지역 코드 이름)에 있으면 합치지 않는다 — 41465 = 용인시수지구
  const { LAWD_CODE_TO_NAME } = require('../services/transactionService');
  assert.equal((await msafe([g('한솔노블(104동)', 37.32, 127.1, 0, 2), g('한솔노블(105동)', 37.3201, 127.1, 0, 1)], [], [{ apt_name: '한솔노블', sigungu: LAWD_CODE_TO_NAME['41465'] }])).length, 2);
  assert.equal((await msafe([g('한솔노블(104동)', 37.32, 127.1, 0, 2), g('한솔노블(105동)', 37.3201, 127.1, 0, 1)], [], [{ apt_name: '한솔노블', sigungu: '다른구' }])).length, 1, '다른 시군구의 같은 이름 공식 단지는 상관없다');
});

test('지도 핀 — 한쪽만 동 번호가 붙어도(거래 많은 쪽이 번호 이름) 공통 이름 핀 하나로 (Plan 185, 강산마을코오롱대성)', async () => {
  const g = (n, lat, lng, by, c) => ({ aptName: n, umdNm: '와부읍 덕소리', lawdCd: '41360', lat, lng, sum: c * 50000, n: c, source: 'molit', buildYear: by });
  const r = await msafe([g('강산마을코오롱대성107동', 37.58922, 127.22045, 1999, 30), g('강산마을코오롱대성', 37.58922, 127.22045, 1999, 6)]);
  assert.equal(r.length, 1); assert.equal(r[0].aptName, '강산마을코오롱대성'); assert.equal(r[0].n, 36);
  assert.deepEqual(r[0]._mergedNames.sort(), ['강산마을코오롱대성', '강산마을코오롱대성107동']);
  assert.equal((await msafe([g('강산마을코오롱대성107동', 37.58922, 127.22045, 1999, 30), g('강산마을코오롱대성', 37.58922, 127.22045, 2003, 6)])).length, 2, '건축년도 다르면 합치지 않는다');
  assert.equal((await msafe([g('강산마을코오롱대성107동', 37.58922, 127.22045, 1999, 30), g('강산마을코오롱대성', 37.5922, 127.22045, 1999, 6)])).length, 2, '150m 밖은 합치지 않는다');
  assert.equal((await msafe([g('태양아파트(1동)', 37.90083, 127.06365, 1990, 1), g('태양아파트(2동)', 37.90115, 127.06365, 1990, 1)])).length, 2, '공통 이름 2자(아파트 뗀 "태양")는 그대로 둔다');
});

// JIBUN-PIN (Plan 185): 괄호 지번 이름은 그 동의 신고 이름 전체를 상세와 같은 일치 함수로 대조해 안전할 때만 합친다.
function fakeAdmin(dimRows, masterRows = []) {
  return { from(t) { const q = { f: {}, select() { return q; }, eq(c, v) { q.f[c] = v; return q; }, in() { return q; }, limit() { return q; },
    then(res, rej) { const data = t === 'apt_master' ? masterRows : dimRows.filter(r => r.lawd_cd === q.f.lawd_cd && r.umd_nm === q.f.umd_nm);
      return Promise.resolve({ data, error: null }).then(res, rej); } }; return q; } };
}
test('지도 핀 — 괄호 지번 이름: 뼈대로 걸리는 신고 이름이 모두 같은 뼈대·같은 해면 합치고 핀 이름은 뼈대', async () => {
  const { _mergeNearDuplicateGroups: m, _jibunSafeStems: safeOf } = require('../routes/search');
  const g = (n, lat, c, by = 2002) => ({ aptName: n, umdNm: '도화동', sigungu: '미추홀구', lawdCd: '28177', lat, lng: 126.67, sum: c * 30000, n: c, source: 'molit', buildYear: by });
  const dim = (n, by = 2002) => ({ lawd_cd: '28177', umd_nm: '도화동', apt_name: n, build_year: by });
  const list = [g('백영쑥골마을(534-15)', 37.46264, 2), g('백영쑥골마을(534-16)', 37.4625, 1)];
  const safe = await safeOf(fakeAdmin([dim('백영쑥골마을(534-15)'), dim('백영쑥골마을(534-16)'), dim('백영쑥골마을(534-28)'), dim('봉림쑥골마을(534-13)')]), list);
  const r = m(list, { jibunSafe: safe });
  assert.equal(r.length, 1); assert.equal(r[0].aptName, '백영쑥골마을'); assert.equal(r[0].n, 3);
  // 같은 동에 뼈대로 걸리는 다른 단지(다른 해 또는 다른 이름)가 있으면 합치지 않는다 — 롯데캐슬(1057-0)·(1057-1) vs 수명산롯데캐슬·롯데캐슬(2014)
  const L = (n, lat, by = 2010) => ({ aptName: n, umdNm: '신월동', sigungu: '양천구', lawdCd: '11470', lat, lng: 126.84, sum: 90000, n: 2, source: 'molit', buildYear: by });
  const ld = (n, by) => ({ lawd_cd: '11470', umd_nm: '신월동', apt_name: n, build_year: by });
  const ll = [L('롯데캐슬(1057-0)', 37.52), L('롯데캐슬(1057-1)', 37.5205)];
  const s2 = await safeOf(fakeAdmin([ld('롯데캐슬(1057-0)', 2010), ld('롯데캐슬(1057-1)', 2010), ld('수명산롯데캐슬', 2008), ld('롯데캐슬', 2014)]), ll);
  assert.equal(s2.size, 0); assert.equal(m(ll, { jibunSafe: s2 }).length, 2);
  // 뼈대와 같은 이름의 공식 단지가 같은 시군구에 있으면(상세가 그 별칭 거래를 보여 줌) 합치지 않는다
  const s3 = await safeOf(fakeAdmin([dim('백영쑥골마을(534-15)'), dim('백영쑥골마을(534-16)')], [{ apt_name: '백영쑥골마을', sigungu: '미추홀구' }]), list);
  assert.equal(s3.size, 0);
  // 해가 다르거나, 괄호 숫자가 1~2자리(차수일 수 있음)면 후보가 아니다
  assert.equal((await safeOf(fakeAdmin([]), [g('유림2차(1)', 35.26, 3, 1994), g('유림2차(2)', 35.2601, 7, 1994)])).size, 0);
  const d2 = [g('백영쑥골마을(534-15)', 37.46264, 2, 2002), g('백영쑥골마을(534-16)', 37.4625, 1, 2003)];
  assert.equal(m(d2, { jibunSafe: await safeOf(fakeAdmin([dim('백영쑥골마을(534-15)'), dim('백영쑥골마을(534-16)', 2003)]), d2) }).length, 2);
  // 조회 실패면 합치지 않는다
  const errAdmin = { from() { const q = { select() { return q; }, eq() { return q; }, in() { return q; }, limit() { return q; }, then(res) { return Promise.resolve({ data: null, error: { message: 'x' } }).then(res); } }; return q; } };
  assert.equal((await safeOf(errAdmin, list)).size, 0);
});

test('거래 조회 이름 일치 함수는 getTransactionsByApt 필터와 같은 것을 쓴다(지도 안전 판정과 상세가 같은 기준)', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '../services/transactionService.js'), 'utf8');
  assert.match(src, /const _matches = aptNameMatcher\(aptName\);\s*filtered = flat\.filter\(t => _matches\(t\.aptName\)\);/);
  const s = require('fs').readFileSync(path.join(__dirname, '../routes/search.js'), 'utf8');
  assert.match(s, /const _jibunSafe = await _jibunSafeStems\(admin, _pinList\)/);
  const { aptNameMatcher } = require('../services/transactionService');
  const mt = aptNameMatcher('롯데캐슬');
  assert.equal(mt('수명산롯데캐슬'), true); assert.equal(mt('롯데캐슬(1057-1)'), true); assert.equal(mt('한신'), false);
});

test('지도 핀 — 안전 판정 동 상한(8)을 넘으면 거래 많은 동부터 대조하고, 결과는 입력 순서와 무관하다', async () => {
  const { _jibunSafeStems: safeOf } = require('../routes/search');
  const list = [];
  for (let i = 0; i < 10; i++) for (const n of ['한솔노블(101동)', '한솔노블(102동)']) list.push({ aptName: n, umdNm: `동${i}`, lawdCd: '41465', lat: 37.3, lng: 127.1, sum: 1, n: i + 1, source: 'molit', buildYear: 2001 });
  const dims = list.map(x => ({ lawd_cd: x.lawdCd, umd_nm: x.umdNm, apt_name: x.aptName, build_year: 2001 }));
  const a = await safeOf(fakeAdmin(dims), list), b = await safeOf(fakeAdmin(dims), list.slice().reverse());
  assert.equal(a.size, 8); assert.deepEqual([...a].sort(), [...b].sort());
  assert.ok(![...a].some(k => k.includes('|동0|') || k.includes('|동1|')), '거래 적은 동0·동1 이 빠진다');
});
