/**
 * backend/test/transactions-window.test.js
 *
 * characterization.test.js(Plan 066, 10,056줄·327 test 단일 파일)를 도메인별로 분할한 조각.
 * 동작을 하나도 바꾸지 않는 이동이다 — 테스트 이름·개수·본문은 원본과 동일하다.
 * 공용 목/스텁 유틸은 ./_helpers 에서 가져온다. 새 테스트는 이 파일의 주제와 맞으면 여기에,
 * 아니면 backend/test/README.md 규칙대로 새 도메인 파일을 만든다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _withMockedDate } = require('../testSupport/_helpers');



// ── Sprint OOOOOOO (2026-08-16) — 한도 리셋 경계는 KST 자정 ──────────
//   왜 추가하나: 종전 todayKey/secondsUntilMidnight 는 `new Date()` 의 **로컬** 시각을 썼는데
//   Vercel 서버리스 런타임은 UTC 라(레포 전역 TZ 설정 0건), 한도 리셋이 실제로는 KST 09:00 에
//   일어났다. 프로덕션 실증: POST /api/report(비로그인 한도 0 → 즉시 429) 의 resetIn = 77,582초로
//   같은 순간 UTC 자정까지(77,640s)와 일치, KST 자정까지(45,240s)와는 3만초 어긋남.
//   그런데 프론트는 10곳 넘게 "매일 자정(KST) 리셋"이라 안내한다 → 밤에 소진한 사용자가 자정 넘어
//   재시도하면 여전히 막히고 9시간을 더 기다린다. 코드를 의도(KST)에 맞췄고, 이 테스트로 고정한다.
//   ⚠ 핵심: 서버 타임존이 UTC 든 KST 든 **같은 결과**가 나와야 한다(getUTC* 만 사용).
test('dailyLimit — 하루 경계가 KST 자정이다 (서버 타임존 무관)', () => {
  const { todayKey, secondsUntilMidnight } = require('../middleware/dailyLimit');
  const origNow = Date.now;
  try {
    // UTC 08-16 14:30 = KST 08-16 23:30 → 아직 16일, 자정까지 30분
    Date.now = () => Date.UTC(2026, 7, 16, 14, 30, 0);
    assert.equal(todayKey(), '20260816', 'KST 23:30 인데 날짜 키가 어긋남');
    assert.equal(secondsUntilMidnight(), 1800, 'KST 자정까지 30분이어야 함');

    // UTC 08-16 15:30 = KST 08-17 00:30 → 날짜가 17일로 넘어가야 한다(= 여기서 한도 리셋)
    Date.now = () => Date.UTC(2026, 7, 16, 15, 30, 0);
    assert.equal(todayKey(), '20260817', 'KST 자정을 넘겼는데 날짜 키가 안 바뀜 = 리셋 안 됨');
    assert.equal(secondsUntilMidnight(), 23.5 * 3600, 'KST 00:30 → 다음 자정까지 23.5시간');

    // UTC 자정 직후(= KST 09:00). 종전 버그면 여기서 리셋됐다 — 이제는 날짜가 안 바뀌어야 한다.
    Date.now = () => Date.UTC(2026, 7, 17, 0, 1, 0);
    assert.equal(todayKey(), '20260817', 'UTC 자정에 리셋되는 종전 동작으로 회귀');

    // 하한 가드: KST 자정 1초 전이어도 최소 60초 TTL
    Date.now = () => Date.UTC(2026, 7, 16, 14, 59, 59);
    assert.equal(secondsUntilMidnight(), 60, 'TTL 하한 60초 가드가 사라짐');
  } finally { Date.now = origNow; }
});



test('평↔㎡ 환산 계수가 저장소 전체에서 하나다 (Sprint MMMMMMM-10)', () => {
  // 정확값 1평 = 3.305785㎡. 예전엔 3.3(어림)과 3.3058 이 섞여 있었다.
  // 실측: 20~250㎡ 전 구간 반올림 불일치 7.2%, 다만 대표 평형(59.82·84.92·114.97·134.9·164.9)은 전부 동일.
  const fs = require('node:fs');
  const path = require('node:path');
  const files = ['../routes/report.js', '../services/analysisService.js', '../services/transactionService.js',
                 '../../frontend/index.html'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    // 어림값이 나눗셈에 다시 쓰이면 실패 — 주석·문서의 '3.3' 은 잡지 않도록 나눗셈 형태만 본다
    assert.equal(src.includes('/ 3.3)'), false, `${f} 에 어림 계수 나눗셈이 되돌아왔다`);
    assert.equal(src.includes('/ 3.3;'), false, `${f} 에 어림 계수 나눗셈이 되돌아왔다`);
    assert.equal(src.includes('/3.3)'), false, `${f} 에 어림 계수 나눗셈이 되돌아왔다`);
  }
  // 정확 계수가 실제로 쓰이고 있는지(전부 지워지는 사고 방지)
  const ana = fs.readFileSync(path.join(__dirname, '../services/analysisService.js'), 'utf8');
  assert.ok(ana.includes('_PYEONG_M2 = 3.3058'), '기준 상수가 사라졌다');
  // PYEONG-CONST-2026-09-02: 리터럴 나눗셈(`/ 3.3058`)을 상수(`/ _PYEONG_M2`)로 바꿨다.
  //   이 단언의 의도는 '계수가 실제로 쓰이는가'(전부 지워지는 사고 방지)이므로, 리터럴이 아니라
  //   **상수를 쓰는 나눗셈이 존재하는가**로 확인한다.
  const divs = (ana.match(/\/\s*_PYEONG_M2/g) || []).length;
  assert.ok(divs >= 2, `analysisService 가 정확 계수를 나눗셈에 쓰지 않는다(${divs}회)`);
});



// ── KST-TIME-2026-09-05 (감사 G-8: '하루' 경계는 호스트 TZ 가 아니라 KST) ─────────────────
test('KST 하루 경계 — 호스트 TZ 와 무관하게 KST 자정을 계산한다', () => {
  const { nextKstMidnight, kstDate } = require('../utils/kstTime');
  // 2026-09-05 12:00 KST(=03:00Z) → 다음 KST 자정 = 2026-09-06 00:00 KST = 2026-09-05T15:00Z
  assert.equal(nextKstMidnight(Date.parse('2026-09-05T03:00:00Z')), Date.parse('2026-09-05T15:00:00Z'));
  assert.equal(nextKstMidnight(Date.parse('2026-09-05T14:59:00Z')), Date.parse('2026-09-05T15:00:00Z'));
  // 자정 정각은 그 날의 시작 → 다음 자정은 하루 뒤
  assert.equal(nextKstMidnight(Date.parse('2026-09-05T15:00:00Z')), Date.parse('2026-09-06T15:00:00Z'));
  assert.equal(kstDate(Date.parse('2026-09-05T15:00:00Z')), '2026-09-06');
  assert.equal(kstDate(Date.parse('2026-09-05T14:59:59Z')), '2026-09-05');
});



test('카카오 일일 카운터 — KST 자정 리셋 (호스트 TZ setHours 금지)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../services/geocodeCacheService.js'), 'utf8');
  const code = src.split(/\r?\n/).map(l => l.split('//')[0]).join('\n'); // 주석은 제외 — 주석이 정규식에 잡힌 사고 4회
  assert.equal(/setHours\(24/.test(code), false, '호스트 TZ 자정으로 되돌아갔다 — 프로덕션(UTC)에서는 KST 09시 리셋');
  assert.match(src, /_kakaoCountResetAt = nextKstMidnight\(now\)/);
});



// ── TXWINDOW-KST-2026-09-05 (감사 G-8) ────────────────────────────────────────────
//   [실측] 옛 구현은 두 가지가 틀렸다: setMonth 오버플로(7/31 → 3/1) · 호스트 TZ 의존(KST 로컬 09시 이전 = 전월 말일).
test('txWindowStart — 31일 오버플로와 KST 달 경계 (옛 코드는 둘 다 틀렸다)', () => {
  const { txWindowStart } = require('../utils/txWindow');
  // 7/31 19:00 KST: 6개월 창은 2월부터. 옛 코드는 "2/31" 오버플로로 3/1 을 냈다.
  assert.equal(txWindowStart(6, Date.parse('2026-07-31T10:00:00Z')), '2026-02-01');
  // 8/31 16:00Z = 9/1 01:00 KST → KST 로는 이미 9월 → 4월부터. 옛 코드(UTC 호스트)는 8월로 보고 3/1 을 냈다.
  assert.equal(txWindowStart(6, Date.parse('2026-08-31T16:00:00Z')), '2026-04-01');
  // 8/31 14:00Z = 8/31 23:00 KST → 아직 8월 → 3월부터
  assert.equal(txWindowStart(6, Date.parse('2026-08-31T14:00:00Z')), '2026-03-01');
  assert.equal(txWindowStart(6, Date.parse('2026-09-05T03:00:00Z')), '2026-04-01');
  assert.equal(txWindowStart(24, Date.parse('2026-09-05T03:00:00Z')), '2024-10-01');
  assert.match(txWindowStart(6), /^\d{4}-\d{2}-01$/, '기본 인자(now 생략)도 달 경계를 돌려줘야 한다');
});



// ── PYEONG-SSOT-2026-09-05 (감사 P2-11: 평↔㎡ 계수 사본 통합) ─────────────────────
test('평↔㎡ 계수 — 코드의 리터럴 3.3058 은 utils/pyeong.js 한 곳에만', () => {
  const fs = require('node:fs'), path = require('node:path');
  const root = path.join(__dirname, '..');
  const hits = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      if (f === 'node_modules' || f === 'test') continue;
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (!f.endsWith('.js')) continue;
      fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((line, i) => {
        const code = line.split('//')[0];                 // 줄 주석은 제외 — 주석 속 설명 숫자는 사본이 아니다
        if (/(?<![\w.])3\.3058\b/.test(code)) hits.push(path.relative(root, p).replace(/\\/g, '/') + ':' + (i + 1));
      });
    }
  })(root);
  assert.deepEqual(hits.map(h => h.split(':')[0]), ['utils/pyeong.js'],
    '평형 계수 리터럴이 다른 파일에 생겼다 — 한쪽만 고치면 화면마다 평당가가 갈린다: ' + hits.join(', '));
  const { PYEONG_M2, toPyeong } = require('../utils/pyeong');
  assert.equal(PYEONG_M2, 3.3058);
  assert.equal(toPyeong(84.97).toFixed(2), '25.70');
  assert.equal(toPyeong('abc'), null);
});



test('KST-SSOT-2026-09-06: dailyLimit·briefingService 사본이 SSOT(kstTime) 와 경계에서 같은 값을 낸다', async () => {
  const { todayKey, secondsUntilMidnight } = require('../middleware/dailyLimit');
  const { kstDayString } = require('../services/briefingService');
  const { kstDate, nextKstMidnight } = require('../utils/kstTime');

  // [라벨, UTC ISO, 기대 todayKey, 기대 secondsUntilMidnight, 기대 kstDayString]
  const CASES = [
    ['KST자정 직전(09-06 23:59:59)', '2026-09-06T14:59:59Z', '20260906', 60, '2026-09-06'],
    ['KST자정 직후=날짜변경(09-07 00:00:00)', '2026-09-06T15:00:00Z', '20260907', 86400, '2026-09-07'],
    ['연말경계(KST 2027-01-01 00:00:00)', '2026-12-31T15:00:00Z', '20270101', 86400, '2027-01-01'],
    ['월말경계(KST 10-01 00:00:00)', '2026-09-30T15:00:00Z', '20261001', 86400, '2026-10-01'],
  ];

  for (const [label, iso, expTodayKey, expSecUntilMidnight, expDayString] of CASES) {
    const ts = Date.parse(iso);

    // (1) dailyLimit — 고정 기대값 + SSOT 교차검증
    // _withMockedDate 가 async 로 바뀌었으므로 await 없이 부르면 finally 원복 시점이
    // 다음 반복과 경합할 수 있다 — 반드시 await 한다(⑦ 수정과 짝을 이루는 호출부 수정).
    await _withMockedDate(ts, () => {
      assert.equal(todayKey(), expTodayKey, `${label}: todayKey 고정 기대값 불일치`);
      assert.equal(todayKey(), kstDate(ts).replace(/-/g, ''), `${label}: todayKey 가 SSOT(kstDate) 와 다르다`);
      assert.equal(secondsUntilMidnight(), expSecUntilMidnight, `${label}: secondsUntilMidnight 고정 기대값 불일치`);
      assert.equal(
        secondsUntilMidnight(),
        Math.max(60, Math.floor((nextKstMidnight(ts) - ts) / 1000)),
        `${label}: secondsUntilMidnight 이 SSOT(nextKstMidnight) 와 다르다`
      );

      // (2) briefingService.kstDayString — 무인자 분기(현재 시각 모킹 경유)
      assert.equal(kstDayString(), expDayString, `${label}: kstDayString() 무인자 고정 기대값 불일치`);
      assert.equal(kstDayString(), kstDate(ts), `${label}: kstDayString() 이 SSOT(kstDate) 와 다르다`);
    });

    // (3) briefingService.kstDayString(d) — 인자 있는 분기(Date.now 모킹과 무관하게 항상 성립해야 함)
    assert.equal(kstDayString(iso), expDayString, `${label}: kstDayString(d) 인자 있는 호출 고정 기대값 불일치`);
    assert.equal(kstDayString(iso), kstDate(ts), `${label}: kstDayString(d) 가 SSOT(kstDate) 와 다르다`);
  }

  // 하한 가드: KST 자정 1초 전이어도 최소 60초 TTL (SSOT 치환 후에도 유지돼야 한다)
  await _withMockedDate(Date.parse('2026-09-06T14:59:59Z'), () => {
    assert.equal(secondsUntilMidnight(), 60, 'TTL 하한 60초 가드가 사라짐(Math.max(60, …) 유지 확인)');
  });
});



test('KST-SSOT-2026-09-06: account.js POST /activity 의 kstYear 가 SSOT(kstDate) 와 경계에서 같은 값을 낸다', async () => {
  // ⚠ 프로덕션 코드는 이미 SSOT 로 치환됐다 — 여기선 라우터 스택에서 핸들러만 꺼내
  //   req/res 목으로 호출해 실제 반환 연도를 확인한다(billing 테스트와 같은 패턴).
  const clientPath = require.resolve('../db/client');
  const accountPath = require.resolve('../routes/account');
  // GATE-STUB-CONTAMINATION-2026-09-06 (Plan 060 ⑥): middleware/auditLog.js 가 모듈 스코프에서
  //   `const { requireSupabaseAdmin } = require('../db/client')` 로 구조분해한다 — routes/account
  //   가 auditLog 를 require 하는데, 이 시점에 auditLog 가 아직 require.cache 에 없으면 방금
  //   스텁한 db/client(throw 하는 함수)를 auditLog 의 클로저에 영구히 가둔다. finally 가
  //   db/client·routes/account 두 캐시만 복원해서는 이걸 못 되돌린다(감사자 실측: 이 테스트
  //   뒤에 writeAudit 을 부르는 프로브를 붙이면 "이 테스트에서 사용되지 않아야 한다" 로 fail).
  //   auditLog 도 같은 생애주기로 저장·삭제·복원한다.
  const auditLogPath = require.resolve('../middleware/auditLog');
  const savedClient = require.cache[clientPath];
  const savedAccount = require.cache[accountPath];
  const savedAuditLog = require.cache[auditLogPath];
  try {
    const rpcCalls = [];
    require.cache[clientPath] = {
      id: clientPath, filename: clientPath, loaded: true,
      exports: {
        getUserScopedClient: () => null,
        requireSupabaseAdmin: () => { throw new Error('이 테스트에서 사용되지 않아야 한다'); },
        getSupabaseAdmin: () => ({
          rpc: async (name, params) => { rpcCalls.push({ name, params }); return { error: null }; },
        }),
      },
    };
    delete require.cache[accountPath];
    delete require.cache[auditLogPath]; // account 와 함께 다시 로드되게 강제 — 스텁 창 밖으로 새지 않는다
    const router = require('../routes/account');
    const layer = router.stack.find((l) => l.route && l.route.path === '/activity' && l.route.methods && l.route.methods.post);
    assert.ok(layer, 'account 라우터에서 POST /activity 를 찾지 못했다(경로 변경 시 이 테스트도 갱신할 것)');
    const handle = layer.route.stack[layer.route.stack.length - 1].handle;

    // [라벨, UTC ISO, 기대 연도]
    const CASES = [
      ['KST자정 직전(09-06 23:59:59, 연도 안바뀜)', '2026-09-06T14:59:59Z', 2026],
      ['연말경계(KST 2027-01-01 00:00:00, 연도 바뀜)', '2026-12-31T15:00:00Z', 2027],
    ];
    for (const [label, iso, expYear] of CASES) {
      const ts = Date.parse(iso);
      await _withMockedDate(ts, async () => {
        const req = { user: { id: `plan047-test-${ts}` }, body: { kind: 'search' } };
        let statusCode = 200, body = null;
        const res = { status(c) { statusCode = c; return this; }, json(b) { body = b; return this; } };
        await handle(req, res);
        assert.equal(statusCode, 200, `${label}: 상태코드 200 이 아니다 — ${JSON.stringify(body)}`);
        assert.equal(body && body.persisted, true, `${label}: persisted 가 true 가 아니다 — ${JSON.stringify(body)}`);
        const last = rpcCalls[rpcCalls.length - 1];
        assert.equal(last.name, 'bump_activity_counter', `${label}: rpc 이름이 다르다`);
        assert.equal(last.params.p_year, expYear, `${label}: p_year 고정 기대값 불일치`);
      });
    }
  } finally {
    if (savedClient) require.cache[clientPath] = savedClient; else delete require.cache[clientPath];
    if (savedAccount) require.cache[accountPath] = savedAccount; else delete require.cache[accountPath];
    if (savedAuditLog) require.cache[auditLogPath] = savedAuditLog; else delete require.cache[auditLogPath];
  }
});



// ── Plan 047 (2026-09-06): rentService.monthsWindow — KST 기준으로 고정 ──────────
//   왜 추가하나: 종전엔 getFullYear()/getMonth() 로 **호스트 로컬 TZ** 를 썼다. 프로덕션(Vercel,
//   TZ=UTC)에서 매월 1일 KST 00~09시엔 아직 "전달"로 읽혀 6개월 창이 한 달 밀렸다(이 저장소의
//   로컬(KST) 개발 환경에선 절대 재현되지 않는 종류 — 로컬 host TZ 가 우연히 KST 와 같아서
//   Date 의 로컬 getter 가 이미 KST 를 돌려주기 때문. 실측: 이 회귀는 host TZ 를 실제로 UTC 로
//   바꿔야만(`TZ=UTC node …`) 잡힌다 — Plan 047 실행 로그의 Step 4 검증 참고).
//   입력은 오프셋이 명시된 ISO 문자열(`+09:00`)이라 host TZ 와 무관하게 같은 절대시각을 가리킨다.
test('KST-SSOT-2026-09-06: rentService.monthsWindow — 매월 1일 KST 00~09시 경계에서도 그 달이 창의 첫 원소다', () => {
  const { monthsWindow } = require('../services/rentService');

  // 경계: KST 10-01 03:00 (버그 노출 지점) — 첫 원소는 반드시 '202610'
  const boundary = new Date('2026-10-01T03:00:00+09:00');
  assert.deepEqual(
    monthsWindow(boundary),
    ['202610', '202609', '202608', '202607', '202606', '202605'],
    'KST 10-01 03:00 경계에서 6개월 창이 한 달 밀렸다(host TZ 의존 회귀)'
  );

  // 비경계 참고 케이스: 경계에서 먼 시각은 당연히 안정적이어야 한다
  const midMonth = new Date('2026-09-15T12:00:00+09:00');
  assert.deepEqual(
    monthsWindow(midMonth),
    ['202609', '202608', '202607', '202606', '202605', '202604'],
    'KST 09-15 12:00 비경계 케이스가 달라졌다'
  );
});



// ── Plan 055 (2026-09-06): 거래 창 계산의 남은 쌍둥이 2벌 ──────────────────────────
//   왜 추가하나: utils/txWindow.js 가 SSOT 라고 선언했지만 transactionService.js 안에 두 함정이
//   그대로 남아 있었다(Plan 047 은 rentService.monthsWindow 만 고쳤다).
//   트윈① getTransactionsByApt(:436-441 이었던 곳) — getFullYear()/getMonth() 호스트 로컬 TZ.
//   트윈② getTransactionsByAptSeq(:784-786 이었던 곳) — setMonth 를 setDate(1) 보다 먼저 호출해
//   31일 말일에 오버플로. 두 곳 모두 utils/txWindow 의 SSOT(txWindowMonths·txWindowStart) 로 치환했다.
test('TXWINDOW-TWIN-2026-09-06: txWindowMonths — 매월 1일 KST 00~09시 경계에서도 그 달이 창의 첫 원소다 (트윈① 회귀 고정)', () => {
  const { txWindowMonths } = require('../utils/txWindow');

  // 함정①: 2026-09-30T23:00:00Z = KST 2026-10-01 08:00. 옛 코드(호스트 로컬 getter)는
  //   프로덕션(TZ=UTC) 에서 이 순간에도 UTC 필드가 아직 9월이라 첫 원소로 '202609' 를 냈다.
  assert.deepEqual(
    txWindowMonths(6, Date.parse('2026-09-30T23:00:00Z')),
    ['202610', '202609', '202608', '202607', '202606', '202605'],
    'KST 로 이미 10월인데 UTC 필드로 계산해 9월을 첫 원소로 낸다면 회귀(트윈①)'
  );

  // 같은 함정의 연도 경계 변형: 2026-12-31T15:00:00Z = KST 2027-01-01 00:00.
  assert.equal(
    txWindowMonths(6, Date.parse('2026-12-31T15:00:00Z'))[0],
    '202701',
    'KST 로 이미 새해인데 UTC 필드로 계산해 작년 12월을 첫 원소로 낸다면 회귀(트윈①, 연도 경계)'
  );

  // 비경계 참고 케이스 — 트윈①과 무관, 안 바뀌어야 한다(같은 달력일이 UTC·KST 양쪽에서 8/31).
  assert.equal(
    txWindowMonths(6, Date.parse('2026-08-31T12:00:00Z'))[0],
    '202608',
    '월 경계에서 먼 시각까지 흔들리면 함정과 무관한 케이스가 바뀐 것 — STOP 조건'
  );
});



test('TXWINDOW-TWIN-2026-09-06: txWindowStart(24, …) — 31일 말일에도 오버플로 없이 24개월 창이 나온다 (트윈② 회귀 고정)', () => {
  const { txWindowStart } = require('../utils/txWindow');

  // 함정②: 2026-08-31 로부터 24개월 전은 2024-09 인데, setMonth 를 setDate(1) 보다 먼저 부르면
  //   "9월 31일" 이 없어 10월로 넘친다 — 옛 코드는 '2024-10-01' 을 냈다(한 달 밀림).
  assert.equal(
    txWindowStart(24, Date.parse('2026-08-31T12:00:00Z')),
    '2024-09-01',
    '31일 말일 + 24개월 창이 한 달 밀렸다면 day-overflow 회귀(트윈②)'
  );
});



test('TXWINDOW-TWIN-2026-09-06: txWindowStart — 기존 반환값이 바뀌지 않았다 (SSOT 보호, Plan 055 는 함수를 고치지 않는다)', () => {
  const { txWindowStart } = require('../utils/txWindow');

  // 감사 G-8 계약 테스트(위 TXWINDOW-KST-2026-09-05)와 같은 입력·같은 기대값 — txWindowStart 의
  // 구현 자체는 이 계획에서 건드리지 않았으므로 그대로 성립해야 한다.
  assert.equal(txWindowStart(6, Date.parse('2026-07-31T10:00:00Z')), '2026-02-01');
  assert.equal(txWindowStart(24, Date.parse('2026-09-05T03:00:00Z')), '2024-10-01');
});



test('TXWINDOW-TWIN-2026-09-06: transactionService.js 소스에 창 계산용 호스트 로컬 TZ 게터가 남아 있지 않다', () => {
  const fs = require('fs');
  const path = require('path');
  const raw = fs.readFileSync(path.join(__dirname, '../services/transactionService.js'), 'utf8');
  // 줄 주석 제거 후 검사 — 마커·설명 주석 문자열이 검사를 오검출시킨 전례(6회 재발) 방지.
  // ⚠ 레포가 CRLF 라 줄마다 끝에 '\r' 이 남는다 — '.' 은 '\r' 을 못 건너뛰어 `$` 앵커가 0매치
  // 되는 함정(레포 기존 교훈)이 있으므로 `$` 없이 '//' 부터 줄 끝(비-개행 문자)까지 지운다.
  const src = raw.split('\n').map((l) => l.replace(/\/\/[^\r\n]*/, '')).join('\n');

  assert.doesNotMatch(
    src, /getFullYear\(\)|getMonth\(\)/,
    '호스트 로컬 TZ 게터(getFullYear/getMonth)가 코드에 남아 있다 — 트윈이 되살아났을 수 있다'
  );
  assert.match(src, /const months = txWindowMonths\(monthsBack\)/,
    '트윈①(getTransactionsByApt)이 SSOT(txWindowMonths) 를 쓰지 않는다');
  assert.match(src, /const since = txWindowStart\(monthsBack\)/,
    '트윈②(getTransactionsByAptSeq)가 SSOT(txWindowStart) 를 쓰지 않는다');
});
