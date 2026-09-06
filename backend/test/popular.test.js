/**
 * backend/test/popular.test.js
 *
 * characterization.test.js(Plan 066, 10,056줄·327 test 단일 파일)를 도메인별로 분할한 조각.
 * 동작을 하나도 바꾸지 않는 이동이다 — 테스트 이름·개수·본문은 원본과 동일하다.
 * 공용 목/스텁 유틸은 ./_helpers 에서 가져온다. 새 테스트는 이 파일의 주제와 맞으면 여기에,
 * 아니면 backend/test/README.md 규칙대로 새 도메인 파일을 만든다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');



test('chatDataRouter — 지역 스코프 인기 단지 추출 (KKKKKKK-17, 운영자 "공덕 인기단지 되게")', async () => {
  const { classifyIntent, route } = require('../services/chatDataRouter');
  // 지역 토큰 추출 — 판정은 데이터(sigungu/umd 매칭)가 하고, 여기선 추출만 고정
  assert.deepEqual(classifyIntent('공덕 인기단지'), { intent: 'popular', query: '공덕' });
  assert.deepEqual(classifyIntent('노원구 인기단지'), { intent: 'popular', query: '노원구' });
  assert.deepEqual(classifyIntent('서울 중구 인기단지 알려줘'), { intent: 'popular', query: '서울 중구' });
  assert.deepEqual(classifyIntent('요즘 인기 단지 알려줘'), { intent: 'popular', query: null });
  // env/DB 없이도 안전: 지역 해석 실패 → 정직 폴백 문구 + 전국 안내로 성립
  const { reply } = await route('공덕 인기단지', null);
  assert.equal(typeof reply, 'string');
  assert.ok(reply.length > 20);
});



test('인기 단지 범례·학군 칩이 실제 동작을 숨기지 않는다 (Sprint MMMMMMM-8)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const pop = fs.readFileSync(path.join(__dirname, '../services/popularService.js'), 'utf8');
  const chat = fs.readFileSync(path.join(__dirname, '../services/chatDataRouter.js'), 'utf8');
  const svc = fs.readFileSync(path.join(__dirname, '../services/propertyService.js'), 'utf8');

  // ① 인기 단지 — 세 가지가 범례에 없었다: 21일 게이트 / 캡이 하드캡 아님 / 좌표 없으면 탈락.
  //    전제(설계)가 그대로인지 먼저 고정한다 — 바뀌면 문구도 다시 판단해야 한다.
  assert.ok(pop.includes('21 * 24 * 60 * 60 * 1000'), '21일 게이트가 사라졌다');
  assert.ok(pop.includes('top = capped.concat(overflow)'), '캡 초과분 재투입 구조가 바뀌었다');
  assert.ok(pop.includes('if (c && c.lat && c.lng) out.push'), '좌표 없는 단지 탈락 구조가 바뀌었다');
  // 문구 3곳이 '최대 2곳' 을 단정하지 않는다
  for (const [label, src] of [['프론트', html], ['챗봇', chat]]) {
    assert.equal(src.includes('시군구당 최대 2곳'), false,
      `${label} 문구가 하드캡을 단정한다 — 실제로는 자리가 남으면 초과분도 채운다`);
  }
  assert.ok(html.includes('최근 21일 거래 단지 우선'), '21일 게이트가 안내되지 않는다');
  assert.ok(chat.includes('최근 21일 거래 단지 우선'), '챗봇 안내에 21일 게이트가 없다');
  assert.ok(html.includes('좌표 확인된 단지'), '좌표 없는 단지 탈락이 안내되지 않는다');

  // ② 학군 중요도 칩 — 검색 결과에는 무영향이고 보고서에만 반영된다
  assert.equal(svc.includes('schoolNeeded'), false,
    'propertyService 가 schoolNeeded 를 쓰기 시작했다면 칩 안내를 다시 판단할 것');
  assert.ok(html.includes('(보고서 반영)'), '학군 칩이 반영 범위를 밝히지 않는다 — 죽은 입력으로 보인다');
});



// ── POPULAR-WINDOW-2026-09-05 ─────────────────────────────────────────────────────
test('인기 단지 집계 창 — 스냅샷이면 계산 시점, 라이브면 지금 기준으로 UTC 날짜 60일 창을 만든다', () => {
  const { popularWindow } = require('../services/popularService');
  // 스냅샷 시각 기준 (DB·서버 모두 UTC — RPC 는 deal_date >= CURRENT_DATE - 60)
  assert.deepEqual(popularWindow('2026-09-05T14:54:22.012Z'), { days: 60, since: '2026-07-07', until: '2026-09-05' });
  // UTC 경계: KST 로 계산하면 하루 어긋난다(로컬 09-06 09:00 = UTC 09-06 00:00)
  assert.deepEqual(popularWindow('2026-09-06T00:00:00.000Z'), { days: 60, since: '2026-07-08', until: '2026-09-06' });
  assert.deepEqual(popularWindow('2026-01-01T23:59:59.000Z'), { days: 60, since: '2025-11-02', until: '2026-01-01' });
  // 라이브(인자 없음) = 지금 UTC 날짜
  const now = popularWindow();
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(now.until, today, '라이브 창의 종료일이 오늘(UTC)이 아니다');
  assert.equal(now.days, 60);
  assert.equal(Math.round((new Date(now.until + 'T00:00:00Z') - new Date(now.since + 'T00:00:00Z')) / 86400000), 60, '창 길이가 60일이 아니다');
  // 못 믿을 값은 null (지어내지 않는다)
  assert.equal(popularWindow('nonsense'), null);
});



test('인기 단지 스냅샷 — 계산 시점을 배열에 실어 보내 호출부 4곳의 반환 계약을 깨지 않는다', async () => {
  const dbPath = require.resolve('../db/client');
  const popPath = require.resolve('../services/popularService');
  const saved = { db: require.cache[dbPath], pop: require.cache[popPath] };
  const computedAt = new Date(Date.now() - 3600 * 1000).toISOString();
  const rows = Array.from({ length: 12 }, (_, i) => ({ aptName: 'A' + i, sigungu: '노원구', dealCount60d: 30 - i }));
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
    getSupabaseReadonly: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { payload: rows, computed_at: computedAt }, error: null }) }) }) }) }),
    getSupabaseAdmin: () => null, hasAdminEnv: () => false,
  } };
  try {
    delete require.cache[popPath];
    const { readPopularSnapshot, popularWindow } = require('../services/popularService');
    const got = await readPopularSnapshot(12);
    assert.ok(Array.isArray(got), '배열이 아니다 — 기존 호출부(브리핑·챗·검색)가 깨진다');
    assert.equal(got.length, 12);
    assert.equal(got[0].aptName, 'A0');
    assert.equal(got.computedAt, computedAt, '계산 시점이 실리지 않았다');
    assert.deepEqual(popularWindow(got.computedAt), popularWindow(computedAt));
  } finally {
    if (saved.db) require.cache[dbPath] = saved.db; else delete require.cache[dbPath];
    if (saved.pop) require.cache[popPath] = saved.pop; else delete require.cache[popPath];
  }
});



test('인기 단지 응답·화면 — 집계 기간은 서버가 싣고 화면은 그 값만 쓴다(날짜 하드코딩 금지)', () => {
  const fs2 = require('node:fs');
  const src = fs2.readFileSync(require.resolve('../routes/search'), 'utf8');
  const i = src.indexOf("router.get('/popular'");
  const j = src.indexOf("router.get('/in-bounds'");
  assert.ok(i > 0 && j > i, 'popular 라우트 범위를 찾지 못했다');
  const block = src.slice(i, j);
  // 세 응답 경로(스냅샷·라이브·만료 폴백) 전부에 window 가 실려야 한다 — 하나라도 빠지면 그 경로만 기간이 사라진다
  const payloads = block.match(/res\.json\(\{[^}]*\}/g) || [];
  const jsonReturns = (block.match(/return res\.json\(/g) || []).length;
  assert.ok(jsonReturns >= 4, `popular 응답 경로가 ${jsonReturns}개뿐이다 — 검사 대상이 바뀌었는지 확인`);
  assert.ok((block.match(/window: popularWindow\(/g) || []).length >= 3,
    '집계 기간(window)이 응답 경로 3곳(스냅샷·라이브·만료 폴백)에 실리지 않는다');
  // ⚠ 주입 실측(2026-09-05): 개수만 세면 **기준 시점이 바뀐 것**을 못 잡는다. 스냅샷은 cron 이 만든
  //   시점(최대 36h 전)의 창이어야 하는데 popularWindow() 로 바꾸면 오늘 기준이 되어 하루 어긋난다 —
  //   시안이 07.08 로 잘못 적었던 것과 같은 종류의 오류다.
  assert.match(block, /results: snap, window: popularWindow\(snap\.computedAt\)/,
    '스냅샷 경로가 계산 시점이 아니라 지금 기준으로 창을 만든다(랭킹은 어제 것인데 기간은 오늘)');
  assert.match(block, /results: stale, stale: true, window: popularWindow\(stale\.computedAt\)/,
    '만료 폴백 경로가 계산 시점 기준이 아니다');
  assert.match(block, /results: out, window: popularWindow\(\)/,
    '라이브 집계 경로가 지금 기준이 아니다');
  const html = fs2.readFileSync(require('node:path').join(__dirname, '../../frontend/index.html'), 'utf8');
  const card = html.slice(html.indexOf('id="popTitleCard"'), html.indexOf('id="mapCtrlStack"'));
  assert.match(card, /id="popWindowNote"/, '인기 카드에 집계 기간 자리가 없다');
  assert.doesNotMatch(card, /20\d\d\.\d\d\.\d\d/, '인기 카드에 날짜가 하드코딩됐다 — 매일 바뀌는 값이라 박으면 안 된다');
  const fn = html.slice(html.indexOf('async function loadPopularMarkers'), html.indexOf('async function loadPopularMarkers') + 9000);
  assert.match(fn, /j\.window/, '프론트가 서버의 window 를 읽지 않는다');
  assert.match(fn, /_pwn\.textContent = [\s\S]{0,240}: ''/, '기간이 없을 때 비우지 않는다(옛 값이 남는다)');
});
