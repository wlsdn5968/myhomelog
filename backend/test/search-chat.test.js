/**
 * backend/test/search-chat.test.js
 *
 * characterization.test.js(Plan 066, 10,056줄·327 test 단일 파일)를 도메인별로 분할한 조각.
 * 동작을 하나도 바꾸지 않는 이동이다 — 테스트 이름·개수·본문은 원본과 동일하다.
 * 공용 목/스텁 유틸은 ./_helpers 에서 가져온다. 새 테스트는 이 파일의 주제와 맞으면 여기에,
 * 아니면 backend/test/README.md 규칙대로 새 도메인 파일을 만든다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _NO_PROMO, _adminWithIlikeChainTracker, _mockAptAdmin, _mockRes, _recentDealDate, _requireRouterWithAdmin, _withSearchDbStub, _withSearchDbStubChain } = require('../testSupport/_helpers');



test('chatDataRouter.classifyIntent — 의도 분류 고정 (Sprint KKKKKKK-16, 비용 0 라우터)', () => {
  const { classifyIntent } = require('../services/chatDataRouter');
  const c = (m) => classifyIntent(m);

  // 시세: 단지명 추출 + 끝의 '아파트' 접미사만 제거 (search.js SEARCH-SUFFIX 와 동일 비대칭 해소)
  assert.deepEqual(c('은마 시세'), { intent: 'market', query: '은마' });
  assert.deepEqual(c('은마아파트 시세 알려줘'), { intent: 'market', query: '은마' });
  assert.equal(c('헬리오시티').intent, 'market');            // 단지명 단독 입력
  assert.equal(c('신동아아파트1 실거래').query, '신동아아파트1'); // 이름 중간 '아파트' 훼손 금지
  assert.equal(c('시세 알려줘').query, null);                 // 단지명 없음 → 되묻기 대상

  // 구체 의도가 광범위 의도(시세)보다 우선
  assert.equal(c('오늘 금리 알려줘').intent, 'rates');
  assert.equal(c('동탄 규제 맞아?').intent, 'regulation');
  assert.equal(c('5억이면 대출 얼마까지 돼?').intent, 'loanLimit');
  assert.equal(c('디딤돌 대출 조건').intent, 'policyLoan');   // '대출' 있어도 정책자금 우선
  assert.equal(c('요즘 인기 단지 알려줘').intent, 'popular');
  assert.equal(c('전세가율이 뭐야').intent, 'jeonse');
  assert.equal(c('특약 어떻게 써?').intent, 'clause');
  assert.equal(c('안녕하세요').intent, 'greeting');
  assert.equal(c('사용법 알려줘').intent, 'howto');

  // 분류 불가는 fallback (아는 척 금지 — 환각 차단)
  assert.equal(c('오늘 저녁 뭐 먹지?').intent, 'fallback');
  assert.equal(c('').intent, 'fallback');
});



test('chatDataRouter.route — DB 무관 인텐트는 항상 성립 + 추천 표현 부재 (절대 룰 ①)', async () => {
  const { route } = require('../services/chatDataRouter');
  // env/DB 없이도 성립해야 하는 경로들 (라우터는 데이터 실패를 개별 삼킴)
  for (const msg of ['안녕하세요', '특약 알려줘', '5억 대출 한도', '사용법', '이해 안 가는 질문 xyz?']) {
    const { reply } = await route(msg, null);
    assert.equal(typeof reply, 'string');
    assert.ok(reply.length > 20, `응답이 비었음: ${msg}`);
    // 절대 룰 ①: 매수·매도 추천 단언 표현 금지
    assert.ok(!/사세요|파세요|매수하세요|추천드려요|오를 겁니다|떨어질 겁니다/.test(reply), `금지 표현 감지: ${msg}`);
  }
  // 시세 인텐트 + 단지명 없음 + 컨텍스트 없음 → 되묻기(친절)
  const { reply: ask } = await route('시세 알려줘', null);
  assert.ok(/단지명/.test(ask));
});



test('chatDataRouter — 추천 요청 전용 응답 + 동사어미 문장 단지명 오인 방지 (KKKKKKK-16d)', async () => {
  const { classifyIntent, route } = require('../services/chatDataRouter');
  // 라이브 실채팅에서 발각: "오늘 저녁 메뉴 추천해줘"가 단지명으로 오인됐다
  assert.equal(classifyIntent('오늘 저녁 메뉴 추천해줘').intent, 'recommendAsk');
  assert.equal(classifyIntent('단지 추천해줘').intent, 'recommendAsk');
  assert.equal(classifyIntent('그냥 아무말이나 해볼게요').intent, 'fallback');
  // 어미 검사(끝 위치만)가 실제 단지명을 훼손하지 않아야 함
  assert.equal(classifyIntent('해모로').intent, 'market');
  // 구체 의도(인기)는 '추천'보다 우선
  assert.equal(classifyIntent('인기 단지 추천해줘').intent, 'popular');
  // 추천 응답은 절대 룰 ① 준수 + 대안 제시
  const { reply } = await route('추천해줘', null);
  assert.ok(/추천은 정책상 하지 않아요/.test(reply) && /내 상황/.test(reply));
});



test('chatDataRouter — 지역 시세 요약 확장, env 무관 성립 (KKKKKKK-18)', async () => {
  const { route } = require('../services/chatDataRouter');
  // env/DB 없이: 지역 해석기 null → 기존 단지 경로 안내로 자연 폴백 (throw 없이 성립)
  for (const msg of ['공덕 시세', '노원구 시세', '시세 알려줘']) {
    const { reply } = await route(msg, null);
    assert.equal(typeof reply, 'string');
    assert.ok(reply.length > 20, `빈 응답: ${msg}`);
  }
});



test('chatDataRouter — 모든 인텐트가 후속 질문(suggestions)을 동봉 (KKKKKKK-19)', async () => {
  const { route, classifyIntent } = require('../services/chatDataRouter');
  // 정적 인텐트 전수: suggestions 는 항상 1개 이상, 전부 실제로 라우팅되는 질문(죽은 예시 금지)
  for (const msg of ['안녕하세요', '특약 알려줘', '5억 대출 한도', '사용법', '추천해줘', '전세가율이 뭐야', '모르는말xyz?']) {
    const { reply, suggestions } = await route(msg, null);
    assert.equal(typeof reply, 'string');
    assert.ok(Array.isArray(suggestions) && suggestions.length >= 1, `suggestions 비어있음: ${msg}`);
    assert.ok(suggestions.length <= 3);
    for (const s of suggestions) {
      if (typeof s === 'string') {
        assert.ok(classifyIntent(s).intent !== 'fallback', `죽은 예시(라우팅 불가): "${s}" ← ${msg}`);
      } else {
        // KKKKKKK-20: 이동형 칩 — label + 화이트리스트 view 만 허용
        assert.ok(typeof s.label === 'string' && s.label.length >= 2, `이동 칩 label 불량 ← ${msg}`);
        assert.ok(['report', 'calc', 'clause', 'map', 'list'].includes(s.view), `이동 칩 view 불량: ${s.view} ← ${msg}`);
      }
    }
  }
});



test('chatDataRouter — 관심단지(watch) 인텐트 + 보고서 퍼널 이동 칩 (KKKKKKK-20)', async () => {
  const { classifyIntent, route } = require('../services/chatDataRouter');
  assert.equal(classifyIntent('관심단지 소식 알려줘').intent, 'watch');
  assert.equal(classifyIntent('찜한 단지 어때?').intent, 'watch');
  // 북마크가 없으면 담는 방법 안내(정직) — env/DB 무관 성립
  const { reply: empty } = await route('관심단지 소식', { session: { bookmarks: [] } });
  assert.ok(/담아둔 관심단지가 없어요/.test(empty));
  // 한도 질문 응답에는 보고서 이동 칩이 동봉된다 (퍼널 연결 고정)
  const { suggestions } = await route('5억 대출 한도', null);
  assert.ok(suggestions.some(s => s && typeof s === 'object' && s.view === 'report'), '보고서 이동 칩 부재');
});



// ── MARKET-SAMPLE-2026-08-17 (Sprint MMMMMMM-13) ──────────────────────────────
// [실측 배경] AI 도우미 시세 답변이 이름 부분일치 전체를 `.limit(400)` 최신순으로 긁어 그 안에서
//   그룹핑했다. 6개월 매칭 행수는 "자이" 6,117건(289그룹)·"푸르지오" 7,057건(351그룹) — 400행은 6.5%.
//   그래서 단지 선택도, 그 단지의 "거래 N건 · 단순평균"도 잘린 조각에서 나왔다.
//   ("은마"는 233건이라 상한에 닿은 적이 없다 — 라이브 점검에서 안 보인 이유.)
test('AI 도우미 시세 — 단지 선택과 통계 계산이 분리돼 있다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../services/chatDataRouter.js'), 'utf8');

  // ① 후보 단지는 단지 단위 집계 MV 에서 고른다(거래 테이블 전체 긁기 아님).
  assert.match(src, /molit_apt_index/, '단지 후보를 MV 에서 고르지 않는다 — 절단이 되살아난다');

  // ② 통계는 **고른 단지(들)**로 좁혀 조회한다. in(apt_name, names) 이 없으면 다시 전체를 긁는 것이다.
  //    APT-RESOLVE-2026-09-06(Plan 051): A/B 형제 합산을 위해 eq(단일명) → in(이름 집합)으로 바뀌었다
  //    (풍림아파트A·B 처럼 국토부에 분리 등록된 한 단지를 합쳐 계산하려면 이름 집합 조회가 필수다).
  assert.match(src, /\.in\('apt_name',\s*names\)/,
    '거래 조회가 이름 집합으로 좁혀지지 않는다(A/B 합산이 불가능해진다)');

  // ③ 세 등급 조회는 서로 포함관계라 같은 MV 행이 중복으로 온다 — 행 고유키로 걸러야 한다.
  //    안 걸러내면 deal_count 가 2~3배로 부풀어 순위가 뒤집힌다.
  assert.match(src, /seenRow/, 'MV 행 중복 제거가 없다 — deal_count 가 부풀어 순위가 뒤집힌다');
  assert.match(src, /rowKey\s*=\s*`\$\{r\.apt_name\}\|\$\{r\.lawd_cd\}/,
    '중복 제거 키가 MV 행 고유키(이름|법정동코드|시군구|읍면동|준공년)가 아니다');

  // ④ MV 의 deal_count 는 **전 기간** 누적이다 — 6개월 건수와 같은 줄에 놓으면 사용자가 비교한다.
  //    "다른 단지도 있어요" 목록에 건수를 붙이지 않는 것이 이 커밋의 결정이다.
  const others = src.match(/같은 이름의 다른 단지도 있어요[\s\S]{0,200}/);
  assert.ok(others, '동명 단지 안내 문구를 찾지 못했다');
  assert.equal(/\$\{[^}]*dealCount[^}]*\}건/.test(others[0]), false,
    '동명 단지 목록에 전 기간 deal_count 를 "건" 으로 붙였다 — 위의 6개월 건수와 기준이 다르다');

  // ⑤ 상한에 닿으면 그 사실을 숨기지 않는다(조용한 절단 재발 방지).
  assert.match(src, /txs\.length >= TX_CAP/, '단지 단위 조회의 상한 도달을 표기하지 않는다');
});



test('JIBUN-COL-2026-09-06: 세 매퍼 모두 select 문뿐 아니라 반환 객체 매핑에도 jibun 이 있다', async () => {
  // 계약: transactionService.js 의 세 select 매퍼(getTransactionsFromDb, getRegionRecentTransactions,
  //   getTransactionsByAptSeq)는 select 문과 반환 객체 매핑 **둘 다**에 jibun 을 실어야 한다
  //   (analyzeTransactions 가 단지 지번 최빈값을 계산할 때 매핑된 필드를 읽는다).
  // ⚠ Plan 060 ②: 원래는 `.select('apt_name...` 로 시작하는 줄만 라인 단위로 세서 select 문자열
  //   안에 jibun 이 있는지만 봤다 — `jibun: r.jibun || ''` 매핑 줄만 지워도(select 는 그대로 둔 채)
  //   pass 249 / fail 0 이었다(감사자 실측). 함수 범위로 잘라 select 와 매핑을 둘 다 본다 —
  //   같은 파일의 MULTI-LENS 테스트(characterization.test.js:6136-6142 부근)가 이미 쓰는 방식.
  const fs = require('fs');
  const path = require('path');
  const svcPath = path.join(__dirname, '../services/transactionService.js');
  const src = fs.readFileSync(svcPath, 'utf8');

  const SELECT_JIBUN_RE = /\.select\('[^']*\bjibun\b[^']*'\)/;
  const MAP_JIBUN_RE = /jibun:\s*r\.jibun\s*\|\|\s*''/;

  const checkMapper = (label, startMarker, endMarker) => {
    const start = src.indexOf(startMarker);
    assert.ok(start >= 0, `${label} 함수를 찾지 못했다 — 이름이 바뀌었으면 이 테스트도 갱신할 것`);
    const end = src.indexOf(endMarker, start);
    assert.ok(end > start, `${label} 의 끝 경계('${endMarker}')를 찾지 못했다`);
    const body = src.slice(start, end);
    assert.match(body, SELECT_JIBUN_RE, `${label} 의 select 문에 jibun 이 없다`);
    assert.match(body, MAP_JIBUN_RE,
      `${label} 의 반환 객체 매핑에 jibun 이 없다 — select 에는 있어도 매핑이 없으면 `
      + 'analyzeTransactions 가 지번을 못 읽는다(select 문자열만 보는 검사로는 이 결함을 놓친다)');
  };

  checkMapper('getTransactionsFromDb', 'async function getTransactionsFromDb(', 'async function getRegionRecentTransactions(');
  checkMapper('getRegionRecentTransactions', 'async function getRegionRecentTransactions(', 'async function getTransactions(');
  checkMapper('getTransactionsByAptSeq', 'async function getTransactionsByAptSeq(', 'module.exports = {');
});



// ── Step 4 핵심 경로 ①: apt_master + alias 확정 + A/B 실제 합산 (운영자 재현 사례) ─────────
test('AI 도우미 시세 — apt_master 히트를 alias 로 확정해 A/B 를 실제로 합산한다 (Plan 051 핵심)', async () => {
  const admin = _mockAptAdmin({
    apt_master: [
      { apt_name: '공릉풍림아이원', lawd_cd: '11350', sigungu: '노원구', umd_nm: '공릉동', kapt_code: 'A13980513', molit_aliases: ['풍림아파트A', '풍림아파트B'] },
    ],
    molit_apt_index: [
      // 정식명("공릉풍림아이원")으로는 국토부에 단 한 건도 없다 — 이게 이 결함의 본질.
      { apt_name: '풍림아파트A', lawd_cd: '11350', sigungu: '노원구', umd_nm: '공릉동', build_year: 2001, deal_count: 90 },
      { apt_name: '풍림아파트B', lawd_cd: '11350', sigungu: '노원구', umd_nm: '공릉동', build_year: 2001, deal_count: 21 },
      { apt_name: '공릉두산', lawd_cd: '11350', sigungu: '노원구', umd_nm: '공릉동', build_year: 1999, deal_count: 15 },
    ],
    molit_transactions: [
      { apt_name: '풍림아파트A', sigungu: '노원구', umd_nm: '공릉동', deal_amount: 60000, deal_date: '2026-08-20', exclu_use_ar: 59.9 },
      { apt_name: '풍림아파트A', sigungu: '노원구', umd_nm: '공릉동', deal_amount: 58000, deal_date: '2026-07-10', exclu_use_ar: 59.9 },
      { apt_name: '풍림아파트B', sigungu: '노원구', umd_nm: '공릉동', deal_amount: 57000, deal_date: '2026-06-15', exclu_use_ar: 59.9 },
    ],
  });
  const { router, restore } = _requireRouterWithAdmin(admin);
  try {
    const { reply } = await router.route('공릉 풍림아이원 시세', null);
    assert.match(reply, /공릉풍림아이원/, '정식명(apt_master)으로 응답하지 않는다');
    assert.match(reply, /거래 3건/, 'A(2건)+B(1건) 합산 건수가 아니다');
    assert.match(reply, /풍림아파트A·풍림아파트B/, '합쳐진 원본명이 밝혀지지 않는다');
    assert.match(reply, /합쳐서 계산했어요/);
    assert.equal(/찾지 못했어요/.test(reply), false, 'apt_master 히트가 있는데 못 찾았다고 답한다');
    assert.equal(_NO_PROMO.test(reply), false);
  } finally { restore(); }
});



// ── Step 4 핵심 경로 ②: apt_master 를 거치지 않는 직접 히트에서도 형제 병합이 적용된다 ──────
test('AI 도우미 시세 — apt_master 없이도 직접 히트 경로에서 A/B 형제를 병합한다 (Plan 051 Step 4)', async () => {
  const admin = _mockAptAdmin({
    molit_apt_index: [
      { apt_name: '상목에버빌A', lawd_cd: '11620', sigungu: '관악구', umd_nm: '신림동', build_year: 2004, deal_count: 50 },
      { apt_name: '상목에버빌B', lawd_cd: '11620', sigungu: '관악구', umd_nm: '신림동', build_year: 2004, deal_count: 30 },
    ],
    molit_transactions: [
      { apt_name: '상목에버빌A', sigungu: '관악구', umd_nm: '신림동', deal_amount: 70000, deal_date: '2026-08-10', exclu_use_ar: 59.9 },
      { apt_name: '상목에버빌B', sigungu: '관악구', umd_nm: '신림동', deal_amount: 68000, deal_date: '2026-07-05', exclu_use_ar: 59.9 },
    ],
  });
  const { router, restore } = _requireRouterWithAdmin(admin);
  try {
    const { reply } = await router.route('상목에버빌A', null);   // 단독 입력 — market 인텐트로 폴백
    assert.match(reply, /상목에버빌\(A·B 합산\)/, 'apt_master 정식명이 없을 때 stem+합산 표기가 아니다');
    assert.match(reply, /거래 2건/);
    assert.match(reply, /상목에버빌A·상목에버빌B/);
    assert.equal(_NO_PROMO.test(reply), false);
  } finally { restore(); }
});



// ── Step 5: apt_master 후보가 2곳 이상이면 되묻는다(동명 단지 등) ─────────────────────
test('AI 도우미 시세 — apt_master 후보가 여럿이면 바로 답하지 않고 되묻는다 (Plan 051 Step 5)', async () => {
  const admin = _mockAptAdmin({
    apt_master: [
      { apt_name: '테스트단지1차', lawd_cd: '11110', sigungu: '종로구', umd_nm: 'A동', kapt_code: 'K1', molit_aliases: [] },
      { apt_name: '테스트단지2차', lawd_cd: '11140', sigungu: '중구', umd_nm: 'B동', kapt_code: 'K2', molit_aliases: [] },
    ],
    molit_apt_index: [],
    molit_transactions: [],
  });
  const { router, restore } = _requireRouterWithAdmin(admin);
  try {
    const { reply, suggestions } = await router.route('테스트단지', null);
    assert.match(reply, /테스트단지1차/);
    assert.match(reply, /테스트단지2차/);
    assert.equal(/찾지 못했어요/.test(reply), false);
    assert.ok(suggestions.length >= 1 && suggestions.length <= 3);
    assert.equal(_NO_PROMO.test(reply), false);
  } finally { restore(); }
});



test('Plan 052 ①: 공백 없는 질의는 추가 조회가 붙지 않는다(_qNo === qApt → 왕복 3 유지)', async () => {
  await _withSearchDbStub([], async (handler, seen) => {
    const res = _mockRes();
    // "아파트"로 끝나지 않고 공백도 없는 질의 — _qStrip === q === qApt, normalizeName 도 동일해야 한다.
    await handler({ query: { q: 'PLAN052무공백단지', limit: 10 } }, res, () => {});
    assert.equal(res.statusCode, 200);
    assert.equal(seen.calls.length, 3,
      `공백 없는 질의인데 DB 조회가 3개가 아니다(${seen.calls.length}개) — ` +
      `공백 제거 변형이 조건 없이 추가됐을 수 있다: ${JSON.stringify(seen.calls)}`);
    const shapes = seen.calls.map((c) => `${c.table}.${c.col}`).sort();
    assert.deepEqual(shapes, ['apt_master.apt_name', 'apt_master.umd_nm', 'molit_apt_index.apt_name'].sort(),
      `기존 3개 조회의 모양이 바뀌었다: ${JSON.stringify(shapes)}`);
  });
});



test('Plan 052 ②: 공백 든 질의는 조건부로 조회 2개가 추가되고, 공백 제거로만 찾히는 단지가 결과에 반영된다', async () => {
  const { normalizeName } = require('../utils/aptNameMatch');
  const q = 'PLAN052 공백질의확인';       // "아파트"로 끝나지 않음 → qApt === q (공백 포함)
  const qApt = q;
  const qNo = normalizeName(qApt);       // 공백 제거 변형
  assert.notEqual(qNo, qApt, '테스트 전제가 깨졌다 — qNo 가 qApt 와 같다(공백이 없어졌다)');

  const fixtureRow = {
    apt_name: 'PLAN052공백질의확인', sigungu: '노원구', umd_nm: '공릉동', lawd_cd: '11350',
    build_year: 2000, recent_deal_date: '2026-01-01', deal_count: 2, apt_seq: 'PLAN052-SEQ',
  };
  const routes = [
    // 원본(공백 포함) 패턴은 0건 — "공릉 풍림아이원"이 재현하는 바로 그 상황.
    { table: 'molit_apt_index', col: 'apt_name', pattern: `%${qApt}%`, result: { data: [], error: null } },
    // 공백 제거 패턴으로만 실제 단지가 잡힌다.
    { table: 'molit_apt_index', col: 'apt_name', pattern: `%${qNo}%`, result: { data: [fixtureRow], error: null } },
  ];

  await _withSearchDbStub(routes, async (handler, seen) => {
    const res = _mockRes();
    await handler({ query: { q, limit: 10 } }, res, () => {});
    assert.equal(res.statusCode, 200);

    assert.equal(seen.calls.length, 5,
      `공백 든 질의인데 DB 조회가 5개가 아니다(${seen.calls.length}개): ${JSON.stringify(seen.calls)}`);
    const molitAptCalls = seen.calls.filter((c) => c.table === 'molit_apt_index' && c.col === 'apt_name');
    assert.equal(molitAptCalls.length, 2,
      'molit_apt_index.apt_name 조회가 조건부로 추가되지 않았다(원본 + 공백제거 변형 2개여야 한다)');
    assert.ok(molitAptCalls.some((c) => c.pattern === `%${qNo}%`),
      '공백 제거 패턴(%qNo%)으로 molit_apt_index 를 조회하지 않았다');
    const masterAptCalls = seen.calls.filter((c) => c.table === 'apt_master' && c.col === 'apt_name');
    assert.equal(masterAptCalls.length, 2, 'apt_master.apt_name 조회도 조건부로 2개(원본+공백제거)여야 한다');

    // Step 3: 공백 제거 변형으로만 찾힌 단지가 기존 그룹핑(aptMap mergeKey)을 그대로 통과해
    //   결과에 실제로 나타나는지 — 여기서 흡수/전달이 끊기면 조회만 추가되고 사용자는 여전히 0건을 본다.
    assert.equal(res.body.results.length, 1,
      `공백 제거 변형으로만 찾힌 단지가 결과에 반영되지 않았다: ${JSON.stringify(res.body.results)}`);
    assert.equal(res.body.results[0].sigungu, '노원구');
    assert.equal(res.body.results[0].dealCount, 2);
    assert.equal(res.body.degraded, undefined, '정상 조회인데 degraded 가 표시됐다');
  });
});



test('Plan 052 ③: 공백 제거 변형 조회가 실패해도 500 이 아니라 기존 결과로 200 응답한다(_softQuery)', async () => {
  const { normalizeName } = require('../utils/aptNameMatch');
  const q = 'PLAN052 실패주입질의';
  const qApt = q;
  const qNo = normalizeName(qApt);
  assert.notEqual(qNo, qApt, '테스트 전제가 깨졌다 — qNo 가 qApt 와 같다');

  const okRow = {
    apt_name: 'PLAN052 실패주입질의', sigungu: '강남구', umd_nm: '역삼동', lawd_cd: '11680',
    build_year: 1999, recent_deal_date: '2026-02-01', deal_count: 1, apt_seq: 'PLAN052-OK',
  };
  const routes = [
    // 기존(공백 포함) 조회는 정상 — 이 결과가 살아남아야 "500 이 아니라 기존 결과로 응답"이 성립한다.
    { table: 'molit_apt_index', col: 'apt_name', pattern: `%${qApt}%`, result: { data: [okRow], error: null } },
    // 공백 제거 변형 조회만 실패로 주입.
    { table: 'molit_apt_index', col: 'apt_name', pattern: `%${qNo}%`, reject: true, error: new Error('PLAN052 주입 실패') },
    { table: 'apt_master', col: 'apt_name', pattern: `%${qNo}%`, reject: true, error: new Error('PLAN052 주입 실패') },
  ];

  await _withSearchDbStub(routes, async (handler) => {
    const res = _mockRes();
    await handler({ query: { q, limit: 10 } }, res, () => {});
    assert.equal(res.statusCode, 200,
      '공백 제거 변형 조회의 실패가 500 으로 번졌다 — _softQuery 로 감싸지 않았을 수 있다');
    assert.equal(res.body.degraded, undefined,
      '공백 제거 변형(추가 조회)의 실패가 degraded 로 잡혔다 — 기존 3개 조회만으로 판정해야 한다(범위 밖)');
    assert.ok(res.body.results.some((r) => r.sigungu === '강남구'),
      '추가 조회 실패로 기존(qApt) 조회 결과까지 사라졌다');
  });
});



test('Plan 052 ④: 공백 제거 변형 조회 2개가 모두 _softQuery 로 감싸여 있다(소스 계약)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const raw = fs.readFileSync(path.join(__dirname, '../routes/search.js'), 'utf8');
  // 줄 주석 제거 후 검사 — 마커·설명 주석 문자열이 검사를 오검출시킨 전례(6회 재발) 방지.
  const src = raw.split('\n').map((l) => l.replace(/\/\/[^\r\n]*/, '')).join('\n');
  const startIdx = src.indexOf('const [molitRes, masterNameRes, masterUmdRes, molitNoSpaceRes, masterNoSpaceRes]');
  assert.ok(startIdx >= 0, 'Promise.all 5개 구조분해를 찾지 못했다 — 공백 제거 변형 조회 구조가 바뀌었다');
  const block = src.slice(startIdx, src.indexOf(']);', startIdx));
  const wrapped = block.match(/_needsNoSpace[\s\S]{0,20}?\?[\s\S]{0,20}?_softQuery\(/g) || [];
  assert.equal(wrapped.length, 2,
    `_needsNoSpace 조건부 _softQuery 래핑이 2개가 아니다(${wrapped.length}개) — ` +
    `공백 제거 변형 조회(molit·master) 중 하나가 _softQuery 없이 직결됐을 수 있다`);
});



