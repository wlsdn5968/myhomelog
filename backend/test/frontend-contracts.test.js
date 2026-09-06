/**
 * backend/test/frontend-contracts.test.js
 *
 * characterization.test.js(Plan 066, 10,056줄·327 test 단일 파일)를 도메인별로 분할한 조각.
 * 동작을 하나도 바꾸지 않는 이동이다 — 테스트 이름·개수·본문은 원본과 동일하다.
 * 공용 목/스텁 유틸은 ./_helpers 에서 가져온다. 새 테스트는 이 파일의 주제와 맞으면 여기에,
 * 아니면 backend/test/README.md 규칙대로 새 도메인 파일을 만든다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _plan056RunGap, _plan056RunPct, _plan056RunSheetMeta, _plan061GetItemThrows, _plan061NormalStorage, _plan061SendOnceFn, _plan061SetItemThrows, _regPairFns, _reportFn } = require('../testSupport/_helpers');



// ── Plan 007 (2026-08-09): Supabase 클라이언트 SSOT — 공개 읽기 키 체인 순서 고정 ──────
//   publishable 우선(defense in depth)·service_role 은 최후 폴백. 순서가 바뀌면 "공개 읽기"
//   경로가 의도보다 넓은 권한(RLS 우회)으로 먼저 붙는 회귀 — 반드시 이 순서 유지.
test('db/client._pickReadonlyKey — publishable > anon > service_role > service_role(소문자)', () => {
  const { _pickReadonlyKey } = require('../db/client');
  assert.equal(_pickReadonlyKey({ SUPABASE_PUBLISHABLE_KEY: 'p', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' }), 'p');
  assert.equal(_pickReadonlyKey({ SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' }), 'a');
  assert.equal(_pickReadonlyKey({ SUPABASE_SERVICE_ROLE_KEY: 's' }), 's');
  assert.equal(_pickReadonlyKey({ service_role: 'sr' }), 'sr');
  assert.equal(_pickReadonlyKey({}), null);
});



// ── IDENTITY-GATE (2026-08-10, Sprint KKKKKKK): KAPT 단지정보 오매칭 차단 ─────────────
//   운영자 발견 사고: 도봉구 방학동 "신동아아파트1"(1986년·3,169세대 방학신동아1단지)에
//   "신동아 타워 아파트"(1997년·104세대)가 붙어 단지정보 탭이 통째로 남의 단지였다.
//   원인은 ratio 게이트가 **이름이 짧은 후보를 편애**한 것(정답 0.429 차단 / 오답 0.600 통과).
// SIDO-SCOPE (2026-08-10): 동명 시군구 환각 — DB 실측으로 '중구'는 6개 시도(서울·부산·대구·인천·
//   대전·울산, 11,243건), '서구'는 4개 시도(17,350건)에 **같은 문자열**로 저장돼 있다
//   (molit_transactions.sigungu 에는 광역 접두가 없다). REGION_KEYWORDS 가 '중구'→서울(11140)로
//   고정돼 있어 "부산 중구"를 넣어도 **서울 중구 아파트**가 추천됐다. 광역 접두로 먼저 좁혀야 한다.
test('pickRegions — 광역 접두로 동명 구를 정확히 구분한다', () => {
  const { pickRegions } = require('../services/propertyService');
  const first = (r) => { const x = pickRegions(r, 10); return x && x[0] ? x[0].lawdCd : null; };

  // 같은 '중구'라도 광역에 따라 다른 코드여야 한다 (예전엔 전부 11140 서울이었다)
  assert.equal(first('서울 중구'), '11140');
  assert.equal(first('인천 중구'), '28110');
  assert.equal(first('부산 중구'), '26110');
  assert.equal(first('대구 중구'), '27110');
  assert.equal(first('대전 중구'), '30140');
  assert.equal(first('울산 중구'), '31110');

  // '서구'도 마찬가지
  assert.equal(first('인천 서구'), '28260');
  assert.equal(first('부산 서구'), '26140');
  assert.equal(first('대전 서구'), '30170');

  // '강서구' — 서울(11500) vs 부산(26440)
  assert.equal(first('서울 강서구'), '11500');
  assert.equal(first('부산 강서구'), '26440');

  // 부분문자열 함정: '남동구' 안에 '동구'가 들어 있다 → 더 긴 이름을 택해야 한다
  assert.equal(first('인천 남동구'), '28200');
  assert.equal(first('인천 동구'), '28140');

  // 기존 동작 회귀 확인: 서울 고유 구·경기 별칭·지방 세부는 그대로여야 한다
  assert.equal(first('서울 강남구'), '11680');
  assert.equal(first('경기 분당'), '41135');
  assert.equal(first('지방 해운대'), '26350');
  assert.equal(first('지방 청주'), '43111');
});



// LAWD-FIRST (2026-08-10): 시도교육청을 **구 이름으로 추정**하면 남의 지역 학교 정보가 붙는다.
//   기존 구현은 "…구로 끝나면 서울"이라 해운대구·수성구·유성구·청주시상당구가 전부 B10(서울)이었고,
//   NEIS 는 (시도교육청 + 학교명)으로 조회하므로 동명 학교가 서울에 있으면 **서울 학교의 학생수**가
//   그 단지 정보로 붙었다. 행정구역 판정은 lawd_cd 로 한다(반복 확인된 원칙).
test('schoolNeis.inferAtptCode — lawd_cd 우선, 모호한 구 이름은 판정 포기', () => {
  const { inferAtptCode } = require('../services/schoolNeisService');
  // lawd_cd 가 있으면 그것으로 확정 — 이름이 무엇이든 정확하다
  assert.equal(inferAtptCode('청주시상당구', '43111'), 'M10'); // 충북
  assert.equal(inferAtptCode('해운대구', '26350'), 'C10');     // 부산 (예전엔 서울로 오판)
  assert.equal(inferAtptCode('수성구', '27260'), 'D10');       // 대구
  assert.equal(inferAtptCode('유성구', '30200'), 'G10');       // 대전
  assert.equal(inferAtptCode('강남구', '11680'), 'B10');       // 서울
  assert.equal(inferAtptCode('수원시영통구', '41117'), 'J10'); // 경기

  // lawd_cd 가 없을 때: 서울 고유 자치구만 인정
  assert.equal(inferAtptCode('강남구'), 'B10');
  assert.equal(inferAtptCode('수원시영통구'), 'J10'); // 시+구 합성어는 모호하지 않다
  // 여러 시도에 함께 있는 이름은 **null** — 서울로 단정하면 환각이 된다
  assert.equal(inferAtptCode('중구'), null);
  assert.equal(inferAtptCode('서구'), null);
  assert.equal(inferAtptCode('해운대구'), null); // 예전엔 B10 을 반환했다
  assert.equal(inferAtptCode(''), null);
  assert.equal(inferAtptCode(null), null);
});



// ── Sprint RRRRRRR (2026-08-16) — 검색 molit 조회 상한(abort) 계약 ──────────
//   왜 추가하나: 라이브 실측에서 자동완성이 최대 7.4s 를 쓰고(래미 7,401ms·주공 7,304ms) 그중
//   일부는 500(은마 4,485ms)까지 났다. 원인은 435,613행 CPU 바운드 ILIKE Seq Scan 으로 확정됐고
//   (EXPLAIN: 스캔 2,467ms·buffers 전부 shared hit / Sort 는 0.015ms / GIN 강제는 더 느림),
//   인덱스로는 줄일 수 없어 **2.5s 에 먼저 끊는** 상한을 넣었다.
//   이 테스트가 지키는 것은 두 가지 퇴행이다:
//     (a) abort 가 error 로 정규화되지 않으면 Promise.all 이 reject → 강등(200)이 **500 으로 퇴행**
//     (b) abort 판정이 새면 우리가 의도적으로 끊은 요청이 'molit-error' 로 분류돼 **Sentry 이슈 양산**
test('_softQuery — reject 를 error 로 정규화해 Promise.all 이 통째로 터지지 않는다', async () => {
  const { _softQuery } = require('../routes/search');

  // 정상 결과는 그대로 통과해야 한다(래핑이 응답을 바꾸면 안 됨)
  const ok = await _softQuery(Promise.resolve({ data: [{ apt_name: '은마' }], error: null }));
  assert.deepEqual(ok, { data: [{ apt_name: '은마' }], error: null });

  // AbortSignal.timeout() 이 던지는 것은 TimeoutError 다 — AbortError 만 보면 놓친다
  const te = new Error('The operation was aborted due to timeout'); te.name = 'TimeoutError';
  const r1 = await _softQuery(Promise.reject(te));
  assert.equal(r1.data, null);
  assert.equal(r1.error.aborted, true, 'TimeoutError 를 abort 로 인식하지 못함');

  // ★ 핵심 회귀: 한 쿼리가 reject 해도 나머지 결과는 살아야 한다(강등의 전제)
  const [a, b] = await Promise.all([
    _softQuery(Promise.reject(te)),
    _softQuery(Promise.resolve({ data: [{ apt_name: '헬리오시티' }], error: null })),
  ]);
  assert.ok(a.error, 'reject 가 error 로 오지 않음');
  assert.equal(b.data.length, 1, '다른 쿼리 결과가 유실됨 → 강등 대신 500 이 된다');

  // ★★ 감사 #7: 위 케이스들은 전부 **reject** 경로인데, postgrest-js 는 실제로 reject 하지 않는다
  //   (구현 주석 참조 — 이 헬퍼의 reject 분기는 라이브러리 변경에 대비한 방어층이다).
  //   운영에서 진짜 일어나는 건 **error 를 담은 resolve** 이고, 그 경로에서 _softQuery 가 해야 할 일은
  //   "아무것도 하지 않는 것"이다. 변형하면 뒤이은 _isAbortErr 판정이 깨져 우리가 의도적으로 끊은
  //   요청이 'molit-error' 로 분류되고 **Sentry 이슈가 매일 쌓인다.**
  //   → 실제 shape 를 넣어 (a) 원형 보존 (b) 그 error 가 abort 로 판정됨 을 함께 못 박는다.
  const realShape = {
    data: null,
    error: {
      message: 'TimeoutError: The operation was aborted due to timeout',
      details: '', hint: '', code: '',
    },
  };
  const passed = await _softQuery(Promise.resolve(realShape));
  assert.deepEqual(passed, realShape,
    '_softQuery 가 postgrest 의 실패 resolve 를 변형했다 — 원형 그대로 통과해야 한다');
  const { _isAbortErr } = require('../routes/search');
  assert.equal(_isAbortErr(passed.error), true,
    '통과된 error 를 abort 로 판정하지 못한다 — 의도한 중단이 오류로 집계되고 Sentry 이슈가 매일 생긴다');
});



// ── Plan 018 (2026-08-16): 서울 규제 **해제** 시나리오에서도 두 경로가 붙어 있는가 ──
//   계획 016 에서 남겨둔 잔여 항목. `_regLtvLabel` 은 lawd_cd 11 이면 스냅샷을 보지 않고
//   무조건 '40%' 였다 — 서울이 해제되면 `isRegFront` 만 비규제로 바뀌어 다시 갈린다.
//   실측 근거: regulations_snapshot.housing_loan_2025 의 regulatedRegions =
//     { seoul: "서울 전 지역 (25개 구)"(문자열), gyeonggi: [15개] }  (2026-08-16 DB 조회)
//     → regulationsService.js:202 `const seoulRegulated = !!reg.seoul` 로 boolean 이 된다.
test('서울 규제 해제 시나리오 — 스냅샷을 따라 두 경로가 함께 움직인다 (부팅 전엔 보수적 40%)', () => {
  // (1) 현행: 서울 전 지역 규제 → 양쪽 다 규제
  {
    const { isRegFront, _regLtvLabel } = _regPairFns({ keywords: ['과천시'], seoulRegulated: true });
    assert.equal(_regLtvLabel('강남구 대치동', '11680'), '40%');
    assert.equal(isRegFront('강남구 대치동', '11680'), true);
  }
  // (2) ★ 해제: 스냅샷이 seoulRegulated=false → **양쪽 다** 비규제로 움직여야 한다.
  //     여기서 _regLtvLabel 만 40% 로 남으면 해제된 서울 매물에 사실 아닌 한도를 표기한다.
  {
    const { isRegFront, _regLtvLabel } = _regPairFns({ keywords: ['과천시'], seoulRegulated: false });
    assert.equal(isRegFront('강남구 대치동', '11680'), false);
    assert.equal(_regLtvLabel('강남구 대치동', '11680'), '70%',
      '스냅샷이 서울 해제인데 _regLtvLabel 이 40% 로 남았다 — 두 경로가 갈렸다');
    // 경기 규제는 그대로여야 한다(서울 해제가 경기까지 풀면 안 된다)
    assert.equal(_regLtvLabel('과천시 별양동', '41290'), '40%');
  }
  // (3) ★ 스냅샷 **미로드**(부팅 직후) → 보수적으로 40% 유지.
  //     이때 70% 를 찍으면 서울 매물 한도를 부풀리는 반대 방향 오표기가 된다.
  {
    const { _regLtvLabel } = _regPairFns(undefined);
    assert.equal(_regLtvLabel('강남구 대치동', '11680'), '40%',
      '스냅샷 미로드인데 서울이 비규제(70%)로 표기됐다 — 한도 부풀림');
  }
});



// ── Plan 017 (2026-08-16): KOSIS 미분양 Redis 2차 캐시의 Map 직렬화 계약 ──
//   순이동 로더에 이미 있던 Redis 캐시를 미분양 로더에 역이식했는데, **그대로 복붙하면 죽는다.**
//   미분양 로더의 반환값은 `map` 이 Map 인스턴스이고 Upstash 는 set(객체)→JSON 직렬화라
//   Map 이 `{}` 로 납작해진다. 그러면 복원 후 getUnsoldTrend 의 `all.map.get(...)` 이
//   TypeError 로 죽어 **보고서의 미분양 패널이 통째로 500** 이 된다.
//   이 테스트는 pack/unpack 이 그 함정을 실제로 막는지, 그리고 이상한 값이 오면
//   조용히 null(캐시 미스)로 떨어지는지를 고정한다.
test('KOSIS 미분양 캐시 — Map 은 JSON 왕복을 못 견딘다: pack/unpack 계약', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../services/kosisService.js'), 'utf8');
  const grab = (name) => {
    const m = src.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}'));
    assert.ok(m, `kosisService.js 에서 ${name} 을 찾지 못했다`);
    return m[0];
  };
  const { _packUnsold, _unpackUnsold } = new Function(
    `${grab('_packUnsold')}\n${grab('_unpackUnsold')}\nreturn { _packUnsold, _unpackUnsold };`)();

  const out = {
    map: new Map([['서울|종로구', [{ ym: '202605', cnt: 12 }, { ym: '202606', cnt: 9 }]],
      ['부산|해운대구', [{ ym: '202606', cnt: 401 }]]]),
    fetchedAt: '2026-08-16T00:00:00.000Z',
  };

  // ★ 함정 자체를 고정한다 — Map 을 그냥 실으면 복원 후 .get 이 사라진다(2026-08-16 Node 실측).
  const naive = JSON.parse(JSON.stringify(out));
  assert.equal(typeof naive.map.get, 'undefined',
    'Map 이 JSON 왕복을 견디게 됐다면 이 테스트와 pack/unpack 의 전제를 다시 확인할 것');

  // pack → (Upstash JSON 직렬화 모사) → unpack 이면 Map 이 살아 돌아온다
  const restored = _unpackUnsold(JSON.parse(JSON.stringify(_packUnsold(out))));
  assert.ok(restored.map instanceof Map, '복원 결과가 Map 이 아니다 — getUnsoldTrend 가 TypeError 로 죽는다');
  assert.deepEqual(restored.map.get('서울|종로구'), [{ ym: '202605', cnt: 12 }, { ym: '202606', cnt: 9 }]);
  assert.equal(restored.map.size, 2);
  assert.equal(restored.fetchedAt, out.fetchedAt);
  // getUnsoldTrend 가 실제로 쓰는 두 연산이 복원본에서 동작하는지
  assert.equal(typeof restored.map.get, 'function');
  assert.equal(typeof restored.map.entries, 'function');

  // ★ fail-safe — 형태가 이상하면 예외가 아니라 null(캐시 미스 → 외부 재조회)
  for (const bad of [null, undefined, {}, { entries: null }, { entries: '해킹' }, 'string', 0]) {
    assert.equal(_unpackUnsold(bad), null, `이상 입력 ${JSON.stringify(bad)} 에 null 이 아니다`);
  }
  // pack 도 Map 이 아니면 null → 호출측이 rset 자체를 건너뛴다(깨진 값을 24h 캐싱하지 않는다)
  assert.equal(_packUnsold(null), null);
  assert.equal(_packUnsold({ map: {} }), null);
  assert.equal(_packUnsold({ map: naive.map }), null);
});



test('지도 마커 — 좌표가 같은 단지는 세로로 쌓여 서로를 가리지 않는다', () => {
  // [실측 근거] 라이브 DOM: 올림픽선수기자촌 1·2·3단지가 x=546.8/548.3/546.8, y=172.8(폭 83~86px)
  //   → 98% 포개져 하나만 클릭 가능했다. 전국 209그룹·450단지 중 241단지가 가려져 있었다.
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const grab = (re, what) => {
    const m = html.match(re);
    assert.ok(m, `frontend/index.html 에서 ${what} 을 찾지 못했다`);
    return m[0];
  };
  const stepSrc = grab(/const _MK_STACK_STEP = \d+;/, '_MK_STACK_STEP');
  const fnSrc = grab(/function _assignMarkerStack\(list\)[\s\S]*?\n\}/, '_assignMarkerStack');
  const styleSrc = grab(/function _mkStackStyle\(p\)[\s\S]*?\n\}/, '_mkStackStyle');
  const { _assignMarkerStack, _mkStackStyle, _MK_STACK_STEP } = new Function(
    `${stepSrc}\n${fnSrc}\n${styleSrc}\nreturn { _assignMarkerStack, _mkStackStyle, _MK_STACK_STEP };`)();

  // ① 겹친 3단지 — 서로 다른 dy 를 받고, 간격은 라벨 높이(26px)보다 커야 겹치지 않는다
  const same = [
    { aptName: '올림픽선수기자촌3단지', lat: 37.5145538, lng: 127.1352531 },
    { aptName: '올림픽선수기자촌1단지', lat: 37.5145538, lng: 127.1352531 },
    { aptName: '올림픽선수기자촌2단지', lat: 37.5145538, lng: 127.1352531 },
  ];
  _assignMarkerStack(same);
  const dys = same.map(p => p._stackDy);
  assert.equal(new Set(dys).size, 3, '같은 좌표 3개가 서로 다른 오프셋을 받지 못했다 — 여전히 포개진다');
  assert.ok(_MK_STACK_STEP > 26, '간격이 라벨 높이(실측 26.3px)보다 작으면 쌓아도 겹친다');
  // 정렬은 단지명 오름차순 — 렌더마다 순서가 흔들리면 같은 마커를 다시 찾을 수 없다
  const byName = [...same].sort((a, b) => a._stackDy - b._stackDy).map(p => p.aptName);
  assert.deepEqual(byName, ['올림픽선수기자촌3단지', '올림픽선수기자촌2단지', '올림픽선수기자촌1단지'],
    'dy 가 단지명 오름차순으로 부여되지 않았다(1단지가 맨 아래여야 한다)');

  // ② 겹치지 않는 마커는 오프셋 0 · style 없음 → 기존 마크업과 픽셀 단위로 동일(회귀 0)
  const solo = [{ aptName: '반포자이', lat: 37.5075936, lng: 127.0131932 },
                { aptName: '은마', lat: 37.4974184, lng: 127.0653274 }];
  _assignMarkerStack(solo);
  assert.deepEqual(solo.map(p => p._stackDy), [0, 0]);
  assert.equal(_mkStackStyle(solo[0]), '', '겹치지 않는 마커에 style 이 붙으면 안 된다');
  assert.match(_mkStackStyle(same.find(p => p._stackDy !== 0)), /^ style="--mkdy:-\d+px"$/);

  // ③ 재렌더(필터 변경) 시 초기화 — 안 하면 오프셋이 누적돼 마커가 화면 밖으로 날아간다
  _assignMarkerStack([same[0]]);
  assert.equal(same[0]._stackDy, 0, '그룹이 1개로 줄었는데 이전 오프셋이 남았다');

  // ④ 좌표 없는 항목이 섞여도 죽지 않는다 (검색 결과엔 좌표 미해결 단지가 실제로 섞인다)
  assert.doesNotThrow(() => _assignMarkerStack([null, { aptName: 'x' }, { aptName: 'y', lat: 1, lng: null }]));

  // ⑤ 마커 HTML 두 경로(Naver·Leaflet fallback)가 모두 이 style 을 실제로 쓰는지 — 배선 계약
  const pinTags = html.match(/<div class="nmap-pin \$\{cls\}\}?"?[^>]*/g) || [];
  const wired = (html.match(/class="nmap-pin \$\{cls\}"\$\{_mkStackStyle\(p\)\}/g) || []).length;
  assert.equal(wired, 2, `_mkStackStyle 배선이 ${wired}곳이다 — Naver·Leaflet 두 경로 모두여야 한다`);
  assert.ok(pinTags.length >= 2);

  // ⑥ CSS 가 --mkdy 를 실제로 반영하는지 (변수만 넣고 transform 을 안 고치면 아무 일도 안 일어난다)
  assert.match(html, /\.nmap-pin\{[^}]*translate\(-50%,calc\(-100% \+ var\(--mkdy,0px\)\)\)/);
  assert.match(html, /\.nmap-pin:hover\{[^}]*translate\(-50%,calc\(-100% \+ var\(--mkdy,0px\)\)\) scale/);
});



