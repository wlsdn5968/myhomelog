/**
 * Plan 176 (2026-10-30, 운영자 승인 "권고대로"): 단지 정체성 — 별칭 v8·손 보정 보존·지도 핀 순서·인기/자동완성 별칭 묶기.
 * 근거 실측은 plans/175-apt-identity-audit.md · plans/176-apt-identity-fixes.md.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

test('별칭 v8: 빈 이름 제외·단지/차 번호 포함 관계·손 보정표 적용·거부 연결만 제거(전체 비우기 아님)', () => {
  const sql = read('../../supabase/migrations/20261030_alias_overrides_refresh_v8.sql');
  assert.match(sql, /\(i\.nn <> '' AND m\.nn <> '' AND \(m\.nn=i\.nn OR starts_with\(i\.nn,m\.nn\) OR starts_with\(m\.nn,i\.nn\)\)/);
  assert.match(sql, /AND \(m\.dset IS NULL OR i\.dset IS NULL OR m\.dset <@ i\.dset OR i\.dset <@ m\.dset\)\) AS by_name/);
  assert.match(sql, /fin2 AS \([\s\S]*o\.action='remove'[\s\S]*o\.action='add'/);
  assert.match(sql, /miss AS \(\s*SELECT kapt_code, molit FROM cur EXCEPT SELECT kapt_code, molit FROM fin2/);
  assert.match(sql, /ALTER TABLE public\.apt_alias_overrides ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /REVOKE ALL ON public\.apt_alias_overrides FROM anon, authenticated;/);
  assert.doesNotMatch(sql, /coalesce\(agg\.aliases, '\[\]'::jsonb\)/, '규칙 결과에 없는 단지의 별칭을 통째로 비우면 정상 연결 176개가 지워진다(실측)');
  const schema = read('../../supabase/schema.sql');
  // Plan 177: 마지막 별칭 함수는 v9 본체(_refresh_molit_aliases_core)를 부르는 껍데기 — 보정표 적용은 본체 안에 있다.
  const last = schema.lastIndexOf('CREATE OR REPLACE FUNCTION public._refresh_molit_aliases_core(');
  assert.ok(last > 0 && schema.indexOf('apt_alias_overrides', last) > last,
    '기준 스키마의 마지막 별칭 본체가 보정표를 적용해야 한다 — 옛 판으로 복구되면 다시 되돌아간다');
  assert.match(schema, /CREATE OR REPLACE FUNCTION public\.geocache_in_bounds/);
});

test('손 보정 좌표(source=manual)는 자동 저장이 덮어쓰지 않는다 · 일일 작업 대상 출처에 manual 이 없다', async () => {
  const dbc = require('../db/client');
  const orig = dbc.getSupabaseAdmin, origEnv = dbc.hasAdminEnv;
  const writes = [];
  let existing = { source: 'manual' };
  const q = {
    select() { return q; }, eq() { return q; },
    maybeSingle() { return Promise.resolve({ data: existing, error: null }); },
    upsert(v) { writes.push(v); return Promise.resolve({ error: null }); },
  };
  try {
    dbc.getSupabaseAdmin = () => ({ from: () => q });
    dbc.hasAdminEnv = () => true;
    delete require.cache[require.resolve('../services/geocodeCacheService')];
    const g = require('../services/geocodeCacheService');
    assert.equal(g.MANUAL_SOURCE, 'manual');
    await g.saveToDb('name:x|노원구|공릉동', { aptName: 'x', sigungu: '노원구', umdNm: '공릉동', lat: 37.6, lng: 127.07 });
    assert.equal(writes.length, 0, 'manual 행은 덮어쓰지 않는다');
    existing = { source: 'kakao' };
    await g.saveToDb('name:x|노원구|공릉동', { aptName: 'x', sigungu: '노원구', umdNm: '공릉동', lat: 37.6, lng: 127.07 });
    assert.equal(writes.length, 1, '자동 출처 행은 예전처럼 저장');
  } finally {
    dbc.getSupabaseAdmin = orig; dbc.hasAdminEnv = origEnv;
    delete require.cache[require.resolve('../services/geocodeCacheService')];
  }
  const job = read('../jobs/geocacheBackfill.js');
  for (const m of job.matchAll(/\.in\('source', \[([^\]]*)\]\)|\.eq\('source', '([^']*)'\)/g)) {
    assert.doesNotMatch(m[0], /manual/, `일일 좌표 작업이 manual 행을 대상으로 고르면 안 된다: ${m[0]}`);
  }
});

test('인기 TOP12: 같은 공식 단지의 두 신고 이름을 한 줄로 — 건수 합산·평균가 가중·공식 이름이 조회 키', async () => {
  const dbc = require('../db/client');
  const tx = require('../services/transactionService');
  const orig = { a: dbc.getSupabaseAdmin, e: dbc.hasAdminEnv, m: tx.getAliasCanonicalMapEach };
  const recent = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
  const rows = [
    { aptName: '풍림아파트A', sigungu: '노원구', umdNm: '공릉동', lawdCd: '11350', buildYear: 2001, recentDealDate: recent, dealCount60d: 10, avgDealAmount: 60000 },
    { aptName: '풍림아파트B', sigungu: '노원구', umdNm: '공릉동', lawdCd: '11350', buildYear: 2001, recentDealDate: recent, dealCount60d: 5, avgDealAmount: 51000 },
  ];
  const coords = [{ apt_name: '풍림아파트A', sigungu: '노원구', umd_nm: '공릉동', lat: 37.629, lng: 127.067, source: 'kakao-v' },
    { apt_name: '풍림아파트B', sigungu: '노원구', umd_nm: '공릉동', lat: 37.628, lng: 127.069, source: 'kakao-v' }];
  const chain = (data) => { const q = { select() { return q; }, in() { return q; }, limit() { return Promise.resolve({ data, error: null }); },
    then(r) { r({ data, error: null }); } }; return q; };
  const admin = {
    rpc() { return { abortSignal: () => Promise.resolve({ data: rows, error: null }) }; },
    from(t) { return chain(t === 'apt_geocache' ? coords : [{ apt_name: '풍림아파트A', sigungu: '노원구', umd_nm: '공릉동', apt_seq: '11350-183' }]); },
  };
  try {
    tx.getAliasCanonicalMapEach = async () => new Map([['풍림아파트A|공릉동', '공릉풍림아이원'], ['풍림아파트B|공릉동', '공릉풍림아이원']]);
    delete require.cache[require.resolve('../services/popularService')];
    const { buildPopularResults } = require('../services/popularService');
    const { results } = await buildPopularResults(1, { client: admin });
    assert.equal(results.length, 1);
    assert.equal(results[0].aptName, '공릉풍림아이원');
    assert.equal(results[0].displayName, '공릉풍림아이원');
    assert.equal(results[0].dealCount60d, 15, '두 신고 이름 건수 합산');
    assert.equal(results[0].avgDealAmount, 57000, '건수 가중 평균 (60000×10 + 51000×5) / 15');
    assert.equal(results[0].aptSeq, '11350-183', '좌표·단지 번호는 거래 많은 신고 이름으로');
  } finally {
    dbc.getSupabaseAdmin = orig.a; dbc.hasAdminEnv = orig.e; tx.getAliasCanonicalMapEach = orig.m;
    delete require.cache[require.resolve('../services/popularService')];
  }
});

test('자동완성·지도: 별칭 묶기와 거래 많은 순 핀 배선', () => {
  const s = read('../routes/search.js');
  assert.match(s, /_canonMap = await getAliasCanonicalMapEach\(molitRows\.map\(r => r\.lawd_cd\)\)/);
  assert.match(s, /const mergeKey = _canon \? `\$\{base\}\|\$\{row\.sigungu\}\|\$\{row\.umd_nm\}\|K`/);
  assert.match(s, /displayName: grp\.canon \|\| displayAptName/);
  assert.match(s, /admin\.rpc\('geocache_in_bounds'/);
  // Plan 185: 공식 단지 키(kapt:) 좌표를 더 읽는 조회는 허용(같은 열 목록) — 막는 것은 이름 좌표를 정렬 없이 범위로만 자르던 옛 모양.
  assert.doesNotMatch(s.slice(s.indexOf("router.get('/in-bounds'"), s.indexOf("router.get('/in-bounds'") + 6000), /\.from\('apt_geocache'\)\s*\.select\('apt_name, sigungu, umd_nm, lat, lng, apt_key, place_name'\)\s*\.gte\(/, '정렬 없는 limit 조회가 돌아왔다');
  const sql = read('../../supabase/migrations/20261030_geocache_in_bounds.sql');
  assert.match(sql, /ORDER BY coalesce\(s\.dc, 0\) DESC, g\.apt_key/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.geocache_in_bounds[\s\S]*FROM PUBLIC, anon, authenticated;/);
});

test('표시 이름: 단지 법정동과 같은 "동," 접두·끝의 (고층)/(저층)만 뗀다 — 백엔드·프런트 같은 결과', () => {
  const { displayAptName } = require('../utils/aptDisplayName');
  const h = read('../../frontend/index.html');
  const a = h.indexOf('const UNNAMED_RE = /^'), b = h.indexOf('/* ── 지역 시장 요약 모달');
  // eslint-disable-next-line no-new-func
  const front = new Function(`${h.slice(a, b)};return _dispAptName;`)();
  const cases = [
    ['산척동,동탄호수공원금강펜테리움센트럴파크Ⅱ', '산척동', '동탄호수공원금강펜테리움센트럴파크Ⅱ'],
    ['산장아파트가동,나동', '정릉동', '산장아파트가동,나동'], // 법정동이 아닌 접두는 건드리지 않는다
    ['상계주공7(고층)', '상계동', '상계주공7'],
    ['퇴계주공(351~359동)', '금정동', '퇴계주공(351~359동)'], // 동 범위는 다른 공식 단지를 가른다
    ['충무주공(872)', '금정동', '충무주공 (872번지)'],
    ['(50-5)', '공항동', '공항동 50-5번지 단지 (이름 미등록)'],
  ];
  for (const [n, u, want] of cases) {
    assert.equal(displayAptName(n, { umdNm: u }), want, `백엔드 ${n}`);
    assert.equal(front(n, u), want, `프런트 ${n}`);
  }
});

test('지도: 공식 단지 핀은 좌표 행이 영역 결과에 없는 별칭의 거래도 더한다(운영 실측 공릉풍림 30 vs DB 38)', () => {
  const s = read('../routes/search.js');
  assert.match(s, /if \(!g\._seen\.has\(a\)\) _missing\.push\(\[g, a\]\);/);
  assert.match(s, /if \(!st \|\| \(g\.sigungu && st\.sigungu && st\.sigungu !== g\.sigungu\)\) continue;/, '동명 타지역 거래를 더하면 안 된다');
  assert.match(s, /g\.sum \+= st\.sum; g\.n \+= st\.n; g\._seen\.add\(a\);/);
});
