/**
 * backend/test/region-top10.test.js — REGION-TOP10-2026-10-21: 서울 구별·경기 시군구별 최근 60일 거래 많은 단지 TOP10.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const rp = require('../services/regionPopularService');
const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');

test('시도별 시군구: 서울 25 · 경기 47(폐지 코드 제외)', () => {
  assert.equal(rp.lawdsOfSido('11').length, 25);
  assert.equal(rp.lawdsOfSido('41').length, 47);
  assert.ok(rp.lawdsOfSido('41').includes('41117') && rp.lawdsOfSido('41').includes('41285'));
});

test('rankLawd: 별칭으로 A·B 를 정식 단지에 합쳐 건수 합산 · 동이 다르면 다른 단지 · 이름 없는 단지 제외 · 상위 N', () => {
  const rows = [
    { apt_name: '풍림아파트A', umd_nm: '공릉동', sigungu: '노원구', lawd_cd: '11350', apt_seq: '11350-1', build_year: 2004, deal_date: '2026-10-01', deal_amount: 70000 },
    { apt_name: '풍림아파트B', umd_nm: '공릉동', sigungu: '노원구', lawd_cd: '11350', apt_seq: '11350-2', build_year: 2004, deal_date: '2026-10-05', deal_amount: 80000 },
    { apt_name: '공릉풍림아이원', umd_nm: '공릉동', sigungu: '노원구', lawd_cd: '11350', apt_seq: '11350-3', build_year: 2004, deal_date: '2026-09-01', deal_amount: 90000 },
    { apt_name: '현대', umd_nm: '상계동', sigungu: '노원구', lawd_cd: '11350', apt_seq: '11350-9', build_year: 1990, deal_date: '2026-10-02', deal_amount: 50000 },
    { apt_name: '현대', umd_nm: '중계동', sigungu: '노원구', lawd_cd: '11350', apt_seq: '11350-8', build_year: 1990, deal_date: '2026-10-03', deal_amount: 60000 },
  ];
  const alias = new Map([['풍림아파트A|공릉동', '공릉풍림아이원'], ['풍림아파트B|공릉동', '공릉풍림아이원']]);
  const out = rp.rankLawd(rows, alias, 10);
  assert.equal(out.length, 3);
  assert.equal(out[0].aptName, '공릉풍림아이원');
  assert.equal(out[0].dealCount60d, 3);
  assert.equal(out[0].avgDealAmount, 80000);
  assert.equal(out[0].recentDealDate, '2026-10-05');
  assert.equal(out[0].aptSeq, '11350-3', '정식 이름으로 신고된 거래의 단지 번호를 쓴다');
  assert.deepEqual(out.slice(1).map((e) => e.umdNm).sort(), ['상계동', '중계동']);
  assert.equal(rp.rankLawd(rows, alias, 1).length, 1);
});

test('trustedCoord: 검증된 출처는 통과 · 키워드 검색 좌표는 장소 이름에 단지 이름이 있어야 통과', () => {
  assert.equal(rp.trustedCoord({ lat: 37.6, lng: 127.07, source: 'kakao-v' }, '공릉풍림아이원'), true);
  assert.equal(rp.trustedCoord({ lat: 37.49, lng: 126.98, source: 'kakao', place_name: '앨리스성수동수제화' }, '엘리스'), false);
  assert.equal(rp.trustedCoord({ lat: 37.5, lng: 127.0, source: 'kakao', place_name: '상계현대1차 아파트' }, '상계현대1차'), true);
  assert.equal(rp.trustedCoord({ lat: 10, lng: 10, source: 'kakao-v' }, 'x'), false);
});

test('라우트·cron 배선: /search/popular-region(적재 9개 시도, 스냅샷→즉석 계산) · retention 에서 매일 저장', () => {
  const s = fs.readFileSync(path.join(__dirname, '../routes/search.js'), 'utf8');
  assert.match(s, /router\.get\('\/popular-region', async \(req, res\) => \{/);
  assert.match(s, /if \(!rp\.SIDOS\[sido\]\) return res\.status\(400\)/);
  assert.match(s, /let p = await rp\.readSido\(sido\);/);
  const c = fs.readFileSync(path.join(__dirname, '../routes/cron.js'), 'utf8');
  assert.match(c, /require\('\.\.\/services\/regionPopularService'\)\.computeAndStoreAll\(\)/);
  assert.equal(rp.SNAP_KEY('11'), 'popular:region:v5:11');
  assert.deepEqual(Object.keys(rp.SIDOS).sort(), ['11', '26', '27', '28', '30', '31', '36', '41', '43'], 'REGION-ALL-SIDO: 실거래 적재 시도 전부');
  for (const k of Object.keys(rp.SIDOS)) assert.ok(rp.lawdsOfSido(k).length >= 1, `${k} 시군구 코드 없음`);
  assert.match(fs.readFileSync(path.join(__dirname, '../services/regionPopularService.js'), 'utf8'), /if \(Date\.now\(\) - t0 > CRON_BUDGET_MS\) \{ out\[sido\] = 'skip\(time\)'; continue; \}/);
});

test('프런트: 적재 9개 시도 칩은 항상 · 구 칩 줄 · 전체 목록은 구마다 5곳+모두 보기 · 지도는 구마다 1위만 · 전국으로 되돌리면 인기 마커 복귀', () => {
  assert.match(html, /const sidos = Object\.keys\(_HP_REG_SIDO\);/);
  assert.match(html, /const _HP_REG_TOP = 5;/);
  // REGION-SHADE-2026-10-21 (운영자 "너무 많아서 어지럽다"): 전체 보기 지도는 구마다 1위 1곳(색 점·구 이름)
  assert.match(html, /groups\.forEach\(g => \{ const p = \(g\.results \|\| \[\]\)\[0\]; if\(p\) markers\.push\(Object\.assign\(\{ _rank: 1, _gu: _hpRegShort\(g\.label\), _col: _hpGuColor\(sido, g\.lawdCd\) \}, p\)\); \}\);/);
  assert.match(html, /if\(groups\.length === 1\) _hpReg = groups\[0\]\.lawdCd;/);
  assert.match(html, /<div class="hp-chips hp-chips2" id="hpChips2" role="group" aria-label="구·시군구 고르기" hidden><\/div>/);
  assert.match(html, /fetch\(`\$\{CFG\.api\}\/search\/popular-region\?sido=\$\{sido\}`/);
  assert.match(html, /\(g\.results \|\| \[\]\)\.slice\(0, _HP_REG_TOP\)\.map\(\(p, i\) => _hpRegRow\(p, i \+ 1\)\)/);
  assert.match(html, /function _hpRegMarkers\(list, o\)\{/);
  assert.match(html, /else if\(wasReg\) \{ try\{ _hpRegPolysClear\(\); _hpRegLegend\(null\); showPop\(\); \}catch\(_\)\{\} \}/);
  assert.match(html, /try\{ if\(_HP_REG_SIDO\[_hpSido\]\)\{ _hpSido = '전국'; _hpReg = 'all'; _hpRender\(\); \} \}catch\(_\)\{\}/);
});

test('REGION-SHADE: 구 경계 파일 — 9개 시도 전부, 우리 시군구 코드와 1:1, 색 번호 0~5, 출처 표기', () => {
  for (const sido of Object.keys(rp.SIDOS)) {
    const g = JSON.parse(fs.readFileSync(path.join(__dirname, `../../frontend/geo/sgg-${sido}.json`), 'utf8'));
    assert.deepEqual(g.features.map((f) => f.properties.c), rp.lawdsOfSido(sido), `${sido} 코드 불일치`);
    assert.match(g.attribution, /통계청 SGIS\(공공누리 제1유형\).*vuski\/admdongkor.*CC BY 4\.0/);
    for (const f of g.features) {
      assert.ok(Number.isInteger(f.properties.k) && f.properties.k >= 0 && f.properties.k <= 5, `${f.properties.c} 색 번호`);
      assert.ok(['Polygon', 'MultiPolygon'].includes(f.geometry.type));
      assert.ok(f.properties.n, '구 이름');
    }
  }
  const v = fs.readFileSync(path.join(__dirname, '../../vercel.json'), 'utf8');
  assert.match(v, /"src": "\/geo\/sgg-\(\\\\d\{2\}\)\\\\\.json", "dest": "\/frontend\/geo\/sgg-\$1\.json"/);
  assert.ok(v.indexOf('/geo/sgg-') < v.indexOf('"dest": "/frontend/404.html"'), '404 잡이보다 앞');
});

test('REGION-SHADE: 색 구역 — 전체는 모두 옅게, 고른 구만 진하게·나머지 흐리게, 범위는 고른 구 · 실패면 다시 부르지 않음 · 검색·인기 복귀 때 걷기', () => {
  assert.match(html, /const unit = sido === '41' \? '시군구' : \['26', '27', '28', '31'\]\.includes\(sido\) \? '구·군' : '구';/);
  assert.match(html, /if\(_hpGeo\[sido\] !== undefined \|\| _hpGeoReq\[sido\]\) return;/);
  assert.match(html, /\.catch\(\(\) => \{ _hpGeo\[sido\] = false; \}\)/);
  // renderMarkers(검색 결과)·showPop(인기 단지로) 둘 다 색 구역과 범례를 되돌린다
  assert.equal((html.match(/_hpRegPolysClear\(\); _hpRegLegend\(null\);/g) || []).length, 3);
  const vm = require('node:vm');
  const fn = (name) => { const m = html.match(new RegExp(`function ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n\\}`)); assert.ok(m, name); return m[0]; };
  const made = [];
  const ctx = {
    window: {}, document: { documentElement: { getAttribute: () => null } },
    naver: { maps: {
      LatLng: function (y, x) { this.y = y; this.x = x; },
      Polygon: function (o) { this.o = o; made.push(this); this.setMap = () => {}; this.setOptions = () => {}; },
      Event: { addListener: () => {} },
    } },
  };
  ctx.window.naver = ctx.naver;
  vm.createContext(ctx);
  const geo = { features: [
    { properties: { c: 'A', k: 0, n: '가구' }, geometry: { type: 'Polygon', coordinates: [[[127, 37], [127.1, 37], [127.1, 37.1], [127, 37]]] } },
    { properties: { c: 'B', k: 1, n: '나구' }, geometry: { type: 'MultiPolygon', coordinates: [[[[127.1, 37], [127.2, 37], [127.2, 37.2], [127.1, 37]]], [[[126.5, 37.5], [126.6, 37.5], [126.6, 37.6], [126.5, 37.5]]]] } },
  ] };
  vm.runInContext([
    "const _HP_GU_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#F43F5E', '#14B8A6'];",
    'var mapObj = { _isNaver: true };', 'var _hpGeo = { "11": ' + JSON.stringify(geo) + ' };', 'function _hpRegPick(){}',
    fn('_hpRegPolysClear'), fn('_hpRegPolys'), 'globalThis.__polys = _hpRegPolys;',
  ].join('\n'), ctx);
  const all = ctx.__polys('11', 'all');
  assert.equal(made.length, 3, 'MultiPolygon 은 조각마다 하나');
  assert.ok(made.every((p) => p.o.fillOpacity >= 0.15 && p.o.fillOpacity <= 0.25), '전체는 옅게(그래도 보이게 — 0.11 은 안 보였다)');
  assert.equal(JSON.stringify(all), '[[37,126.5],[37.6,127.2]]', '전체 범위 = 시도 전체');
  made.length = 0;
  const one = ctx.__polys('11', 'A');
  const a = made.find((p) => p.o.fillColor === '#3B82F6'), others = made.filter((p) => p !== a);
  assert.ok(a.o.fillOpacity > others[0].o.fillOpacity && a.o.strokeWeight > others[0].o.strokeWeight, '고른 구만 진하게');
  assert.ok(others.every((p) => p.o.fillOpacity <= 0.05));
  assert.equal(JSON.stringify(one), '[[37,127],[37.1,127.1]]', '범위 = 고른 구');
  made.length = 0;
  ctx.window._regPolys = [];
  vm.runInContext('_hpGeo["11"] = false;', ctx);
  assert.equal(ctx.__polys('11', 'all'), null, '경계를 못 받으면 색 구역 없이(마커 범위로 맞춘다)');
  assert.equal(made.length, 0);
});

test('순위: 하루 10건 이상인 날만 2건으로 센다 — 하루에 몰린 일괄 신고는 1위가 못 되고, 하루 5~9건인 일반 단지는 실제 건수로', () => {
  const day = (n, d, cnt) => Array.from({ length: cnt }, () => ({ apt_name: n, umd_nm: '응암동', sigungu: '은평구', lawd_cd: '11380', apt_seq: '11380-1', build_year: 2026, deal_date: d, deal_amount: 60000 }));
  const rows = [...day('미가마하나임', '2026-10-01', 30), ...day('백련산파크자이', '2026-09-01', 1), ...day('백련산파크자이', '2026-09-08', 2), ...day('백련산파크자이', '2026-09-15', 2)];
  const out = rp.rankLawd(rows, new Map(), 10);
  assert.equal(out[0].aptName, '백련산파크자이', '거래일이 고른 단지가 앞');
  assert.equal(out[0].dealCount60d, 5);
  assert.equal(out.length, 1, '거래의 절반 이상이 일괄 신고일인 단지(미가마하나임 30건 전부 하루)는 빠진다');
  assert.ok(!('_perDay' in out[0]) && !('_rankN' in out[0]) && !('_burstShare' in out[0]), '내부 필드는 응답에 남기지 않는다');
});

test('이름이 바뀐 같은 단지(같은 동·같은 건축년도·이름 포함·같은 숫자)는 합친다 — 건축년도·숫자가 다르면 따로', () => {
  const R = (n, by, d) => ({ apt_name: n, umd_nm: '중앙동', sigungu: '과천시', lawd_cd: '41290', apt_seq: '41290-' + n.length, build_year: by, deal_date: d, deal_amount: 200000 });
  const rows = [R('과천래미안슈르', 2008, '2026-10-01'), R('과천래미안슈르', 2008, '2026-10-02'), R('래미안슈르', 2008, '2026-10-03'),
    R('현대', 1985, '2026-10-01'), R('현대힐스테이트', 2010, '2026-10-02'), R('주공8', 1983, '2026-10-01'), R('주공9', 1983, '2026-10-02')];
  const out = rp.rankLawd(rows, new Map(), 10);
  const by = Object.fromEntries(out.map((e) => [e.aptName, e.dealCount60d]));
  assert.equal(by['과천래미안슈르'], 3); assert.ok(!('래미안슈르' in by));
  assert.equal(by['현대'], 1); assert.equal(by['현대힐스테이트'], 1);
  assert.equal(by['주공8'], 1); assert.equal(by['주공9'], 1);
});

test('목록 합치기도 괄호 안 이름이 다르면 따로 — 후곡마을(대창) ↔ 후곡마을(동양)', () => {
  const R = (n) => ({ apt_name: n, umd_nm: '일산동', sigungu: '고양시일산서구', lawd_cd: '41287', apt_seq: '41287-1', build_year: 1995, deal_date: '2026-10-01', deal_amount: 30000 });
  const out = rp.rankLawd([R('후곡마을(대창)'), R('후곡마을(동양)')], new Map(), 10);
  assert.equal(out.length, 2);
});

test('지번 별칭: 같은 동·같은 지번·건축년도 1년 이내·정식 이름의 부분열이면 같은 단지(벽적골우성 → 벽적골두산한신우성), 아니면 따로', () => {
  const T = (n, y, j, d) => ({ apt_name: n, umd_nm: '영통동', sigungu: '수원시영통구', lawd_cd: '41117', apt_seq: '41117-' + n.length, build_year: y, deal_date: d, deal_amount: 50000, jibun: j });
  const alias = new Map([['벽적골두산|영통동', '벽적골두산한신우성'], ['벽적골한신|영통동', '벽적골두산한신우성']]);
  const rows = [T('벽적골두산', 1997, '973-3', '2026-10-01'), T('벽적골한신', 1997, '973-3', '2026-10-02'),
    T('벽적골우성', 1998, '973-3', '2026-10-03'), T('벽적골우성', 1998, null, '2026-09-03'),
    T('청구', 1997, '973-3', '2026-10-04'), T('벽적골우성', 2005, '980', '2026-10-05')];
  const j = rp.jibunAliases(rows, alias);
  assert.equal(j.get('벽적골우성|영통동'), '벽적골두산한신우성');
  assert.ok(!j.has('청구|영통동'), '정식 이름의 부분열이 아니면 같은 지번이어도 따로');
  const out = rp.rankLawd(rows.slice(0, 5), alias, 10);
  const by = Object.fromEntries(out.map((e) => [e.aptName, e.dealCount60d]));
  assert.equal(by['벽적골두산한신우성'], 4, '지번 없는 옛 거래도 같은 이름이면 함께 합산');
  assert.equal(by['청구'], 1);
});

test('하루 5~9건은 일반 거래로 그대로 센다 — 순위 순서와 화면 건수가 어긋나지 않는다', () => {
  const day = (n, d, cnt) => Array.from({ length: cnt }, () => ({ apt_name: n, umd_nm: '월계동', sigungu: '노원구', lawd_cd: '11350', apt_seq: '11350-' + n.length, build_year: 1990, deal_date: d, deal_amount: 90000 }));
  const rows = [...day('월계동신', '2026-10-01', 9), ...day('월계동신', '2026-10-02', 7), ...day('상계주공7단지', '2026-10-03', 3), ...day('상계주공7단지', '2026-10-04', 3), ...day('상계주공7단지', '2026-10-05', 3)];
  const out = rp.rankLawd(rows, new Map(), 10);
  assert.deepEqual(out.map((e) => [e.aptName, e.dealCount60d]), [['월계동신', 16], ['상계주공7단지', 9]]);
});