test('결정론 조건 카드 — desc 가 실제로 계산된 값을 담고 런타임 출력에도 등급 라벨이 없다 (Plan 041)', () => {
  // 위 절대 규칙 테스트는 소스 문자열만 훑는다 — 함수를 직접 호출해 실제 출력을 검증한다.
  const { _internals } = require('../services/analysisService');
  const { calcBuySignal } = _internals;

  // 가격 위치 하단(green) · 거래량 neutral · 전세가율 상단(green)
  const r1 = calcBuySignal(20, { signal: 'neutral', seasonalBias: false }, 65);
  const price1 = r1.conditions.find(c => c.label === '가격 위치');
  const vol1 = r1.conditions.find(c => c.label === '거래량 추이');
  const jeonse1 = r1.conditions.find(c => c.label === '전세가율');
  assert.match(price1.desc, /최근 6개월 하위 20%/, '백분위 실값이 desc 에 없다');
  assert.equal(vol1.desc, '거래량 변화 없음');
  assert.match(jeonse1.desc, /65% \(최근 6개월 전세 실거래 기준\)/, '전세가율 실값이 desc 에 없다');

  // 가격 위치 상단(red) · 거래량 down · 전세가율 하단(red)
  const r2 = calcBuySignal(80, { signal: 'down', seasonalBias: false }, 30);
  const price2 = r2.conditions.find(c => c.label === '가격 위치');
  const vol2 = r2.conditions.find(c => c.label === '거래량 추이');
  const jeonse2 = r2.conditions.find(c => c.label === '전세가율');
  assert.match(price2.desc, /최근 6개월 상위 20%/);
  assert.equal(vol2.desc, '거래량 감소');
  assert.match(jeonse2.desc, /30% \(최근 6개월 전세 실거래 기준\) — 역전세 위험 확인 필요/);

  // status 매핑은 이 계획에서 건드리지 않았다 — green/yellow/red 값 그대로인지 확인
  assert.equal(price1.status, 'green');
  assert.equal(price2.status, 'red');
  assert.equal(jeonse1.status, 'green');
  assert.equal(jeonse2.status, 'red');

  // 소스 문자열 검사(위 ⑤)와 별개로, 실제 런타임 desc 에도 등급 라벨이 없는지 재확인
  for (const c of [...r1.conditions, ...r2.conditions]) {
    assert.equal(/실수요 비중 높음|보통 수준/.test(c.desc), false,
      `조건 카드 desc 에 등급 라벨이 남아 있다: ${c.desc}`);
  }
});



test('기간·금리 표기가 실제와 일치한다 (Sprint MMMMMMM-5)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const ana = fs.readFileSync(path.join(__dirname, '../services/analysisService.js'), 'utf8');
  const tx = fs.readFileSync(path.join(__dirname, '../services/transactionService.js'), 'utf8');

  // ① 가격 위치 백분위 — 표본은 6개월인데 표기는 1년이었다.
  //    전제: percentile 은 calcPricePercentile(filteredTx)로 계산되고 그 원천이 monthsBack=6 이다.
  assert.match(tx, /async function getTransactionsByAptInclAliases\(lawdCd, aptName, monthsBack = 6\)/,
    '표본 기간 전제가 바뀌었다 — 표기도 함께 다시 판단할 것');
  assert.match(ana, /calcPricePercentile\(filteredTx/, '백분위 입력이 filteredTx 가 아니다');
  for (const bad of ['최근 1년 하위', '최근 1년 상위', '가격 위치 (최근 1년']) {
    assert.equal(ana.includes(bad) || html.includes(bad), false,
      `"${bad}" 표기가 되돌아왔다 — 실제 표본은 6개월이다`);
  }
  assert.match(ana, /최근 6개월 하위 \$\{percentile\}%/);
  assert.match(html, /가격 위치 \(최근 6개월 거래 대비\)/);

  // ② 정책자금 금리 — 계산 패널이 비교표와 다른 값을 쓰고 있었다(계산 패널은 갱신 대상 밖).
  assert.match(html, /window\._hfRates = hf;/, 'HF 공시값을 공유하지 않는다');
  assert.match(html, /function _polRate\(key, fallback\)/, '_polRate 헬퍼가 없다');
  assert.match(html, /rate: _polRate\('didimdol', '2\.85~4\.15%'\)/, '디딤돌 금리가 공시값과 연결되지 않았다');
  assert.match(html, /rate: _polRate\('bogeum', '4\.9~5\.3%'\)/, '보금자리론 금리가 공시값과 연결되지 않았다');
  // stale 값이 되살아나지 않았는지 (한도 '3.6~4.2억' 은 금리가 아니므로 % 로 한정해 검사)
  assert.equal(/rate: '3\.6~4\.2%'/.test(html), false, '보금자리론에 stale 금리가 되돌아왔다');
  assert.equal(/rate: '2\.0~3\.3%'/.test(html), false, '디딤돌에 stale 금리가 되돌아왔다');
  // HF API 가 없는 두 상품은 하드코딩이 정상 — 실수로 _polRate 에 묶이지 않았는지
  assert.match(html, /name: '신혼 디딤돌'[\s\S]{0,250}rate: '1\.8~3\.1%'/);
  assert.match(html, /name: '신생아 특례'[\s\S]{0,250}rate: '1\.6~3\.3%'/);
});



test('매칭 0건 안내가 단지 건수로 세어지지 않는다 + 진행 문구가 실제와 맞다 (Sprint MMMMMMM-7)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const svc = fs.readFileSync(path.join(__dirname, '../services/propertyService.js'), 'utf8');

  // ① 안내 항목은 단지가 아니다 — 예전엔 표식이 없어 '추천 단지 1건' 으로 세어졌다
  const fb = svc.match(/function getStaticFallback\(budget, region\)[\s\S]*?\n\}/);
  assert.ok(fb, 'getStaticFallback 을 찾지 못했다');
  assert.ok(fb[0].includes('_notice: true'), '안내 항목에 식별 플래그가 없다 — 단지 건수로 세어진다');
  assert.ok(html.includes("props.filter(p=>!p._notice).length"), '프론트가 안내 항목을 건수에서 빼지 않는다');
  assert.equal(html.includes("textContent=props.length+'건'"), false,
    '건수에 안내 항목이 다시 포함된다');

  // ② 추천 경로에 LLM 호출이 없다 — 문구가 'AI 분석' 이면 거짓 서술이 된다
  for (const k of ['callAI', 'anthropic', 'openai']) {
    assert.equal(svc.includes(k), false,
      `propertyService 에 ${k} 가 생겼다 — LLM 을 쓴다면 진행 문구도 다시 판단할 것`);
  }
  assert.ok(html.includes("searchStep('조건 매칭·점수 계산 중...', 3)"), '진행 문구가 사실과 다르다');
  assert.equal(html.includes("searchStep('AI 분석·점수 계산 중...', 3)"), false,
    '추천 진행 문구에 AI 표현이 되돌아왔다');
});



test('시세 "평균"·노후 배지가 실제 계산 기준을 밝힌다 (Sprint MMMMMMM-9)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const tx = fs.readFileSync(path.join(__dirname, '../services/transactionService.js'), 'utf8');

  // ① 시세는 단순평균이 아니라 반감기 90일 가중평균이다 — 화면의 거래 목록으로 재현되지 않는다.
  //    설계 전제를 함께 고정: 이 계산이 단순평균으로 바뀌면 라벨도 되돌려야 한다.
  assert.ok(tx.includes('function _weightedMean'), '_weightedMean 이 사라졌다 — 라벨 근거를 다시 볼 것');
  assert.ok(tx.includes('Math.exp(-daysAgo / 90)'), '가중치 반감기가 바뀌었다');
  assert.ok(html.includes('최근 6개월 실거래 가중평균'), '평형별 시세 라벨이 가중평균임을 밝히지 않는다');
  assert.ok(html.includes('6개월 가중평균(최근 거래 가중)'), '추천 카드 가격 기준 라벨이 부정확하다');

  // ② 노후 기준이 화면마다 다르다 — 배지 25년 / 리스크 30년. 배지에 기준을 밝혀 혼선을 없앤다.
  assert.ok(html.includes("tags.push('🏚 노후 25년+')"), '노후 배지가 기준 연수를 밝히지 않는다');
  assert.ok(html.includes('age != null && age >= 30'), '리스크 탭의 30년 기준이 바뀌었다 — 배지 표기도 함께 볼 것');
});



test('표본·범위 표기가 실제 집계와 맞다 (Sprint MMMMMMM-11)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const svc = fs.readFileSync(path.join(__dirname, '../services/propertyService.js'), 'utf8');
  const txs = fs.readFileSync(path.join(__dirname, '../services/transactionService.js'), 'utf8');
  const kakao = fs.readFileSync(path.join(__dirname, '../services/kakaoService.js'), 'utf8');

  // ① totalTxAnalyzed 는 거래 건수가 아니라 **단지 개수**다.
  //    전제: analyzeTransactions 가 단지별로 묶어서 배열을 돌려준다.
  assert.ok(txs.includes('function analyzeTransactions'), 'analyzeTransactions 가 사라졌다');
  assert.ok(txs.includes('const byApt = {}'), '단지별 그룹화 구조가 바뀌었다 — 표기 근거를 다시 볼 것');
  assert.ok(svc.includes('totalTxAnalyzed: analyzed.length'), '집계 소스가 바뀌었다');
  assert.ok(html.includes('거래가 있는 단지'), '건수/단지수 표기가 되돌아왔다');
  assert.equal(html.includes('실거래 ${(Number(searchMeta.totalTx)||0).toLocaleString()}건 분석'), false,
    "'N건 분석' 표기가 되돌아왔다 — N 은 단지 수다");

  // ② 주변시설 반경은 항목마다 다르다 (편의점 500 ~ 종합병원 2000)
  for (const r of ['500', '1200', '1500', '2000']) {
    assert.ok(kakao.includes(r), `kakaoService 의 반경 ${r} 이 사라졌다 — 표기를 다시 판단할 것`);
  }
  assert.ok(html.includes('항목별 500m~2km'), '주변시설 반경 표기가 실제와 다르다');
  assert.equal(html.includes('주변 (반경 800m~1km)'), false, '단일 반경 표기가 되돌아왔다');

  // ③ 층 분포는 전량이 아니라 화면에 불러온 표본 기준이다
  assert.ok(html.includes('최근 6개월 MOLIT · 표본 기준'), '층 분포가 전량 집계처럼 표기된다');
});



test('poolSpanLabel — 잘리지 않으면 6개월, 잘리면 실제 커버 일수', () => {
  const poolSpanLabel = _reportFn('poolSpanLabel');
  assert.equal(poolSpanLabel({ _poolTruncated: false, _poolFrom: '2026-06-19' }), '최근 6개월');
  assert.equal(poolSpanLabel({}), '최근 6개월');
  assert.equal(poolSpanLabel(null), '최근 6개월');
  // 잘린 경우 — 오늘로부터의 일수. 값 자체가 아니라 **형태**를 고정한다(테스트가 날짜에 안 묶이게).
  const out = poolSpanLabel({ _poolTruncated: true, _poolFrom: '2026-06-19' });
  assert.match(out, /^최근 \d+일$/, `잘린 풀인데 '${out}' 로 나온다 — 6개월이라고 말하면 거짓 서술이다`);
  // _poolFrom 이 없으면 판단 불가 → 억지로 추정하지 않고 기본 문구로 돌아간다.
  assert.equal(poolSpanLabel({ _poolTruncated: true }), '최근 6개월');
});



// ── 출처 없는 단정·수치 제거 (Sprint MMMMMMM-13) ──────────────────────────────
// 절대 룰 ②는 "공식 출처만 인용 + 출처·검증일자 명시"다. 아래 세 자리는 그 룰을 어기고 있었다.
// ⚠ 이 테스트는 **금지 문자열**을 검사하므로, 소스 주석에 옛 문구를 그대로 인용하면 안 된다
//   (이 저장소에서 실제로 두 번 재발한 함정이다 — 설명은 하되 원문은 적지 말 것).
test('출처 없는 단정·수치가 화면에 없다 (청약 커트라인·신용대출 금리·권유 단어)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');

  // ① 청약 가점 — 당락 단정 + 근거 없는 커트라인 점수.
  //    커트라인은 단지·공급유형·평형마다 다르고 공고 후 확정된다. 인용할 공시값이 없다.
  assert.equal(html.includes('안정권'), false, '청약 가점에 당락 단정 표현이 남아 있다');
  assert.equal(/커트라인\s*평균/.test(html), false, '근거 없는 커트라인 평균 점수가 남아 있다');
  assert.equal(html.includes('65~70점'), false, '하드코딩된 커트라인 점수 범위가 남아 있다');
  //    대신 공식 확인처 안내는 반드시 남아 있어야 한다(정보를 지우기만 하면 안 된다).
  assert.ok(html.includes('applyhome.co.kr'), '청약Home 안내가 사라졌다 — 확인 경로는 남겨야 한다');

  // ② 신용대출·마이너스통장 금리 — 출처도 기준시점도 없던 수치.
  assert.equal(/평균 금리 6%대/.test(html), false, '출처 없는 신용대출 금리 수치가 남아 있다');
  assert.equal(/변동 금리 7~8%/.test(html), false, '출처 없는 마이너스통장 금리 수치가 남아 있다');
  assert.ok(html.includes('거래 은행에서 직접 확인'), '금리 확인 경로 안내가 없다');

  // ③ 검색 결과 섹션 제목이 권유 단어를 쓰지 않는다 — 보고서 프롬프트의 금지와 말을 맞춘다.
  assert.equal(html.includes('<span class="st">추천 단지</span>'), false,
    '검색 결과 섹션 제목이 여전히 권유 단어다 (절대 룰 ① · report.js 프롬프트 금지와 모순)');
  assert.ok(html.includes('<span class="st">조건 맞는 단지</span>'), '섹션 제목이 바뀌지 않았다');

  // ④ 보고서 프롬프트 쪽 금지 지시가 살아 있는지도 함께 고정 — 한쪽만 남으면 다시 갈린다.
  const rep = fs.readFileSync(path.join(__dirname, '../routes/report.js'), 'utf8');
  assert.ok(rep.includes('조건 부합 단지'), 'report.js 프롬프트의 대체 표현 지시가 사라졌다');

  // ⑤ 정책 블록의 출처 표기가 정직하다 — 자동 갱신되는 것(LTV·DSR)과 코드에 고정된 것
  //    (규제지역·토허 범위)을 구분해 말해야 한다. 전부를 "자동 인용" 이라 부르면 출처를 오도한다.
  assert.equal(/본 정보는 정부 공시 자동 인용/.test(rep), false,
    '하드코딩된 규제 범위까지 "자동 인용" 이라고 말한다 — 절대 룰 ②(출처 명시) 위반');
  assert.match(rep, /LTV·DSR 은 정부 공시 스냅샷에서 자동 인용/,
    '무엇이 자동이고 무엇이 고정인지 구분하는 문구가 사라졌다');
});



