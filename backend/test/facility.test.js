/**
 * backend/test/facility.test.js
 *
 * characterization.test.js(Plan 066, 10,056줄·327 test 단일 파일)를 도메인별로 분할한 조각.
 * 동작을 하나도 바꾸지 않는 이동이다 — 테스트 이름·개수·본문은 원본과 동일하다.
 * 공용 목/스텁 유틸은 ./_helpers 에서 가져온다. 새 테스트는 이 파일의 주제와 맞으면 여기에,
 * 아니면 backend/test/README.md 규칙대로 새 도메인 파일을 만든다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _NO_PROMO, _mockAptAdmin, _reportFn, _requireRouterWithAdmin } = require('../testSupport/_helpers');



test('aptFacility.jibunFromKaptAddr — KAPT 지번주소에서 지번만 추출', () => {
  const { jibunFromKaptAddr } = require('../services/aptFacilityService');
  assert.equal(jibunFromKaptAddr('서울특별시 도봉구 방학동 271-1 방학신동아1단지'), '271-1');
  assert.equal(jibunFromKaptAddr('서울특별시 도봉구 방학동 736 신동아 타워 아파트'), '736');
  // 단지명에 숫자가 있어도 동 뒤 첫 지번만 — 단지명 숫자를 지번으로 오인하면 안 된다
  assert.equal(jibunFromKaptAddr('서울특별시 도봉구 방학동 738 방학신동아5단지'), '738');
  assert.equal(jibunFromKaptAddr(''), null);
  assert.equal(jibunFromKaptAddr(null), null);
});



test('aptFacility.bonbun — 부번 제거(대단지 다필지 흡수)', () => {
  const { bonbun } = require('../services/aptFacilityService');
  assert.equal(bonbun('271-1'), '271');
  assert.equal(bonbun('271'), '271');
  assert.equal(bonbun(' 530 '), '530');
  assert.equal(bonbun(''), null);
  assert.equal(bonbun(null), null);
});



test('aptFacility.verifyCandidate — 준공연도 불일치는 거부, 지번 일치는 채택', () => {
  const { verifyCandidate } = require('../services/aptFacilityService');
  const 신동아1 = { buildYear: 1986, jibunBon: '271' };

  // 실제 사고: 1986년 단지에 1997년 KAPT(11년 차이) → 반드시 거부
  const 타워 = verifyCandidate('19970825', '서울특별시 도봉구 방학동 736 신동아 타워 아파트', 신동아1, 'token');
  assert.equal(타워.ok, false);

  // 정답: 지번(271-1 → 271) 일치 → 이름이 달라도 채택
  const 정답 = verifyCandidate('19861231', '서울특별시 도봉구 방학동 271-1 방학신동아1단지', 신동아1, 'token');
  assert.equal(정답.ok, true);
  assert.equal(정답.reason, 'jibun-match');

  // 지번 **불일치는 거부 근거가 아니다** — 이름 완전일치(확실한 정답) 2,426쌍 중 10.47%가
  //   본번 불일치(대단지 다필지)라, 거부하면 정상 매칭 10%를 날린다. 연도가 맞으면 통과해야 한다.
  const 다른필지 = verifyCandidate('19861231', '서울특별시 도봉구 방학동 999 다른필지등록', 신동아1, 'token');
  assert.equal(다른필지.ok, true);

  // 약한 매칭(토큰)은 ±1년, 이름 완전일치는 ±3년까지 허용
  assert.equal(verifyCandidate('19880101', '주소없음', { buildYear: 1986 }, 'token').ok, false);
  assert.equal(verifyCandidate('19880101', '주소없음', { buildYear: 1986 }, 'exact').ok, true);

  // 신원 정보가 없으면 기존 동작 유지(통과) — 검증 불가를 거부로 바꾸면 회귀
  assert.equal(verifyCandidate('19970825', '아무주소', null, 'token').ok, true);
});



// ────────────────────────────────────────────────────────────────────────────
// Sprint MMMMMMM (2026-08-17) — 서울 전수조사 4회차에서 **실측으로 확정된** 두 결함의 계약.
//   두 결함 모두 "코드가 던지지도, 로그를 남기지도 않는" 조용한 종류라 테스트로만 지킬 수 있다.
// ────────────────────────────────────────────────────────────────────────────

const { buildFacility } = require('../utils/buildFacility');



test('buildFacility — 세대수 원천 2개가 20% 이상 어긋나면 householdsConflict 로 드러난다', () => {
  // [실측 근거] 서울 apt_master 중 kaptdaCnt·hoCnt 가 둘 다 0이 아니면서 서로 다른 단지 207곳.
  //   상대차 분포: 5%미만 157 / 5~20% 26 / 20~50% 16 / 50%이상 8.
  //   20% 임계는 이 분포에서 뽑았다 — 20% 미만은 관리세대수와 호수의 정상적 차이다.
  const mk = (da, ho) => buildFacility({ kaptdaCnt: String(da), hoCnt: String(ho) }, 'A1', null);

  // ① 아스테리움용산 실값 — 128 vs 338 (62.1%). 이 단지가 '주차여유' 태그를 받고 있었다.
  const conflict = mk(128, 338);
  assert.deepEqual(conflict.householdsConflict, { kaptdaCnt: 128, hoCnt: 338, used: 'kaptdaCnt' });
  assert.equal(conflict.totalHouseholds, 128, '표시값 규칙(kaptdaCnt 우선)은 바뀌지 않아야 한다');

  // ② 대치풍림아이원 1.2단지 실값 — 19 vs 90 (78.9%). 5개동에 19세대는 성립하지 않는다.
  assert.ok(mk(19, 90).householdsConflict, '78.9% 차이가 감지되지 않는다');

  // ③ 반대 방향도 같은 규칙 — 방원예뜨랑 실값(121 vs 3). hoCnt 가 틀린 케이스다.
  assert.ok(mk(121, 3).householdsConflict, 'hoCnt 쪽이 틀린 경우도 불일치로 잡아야 한다');

  // ④ 임계 미만은 **평소 경로** — null 이어야 하고, 여기가 깨지면 정상 단지 대부분이 오탐된다.
  //    롯데캐슬클라시아 실값(2033 vs 2029, 0.2%) — 건축물대장은 hoCnt 손을 들었지만 차이는 무시 가능.
  assert.equal(mk(2033, 2029).householdsConflict, null);
  assert.equal(mk(100, 81).householdsConflict, null, '19% 는 임계 미만이다');
  assert.ok(mk(100, 80).householdsConflict, '정확히 20% 는 임계 이상이다');

  // ⑤ 한쪽만 존재하면 비교 자체가 성립하지 않는다 → null (기존 hoCnt fallback 은 그대로 동작)
  assert.equal(mk(0, 1540).householdsConflict, null);
  assert.equal(mk(1540, 0).householdsConflict, null);
  assert.equal(buildFacility({ kaptdaCnt: '0', hoCnt: '1540' }, 'A1', null).totalHouseholds, 1540,
    'HH-HOCNT-FALLBACK(위례래미안이편한세상 [VERIFIED]) 이 깨졌다');
});



test('부속시설 키워드가 세 판정 경로에 모두 반영돼 있다 (드리프트 방지)', () => {
  // 같은 개념이 3곳에 흩어져 있고 과거에 실제로 갈렸다(GEO-VALIDATE-SSOT 주석의 ca9fcf7 이력).
  //   ① geocodeCacheService.NON_APT_PATTERNS — 지오코딩 후보 점수(-5)
  //   ② geocacheBackfill.REHEAL_NONRES_KEYWORDS — 기존 캐시 재지오코딩 대상 판정
  //   ③ routes/search.js SUBFEATURE_RE — in-bounds 대표좌표 선택 시 강등
  const fs = require('node:fs');
  const path = require('node:path');
  const { NON_APT_PATTERNS } = require('../services/geocodeCacheService');
  const backfillSrc = fs.readFileSync(path.join(__dirname, '../jobs/geocacheBackfill.js'), 'utf8');
  const searchSrc = fs.readFileSync(path.join(__dirname, '../routes/search.js'), 'utf8');
  const subM = searchSrc.match(/const SUBFEATURE_RE = \/[^/]+\//);
  assert.ok(subM, 'search.js 에서 SUBFEATURE_RE 를 찾지 못했다');

  // 전국 실측 규모: 경로당/노인정 298건 · 교차로 9건. 단지명 사용례는 apt_master·molit 모두 0건.
  // 5회차 추가분 — 단지명 사용례 apt_master·molit 모두 0건 실측(출구7·다이소5·복지관3·주민센터1·치과1·기공소1)
  for (const kw of ['경로당', '노인정', '교차로', '주민센터', '복지관', '다이소', '출구', '치과', '기공소']) {
    assert.ok(NON_APT_PATTERNS.test(kw), `NON_APT_PATTERNS 에 '${kw}' 가 없다 — 지오코딩이 그 지점을 고른다`);
    assert.ok(backfillSrc.includes(`'${kw}'`), `REHEAL_NONRES_KEYWORDS 에 '${kw}' 가 없다 — 기존 298건이 안 고쳐진다`);
    assert.ok(subM[0].includes(kw), `SUBFEATURE_RE 에 '${kw}' 가 없다 — 지도 대표좌표로 뽑힌다`);
  }
  // 기존 항목이 사라지지 않았는지도 함께 고정 (넓히다 지우는 사고 방지)
  for (const kw of ['충전소', '주차장', '관리사무소', '경비실', '놀이터']) {
    assert.ok(NON_APT_PATTERNS.test(kw), `NON_APT_PATTERNS 에서 기존 '${kw}' 가 사라졌다`);
    assert.ok(subM[0].includes(kw), `SUBFEATURE_RE 에서 기존 '${kw}' 가 사라졌다`);
  }
  // '플라자'는 의도적으로 넣지 않았다 — 주상복합 실명에 쓰여 오탐 위험이 있다.
  assert.equal(NON_APT_PATTERNS.test('플라자'), false,
    "'플라자'가 NON_APT_PATTERNS 에 들어갔다 — 주상복합 단지명 오탐 위험. 넣으려면 단지명 실측부터 할 것");
  // '프라자' 도 같은 이유로 금지 — 단지명 실측 master 13건·molit 261건.
  assert.equal(NON_APT_PATTERNS.test('프라자'), false,
    "'프라자'는 단지명으로 261건 쓰인다 — 넣으면 진짜 단지를 비주거로 오판한다");
  // '입구' 도 금지 — "서울대입구" 오탐. ('출구'는 지하철 출구 전용이라 위 목록에 들어가 있다.)
  assert.equal(NON_APT_PATTERNS.test('서울대입구'), false,
    "'입구'가 들어가면 '서울대입구'가 비주거로 걸린다");
});



test('세대당 주차 판정 5곳이 모두 세대수 불일치 가드를 거친다 (사본 드리프트 방지)', () => {
  // [배경] 같은 지표가 이미 5곳에서 판단에 쓰이고 있었다 — 태그 2곳(프론트 단지정보·백엔드 추천카드),
  //   점수 가산 1곳, 보고서 등급 보너스 1곳, 보고서 '장점' 문장 1곳. 여기에 필터가 하나 더 있다.
  //   이 저장소는 "사본 하나만 고치고 나머지가 갈리는" 사고를 여러 번 겪었으므로 전부 묶는다.
  const fs = require('node:fs');
  const path = require('node:path');
  const p = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
  const svc = p('../services/propertyService.js');
  const rep = p('../routes/report.js');
  const html = p('../../frontend/index.html');

  // 판정은 한 곳(householdsConflictOf)에서만 나온다 — 임계값을 복사한 자리가 있으면 안 된다
  const { householdsConflictOf, HH_CONFLICT_THRESHOLD } = require('../utils/buildFacility');
  assert.equal(HH_CONFLICT_THRESHOLD, 0.2);
  assert.ok(householdsConflictOf(128, 338), '아스테리움용산 실값(62%)이 불일치로 안 잡힌다');
  assert.equal(householdsConflictOf(2033, 2029), null, '0.2% 차이가 불일치로 잡히면 정상 단지가 오탐된다');
  assert.equal(householdsConflictOf(0, 1540), null, '한쪽만 있으면 비교 불가 → null');
  assert.equal(householdsConflictOf('abc', 100), null, '숫자가 아니면 null (KAPT 원천은 문자열이다)');
  assert.ok(rep.includes("require('../utils/buildFacility')"),
    '보고서가 판정을 따로 구현했다 — 임계값이 갈리면 같은 단지가 화면마다 다르게 나온다');

  // ① 점수 가산 ② 추천카드 태그 ③ 주차 필터 — propertyService
  // SCORE-V2-2026-08-30: 점수 함수가 100점 모델로 바뀌면서 표현이 달라졌다 —
  //   가드의 **의도**(세대수 원천이 갈리면 주차 비율로 점수를 올리지 않는다)는 그대로여야 한다.
  //   ⚠ 다만 이제는 0점이 아니라 **중간값**을 준다(모르는 것을 나쁨으로 만들지 않는다).
  assert.match(svc, /facility && facility\.householdsConflict\) \? null : \(\(facility && facility\.parkingRatio\) \|\| null\)/,
    '점수 가산이 세대수 불일치 단지에도 붙는다 — 실측상 세대당 6.07대까지 부푼다');
  assert.match(svc, /const 주차 = pr === null \? 3 :/,
    '세대수 불일치·주차 미확인을 0점으로 떨어뜨린다 — 모르는 것은 중간값이어야 한다');
  assert.match(svc, /parkingRatio >= 1\.2 && !facility\?\.householdsConflict/,
    '추천카드 주차여유 태그에 가드가 없다');
  assert.ok(svc.includes('if (fMinPark > 0 && fac.householdsConflict) return false;'),
    '주차 필터에 가드가 없다');

  // ④ 보고서 등급 보너스 ⑤ 보고서 장점 문장
  assert.match(rep, /function getParkingBonus\(parkingTotal, households, householdsConflict\)/,
    'getParkingBonus 가 불일치 여부를 받지 않는다');
  assert.match(rep, /if \(householdsConflict\) return \{ ratio: \(p \/ h\)\.toFixed\(2\), bonus: 0, uncertain: true \}/,
    '불일치인데 보너스(최대 12점)가 그대로 붙는다');
  assert.match(rep, /getParkingBonus\(c\.kaptInfo\?\.parking, c\.households, c\.householdsConflict\)/,
    '호출부가 불일치 값을 안 넘긴다 — 함수만 고치고 배선을 놓친 상태다');
  assert.match(rep, /parking_per_household >= 1 && !f\.parking_uncertain/,
    "보고서 '장점' 문장에 가드가 없다");
  assert.match(rep, /parking_uncertain: parking\.uncertain \|\| false/,
    'objectiveFacts 에 parking_uncertain 이 실리지 않는다 — 위 pros 가드가 항상 통과한다');

  // ⑥ 프론트 단지정보 태그
  assert.match(html, /f\.parkingRatio >= 1\.2 && !f\.householdsConflict/,
    '프론트 단지정보 주차여유 태그에 가드가 없다');
});



// ── SAME-DONG-SPLIT-2026-08-30 (Sprint PPPPPPP) ───────────────────────────────
// 운영자 발견: "광해리드빌이 미추로 61에도 있고 주안로 171에도 있는 것 같은데?
//              이런 것들도 많을 테니 확인 잘 해."
// 전수 실측(최근 6개월 거래):
//   · 같은 이름·같은 시군구인데 **다른 동** 340건 → 집계 키에 동이 있어 이미 분리됨(안전)
//   · 같은 이름·같은 동인데 다른 apt_seq 31그룹 중 **준공년도까지 다른 것 20그룹·204거래**
//     [사례] 부천 소사본동 "주공": 400-8(1995년·평균 2.78억·43건) ↔ 407-1(2006년·평균 4.23억·6건).
//            합치면 "2.97억" 이 되어 **둘 다 틀린 값**이 된다. 최대 준공년차 30년.
//   · ⚠ apt_seq 로 나누지 않는다 — 한 단지에 여러 seq 가 붙는 11그룹까지 쪼개진다.
//     준공년도는 "다르면 확실히 별개" 라는 결정적 증거이고 과분할은 2그룹뿐이다.
test('단지 식별 — 이름·동이 같아도 준공년도가 다르면 다른 단지로 센다', () => {
  const fs2 = require('node:fs'); const path2 = require('node:path');
  const tx = fs2.readFileSync(path2.join(__dirname, '../services/transactionService.js'), 'utf8');
  const rpt = fs2.readFileSync(path2.join(__dirname, '../routes/report.js'), 'utf8');

  // ① 추천 경로
  assert.match(tx, /const gkey = `\$\{t\.aptName\}\|\$\{t\.lawdCd \|\| ''\}\|\$\{t\.umdNm \|\| ''\}\|\$\{t\.buildYear \|\| ''\}`/,
    '거래 집계 키에 준공년도가 없다 — 1995년 단지와 2006년 단지가 한 평균으로 합쳐진다');

  // ② 보고서 경로도 **같은 정책**이어야 한다(두 경로가 갈리면 또 어긋난다).
  assert.match(rpt, /const key = `\$\{_canon\}\|\$\{t\.sigungu\}\|\$\{t\.umd_nm\}\|\$\{t\.build_year \|\| ''\}`/,
    '보고서 집계 키가 추천 경로와 다르다 — 같은 단지가 두 화면에서 다른 값을 갖는다');

  // ③ 관심도 캐시 키에도 동이 들어가야 한다(같은 구 동명 단지 340건).
  const dl = fs2.readFileSync(path2.join(__dirname, '../services/naverDatalabService.js'), 'utf8');
  assert.match(dl, /function cacheKeyFor\(name, sigungu, umd\)/,
    '관심도 캐시 키에 동이 없다 — 같은 구의 동명 단지가 뭉개진다');
  assert.ok(!/ni:\$\{normalizeAptName\(name\)\}\|\$\{String\(sigungu \|\| ''\)\.trim\(\)\}`/.test(dl),
    '옛 2단 키(이름|시군구)가 남아 있다');
});



// ── SCORE-ZERO-2026-08-30 (Sprint PPPPPPP) ────────────────────────────────────
// 전국 루프(121지역·2,259건) 검증 중 발각. KAPT 이름 매칭에 실패한 단지가 **0점**으로,
// scoreBreakdown·scoreWhy 도 없이 화면에 찍혔다.
//   [실측] 용산구 12억 검색 → '삼라마이다스빌2'(158세대·6개월 2건)가 0점으로 8위.
// 원인: recommendations 는 `score: 0` 으로 만들어지고 "enrichment 에서 확정" 하기로 돼 있는데,
//   KAPT 코드가 없는 갈래가 **점수 계산 없이 조기 반환**해 확정이 일어나지 않았다.
// 매칭 실패는 우리 사정이지 단지의 결함이 아니다 — 아는 만큼으로 점수를 낸다.
test('점수 — KAPT 매칭 실패 단지도 0점이 아니라 아는 만큼 받는다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const svc = fs2.readFileSync(path2.join(__dirname, '../services/propertyService.js'), 'utf8');

  // ① KAPT 코드 없는 갈래가 점수를 확정한다.
  const branch = svc.slice(svc.indexOf('if (!kaptCode) {'), svc.indexOf('// DTL-INFO-2026-05-13'));
  assert.ok(branch.length > 0, 'KAPT 미매칭 분기를 찾지 못했다');
  assert.match(branch, /_applyFacilityToScore\(/,
    'KAPT 매칭 실패 분기가 점수를 계산하지 않는다 — 그 단지는 영원히 0점이다');
  assert.match(branch, /scoreBreakdown: _sc0\.breakdown/,
    '근거(breakdown)를 싣지 않는다 — 화면에 0점이 이유 없이 찍힌다');

  // ② 세대수를 못 구해도(건축물대장도 실패) 점수는 나와야 한다.
  //    `if (!brHh) return rec;` 로 되돌아가면 이 검사가 깨진다.
  assert.ok(!/if \(!brHh\) return rec;/.test(svc),
    '건축물대장까지 실패하면 다시 0점으로 돌아간다 — 모름은 0점이 아니다');

  // ③ 실제로 계산해 본다 — facility 가 null 이어도 0 보다 커야 한다.
  //    (교통 15 중간값 + 인프라 10 + 규모주차 중간 + 관심도 7 … 최소한 양수)
  const m = svc.match(/function _applyFacilityToScore[\s\S]*?\n\}/);
  assert.ok(m, '_applyFacilityToScore 를 찾지 못했다');
  const bands = require('../utils/scoreBands');
  const walk = require('../utils/walkBand');
  const fn = new Function('turnoverScore', 'interestScore', 'parseWalkBand', 'WALK_BAND_LABEL', 'SCORE_V2_MAX',
    `${m[0]}; return _applyFacilityToScore;`)(
    bands.turnoverScore, bands.interestScore, walk.parseWalkBand, walk.WALK_BAND_LABEL,
    { 교통: 28, 인프라: 16, 규모주차: 12, 거래: 14, 연식: 10, 평형: 6, 관심도: 14 });
  const out = fn({ total: 8, breakdown: { 연식: 6, 평형: 2 }, dealCount: 3 }, null, null);
  assert.ok(out.total > 0, `facility 가 없어도 점수가 0 이면 안 된다 (실제 ${out.total})`);
  assert.ok(Array.isArray(out.why) && out.why.length > 0, '근거 문구가 비어 있다');
});



// ── JIBUN-MATCH-2026-08-30 (Sprint OOOOOOO) ───────────────────────────────────
// [무엇이 있었나] 군포 4.4억 무필터 결과 15곳이 **전부 500세대 이상**인데 500세대+ 필터는 0건이었다.
//   MOLIT 거래명과 KAPT 등록명은 접두·어순이 달라("충무주공(872)" ↔ 산본주공충무1) 이름으로는 안 붙는다.
//   전국 실측: 이름 정확일치 2,588/16,466(15.7%) vs 동+지번 본번 10,104(61.4%).
// [왜 테스트로 묶나] 지번 매칭은 **오매칭 시 남의 단지 세대수·주차를 카드에 띄운다**. 한 필지에
//   여러 KAPT 단지가 있는 경우가 전국 지번키의 6.9% 라, 모호할 때 포기하는지를 기계로 못박는다.
test('지번 매칭 — 유일할 때만 채택하고 모호하면 포기한다', () => {
  const { buildJibunIndex, lookupByJibun } = require('../services/propertyService');

  const idx = buildJibunIndex([
    { kaptCode: 'A1', kaptName: '산본주공충무1', as3: '금정동', jibunBon: '849', kaptUsedate: '19920101' },
    { kaptCode: 'B1', kaptName: '한필지단지A',   as3: '겹친동', jibunBon: '100', kaptUsedate: '19900101' },
    { kaptCode: 'B2', kaptName: '한필지단지B',   as3: '겹친동', jibunBon: '100', kaptUsedate: '20150101' },
    { kaptCode: 'C1', kaptName: '연도같은A',     as3: '연도동', jibunBon: '200', kaptUsedate: '20100101' },
    { kaptCode: 'C2', kaptName: '연도같은B',     as3: '연도동', jibunBon: '200', kaptUsedate: '20100101' },
    { kaptCode: 'D1', kaptName: '지번없음',      as3: '없음동', jibunBon: '',    kaptUsedate: '20000101' },
  ]);

  // ① 이름이 완전히 달라도 동+본번이 유일하면 붙는다 — 이 기능의 존재 이유.
  assert.equal(lookupByJibun(idx, { umdNm: '금정동', jibun: '849', buildYear: 1992 }), 'A1',
    '동+본번이 유일한데도 매칭되지 않는다');
  // 부번이 달라도 본번이 같으면 같은 단지다(대단지는 필지가 여러 개).
  assert.equal(lookupByJibun(idx, { umdNm: '금정동', jibun: '849-3', buildYear: 1992 }), 'A1',
    '부번 차이로 매칭이 깨진다 — 본번까지만 비교해야 한다');

  // ② 한 필지에 여러 단지 → 준공연도가 유일하게 맞을 때만 채택.
  assert.equal(lookupByJibun(idx, { umdNm: '겹친동', jibun: '100', buildYear: 2015 }), 'B2',
    '연도로 가려낼 수 있는데 포기했다');
  assert.equal(lookupByJibun(idx, { umdNm: '겹친동', jibun: '100', buildYear: 1990 }), 'B1',
    '연도로 가려낼 수 있는데 포기했다');

  // ③ ⚠ 연도로도 못 가르면 **포기**해야 한다 — 여기서 아무거나 고르면 남의 단지 정보가 카드에 실린다.
  assert.equal(lookupByJibun(idx, { umdNm: '연도동', jibun: '200', buildYear: 2010 }), null,
    '모호한데도 하나를 골랐다 — 오매칭으로 남의 세대수·주차가 표시된다');
  assert.equal(lookupByJibun(idx, { umdNm: '겹친동', jibun: '100', buildYear: 0 }), null,
    '실거래 준공연도를 모르는데 중복 필지에서 하나를 골랐다');

  // ⑤ EUPMYEON-FALLBACK-2026-08-30: 군(郡)·읍면은 표기 단위가 다르다 —
  //    MOLIT "와부읍 덕소리"(읍/면+리) vs KAPT "와부읍"(읍/면 단독). 동등 비교는 전건 실패한다.
  //    [실측] 이 폴백만으로 거래 매칭률 76.3% → 81.3% (846단지·9,144거래 추가).
  //    ⚠ 지번 본번까지 함께 맞아야 채택되므로 읍/면으로 넓혀도 오매칭 위험은 커지지 않는다.
  {
    const idx2 = buildJibunIndex([
      { kaptCode: 'E1', kaptName: '덕소한강', as3: '와부읍', jibunBon: '410', kaptUsedate: '20050101' },
      { kaptCode: 'E2', kaptName: '다른읍단지', as3: '오남읍', jibunBon: '410', kaptUsedate: '20050101' },
    ]);
    assert.equal(lookupByJibun(idx2, { umdNm: '와부읍 덕소리', jibun: '410-2', buildYear: 2005 }), 'E1',
      '읍/면+리 표기가 읍/면 단독 등록과 매칭되지 않는다 — 군 지역이 통째로 빠진다');
    // 읍/면이 다르면 본번이 같아도 붙으면 안 된다(다른 읍의 같은 번지는 다른 땅이다).
    assert.equal(lookupByJibun(idx2, { umdNm: '진접읍 금곡리', jibun: '410', buildYear: 2005 }), null,
      '다른 읍/면인데 본번만 같다고 매칭했다 — 남의 단지 정보가 붙는다');
    // 공백 없는 일반 동은 폴백을 타지 않는다(기존 동작 불변).
    assert.equal(lookupByJibun(idx2, { umdNm: '와부읍', jibun: '410', buildYear: 2005 }), 'E1');
  }

  // ④ 입력이 없으면 조용히 null (예외 금지)
  assert.equal(lookupByJibun(idx, { umdNm: '금정동', jibun: '', buildYear: 1992 }), null);
  assert.equal(lookupByJibun(idx, { umdNm: '', jibun: '849', buildYear: 1992 }), null);
  assert.equal(lookupByJibun(idx, { umdNm: '없음동', jibun: '999', buildYear: 2000 }), null);
  assert.equal(lookupByJibun(new Map(), { umdNm: '금정동', jibun: '849' }), null);

  // ⑤ 지번 없는 KAPT 행은 색인에 들어가지 않는다(빈 키로 오매칭 방지)
  assert.ok(!idx.has('없음동|'), '지번 없는 행이 색인에 들어갔다');
});



// ── HH-BR-FALLBACK-2026-08-17 (Sprint MMMMMMM-23) ─────────────────────────────
// 운영자 지시: "미확인은 다시 조사해서 채워넣어야지 뭘 그냥 통과시켜."
// 세대수의 3순위 원천으로 건축물대장을 붙인다. 경계는 셋 — KAPT 우선 / 모를 때만 BR / 그래도 없으면 모름.
test('buildFacility — 세대수는 KAPT 우선, 둘 다 0일 때만 건축물대장, 출처를 함께 낸다', () => {
  const { buildFacility } = require('../utils/buildFacility');
  const br = { hhldCnt: 630, dongCnt: 4, useAprDay: '19911115', source: 'buildingRegister' };

  // (1) KAPT 값이 있으면 BR 이 있어도 절대 덮지 않는다 (교차검증 12건 kaptdaCnt 9:2 우세 — 기본 규칙 유지)
  const kapt = buildFacility({ kaptdaCnt: '1540', hoCnt: '1540', _br: br }, 'A1', null);
  assert.equal(kapt.totalHouseholds, 1540, 'KAPT 값이 건축물대장에 밀렸다');
  assert.equal(kapt.householdsSource, 'kapt');

  // (2-1) kaptdaCnt=0 이어도 hoCnt 가 살아 있으면 그쪽이 먼저다 (HH-HOCNT-FALLBACK 유지)
  const ho = buildFacility({ kaptdaCnt: '0', hoCnt: '1540', _br: br }, 'A2', null);
  assert.equal(ho.totalHouseholds, 1540);
  assert.equal(ho.householdsSource, 'kapt');

  // (2-2) 둘 다 0 → 건축물대장. 실측 대상 12곳이 정확히 이 형태다 (kaptdaCnt "0" · hoCnt "0")
  const brOnly = buildFacility({ kaptdaCnt: '0', hoCnt: '0', _br: br }, 'A3', null);
  assert.equal(brOnly.totalHouseholds, 630, '둘 다 0인데 건축물대장 값이 안 붙었다');
  assert.equal(brOnly.householdsSource, 'buildingRegister');

  // (2-3) KAPT 조회 실패 sentinel 위에도 붙는다 — 실측 모집단 395곳이 이 형태다
  const onEmpty = buildFacility({ _empty: true, _br: br }, 'A4', null);
  assert.equal(onEmpty.totalHouseholds, 630);
  assert.equal(onEmpty.householdsSource, 'buildingRegister');

  // (3) 아무 원천도 없으면 **모름**이다. HH-NULL-2026-09-05 부터 값 자체가 null 이다(종전엔 0 을 내고 출처 null 로만 표시).
  const none = buildFacility({ kaptdaCnt: '0', hoCnt: '0' }, 'A5', null);
  assert.equal(none.totalHouseholds, null, 'HH-NULL-2026-09-05: 모름은 null — 0 은 값이다');
  assert.equal(none.householdsSource, null, '미확인인데 출처가 붙으면 0이 값으로 읽힌다');

  // BR 값이 0/음수/쓰레기면 채택하지 않는다(모름 유지) — 상류가 0을 줄 수 있다
  for (const bad of [0, -1, null, undefined, 'N/A']) {
    const r = buildFacility({ kaptdaCnt: '0', hoCnt: '0', _br: { hhldCnt: bad } }, 'A6', null);
    assert.equal(r.totalHouseholds, null, '쓸 수 없는 BR 값이 채택됐다(모름은 null): ' + String(bad));
    assert.equal(r.householdsSource, null);
  }

  // 세대당 주차는 세대수를 분모로 쓴다 — BR 로 세대수가 생기면 비율도 함께 성립해야 한다
  const withPark = buildFacility({ kaptdaCnt: '0', hoCnt: '0', _br: br }, 'A7', { kaptdPcnt: '300', kaptdPcntu: '330' });
  assert.equal(withPark.parkingTotal, 630);
  assert.equal(withPark.parkingRatio, 1, '분모(세대수)가 BR 로 채워졌는데 비율이 안 나왔다');
});



test('BR 되쓰기 — 캐시된 세대수만 붙이고 동명·값없음은 건드리지 않는다', async () => {
  const { writeBackToMaster } = require('../jobs/buildingRegisterBackfill');
  const brRows = [
    { apt_key: 'name:지산타운|27260', title: { hhldCnt: 630, dongCnt: 4, useAprDay: '19911115' } },
    { apt_key: 'name:값없음|11110', title: { hhldCnt: 0 } },       // 상류가 0 → 적지 않는다
    { apt_key: 'name:쌍둥이|11140', title: { hhldCnt: 999 } },     // 동명 2행 → 어느 쪽인지 모른다
    { apt_key: 'name:세대수0|11680', title: { hhldCnt: 250, dongCnt: 2 } },
  ];
  const emptyRows = [
    { kapt_code: 'A1', apt_name: '지산타운', lawd_cd: '27260', facility: { _empty: true } },
    { kapt_code: 'A2', apt_name: '값없음', lawd_cd: '11110', facility: { _empty: true } },
    { kapt_code: 'A3', apt_name: '쌍둥이', lawd_cd: '11140', facility: { _empty: true } },
    { kapt_code: 'A4', apt_name: '쌍둥이', lawd_cd: '11140', facility: { _empty: true } },
    { kapt_code: 'A5', apt_name: '캐시없음', lawd_cd: '41290', facility: { _empty: true } },
  ];
  const zeroRows = [
    { kapt_code: 'B1', apt_name: '세대수0', lawd_cd: '11680', facility: { kaptdaCnt: '0', hoCnt: '0', kaptName: '세대수0' } },
  ];

  const updates = [];
  const admin = {
    from(table) {
      const calls = [];
      const o = {
        select() { return o; },
        not(...a) { calls.push(['not'].concat(a)); return o; },
        is(...a) { calls.push(['is'].concat(a)); return o; },
        eq(...a) { calls.push(['eq'].concat(a)); return o; },
        in(...a) { calls.push(['in'].concat(a)); return o; },
        limit() { return o; },
        update(p) { calls.push(['update', p]); return o; },
        then(res, rej) {
          let data = [];
          if (table === 'building_register') {
            const inCall = calls.find(c => c[0] === 'in');
            const keys = new Set(inCall ? inCall[2] : []);
            data = brRows.filter(b => keys.has(b.apt_key));
          } else if (calls.some(c => c[0] === 'update')) {
            const patch = calls.find(c => c[0] === 'update')[1];
            const key = calls.find(c => c[0] === 'eq' && c[1] === 'kapt_code');
            updates.push({ kaptCode: key && key[2], facility: patch.facility });
            data = null;
          } else {
            // 두 후보 질의를 구분 — 세대수 0 질의만 kaptdaCnt 필터를 건다
            data = calls.some(c => c[0] === 'eq' && c[1] === 'facility->>kaptdaCnt') ? zeroRows : emptyRows;
          }
          return Promise.resolve({ data, error: null }).then(res, rej);
        },
      };
      return o;
    },
  };

  const r = await writeBackToMaster(admin);
  const byCode = new Map(updates.map(u => [u.kaptCode, u.facility]));

  assert.equal(r.written, 2, '되쓴 행 수가 다르다: ' + JSON.stringify(updates.map(u => u.kaptCode)));
  assert.deepEqual([...byCode.keys()].sort(), ['A1', 'B1']);

  assert.equal(byCode.get('A1')._br.hhldCnt, 630);
  assert.equal(byCode.get('A1')._br.dongCnt, 4);
  assert.equal(byCode.get('A1')._br.useAprDay, '19911115');
  assert.equal(byCode.get('A1')._br.source, 'buildingRegister');
  // 기존 facility 를 통째로 갈아끼우면 안 된다 — 덧붙이는 것이다
  assert.equal(byCode.get('A1')._empty, true, '기존 facility 키가 사라졌다');
  assert.equal(byCode.get('B1').kaptName, '세대수0', '기존 KAPT raw 가 사라졌다');
  assert.equal(byCode.get('B1')._br.hhldCnt, 250);

  // 건드리면 안 되는 것들
  assert.equal(byCode.has('A2'), false, '상류 세대수가 0인데 적었다 — 모름을 0으로 굳히면 안 된다');
  assert.equal(byCode.has('A3') || byCode.has('A4'), false, '동명 단지에 값을 붙였다 — 어느 쪽인지 알 수 없다');
  assert.equal(byCode.has('A5'), false, '캐시에 없는 단지를 적었다');
  assert.equal(r.ambiguous, 2, '동명으로 건너뛴 수가 안 맞는다');
});



// ── BR-PRESERVE-BEHAVIORAL-2026-09-02 (감사 후속: 테스트 행위화) ─────────────
//   [왜] backfillFacilityByKaptCode 는 facility 를 **통째로 교체**한다. 건축물대장 보강값(`_br`)을
//     살려두지 않으면 empty 재시도(14일 주기)마다 세대수가 지워져 "채웠는데 며칠 뒤 다시 미상" 이
//     되고, 원인을 사후에 찾기가 대단히 어렵다.
//   [무엇이 바뀌었나] 종전에는 소스에서 `_empty: true, _br: prevBr` 같은 **문자열 모양**을 봤다.
//     그건 리팩터링 한 번이면 의미 없이 깨지고, 반대로 모양이 남아도 앞단 분기가 바뀌면 통과한다.
//     이제 함수를 **실제로 실행**해 DB 에 쓰려던 payload 를 그대로 확인한다.
//     외부 의존은 require.cache 스텁으로 끊는다(이 파일의 결제 테스트와 같은 방식).
test('_br 보존 — 백필을 실제로 실행해 건축물대장 값이 payload 에 남는지 확인한다', async () => {
  const facPath = require.resolve('../services/aptFacilityService');
  const clientPath = require.resolve('../db/client');
  const dgkPath = require.resolve('../services/dataGoKrClient');
  const aptInfoPath = require.resolve('../services/aptInfoService');

  // apt_master 한 행만 흉내내는 최소 목 — update 로 넘어온 payload 를 기록한다
  const makeAdmin = (prevFacility) => {
    const seen = { updates: [], tables: [], selects: [] };
    const upChain = (patch) => {
      // 실패 sentinel 경로가 `.then(()=>{},()=>{})` 로 호출하므로 thenable 이어야 한다
      const c = { eq: () => c, then: (r, j) => Promise.resolve({ error: null }).then(r, j) };
      seen.updates.push(patch);
      return c;
    };
    const mk = () => {
      const s = {
        select: (c) => { seen.selects.push(String(c)); return s; },
        eq: () => s,
        maybeSingle: async () => ({ data: prevFacility === undefined ? null : { facility: prevFacility }, error: null }),
        update: upChain,
      };
      return s;
    };
    return { client: { from: (tb) => { seen.tables.push(tb); return mk(); } }, seen };
  };

  const run = async ({ prevFacility, apiOk, detail }) => {
    const paths = [facPath, clientPath, dgkPath, aptInfoPath];
    const saved = {};
    for (const q of paths) saved[q] = require.cache[q];
    const savedKey = process.env.APT_INFO_API_KEY;
    const { client, seen } = makeAdmin(prevFacility);
    const stub = (q, exp) => { require.cache[q] = { id: q, filename: q, loaded: true, exports: exp }; };
    stub(clientPath, { getSupabaseAdmin: () => client });
    stub(dgkPath, { get: async () => {
      if (!apiOk) throw new Error('네트워크 없음');
      return { data: { response: { header: { resultCode: '00' },
        body: { item: { kaptName: '테스트단지', kaptCode: 'A1', kaptdaCnt: 500 } } } } };
    } });
    stub(aptInfoPath, { getAptListBySgg: async () => [], getAptDtlInfo: async () => detail || null });
    // APT_INFO_KEY 는 모듈 로드 시 상수라 env 를 먼저 세우고 다시 require 해야 한다
    process.env.APT_INFO_API_KEY = 'xxxxxxxx-test-only';
    delete require.cache[facPath];
    try {
      const { backfillFacilityByKaptCode } = require(facPath);
      const res = await backfillFacilityByKaptCode('A1');
      return { res, updates: seen.updates, selects: seen.selects };
    } finally {
      for (const q of paths) { if (saved[q]) require.cache[q] = saved[q]; else delete require.cache[q]; }
      if (savedKey === undefined) delete process.env.APT_INFO_API_KEY;
      else process.env.APT_INFO_API_KEY = savedKey;
    }
  };

  const BR = { hhldCnt: 300, src: 'building_register' };

  // ① KAPT 실패 → 실패 sentinel 을 쓰는데, 여기서 _br 을 버리면 안 된다
  //   (주석이 지적하듯 **오히려 이쪽이** 건축물대장 값이 꼭 필요한 단지다)
  const a = await run({ prevFacility: { _br: BR, kaptName: '옛값' }, apiOk: false });
  assert.equal(a.res.reason, 'no-basisinfo', 'KAPT 실패 경로를 타지 않았다 — 스텁이 안 먹었다');
  assert.equal(a.updates.length, 1, 'sentinel 을 한 번 써야 한다');
  assert.equal(a.updates[0].facility._empty, true, 'sentinel 표식이 없다 — 무한 재시도로 돌아간다');
  assert.deepEqual(a.updates[0].facility._br, BR,
    '실패 sentinel 이 건축물대장 값을 지웠다 — 14일 주기 재시도마다 세대수가 미상으로 되돌아간다');
  assert.ok(a.selects.includes('facility'), '기존 facility 를 읽지 않으면 애초에 보존할 수 없다');

  // ② KAPT 성공 → 새 값으로 갈아끼우되 _br 은 남긴다 (buildFacility 가 3순위로 쓴다)
  const b = await run({ prevFacility: { _br: BR }, apiOk: true, detail: { kaptdPcnt: 400 } });
  assert.equal(b.res.ok, true, 'KAPT 성공 경로가 실패했다');
  assert.deepEqual(b.updates[0].facility._br, BR, '성공 경로가 건축물대장 값을 지웠다');
  assert.deepEqual(b.updates[0].facility._dtl, { kaptdPcnt: 400 }, '상세정보가 병합되지 않았다');
  assert.equal(b.updates[0].facility.kaptName, '테스트단지', 'KAPT 응답이 반영되지 않았다');

  // ③ 보존할 값이 없으면 _br 키를 만들지 않는다 (없는 값을 지어내지 않는다)
  const c = await run({ prevFacility: { kaptName: '옛값' }, apiOk: false });
  assert.deepEqual(c.updates[0].facility, { _empty: true }, '보존할 _br 이 없는데 키가 생겼다');

  // ④ 기존 행이 아예 없어도 죽지 않고 정상 저장한다
  const d = await run({ prevFacility: undefined, apiOk: true, detail: null });
  assert.equal(d.res.ok, true, '기존 행이 없을 때 백필이 실패한다');
  assert.equal('_br' in d.updates[0].facility, false, '없던 _br 이 생겼다');
});



// ── HH-BR-OBSERV-2026-08-17 (Sprint MMMMMMM-26) ───────────────────────────────
// emptyFetch·householdsZero 는 **KAPT 커버리지** 지표라 건축물대장으로 세대수를 채워도 안 줄어든다.
// 그래서 지표만 보면 "407곳 미확인" 이 영원히 유지된다 — 실제로 해소된 몫이 안 보인다.
// 여기서 고정하는 것은 "해소분을 어떻게 세는가" 다. 세는 방법을 틀리면 수치가 조용히 거짓이 된다.
test('facilityQuality — 건축물대장 해소분은 모집단 안에서만 센다', () => {
  const fs = require('fs'); const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const i = src.indexOf('async function getFacilityQuality');
  assert.ok(i >= 0, 'getFacilityQuality 를 못 찾았다');
  const body = src.slice(i, i + 4000);

  // (1) `_br` 을 **단독으로** 세면 안 된다. KAPT 가 나중에 성공한 행도 `_br` 을 보존하므로
  //     (aptFacilityService 가 재조회 시 유실을 막으려고 남긴다) 모집단 밖까지 빼게 되어
  //     실질 미확인이 과소 집계된다 → 반드시 각 모집단 조건과 AND 로 묶어야 한다.
  assert.match(body, /not\('facility->_empty', 'is', null\)\.not\('facility->_br', 'is', null\)/,
    '_empty 모집단 안의 해소분을 AND 로 세지 않는다');
  const zeroBr = body.slice(body.indexOf("_dtl"));
  assert.match(zeroBr, /kaptdaCnt[\s\S]{0,200}hoCnt[\s\S]{0,200}not\('facility->_br', 'is', null\)/,
    '세대수0 모집단 안의 해소분을 AND 로 세지 않는다');

  // (2) 실질 미확인은 뺄셈이되 음수 방어가 있어야 한다(모집단 정의가 바뀌어도 안전).
  assert.match(body, /Math\.max\(0,\s*\(emp - brE\)\)\s*\+\s*Math\.max\(0,\s*\(hh - brZ\)\)/,
    '실질 미확인 계산이 없거나 음수 방어가 없다');

  // (3) 두 신규 필드가 실제로 응답에 실린다 — 안 실으면 관측이 여전히 불가능하다.
  assert.match(body, /householdsFilledByBr:/, '해소 누계 필드가 응답에 없다');
  assert.match(body, /householdsUnknown:/, '실질 미확인 필드가 응답에 없다');

  // (4) warn 은 **실질 미확인**을 봐야 한다. emp 를 그대로 보면 건축물대장으로 다 채워도 계속 켜진다.
  assert.match(body, /warn:[^;]*hhUnknown >= 50/, 'warn 이 실질 미확인이 아니라 옛 지표를 본다');
  assert.equal(/warn:[^;]*emp >= 50/.test(body), false, 'warn 에 옛 emp 임계가 남아 있다');
});



// ── FACILITY-STORE-LOG-2026-09-05 (감사 G-6) ──────────────────────────────────────
test('facility 갱신 저장 실패는 기록된다 (fire-and-forget 금지)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../services/aptFacilityService.js'), 'utf8');
  assert.equal(src.includes(".eq('kapt_code', m.kapt_code).then(() => {}, () => {})"), false, '저장 실패가 다시 삼켜진다');
  assert.match(src, /'facility 갱신 저장 실패'/);
});



// ── HH-NULL-2026-09-05 (감사 G-7: 세대수 "모름" 은 생산 함수에서 null) ─────────────────────────
test('세대수 "모름" 은 null 로 생산된다 — 0 은 값이다', () => {
  const { buildFacility } = require('../utils/buildFacility');
  assert.equal(buildFacility(null, 'K1', null).totalHouseholds, null, 'KAPT 정보가 없을 때');
  assert.equal(buildFacility({ kaptdaCnt: '0', hoCnt: '0' }, 'K1', null).totalHouseholds, null, '두 원천이 모두 0(=모름)일 때');
  assert.equal(buildFacility({ kaptdaCnt: '0', hoCnt: '0', _br: { hhldCnt: '630' } }, 'K1', null).totalHouseholds, 630, '건축물대장 폴백은 그대로');
  assert.equal(buildFacility({ kaptdaCnt: '0', hoCnt: '0' }, 'K1', null).parkingRatio, null, '분모를 모르면 비율도 모름');
});



// ── REC-RESOLVE-FALLBACK-2026-09-05 (벽산·동부골든: 추천 카드만 부실 facility) ──────────────────
test('추천 kapt 미매칭 — BR 세대수로 끝내기 전에 resolveFacility(검증된 단건 매처)를 먼저 시도한다', () => {
  const src = require('node:fs').readFileSync(require.resolve('../services/propertyService'), 'utf8');
  const i = src.indexOf('REC-RESOLVE-FALLBACK-2026-09-05');
  assert.ok(i > 0, '미매칭 복원 분기가 사라졌다 — 벽산류 단지의 단지정보 탭이 다시 전부 미상이 된다');
  const blk = src.slice(i, i + 2400);
  assert.match(blk, /resolveFacility\(\{\s*aptName: ranked\[i\]\.aptName/, 'resolveFacility 호출이 없다');
  assert.match(blk, /_applyFacilityToScore\(rec\._baseScore, facility/, '복원 경로가 점수를 확정하지 않는다(SCORE-ZERO 재발)');
  // 가드 형태 고정 — 'if (false && rf)' 류로 분기만 꺼두는 회귀를 잡는다(주입 실측: 기존 단언들은 전부 초록이었다)
  assert.match(blk, /if \(rf && rf\.kaptCode && rf\.raw\) \{/, '복원 분기 가드가 변형됐다 — 실행되지 않는 코드일 수 있다');
  // 순서: resolveFacility 시도가 BR(_brHh 단독 경로)보다 앞
  const brIdx = src.indexOf('const brHh = await _brHh(ranked[i]);');
  assert.ok(i < brIdx, 'resolveFacility 가 BR 폴백보다 뒤에 있다 — 부실 facility 가 먼저 확정된다');
  assert.ok(src.includes("resolveFacility } = require('./aptFacilityService')"), 'resolveFacility 임포트가 빠졌다');
  // NO-LIVE: 배치 복원은 라이브 KAPT 목록(릴레이 13s 타임아웃)을 타지 않는다 — 프로덕션 실측 facility 14.7s 의 원인
  assert.match(blk, /lawdCd: ranked\[i\]\.lawdCd, noLive: true,/, '배치 복원이 라이브 KAPT 목록 조회를 건너뛰지 않는다(응답 20초)');
  const facSrc = require('node:fs').readFileSync(require.resolve('../services/aptFacilityService'), 'utf8');
  assert.match(facSrc, /if \(!m\?\.kapt_code && lawdCd && !noLive\) \{/, 'resolveFacility 가 noLive 를 존중하지 않는다');
  assert.match(facSrc, /noLive \? 'nolive' : 'live'/, 'noLive 결과가 라이브 경로 캐시 키와 섞인다');
});



// ── T6-SOURCE-2026-09-05 ─────────────────────────────────────────────────────────
test('단지정보 탭 — /search/facility 응답이 있으면 추천 카드의 부실 facility 보다 우선한다', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../frontend/index.html'), 'utf8');
  const i = html.indexOf('T6-SOURCE-2026-09-05');
  assert.ok(i > 0, 't6 소스 우선순위 마커가 사라졌다');
  assert.match(html.slice(i, i + 500),
    /p\._facilityRes && p\._facilityRes\.facility && p\._facilityRes\.facility\.kaptCode/,
    't6 이 _facilityRes(kaptCode 보유분)를 우선하지 않는다');
});



// ── REC-RANK-PROV-2026-09-05 (후보 컷을 거래 건수순 → 검증 티어·임시 점수순) ──────────────────
test('추천 후보 컷 — 거래 건수가 아니라 임시 점수(검증된 세대수 우선)로 RANK_N 을 고른다 + rank 순번 재부여', () => {
  const src = require('node:fs').readFileSync(require.resolve('../services/propertyService'), 'utf8');
  assert.ok(!/_score: a\.dealCount \* 10 \+ \(a\.buildYear \|\| 1990\) \* 0\.01/.test(src),
    '거래 건수 가중 컷이 되살아났다 — 거래가 적은 역세권·중대단지가 채점도 못 받는다');
  assert.match(src, /const prov = _applyFacilityToScore\(_calcBaseScore\(a\), fac, null\)\.total;/, '임시 점수 계산이 없다');
  assert.match(src, /_tier\(x, y\) \|\| \(y\._score - x\._score\)/, '검증 티어 → 임시 점수 정렬이 아니다');
  assert.match(src, /const _tier = \(x, y\) => \(Number\(y\._verified\) - Number\(x\._verified\)\);/, '검증 티어 키가 없다');
  assert.match(src, /_verified: x\.hh != null && x\.hh >= 100/, '검증 티어 판정(확인된 100세대 이상)이 없다');
  assert.match(src, /\|\| lookupByJibun\(_jIdx, apt\) \|\| null;/, 'TRUST+HH 게이트의 코드 매칭에 지번 폴백이 없다');
  // rank 는 표시 순서다(라이브 실측: 5·22·20·29… 로 보였다)
  const wc = src.indexOf('const withCoords = enrichedRecs.map((rec, i) => {');
  assert.ok(wc > 0, 'withCoords 조립이 사라졌다');
  assert.match(src.slice(wc, wc + 700), /rank: i \+ 1,/, 'withCoords 에서 rank 를 재부여하지 않는다');
  assert.match(src, /finalRecs = _big\.map\(\(r, i\) => \(\{ \.\.\.r, rank: i \+ 1 \}\)\);/, '최종 HH 게이트 뒤 순번이 비어 보인다');
  assert.match(src, /else if \(totalHouseholds > 0 && totalHouseholds < 100\) moreTags\.push\('소규모'\);/, '소규모 태그가 없다');
});



// ── FAC-BATCH-CHUNK-2026-09-05 ──────────────────────────────────────────────────
test('facility 배치 조회 — 150개 청크로 나눠 병렬 조회하고 결과를 합친다(URL 한계·1000행 컷 회피)', async () => {
  const dbPath = require.resolve('../db/client');
  const facPath = require.resolve('../services/aptFacilityService');
  const saved = { db: require.cache[dbPath], fac: require.cache[facPath] };
  const calls = [];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
    getSupabaseAdmin: () => ({ from: () => ({ select: () => ({ in: (col, codes) => {
      calls.push(codes.length);
      return Promise.resolve({ data: codes.map(c => ({ kapt_code: c, facility: { kaptdaCnt: '500' } })), error: null });
    } }) }) }),
  } };
  try {
    delete require.cache[facPath];
    const { getFacilitiesByKaptCodes } = require('../services/aptFacilityService');
    const codes = Array.from({ length: 400 }, (_, i) => 'A' + String(i).padStart(8, '0'));
    const m = await getFacilitiesByKaptCodes(codes.concat(codes.slice(0, 5)));
    assert.deepEqual(calls, [150, 150, 100], '청크 분할이 150/150/100 이 아니다: ' + JSON.stringify(calls));
    assert.equal(m.size, 400, '청크 결과 병합이 깨졌다');
  } finally {
    if (saved.db) require.cache[dbPath] = saved.db; else delete require.cache[dbPath];
    if (saved.fac) require.cache[facPath] = saved.fac; else delete require.cache[facPath];
  }
});



// ── REPORT-CANDIDATE-2026-09-05 (보고서 7곳 중 6곳이 n=2 소형 건물) ─────────────────────────
test('보고서 후보 — 표본 3건 우선 + 후보 컷 24 + 최종 정렬(예산 이하 → 세대수 확인 → 점수)', () => {
  const src = require('node:fs').readFileSync(require.resolve('../routes/report'), 'utf8');
  assert.match(src, /const REPORT_PRECUT = 24;/, '후보 컷 상수가 없다');
  assert.match(src, /pool = _n3\.length >= REPORT_PRECUT \? _n3 : pool\.filter\(a => a\.n >= 2\);/, '표본 3건 우선 규칙이 없다');
  assert.ok(!src.includes('Math.min(limit * 3, 20)'), '옛 20개 컷이 남아 있다');
  assert.match(src, /out\.sort\(\(a, b\) => \(Number\(_inBudget\(b\)\) - Number\(_inBudget\(a\)\)\)\s*\|\| \(Number\(_verified\(b\)\) - Number\(_verified\(a\)\)\)\s*\|\| \(b\.score - a\.score\)\);/,
    '최종 정렬이 예산 이하 → 세대수 확인 → 점수 순이 아니다');
  assert.match(src, /const _verified = \(c\) => Number\.isFinite\(c\.households\) && c\.households >= 100;/, '세대수 확인 판정이 없다');
  assert.match(src, /const _inBudget = \(c\) => Number\.isFinite\(_priceOf\(c\)\) && _priceOf\(c\) <= ctx\.buy \* 10000;/, '예산 이하 판정이 없다');
});



// ── MULTI-LENS-2026-09-05 ─────────────────────────────────────────────────────────
//   ⚠ 아래 단언은 **소스의 모양**만 본다 — 분기 반전·인자 교체는 못 잡는다.
//     그 계약은 REC-BEHAVIORAL-2026-09-06 의 실행 테스트가 지킨다.
test('추천 후보 컷 — 임시 점수·거래 건수·확인된 세대수 세 렌즈의 합집합을 역 거리 실측에 넘긴다 + 컷 전 소형 게이트', () => {
  const src = require('node:fs').readFileSync(require.resolve('../services/propertyService'), 'utf8');
  const i = src.indexOf('MULTI-LENS-2026-09-05: 후보 컷을');
  assert.ok(i > 0, '세 렌즈 합집합 컷이 없다 — 신고 밴드 하나로 고른 후보에서 역세권 대단지가 빠진다');
  const blk = src.slice(i, i + 2600);
  assert.match(blk, /const LENS_DEALS = 20;/, '거래 건수 렌즈가 없다');
  assert.match(blk, /const LENS_SCALE = 20;/, '세대수 렌즈가 없다');
  assert.match(blk, /\(\(Number\(y\._hh\) \|\| 0\) - \(Number\(x\._hh\) \|\| 0\)\)/, '세대수 렌즈가 확인된 세대수(_hh)로 정렬하지 않는다');
  assert.match(blk, /for \(const a of byDeals\.slice\(0, LENS_DEALS\)\) _lensPick\.add\(a\);/, '거래 렌즈 결과가 합집합에 들어가지 않는다');
  assert.match(blk, /for \(const a of byScale\.slice\(0, LENS_SCALE\)\) _lensPick\.add\(a\);/, '세대수 렌즈 결과가 합집합에 들어가지 않는다');
  assert.match(blk, /const ranked = byProv\.filter\(a => _lensPick\.has\(a\)\);/, '합집합이 ranked 로 이어지지 않는다');
  assert.match(src, /_hh: x\.hh, _verified: x\.hh != null && x\.hh >= 100/, '후보에 확인 세대수(_hh)를 싣지 않는다');
  // 모든 렌즈의 1차 키는 검증 티어
  assert.equal((blk.match(/\.sort\(\(x, y\) => _tier\(x, y\) \|\|/g) || []).length, 3, '세 렌즈 모두 검증 티어를 1차 키로 써야 한다');
  // 미확인 거래 상위 렌즈 — 확인된 후보가 적을 때 세 렌즈가 같은 집합으로 수렴하던 것(프리뷰 258→45)의 안전판
  assert.match(blk, /const LENS_UNVERIFIED = 15;/, '미확인 거래 상위 렌즈가 없다');
  assert.match(blk, /const byDealsUnverified = _lensBase\.filter\(a => !a\._verified\)/, '미확인 렌즈가 미확인만 고르지 않는다');
  assert.match(blk, /for \(const a of byDealsUnverified\.slice\(0, LENS_UNVERIFIED\)\) _lensPick\.add\(a\);/, '미확인 렌즈 결과가 합집합에 들어가지 않는다');
  // 지역 단일쿼리에 jibun — 없으면 지번 매칭(게이트·카드)이 한 번도 성립하지 않는다
  const txs = require('node:fs').readFileSync(require.resolve('../services/transactionService'), 'utf8');
  // ⚠ 함수 범위로 한정 — 다른 함수(getTransactionsByAptSeq)의 같은 매핑 줄이 검사를 대신 통과시켰다(주입 실측 MISSED).
  const rrt = txs.indexOf('async function getRegionRecentTransactions(');
  assert.ok(rrt > 0, 'getRegionRecentTransactions 가 없다');
  const rrtBody = txs.slice(rrt, txs.indexOf('cache.set(ck, mapped, 21600)', rrt) + 40);
  assert.match(rrtBody, /deal_amount, lawd_cd, apt_seq, jibun'\)/, '지역 단일쿼리 select 에 jibun 이 없다 — 추천 경로 지번 매칭이 죽는다');
  assert.match(rrtBody, /jibun: r\.jibun \|\| '',/, '지역 단일쿼리 매핑에 jibun 이 없다');
  // 컷 전 소형 게이트 — TRANSIT-STAGE 보다 앞
  const sg = src.indexOf('SMALL-GATE-EARLY-2026-09-05');
  const ts = src.indexOf('TRANSIT-STAGE-2026-09-05: 최종 15곳');
  assert.ok(sg > 0 && sg < ts, '컷 전 소형 게이트가 없거나 역 거리 단계 뒤에 있다(15곳 컷 뒤에 빠져 13곳만 남는다)');
  assert.match(src.slice(sg, sg + 1200), /Number\.isFinite\(hh\) && hh > 0 && hh < 100;/, '소형 판정이 확인된 값(0 제외)만 보지 않는다');
  // 가드 형태 고정 — 'if (false && …)' 류로 게이트만 꺼두는 회귀를 잡는다(주입 실측: 위 단언들은 전부 초록이었다)
  assert.match(src.slice(sg, sg + 1200), /if \(keep3\.length >= 1 && keep3\.length !== enrichedRecs\.length\) \{/, '컷 전 소형 게이트가 실행되지 않는 형태로 바뀌었다');
  // 배점 — 규모 18 · 관심도 10 · 평형 4 · 합 100
  const m = src.match(/const SCORE_V2_MAX = \{([^}]+)\}/);
  const max = Object.fromEntries(m[1].split(',').map(kv => kv.split(':').map(s => s.trim())).map(([k, v]) => [k, Number(v)]));
  assert.equal(max['규모주차'], 18, '규모주차 배점이 18 이 아니다');
  assert.equal(max['관심도'], 10); assert.equal(max['평형'], 4);
  assert.equal(Object.values(max).reduce((a, b) => a + b, 0), 100, '배점 합이 100 이 아니다');
  const { _applyFacilityToScore } = require('../services/propertyService');
  const sc = (th) => _applyFacilityToScore({ total: 0, breakdown: {}, dealCount: 0 }, { totalHouseholds: th, parkingRatio: null }, null).breakdown.규모주차;
  assert.equal(sc(3169), 12 + 3, '3,000세대 이상 규모가 12점이 아니다');
  assert.equal(sc(1590), 10 + 3); assert.equal(sc(133), 1 + 3);
});



// ── DISTRICT-SCALE-2026-09-05 ─────────────────────────────────────────────────────
test('보고서 행정구 위계 가점 — 객관 데이터(세대수 최대 30)를 넘지 않는다(양천 169세대가 3,169세대를 앉히던 것)', () => {
  const getDistrictTier = _reportFn('getDistrictTier');
  const getHouseholdBonus = _reportFn('getHouseholdBonus');
  const maxDistrict = Math.max(...['강남구', '마포구', '양천구', '노원구'].map(g => getDistrictTier(g, { 강남구: '11680', 마포구: '11440', 양천구: '11470', 노원구: '11350' }[g]).bonus), getDistrictTier('과천시', '41290').bonus);
  assert.ok(maxDistrict <= 20, `위계 가점 최대가 ${maxDistrict} — 객관 가점을 압도한다`);
  assert.ok(maxDistrict < getHouseholdBonus(3000), '위계 가점이 3,000세대 가점보다 크다');
  // 순서는 유지(강남3구 > 마용성광 > 분당·과천·판교 > 서울 핵심구 > 서울 외곽구 > 기타)
  const b = (g, c) => getDistrictTier(g, c).bonus;
  assert.ok(b('강남구', '11680') > b('마포구', '11440') && b('마포구', '11440') > b('과천시', '41290') && b('과천시', '41290') > b('양천구', '11470') && b('양천구', '11470') > b('노원구', '11350') && b('노원구', '11350') > b('해운대구', '26350'), '위계 순서가 깨졌다');
});



test('stripAptSuffix — 저장소에 정의가 1곳뿐이다 (Plan 051 Step 1, 사본 금지)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const walk = (dir, out = []) => {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p, out);
      else if (name.endsWith('.js')) out.push(p);
    }
    return out;
  };
  const files = walk(path.join(__dirname, '..'));
  const defs = files.filter(f => {
    const src = fs.readFileSync(f, 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    return /function\s+stripAptSuffix\s*\(/.test(src);
  });
  assert.equal(defs.length, 1, `stripAptSuffix 정의가 ${defs.length}곳이다(1곳이어야 한다): ${defs.join(', ')}`);
  assert.match(defs[0], /aptNameMatch\.js$/, '정의가 backend/utils/aptNameMatch.js 에 있지 않다');
  const chatSrc = fs.readFileSync(require.resolve('../services/chatDataRouter.js'), 'utf8');
  assert.match(chatSrc, /require\(['"]\.\.\/utils\/aptNameMatch['"]\)/, 'chatDataRouter 가 aptNameMatch 모듈을 가져다 쓰지 않는다');
});



test('aptNameMatch.dice — 호출부가 전부 후보 정렬/점수 문맥 안에만 있다 (IDENTITY-GATE, Plan 051 Step 6-3)', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../services/chatDataRouter.js'), 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n'); // 주석 줄 제거 — 자기 충돌 방지
  assert.equal(/if\s*\([^)]*dice\(/.test(src), false,
    'dice() 유사도가 if() 자동 채택 조건에 쓰였다 — IDENTITY-GATE 위반');
  let idx = -1, count = 0;
  while ((idx = src.indexOf('dice(', idx + 1)) !== -1) {
    count++;
    const window = src.slice(Math.max(0, idx - 150), idx + 150);
    assert.ok(/sort|score/.test(window), `dice() 호출이 정렬/점수 문맥 밖에 있다: …${window}…`);
  }
  assert.ok(count >= 2, 'dice() 가 후보 정렬에 전혀 쓰이지 않는다(apt_master 후보 정렬·미확정 후보 점수 둘 다 있어야 한다)');
});



// ── Step 0 특성화: 기존(직접 히트, 형제 없음) 경로가 리팩터 후에도 그대로다 ──────────────
test('AI 도우미 시세 — 직접 히트 + 형제 없음(기존 동작 그대로, Plan 051 Step 0)', async () => {
  const admin = _mockAptAdmin({
    molit_apt_index: [
      { apt_name: '은마', lawd_cd: '11680', sigungu: '강남구', umd_nm: '대치동', build_year: 1979, deal_count: 233 },
    ],
    molit_transactions: [
      { apt_name: '은마', sigungu: '강남구', umd_nm: '대치동', deal_amount: 250000, deal_date: '2026-08-20', exclu_use_ar: 84.4 },
      { apt_name: '은마', sigungu: '강남구', umd_nm: '대치동', deal_amount: 240000, deal_date: '2026-07-10', exclu_use_ar: 76.8 },
    ],
  });
  const { router, restore } = _requireRouterWithAdmin(admin);
  try {
    const { reply, suggestions } = await router.route('은마 시세', null);
    assert.match(reply, /은마/);
    assert.match(reply, /거래 2건/);
    assert.equal(/국토부에는/.test(reply), false, '형제가 없는데 합산 문구가 붙었다');
    assert.equal(/찾지 못했어요/.test(reply), false);
    assert.equal(_NO_PROMO.test(reply), false);
    assert.ok(suggestions.includes('강남구 인기단지'), '동네 후속 칩이 없다');
  } finally { restore(); }
});
