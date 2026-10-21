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

test('라우트·cron 배선: /search/popular-region(서울·경기만, 스냅샷→즉석 계산) · retention 에서 매일 저장', () => {
  const s = fs.readFileSync(path.join(__dirname, '../routes/search.js'), 'utf8');
  assert.match(s, /router\.get\('\/popular-region', async \(req, res\) => \{/);
  assert.match(s, /if \(!rp\.SIDOS\[sido\]\) return res\.status\(400\)/);
  assert.match(s, /let p = await rp\.readSido\(sido\);/);
  const c = fs.readFileSync(path.join(__dirname, '../routes/cron.js'), 'utf8');
  assert.match(c, /require\('\.\.\/services\/regionPopularService'\)\.computeAndStoreAll\(\)/);
  assert.equal(rp.SNAP_KEY('11'), 'popular:region:v3:11');
});

test('프런트: 서울·경기 칩은 항상 · 구 칩 줄 · 전체는 구마다 3곳+모두 보기 · 지도 마커는 같은 .pop-marker · 전국으로 되돌리면 인기 마커 복귀', () => {
  assert.match(html, /const sidos = \['서울', '경기'\];/);
  assert.match(html, /<div class="hp-chips hp-chips2" id="hpChips2" role="group" aria-label="구·시군구 고르기" hidden><\/div>/);
  assert.match(html, /fetch\(`\$\{CFG\.api\}\/search\/popular-region\?sido=\$\{sido\}`/);
  assert.match(html, /\(g\.results \|\| \[\]\)\.slice\(0, 3\)\.map\(\(p, i\) => _hpRegRow\(p, i \+ 1\)\)/);
  assert.match(html, /function _hpRegMarkers\(list\)\{/);
  assert.match(html, /else if\(wasReg\) \{ try\{ showPop\(\); \}catch\(_\)\{\} \}/);
  assert.match(html, /try\{ if\(_HP_REG_SIDO\[_hpSido\]\)\{ _hpSido = '전국'; _hpReg = 'all'; _hpRender\(\); \} \}catch\(_\)\{\}/);
});

test('순위는 하루 2건까지만 센다 — 하루에 몰린 일괄 신고(신축 일괄 등기)가 1위를 차지하지 않는다, 표시 건수는 실제 그대로', () => {
  const day = (n, d, cnt) => Array.from({ length: cnt }, () => ({ apt_name: n, umd_nm: '응암동', sigungu: '은평구', lawd_cd: '11380', apt_seq: '11380-1', build_year: 2026, deal_date: d, deal_amount: 60000 }));
  const rows = [...day('미가마하나임', '2026-10-01', 30), ...day('백련산파크자이', '2026-09-01', 1), ...day('백련산파크자이', '2026-09-08', 2), ...day('백련산파크자이', '2026-09-15', 2)];
  const out = rp.rankLawd(rows, new Map(), 10);
  assert.equal(out[0].aptName, '백련산파크자이', '거래일이 고른 단지가 앞');
  assert.equal(out[0].dealCount60d, 5);
  assert.equal(out[1].aptName, '미가마하나임');
  assert.equal(out[1].dealCount60d, 30, '표시 건수는 실제 그대로');
  assert.ok(!('_perDay' in out[0]) && !('_rankN' in out[0]), '내부 필드는 응답에 남기지 않는다');
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