test('단지 카드 — 기간 라벨은 서버 값을 쓰고, 세대당 주차에는 총량이 함께 붙는다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const rep = fs.readFileSync(path.join(__dirname, '../routes/report.js'), 'utf8');

  // ① 서버가 기간 라벨을 내려보낸다. 프론트가 자기 문자열로 다시 만들면 잘림 표기가 조용히 갈린다
  //    (백엔드는 잘렸을 때 '최근 N일' 로 낮추는데 카드만 6개월이라고 우기는 상태가 실제로 있었다).
  assert.match(rep, /sampleSpan:\s*_span/, 'report 응답에 기간 라벨(sampleSpan)이 없다');
  assert.match(html, /a\.sampleSpan\s*\|\|/, '카드가 서버의 기간 라벨을 쓰지 않는다 — 사본이 갈린다');
  assert.equal(/신고가 <b>6개월 /.test(html), false, '카드가 아직 기간을 하드코딩한다');

  // ② 세대당 주차는 **비율**이다 — 분모(총 주차대수)가 데이터에 있는데 카드에만 빠져 있었다.
  //    report.js:948 이 parking_total 을 이미 싣고 있으므로 새 조회 없이 붙일 수 있다.
  assert.match(rep, /parking_total:/, 'objectiveFacts 에 총 주차대수가 없다');
  assert.match(html, /f\.parking_total\?`\s*\(총 /, '카드의 세대당 주차에 총량이 안 붙는다');

  // ③ 세대수 불일치로 분모를 못 믿는 경우 카드에서도 그 사실을 밝힌다(상세 표와 동일 처리).
  assert.match(html, /f\.parking_uncertain\?/, '카드가 세대수 불일치를 표시하지 않는다');
});



// ── NO-UNDEF-2026-08-17 (Sprint MMMMMMM-14) ───────────────────────────────────
// 같은 날 **매달린 참조**를 두 건 잡았다. 둘 다 문법은 합법이라 `node --check` 와 `vm.Script` 로는
// 원리적으로 못 잡고, 실행해 봐야만 드러난다:
//   ① chatDataRouter._market 이 교체 후 옛 변수를 계속 참조 → 시세 답변이 라이브에서 죽었다.
//   ② backend/routes/kakao.js 가 SSOT 리팩터링(acfd032)에서 선언만 지워진 상수를 계속 참조
//      → 카카오 알림 OAuth 의 state 서명이 무증상으로 죽어 있었다.
// 이 테스트는 규칙이 조용히 꺼지는 것을 막는다(끄면 같은 사고가 다시 통과한다).
test('eslint 에 no-undef 가 켜져 있다 (매달린 참조 차단)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const cfg = fs.readFileSync(path.join(__dirname, '../../eslint.config.mjs'), 'utf8');
  const blocks = cfg.split('rules:').slice(1);
  assert.ok(blocks.length >= 2, 'eslint 설정의 rules 블록을 2개(백엔드·인라인) 찾지 못했다');
  for (const [i, b] of blocks.entries()) {
    assert.match(b, /'no-undef':\s*'error'/,
      `rules 블록 #${i + 1} 에 no-undef 가 없다 — 한쪽만 켜면 다른 쪽 매달린 참조가 그대로 통과한다`);
  }
  // 리팩터링이 지운 그 상수가 실제로 복구돼 있는지도 함께 못 박는다(재발 시 여기서 먼저 걸린다).
  const kakao = fs.readFileSync(path.join(__dirname, '../routes/kakao.js'), 'utf8');
  assert.match(kakao, /const SERVICE_KEY = process\.env\.SUPABASE_SERVICE_ROLE_KEY/,
    'kakao.js 의 state HMAC 파생 키 선언이 다시 사라졌다 — OAuth state 서명이 죽는다');
});



// ── REGION-SCOPE-2026-08-17 (Sprint MMMMMMM-16) ───────────────────────────────
// [실측 배경] 프론트가 보내는 지역 문자열은 닫힌 집합이다(`${wide} ${sub}`, wide 4종 · sub 52종).
//   그 56개를 보고서의 지역 분기에 전부 넣어 돌린 결과 **21개가 광역 전체로 샜다**:
//     · 경기 16개 전부 → 경기 44코드   · 인천 5개 → 인천 14코드   · '지방' 미선택 → **전국(필터 없음)**
//   원인은 분기가 `[가-힣]+구` 로 '구'가 붙은 이름만 좁힐 수 있다는 것 —
//   경기·인천 칩은 '과천'·'분당'·'남동'처럼 '구'가 없다.
//   화면 안내는 "선택 시 **그 지역만** 분석" 이라 52개 중 21개가 그 말과 달랐다.
// ⚠ 이 테스트는 **프론트의 칩 목록을 직접 읽어** 검사한다. 칩을 새로 추가했는데 백엔드가
//   해석 못 하면 여기서 잡힌다 — 사람이 케이스를 손으로 고르면 반드시 빠뜨린다(중구 사고).
test('지역 세부 칩 전부가 광역보다 좁게 해석된다 (프론트 칩 목록 기준 전수)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  // REGION-MENU-2026-08-30: 칩 목록은 이제 `/api/region/menu`(LAWD_CODES 파생)에서 온다.
  //   index.html 에 남은 표는 **네트워크 실패 시 폴백**이다 — 그것도 여전히 해석돼야 하므로 같이 검사한다.
  const m = html.match(/const REGION_SUB_FALLBACK = (\{[\s\S]*?\});/);
  assert.ok(m, 'index.html 에서 REGION_SUB_FALLBACK 을 찾지 못했다 (칩 목록 형태가 바뀌었다면 이 테스트도 갱신할 것)');
  const REGION_SUB = new Function(`return ${m[1]}`)();
  assert.deepEqual(Object.keys(REGION_SUB).sort(), ['경기', '서울', '인천', '지방'],
    '광역 칩 구성이 바뀌었다 — report.js 의 광역 분기도 함께 확인할 것');

  const { pickRegions } = require('../services/propertyService');
  const WIDE_PFX = { '서울': '11', '경기': '41', '인천': '28' };
  // 광역 전체 코드 수 — 이 수에 도달하면 "좁히지 못하고 광역으로 샌 것" 이다.
  const { LAWD_CODES } = require('../services/transactionService');
  const wideCount = (pfx) => Object.values(LAWD_CODES).filter(c => String(c).startsWith(pfx)).length;

  // 예산에 따라 pickRegions 의 폴백 분기가 달라지므로 여러 예산으로 함께 본다.
  for (const budget of [4, 6, 8, 10, 15, 25]) {
    for (const [wide, subs] of Object.entries(REGION_SUB)) {
      for (const sub of subs) {
        const region = `${wide} ${sub}`;
        const picked = pickRegions(region, budget, '') || [];
        const codes = [...new Set(picked.map(p => p.lawdCd))];
        assert.ok(codes.length, `'${region}'(예산 ${budget}) 이 아무 지역으로도 해석되지 않는다`);
        // ⚠ 코드 개수만 보면 부족하다 — 매핑에 없는 칩은 **광역 대표 몇 개 구**로 폴백되어
        //   개수·접두 검사를 그대로 통과한다(실측: '인천 테스트동' → 28185·28200·28237·28245).
        //   판별자는 name 이다. 매핑에 걸리면 매칭 키워드가, 못 걸리면 **광역 이름**이 온다.
        const names = picked.map(p => p.name);
        assert.ok(!names.some(n => ['서울', '경기', '인천', '지방'].includes(n)),
          `'${region}'(예산 ${budget}) 이 매핑에 없어 광역 대표 구로 폴백된다 — ` +
          `REGION_KEYWORDS 에 이 칩의 매핑을 추가할 것 (현재 name=${names.join('/')})`);
        const pfx = WIDE_PFX[wide];
        if (pfx) {
          assert.ok(codes.every(c => String(c).startsWith(pfx)),
            `'${region}'(예산 ${budget}) 이 다른 광역 코드로 해석된다: ${codes.join(',')}`);
          assert.ok(codes.length < wideCount(pfx),
            `'${region}'(예산 ${budget}) 이 광역 전체(${wideCount(pfx)}개)로 샌다 — "그 지역만 분석" 안내와 다르다`);
        } else {
          // '지방' 은 여러 시도가 섞이므로 "수도권 코드가 아닐 것" 으로 본다.
          assert.ok(codes.every(c => !['11', '41', '28'].includes(String(c).slice(0, 2))),
            `'${region}'(예산 ${budget}) 이 수도권 코드로 해석된다: ${codes.join(',')}`);
        }
      }
    }
  }
});



