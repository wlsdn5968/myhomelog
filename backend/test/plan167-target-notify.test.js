/**
 * backend/test/plan167-target-notify.test.js
 *
 * TARGET-NOTIFY-2026-10-19 (plans/166 3-3 · plans/167): 목표가 서버 알림 + 단지별 알림 끔.
 *   DB 변경 없음 — 알림 구독의 items JSONB 원소에 targetEok(억)·off(true)를 싣고, 매일 1회 push-notify 가 판정한다.
 *   서버 판정 = "신고된 새 거래 중 최저가가 목표가 이하"(앱 배너의 '평균가 전이' 와 다름 — 문구에 명시).
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const m = require('../jobs/pushNotify');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const since = new Date('2026-10-17T00:00:00Z');
const rows = [
  { ingested_at: '2026-10-18T10:00:00Z', apt_name: '은마', umd_nm: '대치동', lawd_cd: '11680', deal_amount: 330000 },
  { ingested_at: '2026-10-18T10:00:00Z', apt_name: '은마', umd_nm: '대치동', lawd_cd: '11680', deal_amount: 298000 },
  { ingested_at: '2026-10-18T10:00:00Z', apt_name: '반포자이', umd_nm: '반포동', lawd_cd: '11650', deal_amount: 500000 },
  { ingested_at: '2026-10-16T10:00:00Z', apt_name: '반포자이', umd_nm: '반포동', lawd_cd: '11650', deal_amount: 100000 }, // since 이전 — 제외
];

test('matchItems: targetEok 이하 최저가가 있으면 hit 이고 맨 앞에 온다 · 목표가 없는 단지는 종전 필드 그대로', () => {
  const items = [
    { aptName: '반포자이', lawdCd: '11650', sigungu: '서초구', umdNm: '반포동' },
    { aptName: '은마', lawdCd: '11680', sigungu: '강남구', umdNm: '대치동', targetEok: 30 },
  ];
  const e = m._matchItems(items, rows, new Map(), since);
  assert.equal(e.length, 2);
  assert.deepEqual(e[0], { name: '은마', count: 2, maxMan: 330000, minMan: 298000, area: '강남구 대치동', targetEok: 30, hit: true });
  assert.deepEqual(e[1], { name: '반포자이', count: 1, maxMan: 500000, minMan: 500000, area: '서초구 반포동' });
  assert.equal(m._buildBody(e), '은마 목표가 30억 이하 거래 신고 · 최저 29.8억 (새 거래 2건) 외 1개 단지');
  assert.equal(m._buildTitle(e, ''), '관심 단지 목표가 이하 거래');
  assert.equal(m._buildTitle(e, '내집로그 '), '내집로그 관심 단지 목표가 이하 거래');
});

test('matchItems: 목표가보다 비싸면 hit 아님(필드는 남되 false) · 정렬은 건수 순으로 돌아간다', () => {
  const items = [
    { aptName: '은마', lawdCd: '11680', sigungu: '강남구', umdNm: '대치동', targetEok: 25 },
    { aptName: '반포자이', lawdCd: '11650', sigungu: '서초구', umdNm: '반포동' },
  ];
  const e = m._matchItems(items, rows, new Map(), since);
  assert.equal(e[0].name, '은마'); assert.equal(e[0].hit, false); assert.equal(e[0].targetEok, 25);
  assert.equal(m._buildBody(e), '은마 새 실거래 2건 · 최고 33억 외 1개 단지');
  assert.equal(m._buildTitle(e, ''), '관심 단지 새 실거래');
});

test('matchItems: off:true 단지는 매칭에서 빠진다(관심 단지는 유지, 알림만 멈춤)', () => {
  const items = [
    { aptName: '은마', lawdCd: '11680', sigungu: '강남구', umdNm: '대치동', off: true, targetEok: 30 },
    { aptName: '반포자이', lawdCd: '11650', sigungu: '서초구', umdNm: '반포동' },
  ];
  const e = m._matchItems(items, rows, new Map(), since);
  assert.deepEqual(e.map((x) => x.name), ['반포자이']);
  assert.deepEqual(m._matchItems([{ aptName: '은마', lawdCd: '11680', off: true }], rows, new Map(), since), []);
});

test('sanitizeItems(push·kakao): targetEok 는 양수만(상한 9999) · off 는 true 만 · 없으면 필드 자체가 없다', () => {
  for (const rel of ['../routes/push.js', '../routes/kakao.js']) {
    const src = read(rel);
    const fn = src.match(/function sanitizeItems\(items\) \{[\s\S]*?\n\}/);
    assert.ok(fn, `${rel}: sanitizeItems 없음`);
    const sanitize = new Function(`const MAX_ITEMS = 30; ${fn[0]}; return sanitizeItems;`)();
    const out = sanitize([
      { aptName: 'a', lawdCd: '11680', targetEok: '12.5', off: true },
      { aptName: 'b', lawdCd: '11680', targetEok: -1, off: 'yes' },
      { aptName: 'c', lawdCd: '11680', targetEok: 1e9 },
    ]);
    assert.deepEqual(out, [
      { aptName: 'a', lawdCd: '11680', sigungu: '', umdNm: '', targetEok: 12.5, off: true },
      { aptName: 'b', lawdCd: '11680', sigungu: '', umdNm: '' },
      { aptName: 'c', lawdCd: '11680', sigungu: '', umdNm: '', targetEok: 9999 },
    ], rel);
  }
});

test('배선: 발송 제목은 buildTitle · 통계 targetHits 는 최상위 숫자 키로 cronStats NUM 에 등록', () => {
  const src = read('../jobs/pushNotify.js');
  assert.match(src, /title: buildTitle\(entries, ''\), body: buildBody\(entries\)/);
  assert.match(src, /title: buildTitle\(entries, '내집로그 '\), description: buildBody\(entries\)/);
  assert.match(src, /subs: push\.rows\.length, sent, removed, failed, targetHits,/);
  assert.match(read('../services/cronStats.js'), /'targetHits',/);
});

test('프런트: 목표가·알림 끔이 서버 스냅샷(_pushItems)에 실리고, 바뀌면 동기화를 예약하며, 관심 단지 행에 알림 토글이 있다', () => {
  const html = read('../../frontend/index.html');
  assert.match(html, /const alerts=getAlerts\(\), offs=getNotifyOff\(\);\r?\n\s*return getBookmarks\(\)\.map\(b=>\{/);
  assert.match(html, /const t=Number\(alerts\[b\.aptName\]\); if\(t>0\) it\.targetEok=t;\r?\n\s*if\(offs\[b\.aptName\]\) it\.off=true;/);
  assert.match(html, /localStorage\.setItem\(ALERT_KEY,JSON\.stringify\(a\)\);\r?\n\s*try\{ _schedulePushItemsSync\(\); \}catch\(_\)\{\}/);
  assert.match(html, /const NOTIFY_OFF_KEY='mhl_notify_off';/);
  assert.match(html, /function toggleNotifyOff\(aptName\)\{[\s\S]*?_schedulePushItemsSync\(\);[\s\S]*?renderBookmarks\(\);\r?\n\}/);
  assert.match(html, /aria-pressed="\$\{_ntOff\?'true':'false'\}"[^\n]*onclick="toggleNotifyOff\(\$\{_aptNameJs\}\)"/);
  // 문구 규칙: 해요체, 매수 권유 없음
  assert.match(html, /'이 단지 알림을 껐어요\. 관심 단지에는 그대로 있어요'/);
});