test('Plan 052 ⑤: 검색 자동완성 캐시 키에 버전 성분이 있다(엣지 캐시 실사고 방지)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const raw = fs.readFileSync(path.join(__dirname, '../routes/search.js'), 'utf8');
  const src = raw.split('\n').map((l) => l.replace(/\/\/[^\r\n]*/, '')).join('\n');
  assert.match(src, /const sck = `searchapt:v\d+:/,
    '검색 캐시 키에 버전 성분(searchapt:vN:)이 없다 — 응답 모양이 바뀌었는데 캐시 키가 그대로면 ' +
    '배포 전 캐시된 옛 응답이 서버 10분 + CDN s-maxage=600(+SWR 3600) 만큼 계속 나간다');
});



test('splitRegionName — 지역·이름 분할 순수 함수 (Plan 057 Step 1 신설 → Plan 059 Step 2 에서 기대값 갱신)', () => {
  const { splitRegionName } = require('../utils/aptNameMatch');
  assert.deepEqual(splitRegionName('은마'), [], '토큰이 1개면 나눌 지역이 없다');
  assert.deepEqual(splitRegionName('대치 은마'), [{ region: '대치', name: '은마' }], '2토큰 결과는 057 과 완전히 같다(하위호환)');
  // REGION-TOKEN-SINGLE-2026-09-06 (Plan 059 Step 2): 아래 두 기대값은 057 시점(접두 전체를
  //   region 으로 삼음: {region:'서울 강남', name:'은마'} / {region:'서울', name:'강남 은마'})
  //   에서 바뀌었다. [왜] DB 의 umd_nm·sigungu 는 항상 공백 없는 단일 토큰("대치동","강남구")
  //   인데 접두 전체는 공백을 포함해('서울 강남') ilike 매칭이 원리적으로 0건이고, 남은 후보
  //   '서울' 도 sigungu 실제값('강남구')과 불일치해 역시 0건이었다(계획서 059 "결함 ②",
  //   057 실행자가 스스로 보고한 불확실성) — 즉 3토큰 질의는 재시도 2라운드가 둘 다 헛돌아
  //   실패했다. region 을 분할점 바로 앞 단일 토큰(tokens[i-1])으로 바꾸면 {region:'강남',
  //   name:'은마'} 후보가 생겨 매칭된다.
  const three = splitRegionName('서울 강남 은마');
  assert.equal(three.length, 2, '분할점 2곳 모두 2자 이상 조건을 만족한다');
  assert.deepEqual(three[0], { region: '강남', name: '은마' }, 'name 이 짧은(지역을 더 뗀) 후보가 먼저 와야 한다 — 단일 토큰 region 이라 실제 DB 에 매칭된다');
  assert.deepEqual(three[1], { region: '서울', name: '강남 은마' });
  // 가드: 2자 미만 조각은 버린다.
  assert.deepEqual(splitRegionName('a 은마'), [], 'region 1자는 버려야 한다');
  assert.deepEqual(splitRegionName('대치 a'), [], 'name 1자는 버려야 한다');
});



test('AI 도우미 시세 — "대치 은마 시세"가 지역 분리 재시도로 은마 실거래를 준다 (Plan 057 핵심, 운영자 재현)', async () => {
  const { admin, tracker } = _adminWithIlikeChainTracker({
    molit_apt_index: [
      { apt_name: '은마', lawd_cd: '11680', sigungu: '강남구', umd_nm: '대치동', build_year: 1979, deal_count: 233 },
      // NAME-RANK-2026-08-12 사고 재현용 잡음 — 지역으로 좁히지 않으면 "은마" 부분일치로
      // 이 반송동 단지도 걸린다(이 저장소가 실제로 겪은 사고).
      { apt_name: '동탄시범다은마을센트럴파크뷰', lawd_cd: '41590', sigungu: '화성시', umd_nm: '반송동', build_year: 2015, deal_count: 500 },
    ],
    apt_master: [],
    molit_transactions: [
      { apt_name: '은마', sigungu: '강남구', umd_nm: '대치동', deal_amount: 250000, deal_date: _recentDealDate(10), exclu_use_ar: 84.4 },
    ],
  });
  const { router, restore } = _requireRouterWithAdmin(admin);
  try {
    const { reply, suggestions } = await router.route('대치 은마 시세', null);
    assert.match(reply, /은마/);
    assert.match(reply, /거래 1건/);
    assert.equal(/찾지 못했어요/.test(reply), false, 'Plan 057 이전엔 이 문구가 나왔다 — 재현이 안 되면 STOP 대상');
    assert.equal(/동탄시범다은마을/.test(reply), false, '지역으로 좁히지 않고 전국 부분일치로 갔다면 반송동 잡음이 섞였을 것');
    assert.equal(tracker.doubleIlikeChains, 3, '지역 분리 재시도는 1라운드(3조회)에서 성공해 멈춰야 한다 — 왕복 상한 위반(2라운드까지 돌았다)');
    assert.equal(_NO_PROMO.test(reply), false);
    assert.ok(Array.isArray(suggestions));
  } finally { restore(); }
});



test('AI 도우미 시세 — 직접 히트가 있으면 지역 분리 재시도(이중 ilike 체인)가 전혀 일어나지 않는다 (Plan 057 Step 2, 성공 경로 왕복 불변)', async () => {
  // 케이스 ①: 단일 토큰("은마") — splitRegionName 이 애초에 후보를 안 낸다(토큰 1개).
  //   이 케이스만으로는 "성공했으니 재시도 게이트를 건너뛰었다"와 "애초에 나눌 후보가
  //   없어 안 돌았다"를 구분 못한다 — 아래 케이스 ②가 그 구분을 한다.
  {
    const { admin, tracker } = _adminWithIlikeChainTracker({
      molit_apt_index: [
        { apt_name: '은마', lawd_cd: '11680', sigungu: '강남구', umd_nm: '대치동', build_year: 1979, deal_count: 233 },
      ],
      molit_transactions: [
        { apt_name: '은마', sigungu: '강남구', umd_nm: '대치동', deal_amount: 250000, deal_date: _recentDealDate(10), exclu_use_ar: 84.4 },
      ],
    });
    const { router, restore } = _requireRouterWithAdmin(admin);
    try {
      const { reply } = await router.route('은마 시세', null);
      assert.match(reply, /은마/);
      assert.equal(/찾지 못했어요/.test(reply), false);
      assert.equal(tracker.doubleIlikeChains, 0,
        '직접 히트가 있는데 지역 분리 재시도 조회(이중 ilike 체인)가 실행됐다 — 성공 경로의 조회 수가 늘었다');
    } finally { restore(); }
  }

  // 케이스 ②: 다중 토큰("공릉 풍림아이원", Plan 051 사례)인데도 apt_master 직접 히트로
  //   이미 확정된다 — splitRegionName('공릉 풍림아이원')은 후보를 **낸다**(region:'공릉',
  //   name:'풍림아이원'). 그런데도 amCandidates 가 이미 1개라 재시도는 돌면 안 된다.
  //   게이트를 `if (true)`로 무조건 실행하게 망가뜨리면 이 케이스에서만 체인이 잡힌다
  //   (케이스 ①은 애초에 후보가 없어 게이트가 깨져도 감지가 안 된다 — 그래서 이 케이스가 필요).
  {
    const { admin, tracker } = _adminWithIlikeChainTracker({
      apt_master: [
        { apt_name: '공릉풍림아이원', lawd_cd: '11350', sigungu: '노원구', umd_nm: '공릉동', kapt_code: 'A13980513', molit_aliases: ['풍림아파트A', '풍림아파트B'] },
      ],
      molit_apt_index: [
        { apt_name: '풍림아파트A', lawd_cd: '11350', sigungu: '노원구', umd_nm: '공릉동', build_year: 2001, deal_count: 90 },
        { apt_name: '풍림아파트B', lawd_cd: '11350', sigungu: '노원구', umd_nm: '공릉동', build_year: 2001, deal_count: 21 },
      ],
      molit_transactions: [
        { apt_name: '풍림아파트A', sigungu: '노원구', umd_nm: '공릉동', deal_amount: 60000, deal_date: _recentDealDate(10), exclu_use_ar: 59.9 },
        { apt_name: '풍림아파트B', sigungu: '노원구', umd_nm: '공릉동', deal_amount: 57000, deal_date: _recentDealDate(20), exclu_use_ar: 59.9 },
      ],
    });
    const { router, restore } = _requireRouterWithAdmin(admin);
    try {
      const { reply } = await router.route('공릉 풍림아이원 시세', null);
      assert.match(reply, /공릉풍림아이원/, 'apt_master 직접 히트(alias 확정)로 답해야 한다 — Plan 051 동작 불변');
      assert.equal(/찾지 못했어요/.test(reply), false);
      assert.equal(tracker.doubleIlikeChains, 0,
        'apt_master 로 이미 확정됐는데(splitRegionName 은 후보를 내는 질의인데도) 지역 분리 재시도가 실행됐다 — 왕복 계약 위반');
    } finally { restore(); }
  }
});



test('AI 도우미 시세 — 지역으로 좁혀도 후보가 2곳 이상이면 바로 답하지 않고 되묻는다 (Plan 057 Step 3, 운영자 요구)', async () => {
  const { admin, tracker } = _adminWithIlikeChainTracker({
    molit_apt_index: [
      { apt_name: '스카이타워', lawd_cd: '11410', sigungu: '서대문구', umd_nm: '신촌동', build_year: 2010, deal_count: 10 },
      { apt_name: '스카이빌', lawd_cd: '11410', sigungu: '서대문구', umd_nm: '신촌동', build_year: 2011, deal_count: 5 },
    ],
    apt_master: [],
    molit_transactions: [],
  });
  const { router, restore } = _requireRouterWithAdmin(admin);
  try {
    const { reply, suggestions } = await router.route('신촌 스카이 시세', null);
    assert.match(reply, /스카이타워/);
    assert.match(reply, /스카이빌/);
    assert.match(reply, /혹시 이 중에 있나요/, '051 이 이미 쓰는 되묻기 문구 형식이 아니다');
    assert.equal(/찾지 못했어요/.test(reply), false);
    assert.ok(suggestions.length >= 1 && suggestions.length <= 3);
    assert.ok(suggestions.every(s => /시세$/.test(s)));
    assert.equal(tracker.doubleIlikeChains, 3, '되묻기 전까지 1라운드만 돌아야 한다');
    assert.equal(_NO_PROMO.test(reply), false);
  } finally { restore(); }
});



test('AI 도우미 시세 — 지역 분리 재시도 응답 어디에도 매수 권유·가격 예측 표현이 없다 (절대 룰 ①, Plan 057)', async () => {
  const cases = [
    {
      query: '대치 은마 시세',
      tables: {
        molit_apt_index: [{ apt_name: '은마', lawd_cd: '11680', sigungu: '강남구', umd_nm: '대치동', build_year: 1979, deal_count: 233 }],
        apt_master: [],
        molit_transactions: [{ apt_name: '은마', sigungu: '강남구', umd_nm: '대치동', deal_amount: 250000, deal_date: _recentDealDate(5), exclu_use_ar: 84.4 }],
      },
    },
    {
      query: '신촌 스카이 시세',
      tables: {
        molit_apt_index: [
          { apt_name: '스카이타워', lawd_cd: '11410', sigungu: '서대문구', umd_nm: '신촌동', build_year: 2010, deal_count: 10 },
          { apt_name: '스카이빌', lawd_cd: '11410', sigungu: '서대문구', umd_nm: '신촌동', build_year: 2011, deal_count: 5 },
        ],
        apt_master: [],
        molit_transactions: [],
      },
    },
  ];
  for (const c of cases) {
    const { admin } = _adminWithIlikeChainTracker(c.tables);
    const { router, restore } = _requireRouterWithAdmin(admin);
    try {
      const { reply } = await router.route(c.query, null);
      assert.equal(_NO_PROMO.test(reply), false, `"${c.query}" 응답에 매수·매도 권유/예측 표현이 있다: ${reply}`);
    } finally { restore(); }
  }
});



test('AI 도우미 시세 — 지역 분리 재시도의 등급 판정은 name 기준이다(원 질의 기준이면 순위가 뒤집힌다) (Plan 057 Step 2)', async () => {
  // '은마'(name 과 완전일치 → tier3)와 '은마상가'(name 으로 시작 → tier2, 그러나 dealCount 는
  // 훨씬 크다)를 함께 둔다. _tier 를 원 질의(_nq='대치은마') 기준으로 매기면 둘 다 매칭에
  // 실패해 tier1 로 동률이 되고, 그러면 dealCount 순으로 뒤집혀 '은마상가'가 앞에 온다 —
  // name 기준이 아니면 못 잡는 회귀(계획서 Step 5 주입 ③이 실제로 이 순서를 뒤집었다).
  const { admin } = _adminWithIlikeChainTracker({
    molit_apt_index: [
      { apt_name: '은마', lawd_cd: '11680', sigungu: '강남구', umd_nm: '대치동', build_year: 1979, deal_count: 50 },
      { apt_name: '은마상가', lawd_cd: '11680', sigungu: '강남구', umd_nm: '대치동', build_year: 2000, deal_count: 900 },
    ],
    apt_master: [],
    molit_transactions: [],
  });
  const { router, restore } = _requireRouterWithAdmin(admin);
  try {
    const { reply, suggestions } = await router.route('대치 은마 시세', null);
    // 후보가 2곳이라 Step 3 되묻기로 가는데, 그 나열 순서 자체가 등급 판정의 산출물이다.
    assert.match(reply, /혹시 이 중에 있나요/);
    const iEunma = reply.indexOf('은마(');
    const iEunmaSanga = reply.indexOf('은마상가');
    assert.ok(iEunma >= 0 && iEunmaSanga >= 0, '두 후보 모두 나열돼야 한다');
    assert.ok(iEunma < iEunmaSanga,
      `등급이 name("은마") 기준이 아니라 원 질의 기준으로 매겨져 순서가 뒤집혔다: ${reply}`);
    assert.equal(suggestions[0], '은마 시세', 'name 완전일치(tier3)가 1순위 제안이어야 한다');
  } finally { restore(); }
});



test('splitRegionName — Step 2 값 고정 (Plan 059, 계획서 검증 절 3케이스 그대로)', () => {
  const { splitRegionName } = require('../utils/aptNameMatch');
  // 계획서 059 Step 2 "검증" 절에 나열된 값 그대로 — 실행자가 실제로 찍어 보고에 남긴 값이기도 하다.
  assert.deepEqual(splitRegionName('은마'), []);
  assert.deepEqual(splitRegionName('대치 은마'), [{ region: '대치', name: '은마' }]);
  assert.deepEqual(splitRegionName('서울 강남 은마'),
    [{ region: '강남', name: '은마' }, { region: '서울', name: '강남 은마' }],
    '1순위가 {region:"강남", name:"은마"} 여야 한다 — 계획서 059 완료 기준 항목');
});



test('splitRegionName — 2토큰 질의 결과가 Plan 057 시점과 완전히 같다 (Plan 059, 하위호환 회귀 고정)', () => {
  const { splitRegionName } = require('../utils/aptNameMatch');
  // region 계산을 tokens.slice(0,i).join(' ') → tokens[i-1] 로 바꿨지만, i=1 일 때는
  // 두 식이 항상 같은 값(토큰 1개)이라 2토큰 질의는 원리적으로 영향받지 않는다 — 그 사실을
  // "대치 은마"(057 핵심 재현 질의) 뿐 아니라 "공릉 풍림아이원"(051 핵심 재현 질의, 위 8154행
  // normalizeName 테스트와 같은 문자열)으로도 고정해 둘 다 깨지지 않았음을 확인한다.
  assert.deepEqual(splitRegionName('대치 은마'), [{ region: '대치', name: '은마' }]);
  assert.deepEqual(splitRegionName('공릉 풍림아이원'), [{ region: '공릉', name: '풍림아이원' }]);
});



test('AI 도우미 시세 — 지역 분리 재시도에서 진짜로 다른 두 단지는 여전히 되묻고, 목록에 중복이 없다 (Plan 059, 대조군 — 과잉 병합 방지)', async () => {
  const { admin, tracker } = _adminWithIlikeChainTracker({
    molit_apt_index: [
      { apt_name: '은마', lawd_cd: '11680', sigungu: '강남구', umd_nm: '대치동', build_year: 1979, deal_count: 51 },
    ],
    // apt_master 의 '은마타운'은 apt_name ILIKE '%은마%' 에 걸리지만(정규화해도 '은마'와
    // 다른 이름) 실제로는 다른 단지다 — dedup 키가 이름까지 구분하는지 확인하는 대조군.
    apt_master: [
      { apt_name: '은마타운', lawd_cd: '11680', sigungu: '강남구', umd_nm: '대치동', kapt_code: 'A00000099', molit_aliases: null },
    ],
    molit_transactions: [],
  });
  const { router, restore } = _requireRouterWithAdmin(admin);
  try {
    const { reply, suggestions } = await router.route('대치 은마 시세', null);
    assert.match(reply, /혹시 이 중에 있나요/, '진짜 서로 다른 두 단지는 여전히 되물어야 한다 — dedup 이 과잉 병합하면 안 된다');
    const firstIdx = reply.indexOf('은마(강남구)');
    const secondIdx = reply.indexOf('은마(강남구)', firstIdx + 1);
    assert.ok(firstIdx >= 0, '은마(강남구) 표시가 목록에 없다');
    assert.equal(secondIdx, -1, '같은 표시 문자열이 목록에 두 번 나왔다 — 중복 제거가 깨졌다');
    assert.match(reply, /은마타운\(강남구\)/, '두 번째(실제로 다른) 단지 은마타운이 목록에서 빠졌다');
    assert.equal(new Set(suggestions).size, suggestions.length, 'suggestions 에 중복이 있다');
    assert.equal(tracker.doubleIlikeChains, 3, '되묻기 전까지 1라운드만 돌아야 한다');
    assert.equal(_NO_PROMO.test(reply), false);
  } finally { restore(); }
});



test('검색 자동완성 — "대치 은마"가 지역 분리 재시도로 은마를 준다 (Plan 062 핵심, 운영자 재현)', async () => {
  const eunmaRow = {
    apt_name: '은마', sigungu: '강남구', umd_nm: '대치동', lawd_cd: '11680',
    build_year: 1979, recent_deal_date: '2026-08-01', deal_count: 233, apt_seq: '11680-100',
  };
  const routes = [
    // 지역 분리 1라운드(splitRegionName('대치 은마') === [{region:'대치',name:'은마'}])의
    // umd_nm 경로에서만 실제로 은마를 찾도록 stub — 나머지(원본 5조회 + sigungu 경로 +
    // apt_master 경로)는 기본값(빈 결과)이다.
    { table: 'molit_apt_index', ilikes: [{ col: 'umd_nm', pattern: '대치%' }, { col: 'apt_name', pattern: '%은마%' }],
      result: { data: [eunmaRow], error: null } },
  ];
  await _withSearchDbStubChain(routes, async (handler, seen) => {
    const res = _mockRes();
    await handler({ query: { q: '대치 은마', limit: 10 } }, res, () => {});
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.results.some((r) => r.aptName === '은마' && r.sigungu === '강남구'),
      `"대치 은마" 검색 결과에 은마가 없다: ${JSON.stringify(res.body.results)}`);
    assert.equal(seen.doubleIlikeChains, 3,
      `지역 분리 재시도는 1라운드(3조회)에서 성공해 멈춰야 한다(${seen.doubleIlikeChains}개) — 왕복 상한 위반`);
    assert.equal(res.body.degraded, undefined, '지역 분리 재시도 성공인데 degraded 가 표시됐다');
  });
});



test('검색 자동완성 — 원 질의로 이미 찾히면(성공 경로) 지역 분리 재시도가 전혀 돌지 않는다 (Plan 062, 왕복 불변)', async () => {
  // 케이스 ①: 단일 토큰("은마") — splitRegionName 이 애초에 후보를 안 낸다(토큰 1개).
  await _withSearchDbStubChain(
    [{ table: 'molit_apt_index', ilikes: [{ col: 'apt_name', pattern: '%은마%' }],
       result: { data: [{ apt_name: '은마', sigungu: '강남구', umd_nm: '대치동', lawd_cd: '11680', build_year: 1979, recent_deal_date: '2026-08-01', deal_count: 233, apt_seq: 'x' }], error: null } }],
    async (handler, seen) => {
      const res = _mockRes();
      await handler({ query: { q: '은마', limit: 10 } }, res, () => {});
      assert.equal(res.statusCode, 200);
      assert.equal(seen.calls.length, 3,
        `성공 경로인데 왕복 수가 3이 아니다(${seen.calls.length}) — 재시도가 돈 것으로 의심됨: ${JSON.stringify(seen.calls)}`);
      assert.equal(seen.doubleIlikeChains, 0, '직접 히트가 있는데 지역 분리 재시도(이중 ilike 체인)가 실행됐다');
    }
  );

  // 케이스 ②: 다중 토큰이지만 원본(공백 포함) 질의로 이미 직접 히트 — splitRegionName 은
  //   후보를 **낸다**(region:'PLAN062', name:'다중토큰직접매치')는 점에서 케이스 ①과 다르다.
  //   게이트가 무조건 실행으로 망가지면 이 케이스에서만 체인이 잡힌다(케이스 ①은 애초에
  //   후보가 없어 게이트가 깨져도 감지가 안 된다 — 그래서 이 케이스가 필요하다).
  await _withSearchDbStubChain(
    [{ table: 'molit_apt_index', ilikes: [{ col: 'apt_name', pattern: '%PLAN062 다중토큰직접매치%' }],
       result: { data: [{ apt_name: 'PLAN062 다중토큰직접매치', sigungu: '노원구', umd_nm: '공릉동', lawd_cd: '11350', build_year: 2001, recent_deal_date: '2026-08-01', deal_count: 10, apt_seq: 'y' }], error: null } }],
    async (handler, seen) => {
      const res = _mockRes();
      await handler({ query: { q: 'PLAN062 다중토큰직접매치', limit: 10 } }, res, () => {});
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.results.some((r) => r.aptName === 'PLAN062 다중토큰직접매치'));
      assert.equal(seen.doubleIlikeChains, 0,
        '원 질의로 이미 확정됐는데(splitRegionName 은 후보를 내는 질의인데도) 지역 분리 재시도가 실행됐다 — 왕복 계약 위반');
    }
  );
});



test('검색 자동완성 — 3토큰 질의는 최대 2라운드까지만 재시도한다(왕복 상한, Plan 062)', async () => {
  const row = {
    apt_name: '은마', sigungu: '강남구', umd_nm: '대치동', lawd_cd: '11680',
    build_year: 1979, recent_deal_date: '2026-08-01', deal_count: 233, apt_seq: 'x',
  };
  // splitRegionName('서울 강남 은마') === [{region:'강남',name:'은마'}, {region:'서울',name:'강남 은마'}].
  // 1라운드(강남/은마) 후보는 stub 이 없어 실패 → 2라운드(서울/강남 은마)에서만 성공하도록 둔다.
  const routes = [
    { table: 'molit_apt_index', ilikes: [{ col: 'umd_nm', pattern: '서울%' }, { col: 'apt_name', pattern: '%강남 은마%' }],
      result: { data: [row], error: null } },
  ];
  await _withSearchDbStubChain(routes, async (handler, seen) => {
    const res = _mockRes();
    await handler({ query: { q: '서울 강남 은마', limit: 10 } }, res, () => {});
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.results.some((r) => r.aptName === '은마'));
    assert.equal(seen.doubleIlikeChains, 6,
      `2라운드(6조회)까지만 돌아야 한다(${seen.doubleIlikeChains}개) — 3개 후보를 전부 도는 9조회가 아니다`);
  });
});



test('검색 자동완성 — 지역 분리 재시도가 실패해도 500 이 아니라 200 + 빈 결과로 응답한다(_softQuery, Plan 062)', async () => {
  const routes = [
    // 지역 분리 유일 후보(대치/없는단지) 3조회를 전부 실패로 주입 — 원본 5조회는 이미 빈 결과(기본값)다.
    { table: 'molit_apt_index', ilikes: [{ col: 'umd_nm', pattern: '대치%' }, { col: 'apt_name', pattern: '%없는단지%' }],
      reject: true, error: new Error('PLAN062 주입 실패 — molit umd') },
    { table: 'molit_apt_index', ilikes: [{ col: 'sigungu', pattern: '대치%' }, { col: 'apt_name', pattern: '%없는단지%' }],
      reject: true, error: new Error('PLAN062 주입 실패 — molit sigungu') },
    { table: 'apt_master', ilikes: [{ col: 'umd_nm', pattern: '대치%' }, { col: 'apt_name', pattern: '%없는단지%' }],
      reject: true, error: new Error('PLAN062 주입 실패 — master umd') },
  ];
  await _withSearchDbStubChain(routes, async (handler, seen) => {
    const res = _mockRes();
    await handler({ query: { q: '대치 없는단지', limit: 10 } }, res, () => {});
    assert.equal(res.statusCode, 200,
      '지역 분리 재시도 조회의 실패가 500 으로 번졌다 — _softQuery 로 감싸지 않았을 수 있다');
    assert.deepEqual(res.body.results, []);
    assert.equal(seen.doubleIlikeChains, 3, '유일한 후보 1라운드만 시도하고 끝나야 한다(실패해도 재시도 루프가 멈추지 않으면 안 된다는 뜻은 아니다 — 후보가 1개뿐이라 원래 1라운드)');
  });
});



test('검색 자동완성 — 지역 분리 재시도 조회 3개가 모두 _softQuery 로 감싸여 있다(소스 계약, Plan 062)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const raw = fs.readFileSync(path.join(__dirname, '../routes/search.js'), 'utf8');
  // 줄 주석 제거 후 검사 — 마커·설명 주석 문자열이 검사를 오검출시킨 전례(6회 재발) 방지.
  const src = raw.split('\n').map((l) => l.replace(/\/\/[^\r\n]*/, '')).join('\n');
  const startIdx = src.indexOf('async function _regionSplitRetry()');
  assert.ok(startIdx >= 0, '_regionSplitRetry 함수를 찾지 못했다 — 지역 분리 재시도 구조가 바뀌었다');
  // 주석 제거 후에는 "트리거" 같은 설명 주석 텍스트가 사라지므로, 함수 뒤에 이어지는 실제
  // 코드(트리거 if 문)를 경계로 잡는다 — 마커·주석 문자열 자기충돌(6회 재발 전례) 회피.
  const endIdx = src.indexOf('if (!molitRows.length', startIdx);
  assert.ok(endIdx > startIdx, '_regionSplitRetry 함수 다음의 트리거 if 문을 찾지 못했다 — 구조가 바뀌었다');
  const block = src.slice(startIdx, endIdx);
  const softCount = (block.match(/_softQuery\(/g) || []).length;
  assert.equal(softCount, 3,
    `지역 분리 재시도 조회 중 _softQuery 로 감싸이지 않은 것이 있다(${softCount}/3) — 실패가 500 으로 번질 수 있다`);
});



test('검색 자동완성 — 지역 분리 재시도 트리거는 기존 두 출처가 둘 다 비었을 때만 실행된다(소스 계약, Plan 062)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const raw = fs.readFileSync(path.join(__dirname, '../routes/search.js'), 'utf8');
  const src = raw.split('\n').map((l) => l.replace(/\/\/[^\r\n]*/, '')).join('\n');
  assert.match(src, /if\s*\(\s*!molitRows\.length\s*&&\s*!\(\(masterRes\.data\s*\|\|\s*\[\]\)\.length\)\s*\)\s*\{[\s\S]{0,40}const _regionRetry = await _regionSplitRetry\(\);/,
    '지역 분리 재시도 호출이 "molitRows·masterRes.data 둘 다 빈 경우" 게이트 뒤에 있지 않다 — ' +
    '무조건 실행되면 성공 경로의 조회 수가 늘어난다(완료 기준 위반)');
});



test('검색 자동완성 — 캐시 키 버전이 v3 이다(Plan 062, 엣지 캐시 실사고 방지)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const raw = fs.readFileSync(path.join(__dirname, '../routes/search.js'), 'utf8');
  const src = raw.split('\n').map((l) => l.replace(/\/\/[^\r\n]*/, '')).join('\n');
  assert.match(src, /const sck = `searchapt:v3:/,
    '검색 캐시 키가 v3 이 아니다 — 지역 분리 재시도로 응답 모양이 바뀌었는데 캐시 키를 안 올리면 ' +
    '배포 전 캐시된 "빈 결과"가 서버 10분 + CDN s-maxage=600(+SWR 3600) 만큼 계속 나간다');
});