// ── NOTICE-HONEST-2026-08-30 (Sprint OOOOOOO) ─────────────────────────────────
// [무엇이 있었나 — 전수조사 847건에서 발각] "조건에 맞는 단지 없음" 을 화면에
//   **"데이터 일시 조회 실패"** 라고 적고 있었다. 대형(전용 34평+) 조건에서 안내카드가 나온
//   5곳(종로·과천·구리·군포·동두천)은 전부 조회가 **성공**했고(분석 단지 70·16·134·154·62곳)
//   매칭만 0이었다. 틀린 원인을 알려주면 사용자는 "잠시 후 재시도" 를 반복하다 서비스를 불신한다 —
//   실제로 필요한 행동은 조건을 바꾸는 것이다.
test('안내 문구가 원인을 구분한다 — 조회 실패 vs 조건 미매칭', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const src = fs2.readFileSync(path2.join(__dirname, '../services/propertyService.js'), 'utf8');

  // ① 두 분기가 서로 다른 생성기를 쓴다(같은 문구를 재사용하면 다시 갈린다).
  assert.match(src, /if \(!analyzed \|\| !analyzed\.length\) \{[\s\S]{0,200}getStaticFallback/,
    '진짜 조회 실패 분기가 getStaticFallback 을 쓰지 않는다');
  assert.match(src, /if \(!matched\.length\) \{[\s\S]{0,400}getNoMatchNotice/,
    '조건 미매칭 분기가 여전히 "조회 실패" 문구를 쓴다 — 사용자에게 틀린 원인을 알려준다');

  // ② 조건 미매칭 안내는 실패라고 말하지 않는다.
  const noMatch = src.slice(src.indexOf('function getNoMatchNotice'),
    src.indexOf('function getStaticFallback'));
  assert.ok(!/조회 실패|API 응답 없음/.test(noMatch),
    '조건 미매칭 안내에 "조회 실패" 표현이 남아 있다');
  assert.ok(/_reason: 'no-match'/.test(noMatch),
    '프론트가 두 안내를 구분할 수 있는 플래그가 없다');
  assert.ok(/_notice: true/.test(noMatch),
    '_notice 플래그가 없다 — 프론트가 이 항목을 단지 1건으로 세어 "1건" 이라고 표시한다');

  // ③ 진짜 조회 실패 안내는 종전대로 실패라고 말한다(반대 방향 회귀 방지).
  const staticFb = src.slice(src.indexOf('function getStaticFallback'));
  assert.ok(/조회 실패/.test(staticFb), '진짜 실패 안내에서 실패 표현이 사라졌다');
});



// ── MULTI-REGION-2026-08-30 (Sprint OOOOOOO) ──────────────────────────────────
// 운영자: "화성시 동탄·만세구·병점구·효행구 이런식으로 복수 선택이 되면 좋겠다."
//   실제 생활권은 행정구 경계와 일치하지 않는다 — 화성시가 4개 구로 갈리면서 한 도시를 보려면
//   네 번 검색해야 했다. 복수 선택은 그 자체가 기능이지만, **조용히 잘리면** 더 나쁘다
//   (4개 골랐는데 3개만 분석하고 아무 말도 안 하는 것).
test('복수 지역 선택 — 화이트리스트·중복제거·상한을 지키고 조용히 자르지 않는다', () => {
  const { pickRegions } = require('../services/propertyService');

  // ① 고른 만큼 그대로 돌려준다(화성 4개 구).
  const four = pickRegions('경기', 6, '', '41597,41591,41593,41595');
  assert.deepEqual(four.map(r => r.lawdCd), ['41597', '41591', '41593', '41595'],
    '복수 선택이 조용히 잘렸다 — 사용자가 고른 지역이 분석에서 빠진다');
  // name 이 광역 이름이면 보고서가 "해석 실패"로 보고 광역으로 내려간다.
  assert.ok(!four.some(r => ['서울', '경기', '인천', '지방'].includes(r.name)),
    'name 이 광역 이름이다 — 보고서 경로가 지역 해석 실패로 처리한다');

  // ② 중복은 제거하고, LAWD_CODES 에 없는 코드는 버린다(임의 코드로 조회를 열지 않는다).
  const dedup = pickRegions('경기', 6, '', '41597,41597,99999,41595');
  assert.deepEqual(dedup.map(r => r.lawdCd), ['41597', '41595'],
    '중복 제거 또는 화이트리스트 검증이 동작하지 않는다');

  // ③ 상한 6 — 지역 수만큼 실거래·단지목록 조회가 늘어 무제한이면 타임아웃.
  const many = pickRegions('서울', 9, '', '11110,11140,11170,11200,11215,11230,11260');
  assert.equal(many.length, 6, '복수 선택 상한(6)이 지켜지지 않는다');

  // ④ 단일 선택은 종전과 동일(회귀 방지).
  assert.deepEqual(pickRegions('경기', 6, '', '41597').map(r => r.lawdCd), ['41597']);

  // ⑤ 코드가 하나도 유효하지 않으면 문자열 해석으로 내려간다(빈 결과를 돌려주지 않는다).
  const fallback = pickRegions('경기 분당', 9, '', '99999,88888');
  assert.ok(fallback.length > 0, '유효 코드가 없을 때 빈 배열을 돌려준다 — 검색이 통째로 죽는다');
  assert.equal(fallback[0].lawdCd, '41135', '문자열 폴백이 분당을 해석하지 못한다');
});



// 프론트 칩이 실제로 다중 선택을 보내는지 — 백엔드만 고치고 프론트가 단일이면 기능이 없는 것과 같다.
test('프론트 지역 칩이 다중 선택을 보낸다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const html = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');
  // getRegionLawdCd 가 **모든** 선택 칩을 모아 콤마로 잇는다(querySelector 단건이 아니다).
  assert.match(html, /function getRegionLawdCd\(\)\{[\s\S]{0,240}querySelectorAll\('#ch-r-sub \.chip\.on'\)/,
    'getRegionLawdCd 가 칩 하나만 읽는다 — 복수 선택이 백엔드에 전달되지 않는다');
  assert.match(html, /getRegionLawdCd\(\)[\s\S]{0,80}join\(','\)|join\(','\)/,
    '선택된 코드를 콤마로 잇지 않는다');
  // cpSub 가 형제 칩을 전부 끄지 않는다(단일 선택 강제 제거).
  assert.doesNotMatch(html, /function cpSub\(el\)\{[\s\S]{0,200}parentNode\.querySelectorAll\('\.chip'\)\.forEach\(c=>c\.classList\.remove\('on'\)\)/,
    'cpSub 가 여전히 단일 선택을 강제한다');
});



// ── REGION-MENU-2026-08-30 (Sprint OOOOOOO) ───────────────────────────────────
// [무엇이 있었나 — 운영자 발견] "경기는 시 자체도 이상하게 되어 있고, 동탄도 없어."
//   프론트 지역 칩이 **손으로 적은 52개 문자열**이었다. LAWD_CODES 는 122개인데 칩으로
//   도달 가능한 시군구는 pickRegions 전수 계산 결과 **56개뿐** — 적재 실거래 448,508건 중
//   **194,951건(43.5%)이 선택 자체가 불가능**했다(동탄 9,784건 포함).
// [왜 테스트로 묶나] 목록을 손으로 관리하는 한 지역이 늘 때마다 다시 어긋난다. 여기서
//   메뉴가 LAWD_CODES 전수를 덮는지 기계로 확인한다 — 사람이 케이스를 고르면 반드시 빠뜨린다.
test('지역 메뉴가 LAWD_CODES 전수를 덮는다 (도달 불가 시군구 0)', async () => {
  const express = require('express');
  const app = express();
  app.use('/api/region', require('../routes/region'));
  const srv = app.listen(0);
  try {
    const port = srv.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/region/menu`);
    assert.equal(res.status, 200, '지역 메뉴 엔드포인트가 200 이 아니다');
    const j = await res.json();
    const items = (j.groups || []).flatMap(g => g.items || []);

    const { LAWD_CODES, RETIRED_LAWD_CODES } = require('../services/transactionService');
    const want = [...new Set(Object.values(LAWD_CODES).map(String))].filter(c => !RETIRED_LAWD_CODES.has(c));
    const got = new Set(items.map(i => String(i.lawdCd)));
    // MENU-EMPTY-2026-08-30: 운영 환경에서는 **실거래 0건 시군구**(실측: 인천 옹진군 하나)를 뺀다.
    //   테스트 환경엔 DB 자격증명이 없어 그 조회가 실패하고 **fail-open**(전체 노출)으로 떨어진다 —
    //   즉 여기서 검증되는 것은 "열화 시에도 목록이 비지 않는다" 이고, 그게 이 가드의 목적이다.
    //   목록을 조용히 비우는 사고는 이미 겪었다([[degraded-response-cached-at-edge]]).
    assert.equal(j.filtered, false, "DB 없이도 filtered=true 면 fail-open 이 깨진 것이다");
    const missing = want.filter(c => !got.has(c));
    assert.deepEqual(missing, [], `메뉴에서 고를 수 없는 시군구가 있다: ${missing.join(',')}`);

    // 폐지 코드는 **빼야** 한다 — 고르면 신규 거래가 0 인 곳이다.
    const retiredShown = [...got].filter(c => RETIRED_LAWD_CODES.has(c));
    assert.deepEqual(retiredShown, [], `폐지된 시군구가 메뉴에 남아 있다: ${retiredShown.join(',')}`);

    // 라벨 중복은 사용자가 두 칩을 구별할 수 없다는 뜻이다.
    const labels = items.map(i => `${i.label}`);
    assert.equal(new Set(labels).size, labels.length, '지역 라벨이 중복된다 — 사용자가 구별할 수 없다');

    // ⚠ 핵심: 칩이 실어 보내는 lawdCd 가 **그 코드 그대로** 해석돼야 한다.
    //   이름 문자열 경로였다면 동명 구(중구 6곳)에서 갈렸다 — 그 계열의 원천 차단을 여기서 못박는다.
    const { pickRegions } = require('../services/propertyService');
    for (const it of items) {
      const picked = pickRegions('무의미한 문자열', 9, '', it.lawdCd) || [];
      assert.deepEqual(picked.map(x => x.lawdCd), [String(it.lawdCd)],
        `'${it.label}'(${it.lawdCd}) 칩이 다른 코드로 해석된다: ${picked.map(x => x.lawdCd).join(',')}`);
      assert.ok(!['서울', '경기', '인천', '지방'].includes(picked[0].name),
        `'${it.label}'(${it.lawdCd}) 의 name 이 광역 이름이다 — 보고서가 해석 실패로 보고 광역으로 내려간다`);
    }
  } finally { srv.close(); }
});



/* ─────────────────────────────────────────────────────────────────────────────
 * PRICE-RECORDS-2026-08-29 (Sprint NNNNNNN-30): 지역 표시명은 **lawd_cd 에서만** 나온다.
 *
 * [왜 테스트로 묶는가] 동명 구를 문자열로 판정하다 6회 재발했다(서울 중구 LTV 오표기,
 *   부산 강서구 오판 등). molit 의 sigungu 는 광역이 없어 '남구'(부산·대구·울산)·'중구'(6곳)·
 *   '서구'(4곳)·'동구'(5곳)·'북구'(3곳)·'강서구'(2곳)가 **원리적으로 구별되지 않는다**.
 *   그래서 표시명은 LAWD_CODES 에서 파생하고, 그 파생이 전 코드에서 충돌 없는지를 여기서 고정한다.
 *   케이스를 손으로 고르면 빠뜨린다(중구 실사고) — **전수**로 돈다.
 * ───────────────────────────────────────────────────────────────────────────── */
const { regionLabel } = require('../services/priceRecordsService');


const { LAWD_CODES: _LC } = require('../services/transactionService');



test('지역 표시명: LAWD_CODES 전 코드가 매핑되고 표시명이 서로 충돌하지 않는다', () => {
  const seen = new Map();
  for (const [name, code] of Object.entries(_LC)) {
    const label = regionLabel(code, '__FALLBACK__');
    assert.notEqual(label, '__FALLBACK__', `${code}(${name}) 매핑 실패`);
    assert.ok(label && label.length >= 2, `${code}(${name}) 표시명이 비었다`);
    if (seen.has(label)) {
      assert.fail(`표시명 충돌: "${label}" ← ${seen.get(label)} / ${name} — 동명 구가 화면에서 구별되지 않는다`);
    }
    seen.set(label, name);
  }
  assert.equal(seen.size, Object.keys(_LC).length);
});



test('지역 표시명: 동명 구는 광역이 붙어 구별된다', () => {
  // 이름만으로는 같은 '남구'·'중구'·'서구' — 코드가 다르면 표시명도 달라야 한다.
  const 남구 = ['26290', '27200', '31140'].map(c => regionLabel(c, ''));
  assert.equal(new Set(남구).size, 3, `'남구' 3곳이 구별되지 않는다: ${남구.join(' / ')}`);
  const 중구 = ['11140', '26110', '27110', '28110', '30140', '31110'].map(c => regionLabel(c, ''));
  assert.equal(new Set(중구).size, 6, `'중구' 6곳이 구별되지 않는다: ${중구.join(' / ')}`);
  // 서울은 LAWD_CODES 에 접두 없이 등재돼 있다 — 화면에선 '서울'이 붙어야 어느 시인지 알 수 있다.
  assert.match(regionLabel('11140', ''), /^서울/, '서울 구에 광역 표기가 없다');
  assert.match(regionLabel('11500', ''), /^서울/, '서울 강서구에 광역 표기가 없다');
  assert.notEqual(regionLabel('11500', ''), regionLabel('26440', ''), '서울 강서구와 부산 강서구가 같은 표시명이다');
});



test('지역 표시명: 표에 없는 코드는 원본 sigungu 로 폴백한다(빈 문자열 아님)', () => {
  assert.equal(regionLabel('99999', '어딘가구'), '어딘가구');
  assert.equal(regionLabel(null, '어딘가구'), '어딘가구');
  assert.equal(regionLabel('99999', ''), '');
});



// ── STATIC-SEC-HEADERS-2026-09-02 (감사 P0-3) ────────────────────────────────
//   [왜] vercel.json 상 `/`·`/billing`·법적 페이지는 Express 를 거치지 않아 helmet 이 붙지 않는다.
//     그래서 같은 index.html 인데 **루트에만** CSP·X-Frame-Options 가 없었다(라이브 헤더 실측).
//     헤더를 vercel.json 에 복제해 해결했는데, 복제는 곧 **드리프트 위험**이다 —
//     server.js CSP 에 외부 호스트를 추가하고 vercel.json 을 잊으면 정적 경로에서만 조용히 차단된다.
//   [무엇을 고정하나] server.js helmet CSP 에 등장하는 모든 외부 출처가
//     vercel.json 의 정적 라우트 CSP 에도 존재해야 한다(부분집합 관계).
test('보안 헤더: vercel.json 정적 라우트 CSP 가 server.js helmet CSP 의 상위집합이다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const vercel = JSON.parse(fs2.readFileSync(path2.join(__dirname, '../../vercel.json'), 'utf8'));
  const srv = fs2.readFileSync(path2.join(__dirname, '../server.js'), 'utf8');

  // helmet CSP 블록만 잘라낸다 (다른 곳의 URL 문자열을 섞지 않기 위해)
  const from = srv.indexOf('contentSecurityPolicy');
  const to = srv.indexOf('crossOriginEmbedderPolicy');
  assert.ok(from > 0 && to > from, 'server.js 에서 helmet CSP 블록을 찾지 못했다 — 테스트를 갱신할 것');
  const block = srv.slice(from, to);
  const hosts = [...new Set((block.match(/'(?:https|wss):\/\/[^']+'/g) || []).map(s => s.slice(1, -1)))];
  assert.ok(hosts.length >= 10, `helmet CSP 호스트 추출 실패(${hosts.length}건) — 정규식을 갱신할 것`);

  const staticRoutes = vercel.routes.filter(r => r.headers && (r.headers['Content-Security-Policy'] || r.headers['Content-Security-Policy-Report-Only']));
  assert.ok(staticRoutes.length >= 5, `정적 라우트 CSP 가 ${staticRoutes.length}개뿐이다 — 헤더가 빠졌다`);

  for (const r of staticRoutes) {
    const csp = r.headers['Content-Security-Policy'] || r.headers['Content-Security-Policy-Report-Only'];
    const missing = hosts.filter(h => csp.indexOf(h) < 0);
    assert.deepEqual(missing, [], `${r.src} CSP 에 server.js 의 호스트가 빠졌다: ${missing.join(', ')}`);
  }
});



test('보안 헤더: 모든 정적 라우트에 클릭재킹·MIME 방어 헤더가 붙는다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const vercel = JSON.parse(fs2.readFileSync(path2.join(__dirname, '../../vercel.json'), 'utf8'));
  // Express 로 가는 라우트는 helmet 이 담당하므로 제외한다.
  const EXPRESS_DESTS = ['/api/index.js'];
  const staticHtml = vercel.routes.filter(r => typeof r.dest === 'string'
    && r.dest.indexOf('/frontend/') === 0 && r.dest.endsWith('.html'));
  assert.ok(staticHtml.length >= 5, `정적 HTML 라우트가 ${staticHtml.length}개 — 라우트 구조가 바뀌었다`);
  const bad = [];
  for (const r of staticHtml) {
    const h = r.headers || {};
    if (h['X-Frame-Options'] !== 'SAMEORIGIN') bad.push(r.src + ': X-Frame-Options');
    if (h['X-Content-Type-Options'] !== 'nosniff') bad.push(r.src + ': X-Content-Type-Options');
    if (!h['Referrer-Policy']) bad.push(r.src + ': Referrer-Policy');
    if (!h['Content-Security-Policy'] && !h['Content-Security-Policy-Report-Only']) bad.push(r.src + ': CSP');
  }
  assert.deepEqual(bad, [], `정적 HTML 라우트에 보안 헤더 누락:\n  ${bad.join('\n  ')}`);
  assert.ok(EXPRESS_DESTS.length === 1);
});



// ── NULL-NOT-ZERO-2026-09-02 (감사 P0-2) ─────────────────────────────────────
//   [왜] 카카오 주변시설 카운트가 **키 없음·예외 시 0** 을 돌려줬다. 소비자는 그 0 을
//     "반경 안에 0곳" 이라는 사실로 읽어 점수를 최저 밴드로 떨어뜨리고 화면에 "지하철역 0곳" 을 찍었다.
//     같은 병을 키워드 검색(countNearbyKeyword)은 2026-08-30 에 고쳤는데 카테고리 검색은 남아 있었고,
//     소비자(propertyService 인프라 채점)는 이미 "실패는 null" 을 전제로 하드닝돼 있어 **생산 함수만 어긋나** 있었다.
//   [함정] `Number(null) === 0` 이라 `Number.isFinite(Number(x))` 만으로는 null 이 그대로 통과한다.
//   [무엇을 고정하나] 실패는 null 이고, 채점은 아는 항목만으로 하며, null 이 0 점 취급되지 않는다.
test('주변시설: 카카오 키가 없으면 0 이 아니라 null(모름) 을 돌려준다', async () => {
  const kakao = require('../services/kakaoService');
  const saved = process.env.KAKAO_REST_API_KEY;
  delete process.env.KAKAO_REST_API_KEY;   // isKeyMissing 은 호출 시점에 env 를 읽는다 → 네트워크 없음
  try {
    assert.equal(await kakao.countNearby(37.5, 127.0, 'SC4', 1200), null,
      'countNearby 가 키 없음에 0 을 돌려준다 — "학교 0곳" 이라는 사실 주장이 된다');
    assert.equal(await kakao.countNearbyKeyword(37.5, 127.0, '종합병원', 2000), null,
      'countNearbyKeyword 가 키 없음에 0 을 돌려준다');
    const amen = await kakao.getNearbyAmenities(37.5, 127.0);
    assert.ok(amen && typeof amen === 'object', 'getNearbyAmenities 가 객체를 돌려줘야 한다');
    for (const k of ['school', 'mart', 'hospital', 'subway', 'cvs', 'park']) {
      assert.equal(amen[k], null, `amenities.${k} 가 null 이 아니다(${amen[k]}) — 모름이 값으로 샌다`);
    }
  } finally {
    if (saved === undefined) delete process.env.KAKAO_REST_API_KEY;
    else process.env.KAKAO_REST_API_KEY = saved;
  }
});



// ── REG-TABLE-DYNAMIC-2026-09-02 (감사 P1-9 프론트) ─────────────────────────────
//   [왜] 규제 요약 모달의 표가 2025.10.15 수치를 리터럴로 박아둔 정적 HTML 이었다.
//     regulations_snapshot 이 갱신돼도 이 표만 옛 값을 말한다(재배포 없는 갱신이 설계 의도였는데).
//     DB 와 대조한 실측 차이: 생애최초 비규제 80% 행 없음 · 2주택 이상 행 없음 ·
//     생애최초 규제의 15/25억 구간 캡 생략(20억 매수 시 실제 4억인데 표에는 "6억 한도") · 처분조건부 단서 누락.
//   [무엇을 고정하나] index.html 에 실제로 들어간 렌더 IIFE 를 **그대로 꺼내 실행**해서
//     ① 스냅샷이 있으면 그 값으로 그리고 ② 없으면 정적 표로 떨어지고 ③ 값이 이스케이프되는지 확인한다.
test('규제 요약 표: 스냅샷으로 그리되, 미로드 시 정적 표로 떨어진다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const html = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');

  assert.ok(html.indexOf('window.__REG_FULL = d;') >= 0,
    '규제 스냅샷 전문을 보존하지 않는다 — 표를 동적으로 그릴 데이터가 없어진다');

  const marker = html.indexOf('REG-TABLE-DYNAMIC-RENDER');
  assert.ok(marker > 0, '규제 표 동적 렌더러가 사라졌다 — 정적 표로 되돌아갔다');
  const startTok = '${(() => {';
  const s = html.lastIndexOf(startTok, marker);
  const e = html.indexOf('})()}', marker);
  assert.ok(s > 0 && e > s, '렌더러 IIFE 범위를 찾지 못했다 — 테스트를 갱신할 것');
  const body = html.slice(s + startTok.length, e);

  const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const run = (regFull) => new Function('window', '_escHtml', '"use strict"; return (() => {' + body + '})();')({ __REG_FULL: regFull }, esc);

  // ① 스냅샷 기반 렌더 — DB 실측 구조(regulations_snapshot.housing_loan_2025.ltvTable)
  const ltvTable = [
    { condition: '무주택 — 규제지역', ltv: 40, cap: [{ under: 15, max: 6 }, { under: 25, max: 4 }, { over: 25, max: 2 }] },
    { condition: '생애최초 — 규제지역', ltv: 70, note: '6개월 이내 전입 의무', cap: [{ under: 15, max: 6 }, { under: 25, max: 4 }, { over: 25, max: 2 }] },
    { condition: '생애최초 — 비규제', ltv: 80, cap: null },
    { condition: '2주택 이상', ltv: 0, cap: null, note: '규제지역·수도권 구입 불가' },
  ];
  const dyn = run({ ltvTable });
  assert.equal((dyn.match(/<tr>/g) || []).length, 4, '스냅샷 행 수만큼 그려지지 않았다');
  for (const need of ['25억↑ 2억', '생애최초 — 비규제', '2주택 이상', '6개월 이내 전입 의무']) {
    assert.ok(dyn.indexOf(need) >= 0, `표에 "${need}" 가 없다 — 스냅샷 값이 반영되지 않는다`);
  }

  // ② 미로드·빈 스냅샷 → 정적 표 fallback (빈 표를 만들지 않는다)
  for (const empty of [null, undefined, {}, { ltvTable: [] }]) {
    const fb = run(empty);
    assert.ok((fb.match(/<tr>/g) || []).length >= 4, `스냅샷 미로드(${JSON.stringify(empty)})에서 표가 비었다`);
    assert.ok(fb.indexOf('무주택') >= 0, '정적 fallback 내용이 사라졌다');
  }

  // ③ 스냅샷 값은 DB 문자열이다 — 이스케이프 없이 innerHTML 에 들어가면 안 된다
  const evil = run({ ltvTable: [{ condition: '<img src=x onerror=alert(1)>', ltv: 40, cap: null, note: '<b>x</b>' }] });
  assert.equal(evil.indexOf('<img'), -1, '규제 표가 DB 문자열의 태그를 그대로 렌더한다 (XSS)');
  assert.equal(evil.indexOf('<b>x</b>'), -1, 'note 가 이스케이프되지 않는다');
});



// ── SEO-LINKGRAPH-2026-09-02 (감사 P1-8) ──────────────────────────────────────
//   [왜] 사이트맵에 단지 URL 이 15,954개인데 **어떤 페이지도 /apt/* 로 링크하지 않았다**(전수 grep: 앱 0 · SSR 0).
//     내부 링크가 없는 URL 은 크롤 우선순위가 낮다 — 구글 색인이 1페이지에 머문 구조적 이유다.
//     그리고 robots.txt 가 `/share` 를 Disallow 해서, OG 메타를 동적 치환하는 그 라우트를
//     정작 카카오톡·X 링크 미리보기 크롤러가 못 읽었다(운영자 SNS 자동화와 직결).
//   [무엇을 고정하나] 링크 그래프가 다시 끊기는 회귀. 수치가 아니라 **구조**를 본다.
test('SEO: 지역 페이지가 단지 페이지로 내부 링크를 만든다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const src = fs2.readFileSync(path2.join(__dirname, '../routes/regionPage.js'), 'utf8');
  assert.ok(src.indexOf('/apt/') >= 0, '지역 페이지에 /apt 링크가 없다 — 단지 페이지가 링크 그래프 밖으로 나간다');
  assert.ok(/molit_apt_index/.test(src), '단지 목록 조회가 사라졌다');
  // 죽은 링크 방지: /apt 라우트가 받는 형식만 링크해야 한다
  assert.ok(src.indexOf('d{5}-') >= 0, 'apt_seq 형식 필터가 없다 — /apt 가 404 로 거부하는 링크를 뿌릴 수 있다');
});



// ── INTRO-KEY-SYNC-2026-09-02 (감사 P1-7) ──────────────────────────────────────
//   [왜] 랜딩을 벗어나는 두 경로(_landingDismiss·_landingCTA)는 mhl_landing_seen 과 mhl_hero_dismissed 를
//     함께 세팅해 소개 메시지의 중복 노출을 막고 있었다. 그런데 dismissHero 만 반대가 비어 있었다 —
//     공유링크·UTM 으로 들어와 랜딩을 건너뛴 사용자가 히어로만 닫으면 다음 방문에 **랜딩 전면이 다시** 떴다.
//     라이브 실측으로 재현: dismissHero() 호출 후 mhl_hero_dismissed=1 이지만 mhl_landing_seen 은 null.
test('진입 소개: 히어로를 닫으면 랜딩도 본 것으로 기록한다 (같은 메시지 재노출 차단)', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const html = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');
  const i = html.indexOf('function dismissHero()');
  assert.ok(i > 0, 'dismissHero 를 찾지 못했다 — 테스트를 갱신할 것');
  const body = html.slice(i, i + 900);
  assert.ok(body.indexOf("setItem('mhl_hero_dismissed', '1')") >= 0, 'dismissHero 가 히어로 키를 남기지 않는다');
  assert.ok(body.indexOf("setItem('mhl_landing_seen', '1')") >= 0,
    'dismissHero 가 mhl_landing_seen 을 남기지 않는다 — 히어로만 닫은 사용자에게 랜딩이 다시 뜬다');
});



test('진입 소개: 제거된 온보딩 모달(OB)을 기다리는 죽은 코드가 없다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const html = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');
  // id="OB" 는 OB-REMOVE-2026-07-17 에 사라졌다 — 그걸 참조하는 **코드**가 남으면 도달 불가 분기다.
  // ⚠ 단순 문자열 검색은 **이 수정의 설명 주석**까지 잡는다(실제로 한 번 오탐이 났다).
  //   실제 마크업만 보도록 태그 문맥을 요구한다.
  assert.equal(/<[a-zA-Z][^>]*sid="OB"/.test(html), false, 'OB 모달 엘리먼트가 되살아났다 — 이 테스트의 전제를 갱신할 것');
  const i = html.indexOf('function _maybeShowHero()');
  assert.ok(i > 0, '_maybeShowHero 를 찾지 못했다');
  const body = html.slice(i, i + 1600);
  // 주석 줄은 제외하고 실제 코드만 본다(제거 사유를 주석으로 남겨뒀다).
  const code = body.split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.equal(/getElementById\(['\"]OB['\"]\)/.test(code), false,
    '_maybeShowHero 가 다시 OB 를 참조한다 — 항상 null 이라 그 분기는 실행되지 않는다');
  assert.equal(/setInterval/.test(code), false,
    '_maybeShowHero 에 도달 불가 폴링이 되살아났다');
});



// ── QUOTA-NEAR-ONLY-2026-09-02 (감사 P1-7, 운영자 승인) ───────────────────────────
//   [왜] 헤더의 "오늘 남은 검색 5/5 · 채팅 30/30" 이 admin 이 아니면 상시 노출이라,
//     서비스를 처음 연 사람이 가장 먼저 읽는 숫자가 무료 한도였다 — 첫인상이 "제한된 체험판" 이 된다.
//     한도에 근접했을 때만 보이게 바꿨다. 임계값은 새로 만들지 않고 코드에 이미 있던 amber 경고선
//     (검색 잔여 ≤2 · 채팅 ≤3)을 그대로 재사용한다.
//   [무엇을 고정하나] 4가지 상태(여유·검색임박·채팅임박·둘다) + 무제한에서의 표시 조합.
//     한쪽만 보일 때 구분점("·")이 홀로 남는 시각 버그도 함께 막는다.
test('헤더 한도: 근접했을 때만 보이고, 한쪽만 보일 때 구분점이 남지 않는다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const html = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');

  // 항목별 토글이 가능하려면 id 가 있어야 한다(종전엔 wrap 하나뿐이라 개별 제어 자체가 불가능했다).
  for (const id of ['huSearchItem', 'huChatItem', 'huDot', 'huDimLabel']) {
    assert.ok(html.indexOf('id="' + id + '"') > 0, `헤더 한도 항목 id 가 없다: ${id}`);
  }

  // 실제 _syncHUsage 를 꺼내 stub DOM 으로 실행한다.
  const i = html.indexOf('function _syncHUsage()');
  assert.ok(i > 0, '_syncHUsage 를 찾지 못했다 — 테스트를 갱신할 것');
  const end = html.indexOf('function updateQuota(usage){', i);
  assert.ok(end > i, '_syncHUsage 범위를 찾지 못했다');
  const src = html.slice(i, end);

  const run = (unlimited, search, chat) => {
    const els = {};
    for (const id of ['hUsage', 'huSearchItem', 'huChatItem', 'huDot', 'huDimLabel']) els[id] = { style: {} };
    const win = { _quotaUnlimited: unlimited, _quotaNear: { search, chat } };
    const doc = { getElementById: (id) => els[id] || null };
    new Function('document', 'window', src + '; _syncHUsage();')(doc, win);
    const vis = (e) => e.style.display !== 'none';
    return { wrap: vis(els.hUsage), s: vis(els.huSearchItem), c: vis(els.huChatItem), dot: vis(els.huDot), dim: vis(els.huDimLabel) };
  };

  // ① 여유 상태(신규 방문자) — 아무것도 보이지 않는다
  assert.deepEqual(run(false, 5, 30), { wrap: false, s: false, c: false, dot: false, dim: false },
    '한도가 넉넉한데 헤더에 숫자가 노출된다 — 첫인상이 무료 한도가 된다');

  // ② 검색만 임박(잔여 2) — 검색만, 구분점은 숨김
  assert.deepEqual(run(false, 2, 30), { wrap: true, s: true, c: false, dot: false, dim: true },
    '검색 임박인데 표시가 틀렸다(구분점이 홀로 남았을 수 있다)');

  // ③ 채팅만 임박(잔여 3) — 채팅만
  assert.deepEqual(run(false, 5, 3), { wrap: true, s: false, c: true, dot: false, dim: true },
    '채팅 임박인데 표시가 틀렸다');

  // ④ 둘 다 임박 — 구분점 표시
  assert.deepEqual(run(false, 1, 1), { wrap: true, s: true, c: true, dot: true, dim: true },
    '둘 다 임박인데 구분점이 없다');

  // ⑤ 무제한(운영자·관리자) — 종전과 동일하게 숨김
  assert.deepEqual(run(true, null, null), { wrap: false, s: false, c: false, dot: false, dim: false },
    '무제한인데 한도 표시가 뜬다');

  // ⑥ 경계 — 검색 3 은 아직 여유, 2 부터 표시 (amber 임계값과 같은 수)
  assert.equal(run(false, 3, 30).s, false, '검색 잔여 3 은 아직 여유여야 한다');
  assert.equal(run(false, 2, 30).s, true, '검색 잔여 2 부터 보여야 한다');
  assert.equal(run(false, 5, 4).c, false, '채팅 잔여 4 는 아직 여유여야 한다');
  assert.equal(run(false, 5, 3).c, true, '채팅 잔여 3 부터 보여야 한다');
});



// ── PWA-SHORTCUT-2026-09-02 (감사 P2-11) ──────────────────────────────────────
//   [왜] manifest.json 의 바로가기 2개가 `/?view=report`·`/?view=chat` 를 가리키는데
//     `view` 파라미터를 읽는 코드가 **한 줄도 없었다**(전수 grep 0건). 홈 화면에 추가한 사용자가
//     바로가기를 눌러도 그냥 기본 화면이 떴다 — 기능이 있는 척만 하던 상태.
//   [무엇을 고정하나] manifest 가 가리키는 값과 코드가 처리하는 값이 **다시 어긋나지 않게**.
test('PWA 바로가기: manifest 의 view 값을 코드가 실제로 처리한다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const manifest = JSON.parse(fs2.readFileSync(path2.join(__dirname, '../../frontend/manifest.json'), 'utf8'));
  const html = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');

  const shortcuts = manifest.shortcuts || [];
  assert.ok(shortcuts.length > 0, 'PWA 바로가기가 사라졌다 — 이 테스트의 전제를 갱신할 것');

  // 파서가 존재해야 한다
  const i = html.indexOf('function handleViewParam()');
  assert.ok(i > 0, 'view 파라미터 파서가 없다 — manifest 바로가기가 아무 동작도 하지 않는다');
  const fnEnd = html.indexOf(String.fromCharCode(10) + '}', i);
  const body = html.slice(i, fnEnd > i ? fnEnd : i + 1200);

  // 파서가 실제로 호출돼야 한다(정의만 있고 부르지 않는 죽은 코드 방지)
  const callCount = (html.match(/handleViewParam\s*[,(]/g) || []).length;
  assert.ok(callCount >= 2, `handleViewParam 이 호출되지 않는다(출현 ${callCount}회) — 정의만 있는 죽은 코드다`);

  // manifest 의 모든 view 값이 파서에서 다뤄져야 한다
  const unhandled = [];
  for (const s of shortcuts) {
    const m = String(s.url || '').match(/[?&]view=([A-Za-z0-9_-]+)/);
    if (!m) continue;
    const v = m[1];
    const handled = v === 'chat'
      ? body.indexOf("'chat'") >= 0
      : body.indexOf('VIEW_DISPLAY') >= 0;   // 그 외는 VIEW_DISPLAY 화이트리스트로 처리
    if (!handled) unhandled.push(v);
  }
  assert.deepEqual(unhandled, [],
    `manifest 바로가기의 view 값을 코드가 처리하지 않는다: ${unhandled.join(', ')}`);

  // 임의 문자열로 sv() 를 부르지 않는다(화이트리스트 게이트 유지)
  assert.ok(body.indexOf('VIEW_DISPLAY') >= 0,
    'view 값 화이트리스트 검사가 사라졌다 — 임의 파라미터가 sv() 로 들어간다');
});



test('죽은 코드: 호출되지 않던 함수 3종이 되살아나지 않는다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const html = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');
  // 정의가 다시 생기면(=주석이 아니라 실제 function 선언) 실패한다.
  for (const fn of ['_pannMinZoom', 'renderLegacyPriceBars', 'currentYm']) {
    const re = new RegExp('function\\s+' + fn + '\\s*\\(');
    assert.equal(re.test(html), false, `${fn} 정의가 되살아났다 — 호출 0회였던 죽은 함수다`);
  }
});



test('죽은 서비스: 참조 0이던 schoolClusterService 가 되살아나지 않는다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const svc = path2.join(__dirname, '../services/schoolClusterService.js');
  const data = path2.join(__dirname, '../data/schoolClusters.js');
  assert.equal(fs2.existsSync(svc), false,
    'schoolClusterService 가 돌아왔다 — 학군 권역은 절대룰②(공식 출처)로 2026-08-19 퇴역했다');
  assert.equal(fs2.existsSync(data), false, 'schoolClusters 데이터가 돌아왔다');
});



// ── SCOPE-GATE-TRUTH-2026-09-02 (감사 P2) ────────────────────────────────────────
//   [왜] 이 저장소에서 **프로덕션을 세 번 죽인** 결함 클래스는 "매달린 참조"다 — 선언 범위 밖에서
//     식별자를 쓰는 것. 문법검사·계약테스트를 전부 통과하고 런타임에서만 죽는다.
//     그 목적으로 만들어져 있던 scripts/check-inline-scope.js 는 정규식이 `'\b'`(백스페이스 문자)라
//     **한 번도 매치한 적 없는 no-op** 이었다(실측: 선언만 개명해 미선언 상태를 만들어도 0건 보고).
//     실제로 잡는 것은 eslint no-undef 였다(같은 실측에서 사용처 2곳을 정확히 지적).
//   [무엇을 고정하나] 그 lint 배선이 끊기면 이 방어가 통째로 사라진다 — 배선 자체를 계약으로 건다.
test('품질 게이트: 프론트 인라인 JS 가 lint(no-undef)를 실제로 통과하도록 배선돼 있다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const root = path2.join(__dirname, '../..');
  const pkg = JSON.parse(fs2.readFileSync(path2.join(root, 'package.json'), 'utf8'));
  const ci = fs2.readFileSync(path2.join(root, '.github/workflows/ci.yml'), 'utf8');
  const eslintCfg = fs2.readFileSync(path2.join(root, 'eslint.config.mjs'), 'utf8');

  // ① lint 스크립트가 인라인 JS 를 추출해서 eslint 에 넣어야 한다
  const lint = String(pkg.scripts && pkg.scripts.lint || '');
  assert.ok(lint.indexOf('extract-inline-js') >= 0, 'lint 가 인라인 JS 를 추출하지 않는다 — 프론트가 검사 사각지대가 된다');
  assert.ok(/eslint[^&]*\.lint-tmp/.test(lint), 'lint 가 추출된 .lint-tmp 를 검사하지 않는다');

  // ② CI 가 그 스크립트를 실제로 실행해야 한다
  assert.ok(/run:\s*npm run lint/.test(ci), 'CI 에 npm run lint 스텝이 없다 — 로컬에서만 도는 게이트는 게이트가 아니다');

  // ③ no-undef 규칙이 켜져 있어야 한다(이게 매달린 참조를 잡는 실체다)
  assert.ok(/['\"]no-undef['\"]\s*:\s*['\"]error['\"]/.test(eslintCfg),
    'eslint no-undef 가 error 로 켜져 있지 않다 — 런타임에서만 죽는 스코프 오류를 아무도 못 잡는다');

  // ④ 추출기가 index.html 을 실제로 대상에 넣는지(파일명 하드코딩 회귀 방지)
  const ext = fs2.readFileSync(path2.join(root, 'scripts/extract-inline-js.js'), 'utf8');
  assert.ok(ext.indexOf('index') >= 0, '추출기가 index.html 을 대상에서 빠뜨렸다');
});



test('품질 게이트: no-op 로 판명된 스코프 검사기가 되살아나지 않는다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const root = path2.join(__dirname, '../..');
  assert.equal(fs2.existsSync(path2.join(root, 'scripts/check-inline-scope.js')), false,
    'check-inline-scope.js 가 돌아왔다 — 정규식이 백스페이스 문자라 항상 0건을 보고하는 no-op 이었다. '
    + '되살리려면 반드시 \'선언만 개명해 미선언 상태를 만들었을 때 실패하는가\' 를 먼저 실측할 것.');
});



// ── SCHEMA-SNAPSHOT-2026-09-02 (감사 후속) ─────────────────────────────────────
//   [왜] supabase/migrations 만으로는 프로덕션을 재현할 수 없다 — CREATE TABLE 이 어느 파일에도
//     없는 테이블이 9개, 시퀀스 없는 파일이 7개, "이미 적용된 걸 나중에 커밋" 이 8개다.
//     이 저장소는 이미 "파일 존재 ≠ 프로덕션 적용" 으로 3개월짜리 미적용 제약을 겪었다.
//     그래서 pg_catalog 를 직접 읽은 **현재 상태 스냅샷**(supabase/schema.sql)을 뒀다.
//   [무엇을 고정하나] 스냅샷은 방치되면 즉시 거짓말이 된다. 그래서 "코드가 실제로 부르는
//     테이블·RPC 가 스냅샷에 전부 있는가" 를 건다 — 스냅샷이 **중요한 방향으로** 낡으면 깨진다.
//     (2026-09-02 실측: 테이블 28/28, RPC 10/10 일치)
test('스키마 스냅샷: 코드가 참조하는 테이블·RPC 가 supabase/schema.sql 에 전부 선언돼 있다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const root = path2.join(__dirname, '../..');
  const schemaPath = path2.join(root, 'supabase/schema.sql');
  assert.ok(fs2.existsSync(schemaPath), 'supabase/schema.sql 이 사라졌다 — 마이그레이션만으로는 프로덕션을 재현할 수 없다');
  const schema = fs2.readFileSync(schemaPath, 'utf8');

  // 스냅샷이 선언하는 것들
  const declaredTables = new Set();
  for (const m of schema.matchAll(/^create (?:table|materialized view)(?: if not exists)? public\.([a-zA-Z0-9_]+)/gm)) declaredTables.add(m[1]);
  const declaredFns = new Set();
  for (const m of schema.matchAll(/^CREATE OR REPLACE FUNCTION public\.([a-zA-Z0-9_]+)/gm)) declaredFns.add(m[1]);
  assert.ok(declaredTables.size >= 27, `스냅샷 테이블이 비정상적으로 적다(${declaredTables.size}) — 덤프가 잘렸을 수 있다`);

  // 코드가 실제로 부르는 것들 (backend + api 전 소스)
  const srcFiles = [];
  const walk = (dir) => {
    if (!fs2.existsSync(dir)) return;
    for (const e of fs2.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.lint-tmp') continue;
      const fp = path2.join(dir, e.name);
      if (e.isDirectory()) walk(fp);
      else if (/\.(js|mjs|cjs)$/.test(e.name)) srcFiles.push(fp);
    }
  };
  walk(path2.join(root, 'backend'));
  walk(path2.join(root, 'api'));
  const usedTables = new Map();
  const usedFns = new Map();
  for (const fp of srcFiles) {
    const src = fs2.readFileSync(fp, 'utf8');
    for (const m of src.matchAll(/\.from\(\s*['"`]([a-zA-Z0-9_]+)/g)) {
      if (!usedTables.has(m[1])) usedTables.set(m[1], fp);
    }
    for (const m of src.matchAll(/\.rpc\(\s*['"`]([a-zA-Z0-9_]+)/g)) {
      if (!usedFns.has(m[1])) usedFns.set(m[1], fp);
    }
  }
  assert.ok(usedTables.size >= 20, `테이블 참조 수집이 실패했다(${usedTables.size}) — 정규식이 깨졌을 수 있다`);

  const missT = [...usedTables.keys()].filter((x) => !declaredTables.has(x));
  const missF = [...usedFns.keys()].filter((x) => !declaredFns.has(x));
  assert.deepEqual(missT, [], `코드가 쓰는데 스냅샷에 없는 테이블: ${missT.map((x) => x + '(' + usedTables.get(x) + ')').join(', ')} — 스냅샷을 다시 뽑을 것`);
  assert.deepEqual(missF, [], `코드가 쓰는데 스냅샷에 없는 RPC: ${missF.map((x) => x + '(' + usedFns.get(x) + ')').join(', ')} — 스냅샷을 다시 뽑을 것`);
});



// ── TOUCH-TARGET-2026-09-02 (감사 후속: 모바일) ───────────────────────────────
//   [실측] 라이브 375x812 보고서 화면의 조작 요소 18개가 전부 44px 미만이었다(.chip 61개가 39px).
//     오터치는 곧 잘못된 조건 입력이고, 그러면 보고서 결과 자체가 달라진다.
//   [왜 소스 검사인가] CSS 규칙은 "코드의 형태" 자체가 요구사항이라 정규식이 옳은 도구다
//     (실행 대조가 필요한 계산 로직과 다르다).
test('모바일 탭 타깃 — 44px 하한이 모바일에서만, 그리고 .chips 안에만 걸린다', () => {
  const html = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../../frontend/index.html'), 'utf8');
  const i = html.indexOf('TOUCH-TARGET-2026-09-02');
  assert.ok(i > 0, '모바일 탭 타깃 규칙이 사라졌다');
  const block = html.slice(i, i + 1600);

  // ① 모바일 전용이어야 한다 — 전역으로 키우면 칩이 많은 화면이 불필요하게 길어진다
  assert.match(block, /@media\(max-width:700px\){/,
    '모바일 미디어쿼리 안이 아니다');

  // ② ★ .chip 전역이 아니라 .chips 안만. 전역이면 칩 모양 배지까지 눌린 모양이 된다
  assert.match(block, /\.chips \.chip{[^}]*min-height:44px/,
    '.chips 안 칩에 44px 하한이 없다');
  assert.equal(/^\s*\.chip{/m.test(block), false,
    '.chip 을 전역으로 키우고 있다 — 배지가 세로로 쪼개진다(라이브 검증에서 실제로 재현됐다)');

  // ③ ★ 도움말(.wi)에 좌우 여백을 주면 margin-left:auto 때문에 제목을 밀어 줄바꿈시킨다
  const wi = block.match(/\.wchead \.wi[^{]*{([^}]*)}/);
  assert.ok(wi, '.wi 규칙을 찾지 못했다');
  assert.match(wi[1], /padding:8px 0/,
    '.wi 에 좌우 여백이 들어갔다 — 제목이 줄바꿈되고 필수 배지가 세로로 쪼개진다');
});



// ── ESC-SERVER-VALUES-2026-09-05 (감사 H-LOW) ─────────────────────────────────────
test('서버 통제값도 이스케이프 — 청약 sido · 지역 칩 label', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../frontend/index.html'), 'utf8');
  assert.equal((html.match(/\$\{d\.sido\}/g) || []).length, 0, '청약 sido 가 생으로 삽입된다');
  assert.equal((html.match(/\$\{_escHtml\(d\.sido\)\}/g) || []).length, 2);
  assert.ok(html.includes('onclick="cpSub(this)">${_escHtml(g.label)}</span>'), '지역 칩 label 이 생으로 삽입된다');
});



// ── A11Y-LABELS-2026-09-05 (감사 E 접근성: 이름 없는 입력 19개 → 0) ─────────────────
//   [왜 소스 검사인가] "입력에 이름이 있는가"는 마크업의 형태 자체가 요구사항이다.
test('접근성 — 이름 없는 입력 요소 0개 (aria-label · label[for] · 부모 label 중 하나)', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../frontend/index.html'), 'utf8');
  const labelFor = new Set([...html.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map(m => m[1]));
  const re = /<(input|select|textarea)\b([^>]*)>/g;
  const bad = []; let m;
  while ((m = re.exec(html))) {
    const attrs = m[2];
    const type = (attrs.match(/\btype="([^"]+)"/) || [])[1] || '';
    if (['hidden', 'submit', 'button', 'checkbox', 'radio'].includes(type)) continue;
    if (/\baria-label(ledby)?=/.test(attrs) || /\btitle=/.test(attrs)) continue;
    const id = (attrs.match(/\bid="([^"]+)"/) || [])[1];
    if (id && labelFor.has(id)) continue;
    const before = html.slice(Math.max(0, m.index - 400), m.index);
    if (before.lastIndexOf('<label') > before.lastIndexOf('</label>')) continue; // 부모 <label> 로 감싸짐
    bad.push(html.slice(0, m.index).split('\n').length + ':' + m[1] + '#' + (id || '?'));
  }
  assert.deepEqual(bad, [], '이름 없는 입력이 생겼다 — 스크린리더가 "편집 가능 텍스트"라고만 읽는다');
});



// ── ENV-GATE-2026-09-05 (감사 M) ──────────────────────────────────────────────────
test('CI — .env.example 드리프트 검사는 차단 게이트다 (|| true 금지)', () => {
  const ci = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../.github/workflows/ci.yml'), 'utf8');
  const i = ci.indexOf('scripts/check-env-example.js');
  assert.ok(i > 0, 'env.example 검사 스텝이 사라졌다');
  const line = ci.slice(ci.lastIndexOf('\n', i) + 1, ci.indexOf('\n', i));
  assert.equal(/\|\|\s*true/.test(line), false, '.env.example 검사가 다시 비차단이 됐다: ' + line.trim());
});



// ── MASCOT-HIDDEN-2026-09-05 (감사 E·J) ───────────────────────────────────────────
test('브리핑 — "(캐릭터 준비 중)" 플레이스홀더는 사용자에게 보이지 않는다', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../frontend/index.html'), 'utf8');
  const i = html.indexOf('MASCOT-HIDDEN-2026-09-05');
  assert.ok(i > 0, '집킴이 코너 숨김 마커가 사라졌다');
  assert.match(html.slice(i, i + 800), /<div style="margin-top:12px;display:none;/, '집킴이 코너가 다시 보인다(캐릭터 원화 도착 전)');
});



// ── DEAD-ENDPOINTS-2026-09-05 (감사 P2-11: 프론트 호출 0건 엔드포인트 4 + legal 라우터 제거) ─────────
//   [왜 소스 검사인가] "그 경로가 존재하지 않는다" 는 부재 계약이다 — 정규식이 옳은 도구.
test('죽은 엔드포인트는 되살아나지 않는다 — /analysis/total-cost · /properties/info · /regulations/ltv · /api/legal', () => {
  const fs = require('node:fs'), path = require('node:path');
  const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
  assert.equal(/router\.post\('\/total-cost'/.test(read('../routes/analysis.js')), false, 'POST /total-cost 가 되살아났다(프론트 호출 0건)');
  assert.equal(/router\.get\('\/info'/.test(read('../routes/properties.js')), false, 'GET /properties/info 가 되살아났다(/api/search/facility 가 대체)');
  assert.equal(/router\.get\('\/ltv'/.test(read('../routes/regulations.js')), false, 'GET /regulations/ltv 가 되살아났다');
  assert.equal(fs.existsSync(path.join(__dirname, '../routes/legal.js')), false, 'routes/legal.js 가 되살아났다');
  assert.equal(fs.existsSync(path.join(__dirname, '../services/legalCorpusService.js')), false, 'legalCorpusService 가 되살아났다');
  const server = read('../server.js');
  assert.equal(/\/api\/legal'/.test(server), false, 'server.js 가 /api/legal 을 다시 마운트한다');
  assert.equal(/routes\/legal'/.test(server), false, 'server.js 가 routes/legal 을 다시 require 한다');
  // 오라클은 남긴다 — 프론트 취득세 사본과의 1,620조합 대조가 이 함수를 쓴다
  assert.equal(typeof require('../services/analysisService').calcTotalCost, 'function');
});



// ── NO-EMPTY-CATCH-2026-09-05 (감사 P2-12: 빈 catch 44곳 → 0) ───────────────────────────────
//   삼켜야 하는 곳은 "왜" 를 주석으로 남기고, 사용자 결과에 닿는 곳은 logger.warn 을 남긴다.
//   eslint no-empty(allowEmptyCatch:false) 가 같은 것을 막지만, 린트가 꺼지거나 우회돼도 이 테스트가 남는다.
test('백엔드 앱 코드에 빈 catch 블록이 없다', () => {
  const fs = require('node:fs'), path = require('node:path');
  const root = path.join(__dirname, '..');
  const RE = /catch *\((?:_|_e|e)?\) *\{ *\}/;
  const hits = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      if (f === 'node_modules' || f === 'test') continue;
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (!f.endsWith('.js')) continue;
      fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((l, i) => { if (RE.test(l)) hits.push(path.relative(root, p) + ':' + (i + 1)); });
    }
  })(root);
  assert.deepEqual(hits, [], '빈 catch 가 생겼다 — 삼키려면 이유를 주석으로, 아니면 logger.warn: ' + hits.join(', '));
  const eslint = fs.readFileSync(path.join(__dirname, '../../eslint.config.mjs'), 'utf8');
  assert.match(eslint, /'no-empty': \['error', \{ allowEmptyCatch: false \}\]/, 'eslint no-empty 규칙이 빠졌다');
});



// ── PARTIAL-SNAPSHOT-2026-09-05 (감사 G-5: 부분 결손 브리핑 스냅샷을 하루 종일 굳히지 않는다) ─────
//   [행위 테스트] 실제 buildBriefingPayload/getOrCreateSnapshot 을 돌린다. 재료 소스는 require.cache 스텁.
test('브리핑 스냅샷 — 결손 재료는 partial 로 남고, 30분 뒤 더 완전해졌을 때만 덮어쓴다', async () => {
  const R = (p) => require.resolve(p);
  const paths = {
    svc: R('../services/briefingService'), client: R('../db/client'), cache: R('../cache'), news: R('../routes/news'),
    ecos: R('../services/ecosService'), redis: R('../services/redisCache'), pop: R('../services/popularService'),
    rec: R('../services/priceRecordsService'), reg: R('../services/regulationsService'),
  };
  const saved = Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, require.cache[p]]));
  const stub = (p, exports) => { require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  const store = {};
  const admin = {
    from: () => ({
      select: () => ({ eq: (_k, day) => ({ maybeSingle: async () => ({ data: store[day] ? { payload: store[day] } : null }) }) }),
      upsert: async ({ day, payload }) => { store[day] = payload; return {}; },
    }),
  };
  let ecosOk = false;
  try {
    stub(paths.client, { getSupabaseAdmin: () => admin });
    stub(paths.cache, { get: () => undefined, set: () => {} });
    stub(paths.news, { _dataMarketItems: async () => [{ text: '시황 1', src: '테스트' }], _deriveMarketLines: (items) => items.map(i => i.text) });
    stub(paths.ecos, { getEcosRates: async () => { if (!ecosOk) throw new Error('ecos down'); return { baseRate: 2.5, mortgageRate: 3.9, mortgageRateMonth: '202607' }; } });
    stub(paths.redis, { rget: async () => ({ tx: 456561, lastIngestedAt: '2026-09-01T18:08:00Z' }) });
    stub(paths.pop, { readPopularSnapshot: async () => [{ aptName: 'A', sigungu: 'S', dealCount60d: 10 }] });
    stub(paths.rec, { getPriceRecords: async () => ({ highCount: 1, lowCount: 1 }) });
    stub(paths.reg, { getChangeLog: async () => ({ items: [] }) });
    delete require.cache[paths.svc];
    const svc = require('../services/briefingService');
    const today = svc.kstDayString();

    const p1 = await svc.getOrCreateSnapshot(today);
    assert.deepEqual(p1.partial, ['ecos'], '비어 있던 재료(ecos)가 partial 에 남아야 한다');
    assert.equal(p1.ecos, null);
    assert.equal(store[today], p1, '부분 결손이어도 시황이 있으면 저장한다(종전 규칙 유지)');

    ecosOk = true;
    const p2 = await svc.getOrCreateSnapshot(today);
    assert.equal(p2, p1, '30분이 안 지났으면 재시도하지 않는다(요청마다 재계산 금지)');

    store[today] = { ...p1, generatedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() };
    const p3 = await svc.getOrCreateSnapshot(today);
    assert.equal(p3.ecos && p3.ecos.baseRate, 2.5, '30분 뒤 재시도로 금리가 채워져야 한다');
    assert.deepEqual(p3.partial, []);
    assert.equal(store[today], p3, '더 완전해진 스냅샷으로 덮어써야 한다');

    ecosOk = false;
    const stale = { ...p3, ecos: null, partial: ['ecos'], generatedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() };
    store[today] = stale;
    const p4 = await svc.getOrCreateSnapshot(today);
    assert.equal(p4, stale, '더 나아지지 않았으면 기존 스냅샷을 유지한다(덮어쓰기 없음)');

    const past = '2026-01-02';
    const old = { lines: ['x'], partial: ['ecos'], generatedAt: '2026-01-02T00:00:00Z' };
    store[past] = old;
    assert.equal(await svc.getOrCreateSnapshot(past), old, '과거 날짜는 절대 다시 만들지 않는다(아카이브 불변)');
  } finally {
    for (const [k, p] of Object.entries(paths)) { if (saved[k]) require.cache[p] = saved[k]; else delete require.cache[p]; }
  }
});



// ── T0-HERO-2026-09-05 (감사 P1-5, claude.ai/design 시안 코드화: 첫 탭 = 실거래 요약 기본) ──────────
//   [왜 소스 검사인가] 마크업 구조(무엇이 항상 있고, 무엇이 조건부인가) 자체가 요구사항이다.
test('상세 첫 탭 — 실거래 요약이 기본, 점수 없으면 큰 CTA 카드가 아니라 링크 한 줄', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../frontend/index.html'), 'utf8');
  const i = html.indexOf('T0-HERO-2026-09-05: 실거래 요약 히어로');
  assert.ok(i > 0, '히어로 빌더가 사라졌다');
  const blk = html.slice(i, i + 2600);
  // ① 히어로가 점수보다 먼저 그려진다
  assert.match(html, /\$\{_heroSection\}\s*\$\{_scoreSection\}/, '히어로가 첫 자리가 아니다');
  // ② 점수 없음 = 큰 CTA 카드 금지(시안 명세) — score-pending 은 저장소에서 사라져야 한다
  assert.equal(/class="score-pending"/.test(html), false, '"분석 대기" 전면 CTA 카드가 되살아났다 — 검색 진입자의 첫 화면이 다시 dead-end 가 된다');
  assert.match(html, /class="t0-rep-link" onclick="cDM\(\);sv\('report'\)">자금·가족·희망지역을 입력하면/, '보고서 유도 링크 한 줄이 없다');
  // ③ 값이 있는 셀만 — 건수·최근 거래일·준공년도는 각각 값 가드 뒤에서만 push 된다
  assert.match(blk, /if \(_t0DealN > 0\) _t0Cells\.push\(_t0hc\('거래 건수'/, '건수 셀이 값 가드 없이 그려진다(0건이 값처럼 보인다)');
  assert.match(blk, /if \(p\.recentDealDate\) _t0Cells\.push\(_t0hc\('최근 거래일'/, '최근 거래일 셀 가드가 없다');
  assert.match(blk, /if \(p\.buildYear\) _t0Cells\.push\(_t0hc\('준공년도'/, '준공년도 셀 가드가 없다');
  // ④ 평균가 라벨은 경로가 세팅한 _priceBasis — "최근 24개월"·"시간 가중" 같은 창 단정을 하드코딩하면
  //    추천 경로(6개월 가중)에서 거짓 라벨이 된다
  assert.match(blk, /_t0hc\(_escHtml\(p\._priceBasis\|\|'평균 실거래'\)/, '평균가 라벨이 _priceBasis 를 쓰지 않는다');
  const blkCode = blk.split(/\r?\n/).map(l => l.split('//')[0]).join('\n'); // 주석 제외 — 주석이 정규식에 잡힌 사고 5회째
  assert.equal(/24개월|시간 가중/.test(blkCode), false, '히어로가 데이터 창을 단정한다(경로별로 다르다 — 환각)');
  // ⑤ 조회 실패·조회 중 상태 문구는 종전 그대로 유지된다(rg2 를 대체하면서 상태 처리를 잃지 않았는가)
  for (const s of ['일시 조회 실패', '실거래 조회 중…', '최근 실거래 없음', '단지를 다시 열어주세요', '잠시만 기다려주세요', '표시할 거래가 없어요']) {
    assert.ok(blk.includes(s), '상태 문구가 사라졌다: ' + s);
  }
  // ⑥ 옛 rg2 평균가 카드는 히어로가 대체 — t0 에 rg2 잔존 금지(같은 값이 두 번 그려진다)
  assert.equal(/class="rg2"/.test(html), false, 'rg2 카드가 남아 평균가가 두 번 그려진다');
});



// ── PREVIEW-CORS-2026-09-05 ─────────────────────────────────────────────────────
test('CORS — 프리뷰 배포는 자기 호스트(VERCEL_URL·VERCEL_BRANCH_URL)만 추가 허용하고 프로덕션은 그대로', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../server.js'), 'utf8');
  assert.match(src, /if \(process\.env\.VERCEL_ENV === 'preview'\) \{/, '프리뷰 한정 분기가 없다 — 프리뷰 자기 출처 POST 가 500 으로 죽는다');
  assert.match(src, /for \(const h of \[process\.env\.VERCEL_URL, process\.env\.VERCEL_BRANCH_URL\]\)/, '자기 호스트 두 개만 허용해야 한다');
  assert.ok(!/allowedOrigins\.push\('\*'\)|origin: '\*'|origin: true/.test(src), '와일드카드 CORS 가 들어갔다');
  // 프로덕션에서는 분기 밖 로직이 그대로여야 한다
  assert.match(src, /if \(!origin \|\| allowedOrigins\.includes\(origin\)\) return cb\(null, true\);/, '허용 목록 판정이 바뀌었다');
});



// ── TX-PAGE-PAR-2026-09-05 ─────────────────────────────────────────────────────────
test('지역 거래 단일쿼리 — 첫 페이지 단독, 가득 찼으면 다음 4페이지 병렬, 짧은 페이지에서 멈춘다', async () => {
  const dbPath = require.resolve('../db/client');
  const txPath = require.resolve('../services/transactionService');
  const saved = { db: require.cache[dbPath], tx: require.cache[txPath] };
  const ranges = [];
  const total = 2300;
  const mk = (from, n) => Array.from({ length: n }, (_, i) => ({ apt_name: 'x', sigungu: '노원구', umd_nm: '상계동', exclu_use_ar: 84.9, build_year: 1989, floor: 3, deal_year: 2026, deal_month: 8, deal_day: 1, deal_amount: 60000, lawd_cd: '99999', apt_seq: '99999-1', jibun: '1-1' }));
  const q = () => { const s = { select() { return s; }, eq() { return s; }, gte() { return s; }, order() { return s; },
    range(a) { ranges.push(a); const n = Math.max(0, Math.min(1000, total - a)); return Promise.resolve({ data: mk(a, n), error: null }); } }; return s; };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { hasAdminEnv: () => true, getSupabaseAdmin: () => ({ from: () => q() }) } };
  try {
    delete require.cache[txPath];
    const { getRegionRecentTransactions } = require('../services/transactionService');
    require('../cache').del('txregion:99999:6');
    const rows = await getRegionRecentTransactions('99999');
    assert.equal(rows.length, total, '페이지 병합 행수가 다르다');
    assert.deepEqual(ranges, [0, 1000, 2000, 3000, 4000], '첫 페이지 단독 → 4페이지 병렬 순서가 아니다: ' + JSON.stringify(ranges));
    assert.equal(rows[0].jibun, '1-1', 'jibun 매핑이 사라졌다');
  } finally {
    require('../cache').del('txregion:99999:6');
    if (saved.db) require.cache[dbPath] = saved.db; else delete require.cache[dbPath];
    if (saved.tx) require.cache[txPath] = saved.tx; else delete require.cache[txPath];
  }
});



test('.env.example 게이트 — Vercel 자동 주입 변수 VERCEL_BRANCH_URL 은 플랫폼 제공으로 분류된다(CI #911 실패 원인)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../scripts/check-env-example.js'), 'utf8');
  assert.match(src, /'VERCEL_BRANCH_URL',/, 'PLATFORM_PROVIDED 에 VERCEL_BRANCH_URL 이 없다');
  const ex = require('node:fs').readFileSync(require('node:path').join(__dirname, '../.env.example'), 'utf8');
  assert.match(ex, /^RENT_MIN_GAP_MS=/m, 'RENT_MIN_GAP_MS 자리표시자가 .env.example 에 없다');
});



// ── ATTR-ACTIVATION-2026-09-06: 계측 화이트리스트 ↔ 프론트 배선 계약 ───────────────────
//   [왜] 이 저장소는 "백엔드가 4종 이벤트를 받도록 했는데 프론트가 2종만 보낸" 상태가 3개월 방치됐다.
//   배선이 빠지면 관찰할 수 없는 퍼널 구간이 생긴다 — 유입 분석을 원점부터 해야 한다.
//   [무엇을 검증] 화이트리스트의 전 이벤트가 프론트에서 호출되는지, 그리고
//   대량 이벤트 상한이 있는 이벤트(세션당 1회)는 sendOnce 로만 간다.
test('ATTR-ACTIVATION-2026-09-06: 화이트리스트 이벤트가 전부 프론트에서 전송되는지 (배선 계약)', () => {
  const fs = require('node:fs');
  const path = require('node:path');

  const attrSrc = fs.readFileSync(path.join(__dirname, '../routes/attribution.js'), 'utf8');
  const eventsMatch = attrSrc.match(/const EVENTS = new Set\(\[([^\]]+)\]\);/);
  assert.ok(eventsMatch, 'backend/routes/attribution.js 에서 EVENTS 를 찾지 못했다');
  const eventsStr = eventsMatch[1];
  const events = eventsStr.match(/'([^']+)'/g).map(s => s.slice(1, -1));
  assert.ok(events.length >= 4, '화이트리스트가 4종 미만이다');

  const htmlSrc = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  // GATE-LIVE-CALL-2026-09-06 (Plan 060 ⑤): 원문 문자열 존재만 보면 **주석 처리된 호출**도 통과한다
  //   (`sendOnce('report')` 호출 줄을 `//` 로 지워도 pass 249 / fail 0 이었다 — 감사자 실측).
  //   줄 주석을 지운 뒤에 검사한다 — CRLF 라 줄 끝 '\r' 이 남으므로 '$' 없이 '//'~줄 끝까지 지운다
  //   (이 저장소 기존 관례: characterization.test.js 의 TXWINDOW-TWIN-2026-09-06 과 동일 패턴).
  const htmlNoComments = htmlSrc.split('\n').map((l) => l.replace(/\/\/[^\r\n]*/, '')).join('\n');

  for (const e of events) {
    const hasSend = new RegExp(`\\.send\\('${e}'\\)`).test(htmlNoComments);
    const hasSendOnce = new RegExp(`\\.sendOnce\\('${e}'\\)`).test(htmlNoComments);
    assert.ok(hasSend || hasSendOnce, `화이트리스트 이벤트가 프론트에서 발견되지 않음(주석 처리된 호출은 무효): ${e}`);
  }

  assert.ok(new RegExp(`\\.sendOnce\\('search'\\)`).test(htmlNoComments), '상한이 있는 이벤트가 sendOnce 로 보내지지 않음(또는 주석 처리됨)');
  assert.ok(new RegExp(`\\.sendOnce\\('report'\\)`).test(htmlNoComments), '상한이 있는 이벤트가 sendOnce 로 보내지지 않음(또는 주석 처리됨)');

  // 모양만 본다 — 속성명(e.g. _notice)은 안 본다
  assert.ok(/\.some\(function\(r\)\{\s*return\s+r\s*&&\s*!r\./.test(htmlSrc), '검색 전송 가드 모양이 변경됐다 (형태만 감시)');

  // 실행형: 조건식을 함수로 만들어 의미를 단언
  const m = htmlSrc.match(/var _recs = \(data\.recommendations \|\| \[\]\);[\s\S]{0,200}?if \((_recs\.some\([\s\S]*?\))\s*&&\s*window\._attr\)/);
  assert.ok(m, 'frontend 에서 검색 전송 가드를 찾지 못했다 (형태 변경 시 이 테스트도 갱신할 것)');
  const pred = new Function('data', 'var _recs = (data.recommendations || []); return !!(' + m[1] + ');');

  // 테스트 케이스: _notice 응답은 거부, 실제 추천(aptName)은 전송
  assert.strictEqual(pred({ recommendations: [{ _notice: true, aptName: '데이터 일시 조회 실패' }] }), false, '_notice 전용 응답은 거부돼야 함');
  assert.strictEqual(pred({ recommendations: [{ _notice: true }, { _notice: true }] }), false, '_notice만 있는 모든 응답은 거부돼야 함');
  assert.strictEqual(pred({ recommendations: [{ aptName: '반포자이' }] }), true, '실제 추천(aptName 있음)은 전송돼야 함');
  assert.strictEqual(pred({ recommendations: [{ _notice: true }, { aptName: '반포자이' }] }), true, '혼합 응답은 실제 추천 때문에 전송돼야 함');
  assert.strictEqual(pred({ recommendations: [] }), false, '빈 추천 배열은 거부돼야 함');
  assert.strictEqual(pred({}), false, '필드 자체 없음은 거부돼야 함');
});



// ── SELF-HEAL-2026-09-06 (C) ────────────────────────────────────────────────────────
//   [행위 테스트] 개선 실패(같은 결손 반복) 뒤에도 재시도 간격 동안 buildBriefingPayload 가
//   다시 불리지 않는지 확인한다 — 위 PARTIAL-SNAPSHOT 테스트는 cache 를 무조건 미스로 스텁해
//   이 마커를 검증하지 못한다. 여기서는 Map 기반 가짜 cache 로 마커가 실제로 걸리는지 본다.
test('브리핑 스냅샷 — 개선 실패 뒤에는 재시도 간격 동안 buildBriefingPayload 를 다시 부르지 않는다', async () => {
  const R = (p) => require.resolve(p);
  const paths = {
    svc: R('../services/briefingService'), client: R('../db/client'), cache: R('../cache'), news: R('../routes/news'),
    ecos: R('../services/ecosService'), redis: R('../services/redisCache'), pop: R('../services/popularService'),
    rec: R('../services/priceRecordsService'), reg: R('../services/regulationsService'),
  };
  const saved = Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, require.cache[p]]));
  const stub = (p, exports) => { require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  const store = {};
  const admin = {
    from: () => ({
      select: () => ({ eq: (_k, day) => ({ maybeSingle: async () => ({ data: store[day] ? { payload: store[day] } : null }) }) }),
      upsert: async ({ day, payload }) => { store[day] = payload; return {}; },
    }),
  };
  const cacheStore = new Map();
  let buildCalls = 0;
  try {
    stub(paths.client, { getSupabaseAdmin: () => admin });
    stub(paths.cache, {
      get: (k) => (cacheStore.has(k) ? cacheStore.get(k) : undefined),
      set: (k, v) => { cacheStore.set(k, v); return true; },
    });
    stub(paths.news, { _dataMarketItems: async () => { buildCalls++; return [{ text: '시황 1', src: '테스트' }]; }, _deriveMarketLines: (items) => items.map(i => i.text) });
    stub(paths.ecos, { getEcosRates: async () => { throw new Error('ecos down'); } }); // 항상 같은 결손(ecos) — "개선 실패" 를 고정한다
    stub(paths.redis, { rget: async () => ({ tx: 1, lastIngestedAt: '2026-09-01T00:00:00Z' }) });
    stub(paths.pop, { readPopularSnapshot: async () => [{ aptName: 'A', sigungu: 'S', dealCount60d: 1 }] });
    stub(paths.rec, { getPriceRecords: async () => ({ highCount: 1, lowCount: 1 }) });
    stub(paths.reg, { getChangeLog: async () => ({ items: [] }) });
    delete require.cache[paths.svc];
    const svc = require('../services/briefingService');
    const today = svc.kstDayString();

    const old = { lines: ['x'], partial: ['ecos'], generatedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() };
    store[today] = old;

    const p1 = await svc.getOrCreateSnapshot(today);
    assert.equal(buildCalls, 1, '재시도 조건(30분 경과+결손)을 만족하면 첫 호출은 재계산을 시도해야 한다');
    assert.equal(p1, old, '개선에 실패했으므로 기존 스냅샷을 그대로 반환해야 한다');

    const p2 = await svc.getOrCreateSnapshot(today);
    assert.equal(buildCalls, 1, '재시도 간격 안에는 개선 실패 뒤에도 buildBriefingPayload 를 다시 부르면 안 된다(무한 재계산 방지)');
    assert.equal(p2, old, '재시도가 생략되는 동안에는 기존 스냅샷을 그대로 반환해야 한다');
  } finally {
    for (const [k, p] of Object.entries(paths)) { if (saved[k]) require.cache[p] = saved[k]; else delete require.cache[p]; }
  }
});



test('브리핑 스냅샷 — buildBriefingPayload 구성요소 실패 시에도 재시도 마커는 먼저 심어진다', async () => {
  // ⚠ SELF-HEAL-2026-09-06: 마커 순서 (E) 주입 검증.
  //   buildBriefingPayload 내부의 일부 요소(_dataMarketItems)가 실패하면, 그것이 예외로 표현될 수 있다.
  //   이때 마커를 buildBriefingPayload 호출 **전에** 심어야, 재계산 실패 후에도
  //   다음 호출이 buildBriefingPayload 를 다시 부르지 않는다 (30분 간격 유지).
  //   buildBriefingPayload 는 내부 try/catch 로 모든 실패를 부분 결손으로 변환하므로,
  //   일부만 실패해도 반환값은 항상 { ..., partial: [...] } 형태다 — 단 반환된다.
  const R = (p) => require.resolve(p);
  const paths = {
    svc: R('../services/briefingService'), client: R('../db/client'), cache: R('../cache'), news: R('../routes/news'),
    ecos: R('../services/ecosService'), redis: R('../services/redisCache'), pop: R('../services/popularService'),
    rec: R('../services/priceRecordsService'), reg: R('../services/regulationsService'),
  };
  const saved = Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, require.cache[p]]));
  const stub = (p, exports) => { require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  const store = {};
  const admin = {
    from: () => ({
      select: () => ({ eq: (_k, day) => ({ maybeSingle: async () => ({ data: store[day] ? { payload: store[day] } : null }) }) }),
      upsert: async ({ day, payload }) => { store[day] = payload; return {}; },
    }),
  };
  const cacheStore = new Map();
  let buildCalls = 0;
  try {
    stub(paths.client, { getSupabaseAdmin: () => admin });
    stub(paths.cache, {
      get: (k) => (cacheStore.has(k) ? cacheStore.get(k) : undefined),
      set: (k, v) => { cacheStore.set(k, v); return true; },
    });
    stub(paths.news, {
      _dataMarketItems: async () => { buildCalls++; throw new Error('news 조회 실패'); },
      _deriveMarketLines: (items) => items.map(i => i.text)
    });
    stub(paths.ecos, { getEcosRates: async () => ({ baseRate: 3.5, mortgageRate: 5.2 }) });
    stub(paths.redis, { rget: async () => ({ tx: 1, lastIngestedAt: '2026-09-01T00:00:00Z' }) });
    stub(paths.pop, { readPopularSnapshot: async () => [{ aptName: 'A', sigungu: 'S', dealCount60d: 1 }] });
    stub(paths.rec, { getPriceRecords: async () => ({ highCount: 1, lowCount: 1 }) });
    stub(paths.reg, { getChangeLog: async () => ({ items: [] }) });
    delete require.cache[paths.svc];
    const svc = require('../services/briefingService');
    const today = svc.kstDayString();

    const old = { lines: [], partial: ['lines', 'ecos'], generatedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() };
    store[today] = old;

    const p1 = await svc.getOrCreateSnapshot(today);
    assert.equal(buildCalls, 1, '첫 호출은 buildBriefingPayload 를 호출했어야 한다');
    // buildBriefingPayload 가 _dataMarketItems 실패를 내부 처리하고 partial 이 있는 객체를 반환한다.
    // p1.partial 이 old.partial 보다 많으므로(lines+ecos), 개선 실패로 판정해 stored 를 반환한다.
    assert.equal(p1, old, '개선 실패(partial 감소 없음)이므로 저장된 스냅샷을 그대로 반환해야 한다');

    const p2 = await svc.getOrCreateSnapshot(today);
    assert.equal(buildCalls, 1, '재시도 마커가 있으므로 두 번째 호출은 buildBriefingPayload 를 부르지 않아야 한다');
    assert.equal(p2, old, '재시도 마커로 인해 stored 를 반환해야 한다');
  } finally {
    for (const [k, p] of Object.entries(paths)) { if (saved[k]) require.cache[p] = saved[k]; else delete require.cache[p]; }
  }
});


