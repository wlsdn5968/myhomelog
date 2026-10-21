/**
 * backend/test/popular-degraded-label.test.js
 *
 * DEGRADED-LABEL-2026-10-18 — 인기 단지 API 의 대체 경로(실시간 집계 RPC 실패 → 최근 거래 표본) 응답은 degraded:true 이고,
 * 그때 avgDealAmount = 그 단지 최근 1건 가격, dealCount60d = 약 2주 표본 건수다(popularService 대체 분기).
 * 화면이 이 값을 "60일 평균가·60일 N건"으로 표시하지 않도록 모든 소비자가 _popRows 로 값을 비우는지 고정한다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} 함수를 찾지 못했다`);
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name} 의 닫는 중괄호를 찾지 못했다`);
}

test('_popRows — degraded 면 평균가·건수를 비우고 표식, 정상이면 그대로', () => {
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(extractFn(html, '_popRows') + ';globalThis.F=_popRows;', ctx);
  const row = { aptName: 'A', avgDealAmount: 51571, dealCount60d: 60, lat: 1, lng: 2 };
  const ok = ctx.F({ results: [row] });
  assert.equal(ok[0], row, '정상 응답은 원본 그대로');
  const dg = ctx.F({ results: [row], degraded: true });
  assert.equal(dg[0].avgDealAmount, null);
  assert.equal(dg[0].dealCount60d, null);
  assert.equal(dg[0]._degraded, true);
  assert.equal(dg[0].aptName, 'A'); assert.equal(dg[0].lat, 1);
  assert.equal(row.avgDealAmount, 51571, '원본 객체는 바꾸지 않는다');
  assert.equal(ctx.F(null).length, 0); assert.equal(ctx.F({}).length, 0); // vm 다른 영역의 배열이라 길이로 본다
});

test('실시간 응답을 받는 소비자는 모두 _popRows 를 거친다 (소개 화면·브리핑·랭킹 카드·지도 마커)', () => {
  // LANDING-V5-2026-10-21: 소개 화면은 /search/popular 을 더 이상 읽지 않는다(구별 TOP·경신 목록으로 교체) — 다시 읽게 되면 _popRows 를 거쳐야 한다
  const lr = extractFn(html, '_landingAsyncRefresh');
  assert.ok(!lr.includes('/search/popular`') || lr.includes('_popRows('), '소개 화면'); 
  assert.ok(html.includes('const ps=_popRows(pop);'), '브리핑(티커·TOP5·랭킹 카드 재료)');
  assert.ok(html.includes('const popular = _popRows(j);'), '지도 마커');
  const rc = extractFn(html, 'openRankCard');
  assert.ok(rc.includes('ps=_popRows(t);'), '랭킹 카드 직접 요청');
  assert.ok(rc.includes('if(ps.some(p=>p&&p._degraded)){toast('), '대체 경로 순위로는 "최근 60일 많은 순" 카드를 만들지 않는다');
  // 원시 응답을 직접 쓰던 예전 형태가 남아 있지 않다
  assert.ok(!html.includes('top = (d.results || [])[0];'));
  assert.ok(!html.includes('const ps=(pop&&pop.results)||[];'));
  assert.ok(!html.includes('const popular = j.results || [];'));
  assert.ok(!/ps=\(t&&t\.results\)\|\|\[\]/.test(html));
  // 첫 화면 패널은 자체 처리(빈칸 + 안내) — home-panel.test.js 가 고정
  assert.ok(extractFn(html, '_hpRender').includes('const deg = !!_hpData.degraded;'));
});

test('빈 값일 때 "null건"·"60일" 문구가 나오지 않는다 — 마커 팝업·브리핑 안내·지도 범례 안내', () => {
  assert.ok(!html.includes('최근 60일 거래 <b>${p.dealCount60d}건</b></div>`\n') && !/>최근 60일 거래 <b>\$\{p\.dealCount60d\}건<\/b><\/div>\s*\n\s*<button/.test(html), '조건 없는 팝업 건수 줄이 남아 있다');
  assert.equal((html.match(/\$\{p\.dealCount60d \? `<div style="font-size:12px;color:var\(--text-secondary\);margin-top:4px">최근 60일 거래 <b>\$\{p\.dealCount60d\}건<\/b><\/div>` : ''\}/g) || []).length, 2, '네이버·Leaflet 팝업 둘 다 건수가 있을 때만');
  assert.ok(html.includes("ps.length&&ps[0]._degraded?'지금은 집계가 늦어져 최근 거래 표본으로 골랐어요."), '브리핑 TOP5 안내 문구 분기');
  const i = html.indexOf("const _staleEl = document.getElementById('popStaleNote');");
  const blk = html.slice(i, i + 500);
  assert.ok(blk.includes("_staleEl.style.display = (j.stale || j.degraded) ? '' : 'none';"));
  assert.ok(blk.includes("j.degraded ? '⚠ 집계가 늦어져 최근 거래 표본으로 골랐어요'"));
});

test('서버: 대체 경로 응답에 degraded 표식, 스냅샷은 정상 품질만 저장(서버 렌더 브리핑·도우미는 스냅샷만 읽는다)', () => {
  const search = read('../routes/search.js');
  assert.match(search, /if \(usedFallback\) payload\.degraded = true;/);
  assert.match(search, /if \(!usedFallback && out\.length && limit === 12\) \{\s*\n\s*await storePopularSnapshot\(out\)/);
  const svc = read('../services/popularService.js');
  assert.match(svc, /if \(usedFallback \|\| !results\.length\) \{[\s\S]{0,200}return \{ stored: false/);
  for (const f of ['../services/briefingService.js', '../services/chatDataRouter.js']) {
    const src = read(f);
    assert.ok(src.includes("require('./popularService').readPopularSnapshot("), `${f} 는 스냅샷만 읽는다`);
    assert.ok(!src.includes('buildPopularResults'), `${f} 가 실시간(대체 경로 가능) 집계를 직접 부르면 이 보증이 깨진다`);
  }
});
