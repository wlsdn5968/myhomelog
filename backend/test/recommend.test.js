/**
 * backend/test/recommend.test.js
 *
 * characterization.test.js(Plan 066, 10,056줄·327 test 단일 파일)를 도메인별로 분할한 조각.
 * 동작을 하나도 바꾸지 않는 이동이다 — 테스트 이름·개수·본문은 원본과 동일하다.
 * 공용 목/스텁 유틸은 ./_helpers 에서 가져온다. 새 테스트는 이 파일의 주제와 맞으면 여기에,
 * 아니면 backend/test/README.md 규칙대로 새 도메인 파일을 만든다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LAWD, _reportFn, _withRecStubs } = require('../testSupport/_helpers');



test('getDistrictTier — 행정구 위계는 lawd_cd 로만 판정한다 (동명 구 오표기 실사고)', () => {
  const getDistrictTier = _reportFn('getDistrictTier');

  // 서울(lawd_cd 11 접두) — 등급이 실제로 붙는다
  assert.deepEqual(getDistrictTier('강남구', LAWD.강남구), { tier: '강남3구', bonus: 20 });
  assert.deepEqual(getDistrictTier('마포구', LAWD.마포구), { tier: '마용성광', bonus: 16 });
  assert.deepEqual(getDistrictTier('양천구', LAWD.양천구), { tier: '서울 핵심구', bonus: 10 });
  assert.deepEqual(getDistrictTier('노원구', LAWD.노원구), { tier: '서울 외곽구', bonus: 2 });

  // ★ 실사고 재발 차단: 지방 광역시 구에 '서울 …' 라벨이 붙으면 안 된다.
  //   MOLIT sigungu 에는 광역 접두가 없어 이름만 보면 서울 구와 구별할 수 없다.
  assert.deepEqual(getDistrictTier('해운대구', LAWD.해운대구), { tier: '기타', bonus: 0 });
  assert.deepEqual(getDistrictTier('수성구', LAWD.수성구), { tier: '기타', bonus: 0 });
  assert.deepEqual(getDistrictTier('연수구', LAWD.연수구), { tier: '기타', bonus: 0 });

  // ★ 완전 동명 구 — 문자열로는 원리적으로 구별 불가능한 조합
  assert.deepEqual(getDistrictTier('중구', LAWD.서울중구), { tier: '서울 외곽구', bonus: 2 });
  assert.deepEqual(getDistrictTier('중구', LAWD.부산중구), { tier: '기타', bonus: 0 });
  assert.deepEqual(getDistrictTier('서구', LAWD.부산서구), { tier: '기타', bonus: 0 });
  assert.deepEqual(getDistrictTier('서구', LAWD.인천서구), { tier: '기타', bonus: 0 });

  // lawd_cd 가 없으면 서울로 단정하지 않는다 — 틀린 단정보다 미표기(절대룰 ②)
  assert.deepEqual(getDistrictTier('강남구', ''), { tier: '기타', bonus: 0 });
  assert.deepEqual(getDistrictTier('강남구', null), { tier: '기타', bonus: 0 });
  assert.deepEqual(getDistrictTier('강남구', undefined), { tier: '기타', bonus: 0 });
  // sigungu 자체가 없을 때도 예외 없이 '기타'(molit_transactions.sigungu 는 nullable — 실측)
  assert.deepEqual(getDistrictTier(null, LAWD.강남구), { tier: '기타', bonus: 0 });

  // 경기 과천·분당·판교는 **의도적으로** 문자열 매칭이다(report.js:667 — 동명 지역이 없어 안전).
  //   lawd_cd 에 의존하지 않는다는 것 자체가 계약이므로 코드 유무 양쪽을 고정한다.
  assert.deepEqual(getDistrictTier('과천시', LAWD.과천시), { tier: '분당·과천·판교', bonus: 12 });
  assert.deepEqual(getDistrictTier('분당구', ''), { tier: '분당·과천·판교', bonus: 12 });
});



test('getRegulationPenalty — 서울 외 지역을 규제지역으로 단정하지 않는다 (금전 오판 차단)', () => {
  const getRegulationPenalty = _reportFn('getRegulationPenalty');

  assert.deepEqual(getRegulationPenalty('강남구', LAWD.강남구), { status: '투기과열·토허구역 일부', bonus: -8 });
  assert.deepEqual(getRegulationPenalty('노원구', LAWD.노원구), { status: '조정대상지역', bonus: -3 });
  assert.deepEqual(getRegulationPenalty('중구', LAWD.서울중구), { status: '조정대상지역', bonus: -3 });

  // ★ 지방은 코드만으로 규제 여부를 단정할 수 없다 → '미확인'(화면에서 라벨 생략)
  assert.deepEqual(getRegulationPenalty('해운대구', LAWD.해운대구), { status: '미확인', bonus: 0 });
  assert.deepEqual(getRegulationPenalty('수성구', LAWD.수성구), { status: '미확인', bonus: 0 });
  assert.deepEqual(getRegulationPenalty('중구', LAWD.부산중구), { status: '미확인', bonus: 0 });
  assert.deepEqual(getRegulationPenalty('서구', LAWD.인천서구), { status: '미확인', bonus: 0 });
  assert.deepEqual(getRegulationPenalty(null, LAWD.강남구), { status: '미확인', bonus: 0 });

  // ★ lawd_cd 가 없으면 '미확인' 이다 — REG-UNKNOWN-2026-08-16 (감사 #9).
  //   예전엔 여기서 '비규제' 가 나왔고 이 테스트가 그 값을 **정답으로 고정**하고 있었다.
  //   그런데 `regulation` 필드는 '미확인' 이면 null 로 생략되지만 '비규제' 는 화면에 그대로 뜬다
  //   (report.js:908). 즉 코드 없이 부르면 강남구에 "비규제" 라는 **사실 아닌 라벨**이 붙는다.
  //   코드가 없다는 건 "규제가 아니다" 가 아니라 "판정할 근거가 없다" 는 뜻이다(절대룰 ②).
  //   ⚠ 현재 이 분기는 **도달 불가**다(apt_master 14,405행 중 lawd_cd 결측 0건 실측).
  //     그래서 이 수정의 회귀 위험은 0이고, 훗날 코드 없는 호출부가 생겼을 때의 방어로만 존재한다.
  assert.deepEqual(getRegulationPenalty('강남구', ''), { status: '미확인', bonus: 0 });
  assert.deepEqual(getRegulationPenalty('강남구', null), { status: '미확인', bonus: 0 });

  // ★★ Plan 027 (2026-08-16): 이 함수는 규제 판정의 **네 번째 사본**이었고, 프론트 두 함수가
  //   스냅샷을 따라가게 된 뒤에도 여기만 "서울=조정대상" 을 하드코딩하고 있었다.
  //   ⚠ 그리고 **이 테스트가 그 하드코딩을 정답으로 고정**하고 있었다(감사 지적).
  //   이제 3번째 인자로 스냅샷 상태를 받으므로 **두 상태 모두** 고정한다.
  //   기본값은 true(규제) — 스냅샷 조회 실패 시 보수적. 프론트 _regLtvLabel 미로드 동작과 같은 방향.
  assert.deepEqual(getRegulationPenalty('노원구', LAWD.노원구, true), { status: '조정대상지역', bonus: -3 });
  assert.deepEqual(getRegulationPenalty('강남구', LAWD.강남구, true), { status: '투기과열·토허구역 일부', bonus: -8 });
  // 해제 시: 서울 분기를 타지 않고 '미확인'(= 라벨 생략·감산 0) 으로 떨어져야 한다
  assert.deepEqual(getRegulationPenalty('노원구', LAWD.노원구, false), { status: '미확인', bonus: 0 });
  assert.deepEqual(getRegulationPenalty('강남구', LAWD.강남구, false), { status: '미확인', bonus: 0 },
    '서울 해제인데 강남구에 투기과열 라벨이 남았다 — 프론트는 비규제로 바뀌므로 서비스가 서로 다른 말을 한다');
  // 지방은 스냅샷 상태와 무관하게 '미확인'
  assert.deepEqual(getRegulationPenalty('해운대구', LAWD.해운대구, false), { status: '미확인', bonus: 0 });
  assert.deepEqual(getRegulationPenalty('해운대구', LAWD.해운대구, true), { status: '미확인', bonus: 0 });
});



test('applyObjectiveScore — 지방 단지 카드에 서울 위계·규제 문구가 찍히지 않는다 (실사고 재현)', () => {
  const deps = ['getDistrictTier', 'getBuilderTier', 'getHouseholdBonus',
    'getParkingBonus', 'getAgeBonus', 'getRegulationPenalty'];
  // ⚠ 하네스는 함수를 떼어내 실행한다 — 모듈 import(공유 구간)는 명시 주입해야 한다.
  const applyObjectiveScore = _reportFn('applyObjectiveScore',
    deps.concat(['turnoverScore']),
    deps.map((n) => _reportFn(n)).concat([require('../utils/scoreBands').turnoverScore]));

  const mk = (sigungu, lawd_cd) => ({
    sigungu, lawd_cd, umd_nm: '테스트동',
    households: 1200, build_year: new Date().getFullYear() - 3, n: 10,
    kaptInfo: { builder: '삼성물산', parking: 1500 },
    score: 100, scoreBreakdown: {},
  });

  // 서울 강남구 — 라벨이 붙어야 정상
  const seoul = mk('강남구', LAWD.강남구);
  applyObjectiveScore(seoul);
  assert.equal(seoul.objectiveFacts.district, '강남3구');
  assert.equal(seoul.objectiveFacts.regulation, '투기과열·토허구역 일부');

  // ★ 부산 해운대구 — 프론트가 `f.district ? … : null` 로 렌더하므로 null 이어야 문구가 사라진다.
  //   여기서 문자열이 새어 나가면 "해운대구 우동 (서울 외곽구)" 실사고가 그대로 재현된다.
  for (const [gu, code] of [['해운대구', LAWD.해운대구], ['수성구', LAWD.수성구], ['연수구', LAWD.연수구]]) {
    const local = mk(gu, code);
    applyObjectiveScore(local);
    assert.equal(local.objectiveFacts.district, null, `${gu} 에 행정구 등급 라벨이 붙었다`);
    assert.equal(local.objectiveFacts.regulation, null, `${gu} 에 규제 라벨이 붙었다`);
    // 라벨뿐 아니라 **점수 가산/감산도** 서울 기준으로 들어가면 안 된다
    assert.equal(local.scoreBreakdown['객관_행정구위계'], undefined, `${gu} 에 서울 위계 가산점이 붙었다`);
    assert.equal(local.scoreBreakdown['객관_규제'], undefined, `${gu} 에 규제 감산이 붙었다`);
  }
});



test('getAgeBonus — 노후도는 절대 연도가 아니라 현재 연도 기준 상대 나이다 (시간 드리프트 차단)', () => {
  const getAgeBonus = _reportFn('getAgeBonus');
  const Y = new Date().getFullYear();

  // 경계 양쪽을 모두 고정한다 — 한쪽만 보면 부등호 방향 실수를 놓친다(계획 008 의 취득세 경계와 동일 교훈)
  assert.deepEqual(getAgeBonus(Y - 5), { years: 5, bonus: 25 });
  assert.deepEqual(getAgeBonus(Y - 6), { years: 6, bonus: 18 });
  assert.deepEqual(getAgeBonus(Y - 10), { years: 10, bonus: 18 });
  assert.deepEqual(getAgeBonus(Y - 11), { years: 11, bonus: 12 });
  assert.deepEqual(getAgeBonus(Y - 15), { years: 15, bonus: 12 });
  assert.deepEqual(getAgeBonus(Y - 16), { years: 16, bonus: 6 });
  assert.deepEqual(getAgeBonus(Y - 20), { years: 20, bonus: 6 });
  assert.deepEqual(getAgeBonus(Y - 21), { years: 21, bonus: 2 });
  assert.deepEqual(getAgeBonus(Y - 30), { years: 30, bonus: 2 });
  assert.deepEqual(getAgeBonus(Y - 31), { years: 31, bonus: 0 });
  // UNKNOWN-MID-2026-09-02 (감사 P1-5): 준공년도 미상은 **0 이 아니라 null**(모름) 이다.
  //   이 점수는 가산식이라 0 은 곧 "확인된 31년 초과" 와 같은 최하위였다 — 데이터가 없다는 이유로
  //   순위가 밀렸다. 호출부(applyObjectiveScore)가 null 을 보고 중간 밴드를 준다.
  //   years 는 여전히 null — 나이를 **추정하지는 않는다**(표시는 미확인).
  assert.deepEqual(getAgeBonus(null), { years: null, bonus: null });
  assert.deepEqual(getAgeBonus(0), { years: null, bonus: null });
});



test('computeAptScore — 신축/재건축 우선순위도 상대 나이 기준이다 (절대연도 하드코딩 복귀 차단)', () => {
  // ⚠ 하네스는 함수를 떼어내 실행하므로 모듈 import 가 없다 — 공유 구간 모듈을 주입한다.
  const computeAptScore = _reportFn('computeAptScore', ['turnoverScore'], [require('../utils/scoreBands').turnoverScore]);
  const Y = new Date().getFullYear();
  // 다른 항목을 전부 0 으로 만들어 priority 만 남긴다:
  //   n=0 → 거래량 가산 없음 / avgPrice·buy 비 = 0.79999 → 예산 fit 두 구간 모두 밖 / 가구상황 전부 무해
  const ctxOf = (priority) => ({ buy: 10, priority, kidPlan: '없음', stayYears: '5~10년', isFirstBuyer: false });
  const cOf = (buildYear) => ({ n: 0, households: 0, avgPrice: 79999, build_year: buildYear, sigungu: '강남구', umd_nm: '대치동' });

  const score = (priority, buildYear) => computeAptScore(cOf(buildYear), ctxOf(priority)).total;

  // 신축: 8년 이하 35 / 14년 이하 18 / 그 밖 0
  assert.equal(score('신축', Y - 8), 35);
  assert.equal(score('신축', Y - 9), 18);
  assert.equal(score('신축', Y - 14), 18);
  assert.equal(score('신축', Y - 15), 0);
  // 재건축: 30년 이상 30 / 25년 이상 12 / 그 밖 0
  assert.equal(score('재건축', Y - 30), 30);
  assert.equal(score('재건축', Y - 25), 12);
  assert.equal(score('재건축', Y - 24), 0);
  // 준공년도 미상이면 신축·재건축 어느 쪽으로도 추정하지 않는다
  assert.equal(score('신축', null), 0);
  assert.equal(score('재건축', null), 0);
});



test('computeAptScore — 예산 fit 구간 경계 (예산 ±10%/±20% 양쪽 끝)', () => {
  // ⚠ 하네스는 함수를 떼어내 실행하므로 모듈 import 가 없다 — 공유 구간 모듈을 주입한다.
  const computeAptScore = _reportFn('computeAptScore', ['turnoverScore'], [require('../utils/scoreBands').turnoverScore]);
  const Y = new Date().getFullYear();
  // priority '신축' + 15년 구축 → priority 기여 0. n=0 → 거래량 0. 남는 것은 budget_fit 뿐.
  const ctx = { buy: 10, priority: '신축', kidPlan: '없음', stayYears: '5~10년', isFirstBuyer: false };
  const fit = (avgPriceManwon) => computeAptScore(
    { n: 0, households: 0, avgPrice: avgPriceManwon, build_year: Y - 15, sigungu: '강남구', umd_nm: '테스트동' }, ctx).total;

  // buy=10억 → 기준 100,000 만원
  assert.equal(fit(100000), 30);  // 정확 일치
  assert.equal(fit(90000), 30);   // 0.9 — 경계 포함
  assert.equal(fit(110000), 30);  // 1.1 — 경계 포함
  assert.equal(fit(89999), 12);   // 0.9 바로 아래 → 넓은 구간
  assert.equal(fit(80000), 12);   // 0.8 — 경계 포함
  assert.equal(fit(120000), 12);  // 1.2 — 경계 포함
  assert.equal(fit(79999), 0);    // 구간 밖
  assert.equal(fit(120001), 0);   // 구간 밖
});



test('getHouseholdBonus·getParkingBonus — 등급 경계 + 0 나눗셈 방어', () => {
  const getHouseholdBonus = _reportFn('getHouseholdBonus');
  const getParkingBonus = _reportFn('getParkingBonus');

  for (const [n, want] of [[3000, 30], [2999, 25], [2000, 25], [1999, 20], [1000, 20],
    [999, 12], [500, 12], [499, 5], [300, 5], [299, 0]]) {
    assert.equal(getHouseholdBonus(n), want, `세대수 ${n} 의 보너스가 ${want} 가 아니다`);
  }
  // UNKNOWN-MID-2026-09-02 (감사 P1-5): 세대수 미상은 **null**(모름) — 0 이 아니다.
  //   실측: 세대수 미확인 734곳(5.0%) 이 "확인된 300세대 미만" 4,606곳과 똑같이 0 점을 받고 있었다.
  //   여전히 대단지로 오인하지는 않는다(중간 밴드 12 점, 최고 30 점과 구별).
  assert.equal(getHouseholdBonus(null), null);
  assert.equal(getHouseholdBonus(0), null);
  assert.equal(getHouseholdBonus('많음'), null);

  // 주차 비율 — ratio 는 **문자열**(toFixed(2))이다. 프론트가 그대로 표시하므로 타입이 계약의 일부다.
  assert.deepEqual(getParkingBonus(1300, 1000), { ratio: '1.30', bonus: 12 });
  assert.deepEqual(getParkingBonus(1000, 1000), { ratio: '1.00', bonus: 8 });
  assert.deepEqual(getParkingBonus(700, 1000), { ratio: '0.70', bonus: 3 });
  assert.deepEqual(getParkingBonus(699, 1000), { ratio: '0.70', bonus: 0 }); // 표시는 반올림, 판정은 원값
  // ★ 0 나눗셈·미상 방어 — Infinity/NaN 이 점수에 섞이면 그 단지가 상위권을 통째로 차지한다
  //   UNKNOWN-MID-2026-09-02: 미상은 bonus null(모름). ratio 는 여전히 null — 비율을 지어내지 않는다.
  assert.deepEqual(getParkingBonus(1000, 0), { ratio: null, bonus: null });
  assert.deepEqual(getParkingBonus(0, 1000), { ratio: null, bonus: null });
  assert.deepEqual(getParkingBonus(null, null), { ratio: null, bonus: null });
});



// ══════════════════════════════════════════════════════════════════════════════
// Plan 023 (2026-08-16): 중개보수 tier 경계 — **주 경로(스냅샷) == 폴백 경로(법정 하드코딩)**
//
// [실사고] 계획 008(02f4a26)이 취득세 경계를 `<` → `<=` 로 고쳤는데, 그 한 줄이 **같은 헬퍼를
//   쓰던 중개보수까지** 바꿨다. 두 tier 표는 `underAuk` 라는 같은 필드를 쓰지만 법정 경계가 반대다:
//     · 취득세   지방세법 §11①8호          — "6억원 **이하** 1%"    → `<=`
//     · 중개보수 공인중개사법 시행규칙 별표1 — "2억~9억원 **미만** 0.4%" → `<`
//   그 결과 0.5·2·9·12·15억 정확히 5개 지점에서 법정 요율과 어긋났다
//   (라이브 실측 2026-08-16: 9억 −90만 · 12억 −120만 · 15억 −150만 **과소**, 0.5억 +5만 · 2억 +20만 과대).
//   커밋 메시지는 "경계값 하나만 바뀌고 회귀 위험 낮음" 이었다 — **공유 헬퍼의 두 번째 소비처를
//   확인하지 않은 것**이 근본 원인이고, 기존 테스트는 폴백 경로(`source:'fallback'`)만 봐서 못 잡았다.
//
// [이 테스트가 고정하는 것] 스냅샷 tier 로 계산한 값과, 법령을 그대로 옮긴 하드코딩 폴백이
//   **모든 경계에서 같아야 한다**. 손으로 고른 지점이 아니라 tier 의 `underAuk` 에서 경계를
//   **파생**시켜 그 앞·정확히·뒤 3점을 전부 본다(계획 022 의 교훈 — 손으로 고른 목록은 빠뜨린다).
// ══════════════════════════════════════════════════════════════════════════════
test('중개보수 tier — 스냅샷 경로와 법정 폴백이 모든 경계에서 일치한다 (공인중개사법 별표1 = 미만)', () => {
  const fs = require('node:fs');
  const path = require('node:path');

  // 프로덕션에 실제로 실린 tier (regulations_snapshot.acquisition_tax_2025.commission, 2026-08-16 DB 실측)
  const COMMISSION_TIERS = [
    { rate: 0.006, underAuk: 0.5 }, { rate: 0.005, underAuk: 2 },
    { rate: 0.004, underAuk: 9 }, { rate: 0.005, underAuk: 12 },
    { rate: 0.006, underAuk: 15 }, { rate: 0.007, underAuk: 999 },
  ];
  // 법령 그대로 (별표1 매매·교환) — 프론트 7477행·백엔드 analysisService 폴백과 동일한 식
  const legalRate = (p) => (p < 0.5 ? 0.006 : p < 2 ? 0.005 : p < 9 ? 0.004
    : p < 12 ? 0.005 : p < 15 ? 0.006 : 0.007);

  const grabFront = (name) => {
    const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
    const m = html.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}'));
    assert.ok(m, `frontend/index.html 에서 ${name} 을 찾지 못했다`);
    return new Function(`${m[0]}; return ${name};`)();
  };
  const frontUnder = grabFront('_pickTierRateUnder');
  const frontIncl = grabFront('_pickTierRate');

  // 경계를 **데이터에서 파생** — tier 목록이 바뀌어도 자동으로 따라간다
  const bounds = COMMISSION_TIERS.map((t) => t.underAuk).filter((v) => v < 999);
  assert.ok(bounds.length >= 5, `경계가 ${bounds.length}개뿐 — tier 표가 바뀌었는지 확인할 것`);

  for (const b of bounds) {
    for (const p of [Number((b - 0.01).toFixed(2)), b, Number((b + 0.01).toFixed(2))]) {
      const law = legalRate(p);
      assert.equal(frontUnder(COMMISSION_TIERS, p, 0.007), law,
        `프론트 중개보수 ${p}억: 스냅샷 경로가 법정 요율(${(law * 100).toFixed(1)}%)과 다르다`);
    }
    // ★ 경계 **정확히** 그 값일 때가 사고 지점이었다 — '이하' 헬퍼를 쓰면 여기서 갈린다.
    assert.notEqual(frontIncl(COMMISSION_TIERS, b, 0.007), undefined);
    if (frontIncl(COMMISSION_TIERS, b, 0.007) !== legalRate(b)) {
      // 이 분기가 도는 것이 정상이다: '이하' 헬퍼는 중개보수에 쓰면 안 된다는 사실 자체를 고정한다.
      assert.notEqual(frontIncl(COMMISSION_TIERS, b, 0.007), frontUnder(COMMISSION_TIERS, b, 0.007),
        `${b}억에서 두 헬퍼가 같은 값을 낸다 — 경계 분리가 무의미해졌으니 이 테스트를 재검토할 것`);
    }
  }

  // 백엔드 쌍둥이도 같은 계약 (지금은 라우트가 taxConfig 를 안 넘겨 도달 불가지만,
  //   넘기는 순간 되살아나는 결함이라 함께 고정한다 — 오늘만 "한쪽만 고침"이 4번 나왔다)
  const beSrc = fs.readFileSync(path.join(__dirname, '../services/analysisService.js'), 'utf8');
  const mBe = beSrc.match(/function pickTierRateUnder\([\s\S]*?\n\}/);
  assert.ok(mBe, 'analysisService.js 에서 pickTierRateUnder 를 찾지 못했다');
  const beUnder = new Function(`${mBe[0]}; return pickTierRateUnder;`)();
  for (const b of bounds) {
    assert.equal(beUnder(COMMISSION_TIERS, b, 0.007), legalRate(b),
      `백엔드 중개보수 ${b}억이 법정 요율과 다르다`);
    assert.equal(beUnder(COMMISSION_TIERS, b, 0.007), frontUnder(COMMISSION_TIERS, b, 0.007),
      `${b}억에서 프론트↔백엔드 중개보수가 갈렸다`);
  }

  // 취득세는 반대로 '이하' 가 맞다 — 두 표의 경계 의미가 다르다는 것 자체를 고정한다
  const ACQ_TIERS = [{ rate: 0.01, underAuk: 6 }, { rate: 0.02, underAuk: 9 }, { rate: 0.03, underAuk: 999 }];
  assert.equal(frontIncl(ACQ_TIERS, 6, 0.03), 0.01, '취득세 6억 정확히는 1%(지방세법 §11①8호 6억 이하)여야 한다');
  assert.equal(frontIncl(ACQ_TIERS, 9, 0.03), 0.02, '취득세 9억 정확히는 누진구간(2% tier)이어야 한다');

  // ★★ 배선(wiring) 계약 — 헬퍼가 옳아도 **호출부가 틀린 헬퍼를 부르면** 사고가 그대로 재현된다.
  //   [실측 근거] 위 단언들만 있을 때 회귀 주입(호출부를 `_pickTierRateUnder` → `_pickTierRate` 로
  //   되돌림)을 했더니 **65개 전부 통과했다** — 원래 사고를 그대로 되돌려도 못 잡았다.
  //   함수 단위 테스트는 "함수가 옳은가"만 보고 "누가 그 함수를 쓰는가"는 안 본다.
  const feSrc = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const feCall = feSrc.split('\n').find((l) => /cr\s*=\s*_pickTierRate\w*\(tc\.commission/.test(l));
  assert.ok(feCall, '프론트에서 중개보수 요율 선택 호출부를 찾지 못했다 (형태 변경 시 이 테스트도 갱신할 것)');
  assert.match(feCall, /_pickTierRateUnder\(tc\.commission/,
    `프론트 중개보수가 '이하' 헬퍼를 쓰고 있다 — 별표1 은 '미만' 경계다: ${feCall.trim()}`);

  const beCall = beSrc.split('\n').find((l) => /commRate\s*=\s*pickTierRate\w*\(taxConfig\.commission/.test(l));
  assert.ok(beCall, '백엔드에서 중개보수 요율 선택 호출부를 찾지 못했다');
  assert.match(beCall, /pickTierRateUnder\(taxConfig\.commission/,
    `백엔드 중개보수가 '이하' 헬퍼를 쓰고 있다: ${beCall.trim()}`);

  // 취득세 호출부는 반대로 '이하' 헬퍼여야 한다(Under 를 잘못 쓰면 6억에서 다시 1,200만원 과다).
  //   ⚠ `rate = _pickTierRate…(at.` 형태만 잡는다. 처음엔 `\((at|tiers)\b` 로 느슨하게 썼다가
  //   **함수 정의 줄까지 매칭**해 테스트가 자기 자신 때문에 실패했다(2026-08-16 실측) —
  //   소스 텍스트 기반 단언은 정의/호출을 반드시 구분할 것.
  const acqCalls = feSrc.split('\n').filter((l) => /rate\s*=\s*_pickTierRate\w*\(at\./.test(l));
  assert.ok(acqCalls.length >= 2,
    `취득세 호출부를 ${acqCalls.length}개만 찾았다 — 형태 변경 시 이 테스트도 갱신할 것`);
  for (const l of acqCalls) {
    assert.ok(!/_pickTierRateUnder/.test(l),
      `취득세 호출부가 '미만' 헬퍼를 쓰고 있다 — §11①8호는 '6억 이하'다: ${l.trim()}`);
  }
});



// ── COND-FILTER-BEHAVIORAL-2026-09-02 (감사 후속: 테스트 행위화) ─────────────
//   [왜] 추천 조건 필터(_condPass)는 "모름"을 어떻게 다루느냐가 곧 결과다. 이 저장소는 이미
//     미확인 세대수를 0 으로 읽어 407곳(서울 56)을 소형으로 잘못 배제한 적이 있다.
//   [무엇이 바뀌었나] 종전 테스트는 소스에서 두 줄의 **존재와 순서**만 봤다("단위 테스트로는
//     못 잡는다"고 스스로 적어 뒀다). 그런데 _condPass 는 fMinHh/fMinPark/fSaleOnly 세 값만
//     닫아 쓰는 순수 클로저다 — 소스에서 그대로 **추출해 실행**하면 DB 없이 판정을 확인할 수 있다.
//     (프론트 함수에 쓰던 추출 기법과 같다. 프로덕션 코드는 건드리지 않는다.)
test('추천 조건 필터 — 실제로 실행해 판정을 확인한다 (모름·불일치·경계)', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const src = fs2.readFileSync(path2.join(__dirname, '../services/propertyService.js'), 'utf8');
  const m = src.match(/ {2}const _condPass = \(fac\) => \{[\s\S]*?\n {2}\};/);
  assert.ok(m, 'propertyService 에서 _condPass 를 찾지 못했다 — 이름/형태가 바뀌었다면 이 테스트도 갱신할 것');

  // 클로저가 닫아 쓰는 값만 주입해 실제 함수를 만든다
  const make = (fMinHh, fMinPark, fSaleOnly) =>
    new Function('fMinHh', 'fMinPark', 'fSaleOnly', m[0] + '\nreturn _condPass;')(fMinHh, fMinPark, fSaleOnly);

  const none = make(0, 0, false);
  const park = make(0, 1.5, false);
  const hh = make(500, 0, false);
  const sale = make(0, 0, true);

  // ① 필터가 없으면 통과 — 단, facility 자체를 모르면 조건을 확인할 수 없으니 제외한다
  //    (UI 안내와 같은 의미: "조건 확인 불가"이지 "조건 미달"이 아니다)
  assert.equal(none({ totalHouseholds: 100 }), true, '무필터인데 걸러졌다');
  assert.equal(none(null), false, 'facility 를 모르는데 조건을 만족한다고 봤다');

  // ② 주차 비율 — 경계와 **모름**
  assert.equal(park({ parkingRatio: 1.6 }), true, '기준 이상인데 걸러졌다');
  assert.equal(park({ parkingRatio: 1.5 }), true, '경계값(1.5)은 통과해야 한다');
  assert.equal(park({ parkingRatio: 1.4 }), false, '기준 미달이 통과했다');
  assert.equal(park({ parkingRatio: null }), false, '주차 비율을 모르는데 통과시켰다');

  // ③ ★ 세대수 원천이 갈린 단지는 주차 비율의 **분모를 믿을 수 없다** → 주차 조건에서 제외.
  //    이 가드가 빠지면 "주차 여유"라며 근거 없는 단지가 추천된다.
  assert.equal(park({ parkingRatio: 1.6, householdsConflict: true }), false,
    '세대수 불일치 단지가 주차 조건을 통과했다 — 분모를 못 믿는 값으로 추천된다');
  // 단, 주차 조건을 안 걸었으면 불일치는 배제 사유가 아니다(과잉 배제 방지)
  assert.equal(none({ parkingRatio: 1.6, householdsConflict: true }), true,
    '주차 필터를 안 걸었는데 세대수 불일치만으로 배제했다');

  // ④ 세대수 — 경계와 모름. `null` 과 `0` 둘 다 통과시키지 않는다
  //    (모름을 0 으로 표현한 생산자가 있어서 실제로 사고가 났던 지점이다)
  assert.equal(hh({ totalHouseholds: 500 }), true, '경계값(500)은 통과해야 한다');
  assert.equal(hh({ totalHouseholds: 499 }), false, '기준 미달이 통과했다');
  assert.equal(hh({ totalHouseholds: null }), false, '세대수를 모르는데 통과시켰다');
  assert.equal(hh({ totalHouseholds: 0 }), false, '0(=모름의 잘못된 표현)이 통과했다');

  // ⑤ 분양만
  assert.equal(sale({ saleType: '분양' }), true, '분양 단지가 걸러졌다');
  assert.equal(sale({ saleType: '임대' }), false, '임대 단지가 분양만 조건을 통과했다');
  assert.equal(sale({}), false, '분양 여부를 모르는데 통과시켰다');
});



test('절대 규칙 — 화면·프롬프트가 추천/예측/대출알선을 하지 않는다 (Sprint MMMMMMM-4)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const ai = fs.readFileSync(path.join(__dirname, '../services/aiService.js'), 'utf8');
  const clause = fs.readFileSync(path.join(__dirname, '../routes/clause.js'), 'utf8');
  const ana = fs.readFileSync(path.join(__dirname, '../services/analysisService.js'), 'utf8');

  // ① 미래 사건 확률 — AI 가 지어낸 "발생 가능성 35%" 가 필터를 우회해 화면에 뜨고 있었다.
  //    (aiOutputFilter 의 CLAUSE_FILTER_FIELDS 는 risks.probability 를 의도적으로 제외한다.)
  //   ★ 주석은 검사 대상이 아니다 — clause.js:161 은 2026-07-15 에 POST /risk 를 지우며
  //     "'발생 가능성 %' 등 예측성 서술 요구(절대룰 저촉 소지)" 라고 **문제를 이미 기록해 둔** 줄이다.
  //     그때 죽은 라우트만 지우고 **살아있는 /clause 프롬프트의 같은 문제는 남겨뒀다** — 그 잔여분이
  //     이번에 제거됐다. 기록은 보존하고, 실제 스키마 키만 본다.
  assert.equal(/"probability"/.test(clause), false,
    'clause 프롬프트가 다시 AI 에게 확률을 요구한다 — 근거 없는 수치가 화면에 뜬다');
  assert.equal(/class="rcard-p">\$\{_escHtml\(r\.probability/.test(html), false,
    '리스크 카드가 다시 probability 를 렌더한다');

  // ② 대출 알선 — aiService 규칙 5 가 "대출 알선·소개 금지"인데 같은 프롬프트가 이를 어기고 있었다.
  assert.ok(/대출 알선·소개 금지/.test(ai), '대출 알선 금지 규칙 자체가 사라졌다');
  assert.equal(/신협·수협 특판/.test(ai), false,
    '프롬프트가 특정 금융기관 특판 금리를 다시 싣는다 — 화면 disclaimer "대출 알선 X" 와 충돌');
  assert.equal(/대출상담사 활용 권장/.test(ai), false, '프롬프트가 대출상담사를 다시 권한다');
  assert.equal(/상호금융권\(DSR 50%\) 사전 상담/.test(html), false,
    '규칙기반 특약 폴백이 특정 금융업권 상담을 다시 유도한다');

  // ③ 단지 등급 판정 — 규칙 10(특정 단지 평가 금지)과 절대 룰 ①에 어긋나던 지시문
  assert.equal(/3% 이상: 양호, 5% 이상: 우수/.test(ai), false,
    '프롬프트가 다시 단지에 등급을 매긴다');
  assert.equal(/하방 지지력/.test(ai), false,
    '프롬프트가 다시 미래 가격 방어력을 단정한다');

  // ④ 랜딩 첫 화면의 가짜 실측값 — API 실패 시 하드코딩 단지가 '실시간' 딱지를 달고 남았다
  assert.equal(/id="lv-aptName">헬리오시티/.test(html), false,
    '랜딩 카드에 하드코딩 단지명이 되돌아왔다 — 실패 시 가짜 시세가 실시간으로 보인다');
  assert.equal(/id="lv-aptPrice">\d/.test(html), false, '랜딩 카드에 하드코딩 가격이 되돌아왔다');
  assert.match(html, /id="lv-aptMeta">불러오는 중</, '초기 라벨이 플레이스홀더가 아니다');
  assert.match(html, /_set\('lv-aptMeta', '실시간'\)/, "'실시간' 라벨을 응답 수신 후에 달지 않는다");

  // ⑤ 결정론 조건 카드 — 절대 룰 ①을 AI 프롬프트에서만 집행하고 있었다(RULE-DETERMINISTIC-2026-09-06).
  //    aiService.js "단지 정보 정리 기준"(등급 라벨 금지, 위 ③에서 이미 검사)을
  //    analysisService.js 의 conditions 카드에도 동일하게 적용한다.
  //    ★ 제거 대상 원문은 여기에 옮기지 않는다 — 이 테스트는 주석을 걸러내지 않고 파일 전체를
  //      정규식으로 훑으므로, 주석에 원문을 쓰면 그 주석 자신이 걸린다.
  assert.equal(/실수요 비중 높음/.test(ana), false,
    '전세가율 조건 카드가 다시 수요 성격을 단정한다');
  assert.equal(/관망세/.test(ana), false,
    '거래량 조건 카드가 다시 시장 심리를 단정한다');
  assert.equal(/보통 수준/.test(ana), false,
    '조건 카드가 다시 등급 라벨을 붙인다');
});



// ── REPORT-DEPTH-2026-08-31 (Sprint PPPPPPP) ──────────────────────────────────
// 운영자: "예전에 받았던 컨설팅 보고서처럼 요약 총평·매매 시 주의할 점·뭘 봐야 하는지·
//          어떤 집을 피해야 하는지가 들어가면 좋겠다. 로고랑 워터마크도."
// ⚠ 참고로 받은 컨설팅 보고서에는 "상승여력 2~5억", "○○구역을 추천함" 같은 표현이 있었다.
//   그건 **옮기지 않는다** — 이 서비스의 절대 룰(매수·매도 추천 X · 미래 가격 예측 X)이 우선한다.
//   넣는 것은 매수 실무에서 **확인해야 할 항목**과 **우리가 잰 사실**뿐이다.
test('보고서 확인사항 — 실무 항목만 넣고 추천·예측 표현은 넣지 않는다', () => {
  const fs2 = require('node:fs'); const path2 = require('node:path');
  const rpt = fs2.readFileSync(path2.join(__dirname, '../routes/report.js'), 'utf8');

  // ① 섹션이 존재하고 응답에 실린다.
  assert.match(rpt, /const cautions = \[/, '확인사항(cautions) 섹션이 없다');
  assert.match(rpt, /^\s*cautions,$/m, 'cautions 가 보고서 응답에 실리지 않는다');

  // ② ⚠ 절대 룰 — cautions 본문에 가격 예측·매수 권유 표현이 없어야 한다.
  const block = rpt.slice(rpt.indexOf('const cautions = ['), rpt.indexOf('  return {', rpt.indexOf('const cautions = [')));
  const banned = ['상승여력', '오를 것', '유망', '저평가', '추천함', '사세요', '매수하세요', '지금이 기회'];
  for (const w of banned) {
    assert.ok(!block.includes(w), `확인사항에 금지 표현이 들어갔다: "${w}" — 절대 룰(추천 X·예측 X) 위반`);
  }
  // 권유가 아니라는 점을 본문에 명시한다.
  assert.ok(/매수·매도 권유가 아니에요/.test(block),
    '확인사항이 권유가 아니라는 문장이 없다 — 조언으로 읽힐 수 있다');

  // ③ 화면·인쇄 **양쪽** 에 그려야 한다(한쪽만 그리면 PDF 와 화면이 갈린다).
  const fe = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');
  assert.match(fe, /const cautionsHtml =/, '인쇄 보고서가 확인사항을 그리지 않는다');
  assert.match(fe, /const _cautionsWeb =/, '화면 보고서가 확인사항을 그리지 않는다');

  // ④ 로고·워터마크 (운영자 명시 요청)
  assert.match(fe, /class="brandbar"/, '인쇄 보고서에 로고가 없다');
  assert.match(fe, /class="wmark"/, '인쇄 보고서에 워터마크가 없다');
  // 워터마크가 본문 선택·클릭을 막으면 안 된다.
  assert.match(fe, /\.wmark \{[^}]*pointer-events: none/, '워터마크가 본문 조작을 막는다');
});



// ── INTEREST-KEY-2026-08-30 (Sprint PPPPPPP) ──────────────────────────────────
// 캐시를 1,551건 채워놓고도 점수는 전부 중간값이었다 — **키가 양쪽에서 달랐다.**
//   채우는 쪽: apt_geocache 이름 "서동탄역파크자이아파트"
//   읽는 쪽  : MOLIT 이름 "서동탄역파크자이" + 게다가 추천 객체엔 `sigungu` 필드가 아예 없다
//              (area 로 합쳐져 있어 rec.sigungu 는 항상 undefined → 키 뒷부분이 빈 문자열)
// 캐시는 "채웠다" 와 "쓰인다" 가 다른 문제다. 채운 건수만 보고 됐다고 하면 안 된다.
test('관심도 캐시 — 이름 표기가 달라도 같은 키를 만든다', () => {
  const dl = require('../services/naverDatalabService');

  // ① 표기 차이가 키에 영향을 주면 안 된다.
  assert.equal(dl.normalizeAptName('서동탄역파크자이아파트'), '서동탄역파크자이');
  assert.equal(dl.normalizeAptName('서동탄역파크자이'), '서동탄역파크자이');
  assert.equal(dl.normalizeAptName('힐스테이트대명센트럴(101,102동)'), '힐스테이트대명센트럴');
  // 단지 번호는 이름의 일부다 — 지우면 다른 단지와 뭉개진다.
  assert.equal(dl.normalizeAptName('수원 호매실벨섬시티 14단지'), '수원 호매실벨섬시티 14단지');

  // ② propertyService 가 sigungu 를 **실제 있는 곳**에서 가져온다.
  const fs2 = require('node:fs'); const path2 = require('node:path');
  const svc = fs2.readFileSync(path2.join(__dirname, '../services/propertyService.js'), 'utf8');
  assert.ok(!/aptName: rec\.aptName, sigungu: rec\.sigungu/.test(svc),
    '추천 객체에 없는 rec.sigungu 로 캐시 키를 만든다 — 키 뒷부분이 항상 비어 영원히 미스다');
  assert.match(svc, /sigungu: \(_rankedF\[i\] && _rankedF\[i\]\.sigungu\)/,
    'sigungu 를 실제 소스(_rankedF)에서 가져오지 않는다');
});



// ── INTEREST-BAND-2026-08-30 (Sprint PPPPPPP) ─────────────────────────────────
// 장기 검색 관심도(네이버 데이터랩 36개월) 구간은 **실분포로 보정**했다.
//   전국 1,551단지·103시군구 실측 분위수:
//     p10 0.0001 · p25 0.0003 · p50 0.0062 · p75 0.0224 · p90 0.0563 · p97 0.1296 · 최대 1.304
//   (초기 구간은 표본 3개로 잡은 값이었고, 그 구간에서는 45% 가 최저점을 받았다.)
test('관심도 점수 — 모름은 중간값, 측정된 최저도 0 이 아니다', () => {
  const { interestScore } = require('../utils/scoreBands');
  const MAX = 14;

  // ① ⚠ Number(null) === 0 이다. null 을 숫자로 흘리면 **모름이 최저점으로 둔갑**한다.
  for (const unknown of [null, undefined, '', 'x', NaN]) {
    const r = interestScore(unknown, MAX);
    assert.equal(r.known, false, `${String(unknown)} 를 '측정됨' 으로 취급한다`);
    assert.equal(r.score, 7, '모름이 중간값(7)을 받지 않는다 — 모름은 나쁨이 아니다');
    assert.equal(r.why, null, '모르는데 근거 문구를 지어낸다');
  }

  // ② 측정된 값은 단조 증가하고, **바닥도 0 이 아니다**.
  //    낮은 비율은 '인기 없음' 이기도 하지만 '우리 키워드가 안 맞는다' 는 신호이기도 하다
  //    (실측: "서동탄역파크자이아파트" 0.003 ↔ "서동탄역파크자이" 1.10 — 355배).
  const pts = [1.304, 0.1296, 0.0563, 0.0224, 0.0062, 0.0003, 0].map(r => interestScore(r, MAX).score);
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i] <= pts[i - 1], `관심도가 낮아졌는데 점수가 올랐다 (${pts[i - 1]} → ${pts[i]})`);
  }
  assert.equal(pts[0], MAX, '최상위가 만점이 아니다');
  assert.ok(pts[pts.length - 1] > 0, '측정된 최저가 0 점이다 — 증거가 약한 쪽에 큰 벌점을 주면 안 된다');
  assert.ok(pts[pts.length - 1] < 7, '측정된 최저가 모름(중간값)보다 높거나 같다 — 변별이 사라진다');

  // ③ 구간 숫자는 scoreBands 한 곳에만 있어야 한다(소비자 복제 금지).
  const fs2 = require('node:fs'); const path2 = require('node:path');
  const svc = fs2.readFileSync(path2.join(__dirname, '../services/propertyService.js'), 'utf8');
  assert.ok(!/r >= 0\.1296/.test(svc), '관심도 구간이 propertyService 에 복제돼 있다');
  assert.match(svc, /interestScore\(/, 'propertyService 가 공유 구간 함수를 쓰지 않는다');
});



// ── WALK-BAND-2026-08-30 (Sprint PPPPPPP) ─────────────────────────────────────
// 운영자: "서동탄역더샵파크시티는 누가봐도 도보 30분 이상인데 지하철 5분 이내는
//          무슨 소리를 하는거야;; db가 잘못된거야 뭐야."
// [실측 — 이 테스트가 고정하는 사실]
//   · KAPT 원본 kaptdWtimesub = "10~15분이내" (5분이내 아님)
//   · 카카오 도보 실측 = 1,783m / 1,606초 = 26.8분
//   · `"10~15분이내".includes("5분이내")` === true  ← **버그의 정체**
//   · 그래서 도보 10~15분 단지 2,429곳이 교통 만점(30)을 받았다.
//     만점 단지 4,357곳 중 55.7% 가 가짜였다 → 검색 상위가 통째로 뒤틀렸다.
test('도보시간 밴드 — 부분문자열 매칭 금지(10~15분이 5분이내로 읽히면 안 된다)', () => {
  const { parseWalkBand, WALK_BAND_LABEL } = require('../utils/walkBand');

  // ① 밴드가 1:1 로 정확히 갈린다. 특히 10~15 는 절대 LE5 가 아니다.
  assert.equal(parseWalkBand('5분이내'), 'LE5');
  assert.equal(parseWalkBand('5~10분이내'), 'M5_10');
  assert.equal(parseWalkBand('10~15분이내'), 'M10_15',
    '"10~15분이내" 가 5분이내로 읽힌다 — 이 버그가 2,429 단지를 교통 만점으로 올렸다');
  assert.equal(parseWalkBand('15~20분이내'), 'M15_20');
  assert.equal(parseWalkBand('20분초과'), 'GT20');

  // ② 모르는 값은 조용히 통과시키지 말고 null(=모름). 뒤에서 중간값을 받는다.
  for (const junk of ['', null, undefined, '거리없음', '해당없음']) {
    assert.equal(parseWalkBand(junk), null, `인식 못 하는 값(${junk})은 null 이어야 한다`);
  }

  // ③ ⚠ 회귀 방지의 핵심: 순진한 includes 구현이었다면 ①이 깨진다는 것을 여기서 못박는다.
  assert.ok('10~15분이내'.includes('5분이내'),
    '전제가 바뀌었다 — 이 substring 함정이 사라졌다면 위 주석을 갱신하라');

  // ④ 점수 소비자가 includes 로 되돌아가지 못하게 한다.
  const svc = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../services/propertyService.js'), 'utf8');
  assert.ok(!/sub\.includes\('5분이내'\)/.test(svc),
    'propertyService 가 다시 부분문자열 매칭을 쓴다 — parseWalkBand 를 쓸 것');
  assert.ok(/parseWalkBand\(facility && facility\.walkSubwayMin\)/.test(svc),
    '지하철 도보시간이 parseWalkBand 를 거치지 않는다');
  assert.ok(/parseWalkBand\(facility && facility\.walkBusMin\)/.test(svc),
    '버스 도보시간도 같은 함정에 있다 — parseWalkBand 를 거칠 것');

  // ⑤ 라벨은 밴드마다 달라야 한다(표시가 겹치면 사용자가 구분 못 한다).
  const labels = Object.values(WALK_BAND_LABEL);
  assert.equal(new Set(labels).size, labels.length, '밴드 라벨이 중복된다');
});



// ── SCORE-V2-2026-08-30 (Sprint OOOOOOO) ──────────────────────────────────────
// 운영자: "부동산은 위치·교통(지하철 도보 몇 분)·핵심 인프라·거래 활발이 더 중요하다.
//          기존 점수표가 너무 별로다. 다시 객관화해라."
// [기존 실측] 거래량 30 · 신축 18 · 평형 8 · 세대수 8 · 주차 4 · **지하철 도보 4** · 교육 2.
//   교통이 거래량의 1/7.5 였고, 병원·마트는 추천 점수에 **아예 없었다**.
// [새 배점 — 운영자 승인] 교통 30 · 인프라 20 · 규모주차 15 · 거래 15 · 연식 12 · 평형 8 = 100
test('점수 V2 — 교통이 최대 비중이고, 모르는 것은 0이 아니라 중간값이다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const svc = fs2.readFileSync(path2.join(__dirname, '../services/propertyService.js'), 'utf8');

  // ① 배점표가 한 곳에 선언되고 교통이 가장 크다(사본이 갈릴 자리를 만들지 않는다).
  const m = svc.match(/const SCORE_V2_MAX = \{([^}]+)\}/);
  assert.ok(m, '배점표 상수(SCORE_V2_MAX)가 없다 — 배점이 코드 곳곳에 흩어지면 또 갈린다');
  const max = {};
  for (const kv of m[1].split(',')) {
    const [k, v] = kv.split(':').map(x => x.trim());
    if (k) max[k] = Number(v);
  }
  assert.equal(Object.values(max).reduce((a, b) => a + b, 0), 100, '배점 합이 100 이 아니다');
  assert.equal(max['교통'], 28, '교통 배점이 28 이 아니다');
  assert.ok(max['교통'] > max['거래'], '교통이 거래량보다 작다 — 운영자 우선순위와 반대다');
  assert.ok(max['인프라'] >= 16, '생활 인프라 배점이 16 미만이다');
  // SCORE-V3-2026-08-30: 운영자 보고서 리뷰로 추가된 두 축.
  assert.ok(max['관심도'] >= 10,
    '장기 검색 관심도 배점이 없다 — 운영자가 "1년·3년 오래 검색되는 곳" 을 요구했다');

  // ②-0 거래는 **절대 건수가 아니라 세대수 대비 회전율**로 판정한다.
  //   [실측 결함] 푸른마을포스코더샵2차는 43건으로 건수 1위였지만 1,226세대라 회전율 3.51% 로 4위였다
  //   (서동탄역파크자이 6.42% · 동탄파크푸르지오 5.81% · 자연앤데시앙 4.42%).
  //   구간은 전국 분위수 실측(6개월·100세대 이상 2,981단지): p25 1.25 · p50 2.03 · p75 3.02 · p90 4.11.
  const bands = require('../utils/scoreBands');
  const hi = bands.turnoverScore(63, 982, 14);   // 6.42% — 상위 10%
  const lo = bands.turnoverScore(43, 1226, 14);  // 3.51% — 상위 25% 언저리
  assert.ok(hi.score > lo.score,
    '회전율 6.42% 가 3.51% 보다 높은 점수를 받지 않는다');
  assert.ok(lo.turnover > 3 && lo.turnover < 4, '회전율 계산이 세대수 대비가 아니다');
  // ⚠ 건수만 크고 세대수도 큰 단지가 이기면 안 된다 — 이 저장소가 실제로 겪은 결함이다.
  assert.ok(bands.turnoverScore(43, 1226, 14).score < bands.turnoverScore(20, 300, 14).score,
    '대단지의 큰 건수가 소단지의 높은 회전율을 이긴다 — 정규화가 안 된 것이다');
  // 세대수를 모를 때 0 점으로 떨어뜨리지 않는다.
  assert.ok(bands.turnoverScore(3, 0, 14).score > 0,
    '세대수 미확인 단지가 거래 0점을 받는다 — 모름은 나쁨이 아니다');
  assert.equal(bands.turnoverScore(3, 0, 14).turnover, null, '모름인데 회전율 숫자를 지어낸다');

  // ②-0-1 ⚠ **두 화면이 같은 구간을 쓴다.** 점수표가 두 벌이면 한쪽만 고쳐지고 갈린다
  //   ([[tax-law-crosscheck-2026-06-24]]: 취득세 tier 사본 2개로 3주간 과다 표기).
  const rpt = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../routes/report.js'), 'utf8');
  for (const [file, src] of [['propertyService', svc], ['report', rpt]]) {
    assert.match(src, /require\('\.\.\/utils\/scoreBands'\)/,
      `${file} 가 공유 구간 모듈을 쓰지 않는다 — 사본이 갈린다`);
  }
  assert.ok(!/tr >= 4\.11 \?/.test(svc) && !/tr >= 4\.11 \?/.test(rpt),
    '회전율 구간 숫자가 소비자 쪽에 복제돼 있다 — scoreBands 한 곳에만 두라');

  // ②-1 아파트가 아닌 유형은 추천에서 뺀다. ⚠ 단, **모름은 빼지 않는다**.
  assert.ok(bands.isExcludedAptType('도시형 생활주택(아파트)'), '도시형생활주택이 제외되지 않는다');
  assert.ok(!bands.isExcludedAptType('주상복합'),
    '주상복합까지 제외한다 — 1,261곳이고 오피스텔과 동의어가 아니다(근거 없는 배제)');
  assert.ok(!bands.isExcludedAptType(''), '유형 미상(331곳)이 통째로 제외된다');

  // ②-2 신고가 갱신은 **평형별**로 센다.
  //   [실측] 평형을 섞으면 큰 평형이 최고가를 찍은 뒤 소형 신고가가 영영 안 세진다 —
  //   푸른마을포스코더샵2차: 혼합 4회 ↔ 평형별 18회(과대가 아니라 과소였다).
  const nh = bands.countNewHighByArea([
    { date: '2026-01', amount: 50000, area: 76 },
    { date: '2026-02', amount: 90000, area: 117 },
    { date: '2026-03', amount: 60000, area: 76 },
  ]);
  assert.equal(nh, 1, '평형을 섞어 세면 76㎡ 의 신고가 갱신이 사라진다');

  // ② 지하철 접근성은 **잰 거리(1순위)** 로 매기고, KAPT 자기신고값은 **폴백**이다.
  //    TRANSIT-TRUTH-2026-08-30 실측(좌표 보유 2,778 단지, 카카오 최근접역):
  //      신고 밴드와 일치 42.6% · 두 칸 이상 어긋남 15.8%(413곳) · 과대신고 347곳.
  //      운영자 확인 사례: 동탄파크한양수자인 신고 "10~15분" ↔ 네이버 도보 3.3km / 52분.
  //    ⇒ 신고값은 **만점을 받을 수 없다**(잰 값보다 상한이 낮아야 한다).
  const distMap = svc.match(/d <= 250 \? (\d+) : d <= 450 \? (\d+) : d <= 650 \? (\d+) : d <= 900 \? (\d+) : d <= 1400 \? (\d+) : d <= 2500 \? (\d+) : (\d+)/);
  assert.ok(distMap, '최근접 역까지 **잰 거리**로 교통 점수를 매기지 않는다 — 신고값만 믿으면 안 된다');
  const dPts = distMap.slice(1, 8).map(Number);
  assert.equal(dPts[0], max['교통'], '역 250m 이내가 교통 만점이 아니다');
  for (let i = 1; i < dPts.length; i++) {
    assert.ok(dPts[i] < dPts[i - 1], `거리가 멀어졌는데 점수가 줄지 않는다(${dPts[i - 1]} → ${dPts[i]})`);
  }

  //    신고 밴드 5단계도 전부 쓰되(버리지 않는다), 상한은 잰 값보다 낮다.
  const bandMap = svc.match(/\{ LE5: (\d+), M5_10: (\d+), M10_15: (\d+), M15_20: (\d+), GT20: (\d+) \}/);
  assert.ok(bandMap, '지하철 도보 5단계 → 점수 표가 없다 — KAPT 가 5단계로 주는데 버리고 있다');
  const pts = bandMap.slice(1, 6).map(Number);
  assert.ok(pts[0] < max['교통'],
    '자기신고 "5분이내" 가 교통 만점을 받는다 — 검증된 값과 신고값이 같은 대접을 받으면 안 된다');
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i] < pts[i - 1], `도보 시간이 늘었는데 점수가 줄지 않는다(${pts[i - 1]} → ${pts[i]})`);
  }

  //    ⚠ '역 없음'(관측된 사실) 과 '조회 실패'(모름) 를 섞으면 안 된다.
  assert.match(svc, /nearM === null/,
    '반경 내 역 없음을 별도로 다루지 않는다 — 조회 실패와 섞이면 멀쩡한 단지가 최저점을 받는다');

  // ③ ⚠ 모르는 것은 **0점이 아니라 중간값**. 도보시간 미보유가 전국 26% 다 —
  //    0 처리하면 데이터 없는 단지가 부당하게 밀린다([[unknown-treated-as-value]]).
  assert.match(svc, /교통 === null\) \{ 교통 = 15;/,
    '교통 정보가 없을 때 0점을 준다 — 모름을 나쁨으로 만들면 안 된다');
  // ⚠ NULL-NOT-ZERO-2026-08-30: 카카오 조회 **실패**(null)를 0 으로 읽으면
  //   "주변에 병원이 없다" 는 사실 주장이 된다. 실제로 키워드 검색 size 상한(15)에 45 를 넘겨
  //   전건 400 이 떨어졌고, 화면엔 "종합병원 0" 이 점수엔 0점이 찍혔다(런타임 로그 실측).
  //   → 아는 항목만으로 채점해 만점으로 환산하고, 하나도 모르면 중간값.
  assert.match(svc, /const known = parts\.filter\(p => p\.v !== null/,
    '인프라가 모르는 항목을 0 으로 섞어 계산한다');
  assert.match(svc, /인프라 = Math\.round\(SCORE_V2_MAX\.인프라 \* 0\.5\)/,
    '인프라를 하나도 모를 때 0점을 준다');
  const kakao = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../services/kakaoService.js'), 'utf8');
  assert.ok(!/size: (?:[2-9]\d|1[6-9])/.test(kakao),
    '카카오 검색 size 가 상한(15)을 넘는다 — 400 이 떨어지고 결과가 전부 0 이 된다');

  // ④ 점수 근거(breakdown·why)를 함께 내보낸다 — "왜 이 순서인가" 가 보여야 신뢰가 생긴다.
  assert.ok(/scoreBreakdown: _sc\.breakdown/.test(svc), '점수 근거(breakdown)를 응답에 싣지 않는다');
  assert.ok(/scoreWhy: _sc\.why/.test(svc), '점수 근거 문구(why)를 응답에 싣지 않는다');

  // ⑤ 최종 순서가 **화면에 보이는 점수** 로 정해진다(거래량 정렬이 아니다).
  assert.match(svc, /order\.sort\(\(a, b\) => \(Number\(b\.rec\?\.score\)/,
    '최종 정렬이 표시 점수 기준이 아니다 — 98점이 3위, 69점이 1위이던 그 상태로 돌아간다');

  // ⑥ ⚠ 재정렬 시 coords·schoolsArr 도 함께 옮긴다 —
  //    downstream 이 인덱스 대응을 전제하므로 하나만 정렬하면 마커가 다른 단지에 찍힌다.
  assert.match(svc, /coords\[i\] = order\[i\]\.coord; schoolsArr\[i\] = order\[i\]\.school;/,
    '재정렬이 좌표·학군을 함께 옮기지 않는다 — 마커가 다른 단지 위치에 찍힌다');
});



// ── HH-UNKNOWN-2026-08-17 (Sprint MMMMMMM-19) ─────────────────────────────────
// [실측 배경] 추천의 소형 단지 게이트가 **세대수 미확인(0)을 소형으로 취급**해 407곳(서울 56)을
//   조용히 배제하고 있었다. 코드 주석은 "세대수 **확인된** 100세대 미만 제외 · 미확인(null) 유지"
//   라고 적혀 있었지만, `buildFacility` 는 모를 때 null 이 아니라 **0** 을 넣으므로 그 의도는
//   도달할 수 없었다(`Number.isFinite(0)` = true).
//   그 407곳 중 건축물대장으로 교차확인되는 17곳은 **전부 100세대 이상**(평균 878·최대 2,700),
//   소형은 0곳 — "미확인 = 소형" 전제가 데이터로 반증된다.
test('추천 소형 게이트 — 미확인(0)은 배제하지 않고, 확인된 1~99만 배제한다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../services/propertyService.js'), 'utf8');

  // 판정을 소스에서 뽑아 **직접 실행**한다 — 형태만 보면 경계 실수를 못 잡는다.
  const m = src.match(/const _isKnownSmall = \(r\) => \{[\s\S]*?\n {4}\};/);
  assert.ok(m, 'propertyService 에서 _isKnownSmall 을 찾지 못했다 (형태가 바뀌면 이 테스트도 갱신할 것)');
  const _isKnownSmall = new Function(`${m[0]} return _isKnownSmall;`)();

  const mk = (hh) => ({ facility: hh === undefined ? undefined : { totalHouseholds: hh } });
  // 미확인 계열 — 전부 유지(배제 대상 아님)
  assert.equal(_isKnownSmall(mk(0)), false, '세대수 0(미확인)이 소형으로 배제된다 — 407곳이 사라진 원인');
  assert.equal(_isKnownSmall(mk(null)), false, 'null(미확인)이 배제된다');
  assert.equal(_isKnownSmall(mk(undefined)), false, 'undefined(미확인)가 배제된다');
  assert.equal(_isKnownSmall({}), false, 'facility 자체가 없을 때 배제된다');
  // 확인된 소형 — 배제 (운영자 지시의 실제 대상, 실측 239곳)
  assert.equal(_isKnownSmall(mk(1)), true, '1세대가 소형으로 안 걸린다');
  assert.equal(_isKnownSmall(mk(83)), true, '83세대(YM프라젠 실사례)가 소형으로 안 걸린다');
  assert.equal(_isKnownSmall(mk(99)), true, '99세대가 소형으로 안 걸린다');
  // 경계 — 100 이상은 유지
  assert.equal(_isKnownSmall(mk(100)), false, '100세대가 소형으로 배제된다(경계 오류)');
  assert.equal(_isKnownSmall(mk(2700)), false, '2,700세대가 배제된다');

  // 주석이 실제 동작과 다시 어긋나지 않도록 근거 수치를 함께 고정한다.
  assert.match(src, /미확인이 전부 소형으로 배제/, 'HH-UNKNOWN 근거 주석이 사라졌다');
});



test('추천 점수: 주변시설 null 은 0 곳으로 채점되지 않는다 (Number(null)===0 함정)', () => {
  const { _applyFacilityToScore } = require('../services/propertyService');
  const base = { breakdown: {} };
  // 교통 근거가 하나도 없는 단지 — facility 신고값도 없다.
  const facility = {};
  const unknown = _applyFacilityToScore(base, facility, { school: null, mart: null, hospital: null, subway: null, cvs: null, park: null });
  const zero = _applyFacilityToScore(base, facility, { school: 0, mart: 0, hospital: 0, subway: 0, cvs: 0, park: 0 });

  // ① 모름(null)과 실제 0 곳은 **다른 점수**여야 한다. 같아지면 조회 실패가 최저점으로 둔갑한다.
  assert.notEqual(unknown.breakdown.교통, zero.breakdown.교통,
    `모름과 0곳이 같은 교통 점수(${unknown.breakdown.교통})다 — null 이 0 으로 읽히고 있다`);
  assert.ok(unknown.breakdown.교통 > zero.breakdown.교통,
    '모름이 실제 0곳보다 낮게 채점됐다 — 모름을 나쁨으로 만들면 안 된다');

  // ② 모름일 때 근거 문구에 "0곳" 같은 사실 주장이 들어가면 안 된다.
  const whyText = (unknown.why || []).join(' ');
  assert.equal(/지하철역\s*0\s*곳/.test(whyText), false, `모름인데 근거에 "0곳" 이 적혔다: ${whyText}`);

  // ③ 인프라도 마찬가지 — 전부 모르면 아는 항목이 없으니 카카오 기반 점수를 매기지 않는다.
  assert.notEqual(unknown.breakdown.인프라, 0,
    '전부 모름인데 인프라가 0 점이다 — 조회 실패가 감점이 된다');
});



// ── REC-BROAD-ALL-2026-09-05 (운영자 재실사고: 5구 결과 vs 서울 25구 개별 조회 합집합 상위 15 = 2곳 겹침) ────
//   같은 날 1차 수정(예산 밴드 상위 5구)도 정답을 놓쳤다. 광역은 그 시도의 모든 시군구를 본다.
test('광역 검색 — 시도 전체 시군구를 본다(서울 25·인천·경기 전부) + 광역 모드 비용 통제 배선', () => {
  const svc = require('../services/propertyService');
  const { LAWD_CODES, RETIRED_LAWD_CODES } = require('../services/transactionService');
  const cnt = (pfx) => new Set(Object.values(LAWD_CODES).map(String)
    .filter(c => c.startsWith(pfx) && !RETIRED_LAWD_CODES.has(c))).size;
  const seoul = svc.pickRegions('서울', 6.5, '');
  assert.equal(seoul._broad, '11', "'서울' 이 _broad 마커를 잃었다");
  assert.equal(seoul.length, cnt('11'), `서울 광역이 ${seoul.length}개 구만 본다(전체 ${cnt('11')})`);
  assert.equal(seoul.length, 25, '서울은 25개 구다');
  assert.ok(seoul.every(r => String(r.lawdCd).startsWith('11')), '서울 광역에 다른 시도 코드가 섞였다');
  assert.ok(seoul.some(r => r.lawdCd === '11350') && seoul.some(r => r.lawdCd === '11680'), '노원·강남이 빠졌다');
  assert.equal(new Set(seoul.map(r => r.lawdCd)).size, seoul.length, '코드 중복');
  // 예산이 달라도 대상은 같다 — 예산으로 구를 고르는 발상이 결함이었다
  assert.deepEqual(svc.pickRegions('서울', 3, '').map(r => r.lawdCd).sort(), seoul.map(r => r.lawdCd).sort(),
    '예산에 따라 서울 대상 구가 달라진다(하드코딩·밴드 선정 회귀)');
  assert.equal(svc.pickRegions('', 6.5, '').length, cnt('11'), '빈 지역(기본=서울)도 전체여야 한다');
  const inc = svc.pickRegions('인천', 5, '');
  assert.equal(inc._broad, '28'); assert.equal(inc.length, cnt('28'), '인천 광역이 전체가 아니다');
  assert.ok(inc.every(r => !RETIRED_LAWD_CODES.has(r.lawdCd)), '폐지 코드에 빈 조회를 던진다');
  const gg = svc.pickRegions('경기', 5, '');
  assert.equal(gg._broad, '41'); assert.equal(gg.length, cnt('41'), '경기 광역이 전체가 아니다');
  assert.equal(svc.pickRegions('노원', 6.5, '')._broad, undefined, '구를 직접 고른 검색까지 광역 확장하면 안 된다');
  assert.equal(svc.pickRegions('경기', 6, '', '41597')._broad, undefined, 'lawdCd 명시 선택은 광역 확장 금지');
  assert.equal(svc.pickRegions('서울 노원구', 6.5, '').length, 1, '세부 구 문자열이 광역으로 새면 안 된다');
  assert.equal(typeof svc.pickBroadRegionsByBudget, 'undefined', '예산 밴드 구 선정 코드가 남아 있다(죽은 코드)');

  //   ⚠ 아래 단언은 **소스의 모양**만 본다 — 분기 반전·인자 교체는 못 잡는다.
  //     그 계약은 REC-BEHAVIORAL-2026-09-06 의 실행 테스트가 지킨다.
  const src = require('node:fs').readFileSync(require.resolve('../services/propertyService'), 'utf8');
  assert.match(src, /const _broadMode = !_lawd && !!_picked\._broad;/, '광역 모드 판정이 없다');
  assert.match(src, /const targetRegions = \(_lawd \|\| _broadMode\) \? _picked : _picked\.slice\(0, 3\);/,
    '광역이 slice(0,3)에 잘린다 — 서울이 다시 3구가 된다');
  assert.match(src, /_broadMode \? Promise\.resolve\(\[\]\) : getAptListBySgg\(r\.lawdCd\)/,
    '광역 모드에서 라이브 KAPT 목록(지역당 최대 10페이지 외부 호출)을 생략하지 않는다');
  assert.match(src, /\?\? \(_broadMode \? \[\] : await getTransactionsByApt\(r\.lawdCd, ''\)\)/,
    '광역 모드에서 MOLIT 월별 API 폴백(지역당 6콜)을 막지 않는다');
  assert.ok(!src.includes('pickBroadRegionsByBudget('), '예산 밴드 구 선정 호출이 남아 있다');
  assert.ok(src.includes('rec:v29:'), '캐시 키 버전이 v29 가 아니다 — 옛 결과가 3시간 서빙된다');
});



// ── BUDGET-CAP-2026-09-05 (운영자 "6.5억인데 6.8억이 나온다") ──────────────────────────────
//   ⚠ 아래 단언은 **소스의 모양**만 본다 — 분기 반전·인자 교체는 못 잡는다.
//     그 계약은 REC-BEHAVIORAL-2026-09-06 의 실행 테스트가 지킨다.
test('추천 예산 상한 — 대표가격이 예산 이하인 단지만(5% 여유 제거)', () => {
  const src = require('node:fs').readFileSync(require.resolve('../services/propertyService'), 'utf8');
  assert.match(src, /const budgetMaxMan = maxBudget \* 10000;/, '예산 상한이 1.0x 가 아니다');
  assert.ok(!/budgetMaxMan = maxBudget \* 10000 \* 1\.05/.test(src), '5% 여유가 되살아났다 — 6.5억 검색에 6.8억이 실린다');
  assert.match(src, /p\.avgPrice <= budgetMaxMan && p\.avgPrice >= budgetMinMan/, '표시값(avgPrice) 기준 예산 필터가 사라졌다');
});



// ── HH-FLOOR-2026-09-05 ─────────────────────────────────────────────────────────
test('회전율 — 100세대 미만은 분모를 100으로 올려 잰다(17세대 2건이 만점이 되지 않는다)', () => {
  const bands = require('../utils/scoreBands');
  const tiny = bands.turnoverScore(2, 17, 14);
  assert.equal(tiny.score, bands.turnoverScore(2, 100, 14).score, '17세대 2건이 100세대 2건과 다르게 채점된다');
  assert.ok(tiny.score < 14, '17세대 2건(11.8%)이 회전율 만점이다');
  assert.match(tiny.why, /100세대 기준 환산/, '환산 사실을 밝히지 않는다');
  assert.ok(tiny.why.includes('17세대'), '실제 세대수를 숨긴다');
  assert.equal(bands.turnoverScore(43, 1226, 14).why, '6개월 회전율 3.5% (43건 / 1226세대)', '100세대 이상 문구가 달라졌다');
});



// ── BROAD-META-2026-09-05 ──────────────────────────────────────────────────────
test('분석 지역 안내 — 광역 검색은 시군구 이름을 나열하지 않고 "전체 N개 시군구" 로 말한다', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../frontend/index.html'), 'utf8');
  assert.match(html, /const _regionLabel = \(regs\) => \{/, '지역 라벨 헬퍼가 없다');
  assert.match(html, /전체 \$\{regs\.length\}개 시군구/, '광역 라벨이 "전체 N개 시군구" 가 아니다');
  assert.ok(!html.includes('전체 중 예산에 맞는 구를 골라 분석했어요'), '옛 안내("예산에 맞는 구를 골라")가 남아 있다 — 사실과 다르다');
  assert.match(html, /전체 \$\{searchMeta\.regions\.length\}개 시군구를 분석했어요/, '광역 안내 문구가 없다');
});



// ── TRANSIT-STAGE-2026-09-05 ─────────────────────────────────────────────────────
//   ⚠ 아래 단언은 **소스의 모양**만 본다 — 분기 반전·인자 교체는 못 잡는다.
//     그 계약은 REC-BEHAVIORAL-2026-09-06 의 실행 테스트가 지킨다.
test('추천 — 최종 15곳을 고르기 전에 후보 전체의 최근접 역 거리를 재고, 표본 3건 이상을 앞세운다', () => {
  const src = require('node:fs').readFileSync(require.resolve('../services/propertyService'), 'utf8');
  const i = src.indexOf('TRANSIT-STAGE-2026-09-05: 최종 15곳');
  assert.ok(i > 0, '역 거리 사전 단계가 없다 — 신고밴드로 고른 15곳에 역세권 대단지가 빠진다');
  const blk = src.slice(i, i + 3200);
  assert.match(blk, /const \{ nearestSubway \} = require\('\.\/kakaoService'\);/, 'nearestSubway 를 쓰지 않는다');
  // 가드 형태 고정 — 'false ? … : []' 류로 단계만 꺼두는 회귀를 잡는다(주입 실측: 아래 단언들은 전부 초록이었다)
  assert.match(blk, /const stageCoords = await resolveCoordBatch\(stageInputs, 8\);/, '역 거리 단계가 실행되지 않는 형태로 바뀌었다');
  assert.match(blk, /dists\[i \+ k\] = await nearestSubway\(c\.lat, c\.lng, 3000\)/, '후보 전체에 역 거리 조회를 걸지 않는다');
  assert.match(blk, /if \(ns === undefined\) continue;/, '조회 실패를 "역 없음" 으로 읽는다(최저점 오염)');
  assert.match(blk, /subwayNearestM: ns \? ns\.distance : null/, '역 없음(null)을 사실로 반영하지 않는다');
  // 단계 순서: TRANSIT-STAGE → SCORE-ORDER(정렬) → slice(0, 15)
  const so = src.indexOf('SCORE-ORDER-2026-08-30 (Sprint OOOOOOO): **최종 순서를');
  const sl = src.indexOf('_rankedF = _rankedF.slice(0, 15);');
  assert.ok(i < so && so < sl, '역 거리 단계가 정렬·15곳 컷보다 뒤에 있다 — 컷에 반영되지 않는다');
  assert.match(src, /const LENS_PROV = _filterActive \? 45 : 40;/, '세 렌즈 합집합 컷(임시 점수 렌즈)이 없다');
  // 표본 티어 — **선택**(15곳 컷 전 정렬)에만 1회. 표시 순서는 점수순(SCORE-ORDER 계약)이어야 한다.
  const tiers = src.match(/const _sOk = \(o\) => Number\(\(Number\(o\.rec\?\.priceSampleN\) \|\| 0\) >= 3\);/g) || [];
  assert.equal(tiers.length, 1, `표본 티어 키는 선택 정렬 한 곳에만 있어야 한다(현재 ${tiers.length})`);
  assert.equal((src.match(/order\.sort\(\(a, b\) => \(_sOk\(b\) - _sOk\(a\)\)/g) || []).length, 1, '선택 정렬의 1차 키가 표본 티어가 아니다');
  // 15곳 컷 직후 표시용 점수순 재정렬 — 시설 단계가 건너뛰어져도 화면은 점수순
  assert.match(src, /enrichedRecs = enrichedRecs\.slice\(0, 15\);\s*\/\/ DISPLAY-ORDER-2026-09-05[\s\S]{0,900}disp\.sort\(\(a, b\) => \(Number\(b\.rec\?\.score\) \|\| 0\) - \(Number\(a\.rec\?\.score\) \|\| 0\)/,
    '15곳 컷 뒤 표시용 점수순 재정렬이 없다 — 표본 티어 순서가 화면에 그대로 나간다');
});



// ── COUNT-CAP + SCALE-BANDS-2026-09-05 ──────────────────────────────────────────
test('점수 — 회전율은 절대 건수를 넘지 못하고, 300세대 미만은 규모 1점', () => {
  const bands = require('../utils/scoreBands');
  const small = bands.turnoverScore(8, 133, 14);   // 6.0% 이지만 8건
  const big = bands.turnoverScore(39, 1590, 14);   // 2.5% · 39건
  assert.equal(small.score, big.score, `133세대 8건(${small.score})이 1,590세대 39건(${big.score})과 다르다`);
  assert.ok(bands.turnoverScore(2, 100, 14).score < bands.turnoverScore(5, 100, 14).score, '건수 2와 5가 같은 점수다');
  assert.equal(bands.turnoverScore(63, 982, 14).score, 14, '대단지 고회전(63건·6.4%)이 만점이 아니다');
  const { _applyFacilityToScore } = require('../services/propertyService');
  const sc = (th) => _applyFacilityToScore({ total: 0, breakdown: {}, dealCount: 0 }, { totalHouseholds: th, parkingRatio: null }, null).breakdown.규모주차;
  assert.equal(sc(150), 1 + 3, '100~299세대 규모가 1점이 아니다');
  assert.equal(sc(350), 3 + 3, '300~499세대 규모가 3점이 아니다');
  assert.equal(sc(0), 6 + 3, '모름(0)이 중간값이 아니다');
  assert.ok(sc(1590) > sc(350) && sc(350) > sc(150), '규모 단조성이 깨졌다');
});



// ── ALIAS-NONEMPTY + APTLIST-LEAN-2026-09-05 ──────────────────────────────────────
test('광역 전수 조회 경량화 — 별칭은 비어 있지 않은 행만, 단지목록은 두 JSON 키만 + 병렬 페이지', async () => {
  const tx = require('node:fs').readFileSync(require.resolve('../services/transactionService'), 'utf8');
  assert.match(tx, /\.not\('molit_aliases', 'is', null\)[\s\S]{0,400}\.neq\('molit_aliases', '\[\]'\)/, '빈 별칭 배열 행을 걸러내지 않는다(경기 13초)');
  const fac = require('node:fs').readFileSync(require.resolve('../services/aptFacilityService'), 'utf8');
  assert.match(fac, /\.select\('kapt_code, apt_name, umd_nm, facility->>kaptAddr, facility->>kaptUsedate'\)/, '단지목록이 facility JSON 통째(경기 7.7MB)를 받는다');
  assert.ok(!/select\('kapt_code, apt_name, umd_nm, facility'\)/.test(fac), '옛 통째 select 가 남아 있다');
  // 행위: 첫 페이지 단독 → 가득 찼으면 다음 4페이지 병렬, 짧은 페이지에서 멈춤. JSON 경로 키(kaptAddr)를 그대로 읽는다.
  const dbPath = require.resolve('../db/client');
  const facPath = require.resolve('../services/aptFacilityService');
  const saved = { db: require.cache[dbPath], fac: require.cache[facPath] };
  const ranges = [];
  const mkRows = (from, n) => Array.from({ length: n }, (_, i) => ({ kapt_code: 'A' + String(from + i).padStart(6, '0'), apt_name: 'x', umd_nm: 'd', kaptAddr: '서울특별시 노원구 상계동 ' + (from + i + 100) + '-1', kaptUsedate: '19890101' }));
  const total = 2300;
  const q = () => { const s = { select() { return s; }, in() { return s; }, not() { return s; }, order() { return s; },
    range(a) { ranges.push(a); const n = Math.max(0, Math.min(1000, total - a)); return Promise.resolve({ data: mkRows(a, n), error: null }); } }; return s; };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { hasAdminEnv: () => true, getSupabaseAdmin: () => ({ from: () => q() }) } };
  try {
    delete require.cache[facPath];
    const { getAptListByLawdFromDb } = require('../services/aptFacilityService');
    const out = await getAptListByLawdFromDb(['11350', '11320']);
    assert.equal(out.length, total, '페이지 병합 행수가 다르다');
    assert.deepEqual(ranges, [0, 1000, 2000, 3000, 4000], '첫 페이지 단독 → 4페이지 병렬 순서가 아니다: ' + JSON.stringify(ranges));
    assert.equal(out[0].jibunBon, '100', 'JSON 경로 키(kaptAddr)에서 지번 본번을 읽지 못한다');
    assert.equal(out[0].kaptUsedate, '19890101', 'JSON 경로 키(kaptUsedate)를 읽지 못한다');
  } finally {
    if (saved.db) require.cache[dbPath] = saved.db; else delete require.cache[dbPath];
    if (saved.fac) require.cache[facPath] = saved.fac; else delete require.cache[facPath];
  }
});



test('T0-HERO-FIELD (Plan 038) — 추천 응답 dealCount6m을 히어로가 읽고, 렌더 순서가 올바르다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');

  // 결함: 추천 경로는 dealCount6m 으로, 검색·지도 경로는 dealCount 로 응답하는데,
  //   히어로가 dealCount 만 읽어 추천 카드의 거래 건수·표본 배지가 통째로 빠졌다.
  //   또한 recentDealDate 정규화가 렌더 뒤에 있어 같은 카드를 두 번째로 열 때만 나타났다.

  // 계약 1: propertyService.js 가 dealCount6m 을 싣는다
  const psJs = fs.readFileSync(path.join(__dirname, '../services/propertyService.js'), 'utf8');
  assert.match(psJs, /dealCount6m:\s*apt\.dealCount/,
    'propertyService.js 에서 dealCount6m 필드를 찾지 못했다');

  // 계약 2: frontend/index.html 에서 dealCount6m 을 ?? 연산자로 읽는다
  assert.match(html, /p\.dealCount\s*\?\?\s*p\.dealCount6m/,
    'frontend 에서 ?? 연산자로 dealCount6m 을 읽지 않는다');

  // 계약 3: 렌더 순서 — recentDealDate 정규화(실제 대입 코드)가 const _heroSection 앞에 있다.
  //   ⚠ Plan 060 ③: 원래는 주석 한 줄(RECENTDEAL-2026-08-19 마커)의 위치만 봤다 — 그 주석은
  //   그대로 두고 실제 정규화 블록(try{...}catch(_e){}) 만 뒤로 옮겨도 통과했다(감사자 실측,
  //   Plan 038 이 고친 증상이 그대로 복원됨). 실제 대입 코드를 정규식으로 찾아 그 위치를 쓴다 —
  //   변수명(_t0 등)은 구조에서 자유롭게 둬 의미 보존 리팩터에는 fail 하지 않는다.
  const assignRe = /p\.recentDealDate\s*=\s*\w+\.dealYear/;
  const regIdx = html.search(assignRe);
  const heroIdx = html.indexOf('const _heroSection');
  assert.ok(regIdx > -1, 'frontend 에서 recentDealDate 대입 코드(p.recentDealDate=...dealYear)를 찾지 못했다');
  assert.ok(heroIdx > -1, 'frontend 에서 const _heroSection 을 찾지 못했다');
  assert.ok(regIdx < heroIdx,
    '렌더 순서 계약 위반: recentDealDate 정규화 코드가 _heroSection 뒤에 있다 (' + regIdx + ' vs ' + heroIdx + ')');

  // 계약 4: 히어로가 _t0DealN 변수를 사용해 거래 건수·표본 배지를 표시한다
  assert.match(html, /const _t0DealN = Number\(p\.dealCount \?\? p\.dealCount6m\)/,
    '_t0DealN 정규화 줄을 찾지 못했다');
  assert.match(html, /if \(_t0DealN > 0\)[\s\S]{0,100}?_t0hc\('거래 건수'/,
    '거래 건수 셀이 _t0DealN 을 쓰지 않는다');
  assert.match(html, /<span class="t0h-bdg">표본 \$\{_t0DealN\.toLocaleString\(\)\}건<\/span>/,
    '표본 배지가 _t0DealN 을 쓰지 않는다');
});



// ── REC-BEHAVIORAL-2026-09-06 (A) 예산 상한 — BUDGET-CAP 계약을 실행으로 고정 ──────────────
//   운영자 실사고 "6.5억인데 6.8억이 나온다" 를 낳은 값(6.8) 그대로 재현한다.
test('REC-BEHAVIORAL-2026-09-06: 추천 예산 상한(실행) — 대표가격이 예산 이하인 단지만 남는다', async () => {
  const LAWD = '11350'; // 노원구 — transactionService.LAWD_CODES 실값(임의 코드 금지)
  const buildYear = 2015;
  await _withRecStubs({
    lawdCd: LAWD, sigungu: '노원구', umdNm: '상계동',
    complexes: [
      { name: '예산단지64', buildYear, price: 64000, n: 3, households: 1000 }, // 6.4억 — 포함
      { name: '예산단지65', buildYear, price: 65000, n: 3, households: 1000 }, // 6.5억(경계) — 포함("이하")
      { name: '예산단지66', buildYear, price: 66000, n: 3, households: 1000 }, // 6.6억 — 제외
      { name: '예산단지68', buildYear, price: 68000, n: 3, households: 1000 }, // 6.8억 — 제외(운영자 실사고 값)
      // FIELD-SWAP-GUARD: 나머지 4곳은 평형 안 가격이 전부 동일해 avgPrice·medianPrice·minPrice 가
      // 우연히 같은 값이 된다 — 그러면 "다른 가격 필드로 교체" 회귀를 구분 못 한다. 이 단지는
      // 3건 6.0억 + 2건 9.0억(날짜 동일 → 가중치 동일)을 섞어 세 통계를 일부러 갈라놓는다.
      //   avgPrice(가중평균) = (3*6.0+2*9.0)/5 = 7.2억 → 예산(6.5억) 초과, 제외가 맞다.
      //   medianPrice = 6.0억, minPrice = 6.0억 → 둘 다 예산 이내라, 필터가 그중 하나로 바뀌면
      //   이 단지가 잘못 포함된다(실측: 위 두 값으로 교체 시 실제로 포함됨을 확인했다).
      { name: '필드검증단지', buildYear, prices: [60000, 60000, 60000, 90000, 90000], households: 1000 },
    ],
  }, async (ps) => {
    const result = await ps.getAIRecommendations({
      maxBudget: 6.5, lawdCd: LAWD, houseStatus: '무주택', isFirstBuyer: false,
    });
    // ⚠ 필드명은 실행해 직접 확인했다(추측 아님) — 최종 avgPrice 는 억 단위(예: 6.5).
    assert.ok(result.recommendations.length > 0, '결과가 비어 있다 — 픽스처가 어느 단계에서 걸렀는지 먼저 확인할 것');
    for (const r of result.recommendations) {
      assert.ok(r.avgPrice <= 6.5, `avgPrice ${r.avgPrice} 가 예산 6.5억을 넘는다(${r.aptName})`);
    }
    const names = result.recommendations.map(r => r.aptName);
    assert.ok(!names.includes('예산단지68'), '6.8억 단지가 6.5억 검색 결과에 있다(5% 여유 부활과 같은 결함)');
    assert.ok(!names.includes('예산단지66'), '6.6억 단지가 6.5억 검색 결과에 있다');
    assert.ok(names.includes('예산단지65'), '예산과 정확히 같은(6.5억) 단지가 빠졌다 — 경계를 "미만"으로 잘못 좁혔다');
    assert.ok(names.includes('예산단지64'), '예산 이하(6.4억) 단지가 빠졌다');
    assert.ok(!names.includes('필드검증단지'),
      '평균가 7.2억 단지가 6.5억 검색 결과에 있다 — 예산 판정이 avgPrice 가 아닌 다른 필드(median/min)를 본다');
  });
});



// ── REC-BEHAVIORAL-2026-09-06 (B) MULTI-LENS — 임시 점수가 낮아도 거래·세대수 렌즈로 산다 ──
//   [픽스처 설계] 필러 40곳은 최근 신축·대형(5,000세대)·주차 여유로 임시 점수(_prov)를 target 보다
//   높이고(신축급 연식 만점+규모주차 만점) 확인 세대수도 target(1,590) 보다 훨씬 크게 잡아
//   LENS_PROV(top40)·LENS_SCALE(top20) 를 전부 채운다. 대신 거래는 최소(2건)만 둬서
//   LENS_DEALS(top20) 에서는 target(39건) 에 밀리게 한다 — target 이 **오직 거래 렌즈**로만
//   합집합에 들어오게 설계했다(실측: LENS_DEALS 합집합 줄을 지우면 이 target 만 사라진다).
test('REC-BEHAVIORAL-2026-09-06: MULTI-LENS(실행) — 임시 점수 45위인 고회전·대단지가 결과에 남는다', async () => {
  const LAWD = '11350';
  const thisYear = new Date().getFullYear();
  const fillers = Array.from({ length: 40 }, (_, i) => ({
    name: `필러단지${String(i).padStart(2, '0')}`,
    buildYear: thisYear - 2, excluUseAr: 84.9,
    price: 45000, n: 2, households: 5000, parkingRatio: 1.3,
  }));
  const targetName = '벽산형단지';
  const target = { name: targetName, buildYear: thisYear - 32, excluUseAr: 59.9, price: 45000, n: 39, households: 1590 };
  await _withRecStubs({
    lawdCd: LAWD, sigungu: '노원구', umdNm: '상계동',
    complexes: [...fillers, target],
    coordsByName: { [targetName]: { lat: 37.6, lng: 127.0 } },
    subwayByName: { [targetName]: { distance: 108, name: '테스트역' } },
  }, async (ps) => {
    const result = await ps.getAIRecommendations({ maxBudget: 5, lawdCd: LAWD, houseStatus: '무주택', isFirstBuyer: false });
    const names = result.recommendations.map(r => r.aptName);
    assert.ok(names.includes(targetName),
      '거래 39건·1,590세대·역 108m 단지가 결과에 없다 — 임시 점수(top40) 단일 컷으로 후보를 골랐다는 뜻');
  });
});



// ── REC-BEHAVIORAL-2026-09-06 (C) 소형 게이트 — 확인된 소형만 제외, 미확인은 유지 ──────────
//   이 저장소는 "모름을 0으로 취급해 세대수 미확인 407곳을 소형으로 잘못 배제한" 실사고가 있다
//   ([[unknown-treated-as-value]]). 여기서 그 방향(모름 ≠ 소형)을 실행으로 고정한다.
test('REC-BEHAVIORAL-2026-09-06: 소형 게이트(실행) — 확인된 100세대 미만만 빠지고 미확인은 남는다', async () => {
  const LAWD = '11350';
  const buildYear = 2015;
  await _withRecStubs({
    lawdCd: LAWD, sigungu: '노원구', umdNm: '상계동',
    complexes: [
      { name: '소형확인단지', buildYear, price: 45000, n: 2, households: 80 },      // 확인된 소형 — 제외돼야 함
      { name: '미확인단지', buildYear, price: 45000, n: 2, households: undefined }, // KAPT 미매칭 — 남아야 함
      { name: '일반단지1', buildYear, price: 45000, n: 2, households: 500 },
      { name: '일반단지2', buildYear, price: 45000, n: 2, households: 500 },
    ],
  }, async (ps) => {
    const result = await ps.getAIRecommendations({ maxBudget: 5, lawdCd: LAWD, houseStatus: '무주택', isFirstBuyer: false });
    const names = result.recommendations.map(r => r.aptName);
    assert.ok(!names.includes('소형확인단지'), '확인된 100세대 미만 단지가 제외되지 않았다');
    assert.ok(names.includes('미확인단지'), '세대수 미확인 단지가 소형으로 오배제됐다(모름=0 취급 회귀)');
  });
});



// ── SELF-HEAL-2026-09-06 (B) ────────────────────────────────────────────────────────
//   [행위 테스트] ① dayIdx 가 다르면 워밍 큐가 실제로 회전하는지, ② budgetMs 를 넘기면
//   naverDatalabService.warmInterest 실체가 네트워크 호출 전에 멈추는지 확인한다.
test('관심도 워밍 — dayIdx 로 매일 다른 구간을 회전시키고, budgetMs 예산을 넘기면 즉시 멈춘다', async () => {
  const dbPath = require.resolve('../db/client');
  const dlPath = require.resolve('../services/naverDatalabService');
  const jobPath = require.resolve('../jobs/interestWarm');
  const saved = { db: require.cache[dbPath], dl: require.cache[dlPath], job: require.cache[jobPath] };
  const q = (table) => {
    const s = { _t: table, _in: null,
      select() { return s; }, order() { return s; }, not() { return s; },
      in(col, vals) { s._in = vals; return s; },
      range(a, b) {
        if (table === 'molit_apt_index') {
          const rows = Array.from({ length: 1200 }, (_, i) => ({ apt_name: 'A' + i, sigungu: '노원구', umd_nm: '상계동', deal_count: 5000 - i }));
          return Promise.resolve({ data: rows.slice(a, b + 1), error: null });
        }
        return Promise.resolve({ data: [], error: null });
      },
      then(resolve) { // apt_geocache 는 range 없이 await 된다 — 전부 좌표가 있는 것으로 만든다(회전만 본다)
        const rows = (s._in || []).map(n => ({ apt_name: n, sigungu: '노원구', umd_nm: '상계동', lat: 37.6, lng: 127.0 }));
        resolve({ data: rows, error: null });
      },
    };
    return s;
  };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getSupabaseAdmin: () => ({ from: (t) => q(t) }) } };
  let got = null;
  require.cache[dlPath] = { id: dlPath, filename: dlPath, loaded: true, exports: {
    hasKeys: () => true, warmInterest: async (items, calls) => { got = { items, calls }; return { calls: 0, filled: 0, pending: items.length, stopped: null }; },
  } };
  try {
    delete require.cache[jobPath];
    const { run } = require('../jobs/interestWarm');
    const out0 = await run({ calls: 10, top: 1200, dayIdx: 0 });
    const items0 = got.items;
    const out3 = await run({ calls: 10, top: 1200, dayIdx: 3 });
    const items3 = got.items;
    assert.equal(items0.length, items3.length, '회전은 항목 수를 바꾸면 안 된다');
    assert.notEqual(items0[0].aptName, items3[0].aptName, 'dayIdx 가 달라도 매일 같은 앞자리를 처리한다(회전이 없다) — 기아 회귀');
    assert.deepEqual(items0.map(i => i.aptName).slice().sort(), items3.map(i => i.aptName).slice().sort(),
      '회전은 순서만 바꿔야 한다 — 집합 자체가 달라졌다');
    assert.equal(out0.slot, 0, '반환 요약에 slot 이 없다'); assert.equal(out3.slot, 3);
    assert.ok(Number.isFinite(out0.off) && Number.isFinite(out3.off), '반환 요약에 off 가 없다');
  } finally {
    if (saved.db) require.cache[dbPath] = saved.db; else delete require.cache[dbPath];
    if (saved.dl) require.cache[dlPath] = saved.dl; else delete require.cache[dlPath];
    if (saved.job) require.cache[jobPath] = saved.job; else delete require.cache[jobPath];
  }

  // budgetMs — naverDatalabService.warmInterest 실체(스텁 아님)를 직접 호출한다.
  // budgetMs:0 이면 루프 진입 즉시 멈춰야 한다 — 그래야 네트워크(fetchBatch)를 타지 않는다는 것도 같이 확인된다.
  const savedId = process.env.NAVER_CLIENT_ID, savedSecret = process.env.NAVER_CLIENT_SECRET;
  process.env.NAVER_CLIENT_ID = 'test-id';
  process.env.NAVER_CLIENT_SECRET = 'test-secret';
  try {
    const dl = require('../services/naverDatalabService');
    const items = [{ aptName: 'SELF-HEAL 예산 테스트 단지', sigungu: '노원구', umd: '상계동', lat: 37.6, lng: 127.0 }];
    const res = await dl.warmInterest(items, 5, { budgetMs: 0 });
    assert.equal(res.stopped, 'budget', 'budgetMs 를 0 으로 줘도 stopped 가 budget 이 아니다');
    assert.equal(res.calls, 0, '예산을 넘기면 호출(fetchBatch) 전에 멈춰야 한다');
  } finally {
    if (savedId === undefined) delete process.env.NAVER_CLIENT_ID; else process.env.NAVER_CLIENT_ID = savedId;
    if (savedSecret === undefined) delete process.env.NAVER_CLIENT_SECRET; else process.env.NAVER_CLIENT_SECRET = savedSecret;
  }
});