test('Plan 049: 문서 드리프트 방지 — 삭제된 엔드포인트·서비스·스크립트', async (t) => {
  const fs = require('fs');
  const path = require('path');

  // 1. README.md 에 삭제된 엔드포인트 3개가 없다 (경로만 검사)
  const readme = fs.readFileSync(path.join(__dirname, '../../README.md'), 'utf8');

  // 금지 문자열 직접 사용 회피 — 경로만 체크
  const p1 = ['/api/properties', 'info'].join('/');
  const p2 = ['/api/regulations', 'ltv'].join('/');
  const p3 = ['/api/analysis', 'total-cost'].join('/');

  assert(!readme.includes(p1), `README 에 삭제된 경로 ${p1} 이 있음`);
  assert(!readme.includes(p2), `README 에 삭제된 경로 ${p2} 이 있음`);
  assert(!readme.includes(p3), `README 에 삭제된 경로 ${p3} 이 있음`);

  // 2. README 가 cron 개수를 숫자로 적지 않기로 했으므로, vercel.json 과의 일치 검증은 생략.
  // (이유: 줄번호처럼 반복적으로 낡는다 — Plan 049 Step 4.2)

  // 3. CLAUDE.md 에 삭제된 서비스·라우터 이름이 살아 있는 것처럼 나오지 않는다
  const claude = fs.readFileSync(path.join(__dirname, '../../CLAUDE.md'), 'utf8');

  const svc1 = ['school', 'ClusterService'].join('');
  const svc2 = ['legal', 'CorpusService'].join('');
  const route = ['/api/legal', '/'].join('');

  assert(!claude.includes(svc1), `CLAUDE.md 에 ${svc1} 이 남아있음`);
  assert(!claude.includes(svc2), `CLAUDE.md 에 ${svc2} 이 남아있음`);
  assert(!claude.includes(route), `CLAUDE.md 에 ${route} 이 남아있음`);

  // 4. 루트 package.json 에 verify 스크립트 있고, 6종 게이트 전부
  //    (Plan 050: backend test 게이트가 `npm --prefix backend test` 직접 호출에서
  //     `run-backend-tests-utc.js` 래퍼 경유로 바뀌었다 — TZ=UTC 계약은 아래 별도
  //     테스트에서 더 구체적으로 고정한다.)
  const pkgPath = path.join(__dirname, '../../package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  assert(pkg.scripts && pkg.scripts.verify, 'package.json 에 verify 스크립트 없음');

  const verify = pkg.scripts.verify;
  const gates = [
    'npm run lint',
    'check-json-config',
    'check-deps-sync',
    'check-env-example',
    'security-regression-check',
    'run-backend-tests-utc'
  ];

  for (const gate of gates) {
    assert(verify.includes(gate), `verify 에 게이트 '${gate}' 없음`);
  }
});



// ── Plan 050 (2026-09-06): verify 가 backend 테스트를 TZ=UTC 로 돌리는지 계약 고정 ──────
//   왜 추가하나: 프로덕션(Vercel) 런타임은 TZ=UTC 고정인데 개발 호스트는 Asia/Seoul(KST) 이다.
//   `npm run verify` 가 호스트 TZ 로만 backend 테스트를 돌리면, host-local getter 를 쓰는
//   회귀(rentService.monthsWindow 실사고, Plan 047)를 로컬에서 절대 못 잡는다 — "로컬 통과는
//   CI 초록의 근거가 아니다"가 여기서도 재발할 수 있다. `TZ=UTC npm test` 는 POSIX 셸 문법이라
//   Windows cmd.exe(npm 기본 script-shell)에서 동작하지 않으므로, 이 저장소는 작은 Node 래퍼
//   (scripts/run-backend-tests-utc.js)로 child_process 를 TZ=UTC 환경에서 spawn 한다.
//   누군가 나중에 verify 에서 이 래퍼를 빼고 다시 `npm --prefix backend test` 로 되돌리면
//   여기서 잡는다.
test('Plan 050: verify 가 backend 테스트를 TZ=UTC 로 실행한다 (호스트 TZ 직접 실행이 아니다)', () => {
  const fs = require('fs');
  const path = require('path');
  const pkgPath = path.join(__dirname, '../../package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const verify = pkg.scripts && pkg.scripts.verify;

  assert.ok(verify, 'package.json 에 verify 스크립트 없음');
  assert.ok(
    verify.includes('run-backend-tests-utc'),
    'verify 가 backend 테스트를 run-backend-tests-utc 래퍼 경유로 돌리지 않는다 — ' +
      '호스트 TZ 직접 실행(npm --prefix backend test 등)으로 되돌아간 것으로 보인다'
  );
  assert.ok(
    !/\bTZ=UTC\s+npm\b/.test(verify),
    'verify 가 POSIX 전용 `TZ=UTC npm ...` 문법을 직접 쓰고 있다 — Windows cmd.exe(npm 기본 ' +
      'script-shell)에서 깨진다. child_process 래퍼(run-backend-tests-utc.js)를 경유할 것'
  );

  // 래퍼 스크립트 자체가 TZ 를 실제로 UTC 로 덮어쓰는지 소스에서 고정 (문자열 존재만으로는
  // "덮어쓴다"는 보장이 안 되므로, env 조립 지점과 'UTC' 리터럴이 같이 있는지 확인한다).
  const wrapperPath = path.join(__dirname, '../../scripts/run-backend-tests-utc.js');
  assert.ok(fs.existsSync(wrapperPath), 'scripts/run-backend-tests-utc.js 가 없다');
  const wrapperSrc = fs.readFileSync(wrapperPath, 'utf8');
  assert.match(
    wrapperSrc,
    /TZ:\s*['"]UTC['"]/,
    'run-backend-tests-utc.js 가 자식 프로세스 env 에 TZ: \'UTC\' 를 심지 않는다'
  );
  assert.match(
    wrapperSrc,
    /require\(['"]child_process['"]\)/,
    'run-backend-tests-utc.js 가 child_process 를 쓰지 않는다 — 셸 문법(TZ=UTC cmd) 로 되돌아간 것으로 보인다'
  );
});



test('GATE-STUB-CONTAMINATION-2026-09-06: 위 테스트 직후에도 writeAudit 이 db/client 스텁에 오염되지 않는다', async () => {
  // 이 테스트는 반드시 바로 위 테스트 **다음**에 있어야 의미가 있다(순서 의존) — 바로 위
  // 테스트가 db/client 를 스텁하는 동안 middleware/auditLog.js 가 그 스텁을 클로저에 가두면,
  // 그 다음으로 auditLog 를 쓰는 코드가 바로 이 테스트다. writeAudit 은 실패를 내부에서 삼키므로
  // (파일 상단 "장애 허용" 설계) 예외 발생 여부로는 오염을 못 잡는다 — logger.warn 호출 인자를
  // 가로채 실제로 흘러간 에러 메시지를 확인한다. 오염됐다면 db/client 미설정 메시지
  // ('Supabase 미설정 — …') 대신 스텁의 '이 테스트에서 사용되지 않아야 한다' 가 찍힌다.
  const logger = require('../logger');
  const origWarn = logger.warn;
  let captured = null;
  logger.warn = (obj) => { captured = obj; };
  try {
    const { writeAudit } = require('../middleware/auditLog');
    await writeAudit({ headers: {}, ip: '127.0.0.1' }, 'test.probe', 'test', 'probe-id', {});
  } finally {
    logger.warn = origWarn;
  }
  if (captured) {
    assert.notEqual(captured.err, '이 테스트에서 사용되지 않아야 한다',
      'auditLog 가 위 테스트의 db/client 스텁을 영구히 클로저에 가두고 있다(require.cache 전이 오염)');
  }
});



test('aptNameMatch — 순수 함수 고정 (Plan 051 Step 1)', () => {
  const { normalizeName, siblingKey, groupSiblings, dice, stripAptSuffix } = require('../utils/aptNameMatch');

  // normalizeName: %·_ 제거 + 공백 전부 제거. 소문자화하지 않는다.
  assert.equal(normalizeName('공릉 풍림아이원'), '공릉풍림아이원');
  assert.equal(normalizeName('%자이_'), '자이');
  assert.equal(normalizeName(null), '');

  // siblingKey: <stem 2자+><단일 접미문자> 형태만 값을 준다.
  assert.deepEqual(siblingKey('풍림아파트A'), { stem: '풍림아파트', suffix: 'A' });
  assert.equal(siblingKey('은마'), null, '길이가 짧아 stem+접미문자로 쪼갤 수 없다');
  assert.equal(siblingKey('현대'), null);

  // groupSiblings — 계획서 Step 1 의 3케이스 그대로.
  assert.deepEqual(groupSiblings([{ apt_name: '태강CITY', build_year: 2018 }, { apt_name: '태강CITY', build_year: 2016 }]), [],
    '접미문자가 같은(=이름이 동일한) 행은 형제가 아니다');
  assert.deepEqual(groupSiblings([{ apt_name: '현대A', build_year: 1995 }, { apt_name: '현대C', build_year: 1996 }]), [],
    'build_year 가 다르면 형제가 아니다(남양주 현대A/C/D 오매칭 방지)');
  const g = groupSiblings([{ apt_name: '풍림아파트A', build_year: 2001 }, { apt_name: '풍림아파트B', build_year: 2001 }]);
  assert.equal(g.length, 1, '운영자 사례(풍림아파트A/B)는 그룹 1개여야 한다');
  assert.deepEqual(g[0], { stem: '풍림아파트', names: ['풍림아파트A', '풍림아파트B'], buildYear: 2001 });

  // stripAptSuffix — chatDataRouter 의 옛 동작과 동일해야 한다(이전 검증).
  assert.equal(stripAptSuffix('은마아파트'), '은마');
  assert.equal(stripAptSuffix('신동아아파트1'), '신동아아파트1', '중간에 낀 아파트는 보존');

  // dice — IDENTITY-GATE 예시: 유사도가 높아도(0.7+) 자동 채택 판정에 쓰면 안 된다는
  //   것은 아래 별도 소스 계약 테스트가 확인한다. 여기서는 값 산출만 고정.
  assert.ok(dice('강일리버파크11단지', '강일리버파크1단지') > 0.7, '두 단지는 실제로 유사도가 높다 — 그래서 위험하다');
  assert.equal(dice('', '아무거나'), 0);
  assert.equal(dice('은마', '은마'), 1);
});



test('Plan 056 ①-a: pctHtml — 041 이 지운 등급 표현이 프론트 사본에서도 사라졌다', () => {
  for (const pct of [20, 50, 80]) {
    const html = _plan056RunPct(pct);
    for (const banned of ['시세 하단 구간', '시세 중간 구간', '시세 상단 구간']) {
      assert.equal(html.indexOf(banned), -1, `pct=${pct}: 등급 표현 "${banned}" 이 되살아났다`);
    }
  }
});



test('Plan 056 ①-a: pctHtml — 등급 표현을 지워도 백분위 수치·신뢰구간·표본 건수는 그대로다', () => {
  const low = _plan056RunPct(20);
  assert.ok(low.indexOf('하위 20%') >= 0, '백분위 라벨(하위 20%)이 사라졌다');
  assert.ok(low.indexOf('95% 신뢰 구간 15~25%') >= 0, '신뢰구간 수치가 사라졌다');
  assert.ok(low.indexOf('표본 40건') >= 0, '표본 건수가 사라졌다');

  const high = _plan056RunPct(80);
  assert.ok(high.indexOf('상위 20%') >= 0, '50% 초과 시 상위 % 전환(PCT-LABEL-2026-07-15)이 사라졌다');
});



test('Plan 056 ①-b: gapHtml — green/yellow 등급 라벨은 사라지고 red 위험 고지는 유지된다', () => {
  const green = _plan056RunGap(70);
  assert.equal(green.indexOf('역전세 위험 낮음'), -1, 'green 등급 라벨이 되살아났다');

  const yellow = _plan056RunGap(50);
  assert.equal(yellow.indexOf('보통'), -1, 'yellow 등급 라벨이 되살아났다');

  const red = _plan056RunGap(40);
  assert.ok(red.indexOf('역전세 위험 확인 필요') >= 0,
    'red 의 위험 고지(041 이 의도적으로 남긴 문구, 백엔드와 같은 판단)가 사라졌다');

  // 수치 자체는 등급 판정과 무관하게 항상 그대로 나온다.
  for (const rate of [70, 50, 40]) {
    const out = _plan056RunGap(rate);
    assert.ok(out.indexOf(`${rate}%`) >= 0, `jeonseRate=${rate}: 수치 자체가 사라졌다`);
  }
});



test('Plan 056 ②: 모바일 하단 시트 — dealCount 없이 dealCount6m 만 있어도 거래 건수가 표시된다', () => {
  // 추천 응답 형태: dealCount 는 undefined, dealCount6m 만 있다 — T0-HERO-FIELD-2026-09-06 과 같은 상황.
  const recLike = { buildYear: 2005, dealCount6m: 7 };
  const meta = _plan056RunSheetMeta(recLike, 'search');
  assert.ok(meta.indexOf('거래 7건') >= 0,
    '추천 응답 형태(dealCount6m 만 있음)에서 거래 건수가 하단 시트 meta 에 나오지 않는다');

  // 검색·지도 응답 형태: dealCount 가 있으면 그것을 우선한다(기존 동작 유지, ?? 는 좌항이 있으면 좌항).
  const searchLike = { buildYear: 2005, dealCount: 3, dealCount6m: 99 };
  const meta2 = _plan056RunSheetMeta(searchLike, 'search');
  assert.ok(meta2.indexOf('거래 3건') >= 0, 'dealCount 가 있는데 dealCount6m 이 대신 쓰였다');

  // 0건은 유효한 값이다(?? 를 쓰는 이유) — || 였다면 0 도 "없음"으로 뭉개진다.
  const zeroLike = { buildYear: 2005, dealCount: 0, dealCount6m: 5 };
  const meta3 = _plan056RunSheetMeta(zeroLike, 'search');
  assert.equal(meta3.indexOf('거래 0건') >= 0, false, '0건은 표시하지 않는 기존 동작(빈 문자열)이 바뀌었다');
  assert.equal(meta3.indexOf('거래 5건'), -1, 'dealCount=0(유효값)인데 dealCount6m 으로 넘어갔다 — ??/|| 혼동');

  // 인기 단지(pop) 경로는 dealCount60d 를 쓴다 — 이 경로는 건드리지 않는다.
  const popLike = { buildYear: 2005, dealCount60d: 12, dealCount: 999 };
  const meta4 = _plan056RunSheetMeta(popLike, 'pop');
  assert.ok(meta4.indexOf('60일 12건') >= 0, 'pop 경로가 dealCount60d 대신 다른 필드를 썼다');
});



test('Plan 056 ⑤: 절대 룰 ① — pctHtml·gap-grid 카드 어디에도 매수 권유·가격 예측 표현이 없다', () => {
  const banned = /매수|매도|사세요|파세요|오를|내릴|상승할|하락할/;
  for (const pct of [20, 50, 80]) {
    const html = _plan056RunPct(pct);
    assert.equal(banned.test(html), false, `pctHtml(pct=${pct})에 금지 표현이 있다`);
  }
  // gapHtml 전체에는 041 이전부터 있던 역전세 시뮬레이터의 규제 고지문(예: "규제지역 추가 매수 제한")이
  // 포함돼 "매수" 라는 단어 자체가 정당하게 나온다 — 그건 매수 "권유"가 아니라 매수 "제한" 규제 설명이다.
  // 이번 계획이 실제로 건드린 gap-grid 카드(전세가율·갭) 구간만 좁혀서 검사한다.
  for (const rate of [70, 50, 40]) {
    const html = _plan056RunGap(rate);
    const simIdx = html.indexOf('역전세 시뮬레이터');
    assert.ok(simIdx > 0, `gapHtml(rate=${rate}): 역전세 시뮬레이터 섹션을 못 찾았다 — 구조가 바뀌었다`);
    const gridPart = html.slice(0, simIdx);
    assert.equal(banned.test(gridPart), false, `gap-grid(rate=${rate})에 금지 표현이 있다`);
  }
});



test('Plan 061 ①: sendOnce — 정상 sessionStorage 면 5회 호출해도 send 는 1회(정상 경로 회귀 없음)', () => {
  const sends = [];
  const obj = { send: (e) => sends.push(e) };
  const fn = _plan061SendOnceFn(_plan061NormalStorage(), Object.create(null));
  for (let i = 0; i < 5; i++) fn.call(obj, 'search');
  assert.equal(sends.length, 1, `정상 스토리지인데 send 가 ${sends.length}회 호출됐다`);
});



test('Plan 061 ②: sendOnce — setItem 만 throw 해도(사파리 프라이빗 계열) 인메모리 폴백으로 send 는 1회', () => {
  const sends = [];
  const obj = { send: (e) => sends.push(e) };
  const fn = _plan061SendOnceFn(_plan061SetItemThrows(), Object.create(null));
  for (let i = 0; i < 5; i++) fn.call(obj, 'search');
  assert.equal(sends.length, 1, `setItem 만 throw 하는데 send 가 ${sends.length}회 호출됐다(수정 전 결함=5회)`);
});



test('Plan 061 ③: sendOnce — getItem 부터 throw 해도(사이트 데이터 전면 차단) 인메모리 폴백으로 send 는 1회', () => {
  const sends = [];
  const obj = { send: (e) => sends.push(e) };
  const fn = _plan061SendOnceFn(_plan061GetItemThrows(), Object.create(null));
  for (let i = 0; i < 5; i++) fn.call(obj, 'search');
  assert.equal(sends.length, 1, `getItem 부터 throw 하는데 send 가 ${sends.length}회 호출됐다(수정 전 결함=5회)`);
});



test('Plan 061 ④: sendOnce — 스토리지 차단 상태에서도 서로 다른 이벤트는 각각 독립으로 1회씩 보낸다', () => {
  const sends = [];
  const obj = { send: (e) => sends.push(e) };
  const mem = Object.create(null);
  const fn = _plan061SendOnceFn(_plan061GetItemThrows(), mem);
  fn.call(obj, 'search'); fn.call(obj, 'search');
  fn.call(obj, 'report'); fn.call(obj, 'report');
  fn.call(obj, 'search');
  assert.deepEqual(sends, ['search', 'report'], `이벤트별 독립 가드가 깨졌다: ${JSON.stringify(sends)}`);
});



test('Plan 061 ⑤: sendOnce 주변에 "가드 없이 1회 보낸다" 라는 사실과 다른 옛 주석이 더 이상 없다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const fe = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');
  // ⚠ 줄 주석을 지우면 검사 대상(주석 문구 자체)까지 사라져 이 테스트가 무력화된다 — 그래서
  // 여기서는 줄 주석 제거 없이, 옛 catch 블록의 정확한 원문(따옴표·괄호·em dash 포함)을
  // 문자열 그대로 탐색한다. 이 정확한 문구는 이 계획의 정정 설명(재인용 시에도 표현을 바꿔 씀)
  // 어디에도 다시 등장하지 않는다 — 마커 자기충돌(6회 재발 이력) 없이 옛 문구의 생존만 잡아낸다.
  const OLD_FALSE_CATCH = "catch(_){ /* sessionStorage 불가(프라이빗 모드 등) — 가드 없이 1회 보낸다 */ }";
  assert.equal(fe.includes(OLD_FALSE_CATCH), false,
    '옛 catch 블록의 사실과 다른 인라인 주석("가드 없이 1회 보낸다")이 그대로 남아 있다');
  assert.match(fe, /SENDONCE-MEMFALLBACK-2026-09-06/,
    '인메모리 폴백을 설명하는 정정 마커 주석이 없다');
});
