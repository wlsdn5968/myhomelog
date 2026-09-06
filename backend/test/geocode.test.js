/**
 * backend/test/geocode.test.js
 *
 * characterization.test.js(Plan 066, 10,056줄·327 test 단일 파일)를 도메인별로 분할한 조각.
 * 동작을 하나도 바꾸지 않는 이동이다 — 테스트 이름·개수·본문은 원본과 동일하다.
 * 공용 목/스텁 유틸은 ./_helpers 에서 가져온다. 새 테스트는 이 파일의 주제와 맞으면 여기에,
 * 아니면 backend/test/README.md 규칙대로 새 도메인 파일을 만든다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');



// ── Plan 002: geocode 전역 캡 판정 — Redis 미설정(null) 은 허용(fail-open), 초과만 차단 ──────
test('geocode _geocodeCapExceeded — 경계·fail-open', () => {
  const { _geocodeCapExceeded } = require('../routes/geocode');
  assert.equal(_geocodeCapExceeded(7999, 8000), false); // 상한 미만 — 허용
  assert.equal(_geocodeCapExceeded(8000, 8000), false); // 정확히 상한(이번 호출이 8000번째) — 허용
  assert.equal(_geocodeCapExceeded(8001, 8000), true);  // 초과 — 차단
  assert.equal(_geocodeCapExceeded(null, 8000), false); // Redis 미설정 — fail-open
  assert.equal(_geocodeCapExceeded(undefined, 8000), false);
});



// JIBUN-MISMATCH (2026-08-10): 좌표가 **남의 단지**에 찍혔는지는 지번 본번으로 판정한다.
//   운영자 발견 실사고: '신동아아파트3'(신고 지번 방학동 530)의 저장 좌표가 272("신동아1단지 3동")로,
//   같은 동이라 거리(300m) 기준만으로는 '검증 통과'로 박제될 수 있었다. 본번 비교가 그걸 잡는다.
test('geocacheBackfill.addrBonbun — 주소 끝 지번의 본번만 추출(부번 무시)', () => {
  const { addrBonbun } = require('../jobs/geocacheBackfill');
  assert.equal(addrBonbun('서울 도봉구 방학동 271-4'), '271'); // 대단지 다필지 → 본번만
  assert.equal(addrBonbun('서울 도봉구 방학동 272'), '272');
  assert.equal(addrBonbun('서울 도봉구 방학동 530'), '530');
  assert.equal(addrBonbun('경기 안양시 동안구 호계동 946-13'), '946');
  assert.equal(addrBonbun('경기 평택시 동삭동'), null);        // 번지 없는 주소 → 판정 불가
  assert.equal(addrBonbun(''), null);
  assert.equal(addrBonbun(null), null);

  // 실사고 재현: 신고 지번(530)과 저장 좌표 주소(272)의 본번이 다르면 '다른 단지'로 판정돼야 한다
  const 저장 = addrBonbun('서울 도봉구 방학동 272');
  const 신고 = addrBonbun('서울 도봉구 방학동 530');
  assert.ok(저장 && 신고 && 저장 !== 신고, '신동아아파트3 은 지번 불일치로 강제 교정 대상이어야 한다');

  // 정상 케이스: 신고 271-1 vs 저장 271-4 → 본번 271 로 같으므로 교정하지 않는다(오탐 방지)
  //   ⚠ 감사 #30: 예전엔 `addrBonbun(a) === addrBonbun(b)` 로 **함수끼리** 비교했다.
  //     그러면 함수가 항상 null 을 돌려줘도 통과한다 → 리터럴 기대값으로 고정한다.
  assert.equal(addrBonbun('서울 도봉구 방학동 271-1'), '271');
  assert.equal(addrBonbun('서울 도봉구 방학동 271-4'), '271');
});



test('geocacheBackfill.canFastVerify — Kakao 호출 없이 통과시켜도 되는 조건 (Sprint KKKKKKK-10)', () => {
  const { canFastVerify } = require('../jobs/geocacheBackfill');

  // 통과: 신고 지번(271-1)과 저장 주소(271-4)의 **본번이 같다** = 같은 필지.
  //   부번 차이는 대단지 다필지라 정상이고, 여기서 끝내면 Kakao 왕복 1회가 통째로 사라진다.
  assert.equal(canFastVerify({
    addrFromMolit: true, storedAddress: '서울 도봉구 방학동 271-4',
    officialAddress: '도봉구 방학동 271-1', placeName: '신동아1단지아파트',
  }), true);

  // ★ 기대값 변경 2026-08-17 (Sprint MMMMMMM) — 예전엔 이 케이스의 placeName 이
  //   '신동아1단지아파트 **노인정**' 인 채로 `true` 로 고정돼 있었다. 본번만 보고 무호출 통과시킨 것이다.
  //   그런데 **노인정 좌표는 단지 본체가 아니다** — 본번이 같아도 핀은 수십~수백m 어긋난다.
  //   서울 전수조사 4회차에서 이 단지가 실제 오배치 목록(도봉구 방학동 신동아아파트1 → "…노인정")에
  //   올라왔고, 전국 경로당/노인정 place 는 **298건**이다. '노인정'을 REHEAL_NONRES 에 넣어
  //   이제 fast-verify 가 거부하고 지오코딩 교정 경로로 내려간다 — 이것이 **의도한 동작 변경**이다.
  assert.equal(canFastVerify({
    addrFromMolit: true, storedAddress: '서울 도봉구 방학동 271-4',
    officialAddress: '도봉구 방학동 271-1', placeName: '신동아1단지아파트 노인정',
  }), false);
  assert.equal(canFastVerify({
    addrFromMolit: true, storedAddress: '서울 노원구 상계동 700',
    officialAddress: '노원구 상계동 700-1', placeName: '상계주공10단지아파트 경로당',
  }), false, '경로당도 같은 이유로 무호출 통과 대상이 아니다');

  // 거부: 본번이 다르다(신고 530 vs 저장 272) — 실사고 재현. 남의 단지에 찍힌 좌표이므로
  //   반드시 지오코딩 경로로 내려가 교정돼야 한다.
  assert.equal(canFastVerify({
    addrFromMolit: true, storedAddress: '서울 도봉구 방학동 272',
    officialAddress: '도봉구 방학동 530', placeName: '신동아1단지아파트 3동',
  }), false);

  // 거부: 주소가 MOLIT 신고 지번이 아니라 KAPT 폴백 — kaptCode 자체가 이름 매칭 산물이라
  //   오염 가능(IDENTITY-GATE). 본번이 같아 보여도 무호출 통과시키지 않는다.
  assert.equal(canFastVerify({
    addrFromMolit: false, storedAddress: '서울 도봉구 방학동 736',
    officialAddress: '서울특별시 도봉구 방학동 736', placeName: null,
  }), false);

  // 거부: 비주거 상호 — 본번이 같아도 NONRES 강제 교정 대상이라 종전 판정을 유지해야 한다.
  assert.equal(canFastVerify({
    addrFromMolit: true, storedAddress: '서울 노원구 월계동 100-1',
    officialAddress: '노원구 월계동 100', placeName: '동신손세차',
  }), false);

  // 거부: 본번을 뽑을 수 없으면 판정 불가 → 종전 경로(거리 검증)로.
  assert.equal(canFastVerify({
    addrFromMolit: true, storedAddress: '경기 평택시 동삭동',
    officialAddress: '평택시 동삭동 500', placeName: null,
  }), false);
});



test('geocode 단건 호출 3경로가 모두 sigungu·umdNm 을 넘긴다 (배선 계약)', () => {
  // [근본 원인] 백엔드 kakaoGeocode 의 검증 3종(sigungu 주소 하드필터 · 동명 구 umd 하드필터 ·
  //   umdMatch +2)은 전부 `if (sgg && ...)` 조건부다. 프론트가 area 문자열만 넘기면 **전부 꺼지고**
  //   점수 0 동점 → `score > bestScore` 라 Kakao 관련도 1순위(상가·교차로)가 그대로 채택된다.
  //   실호출 실측: '반포자이'→"반포자이플라자", '은마'→"은마아파트입구교차로", '헬리오시티'→"…상가".
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  // /geocode 와 /geocode/batch 호출의 body 를 전부 뽑아 하나도 빠짐없이 검사한다
  //   (한 곳만 고치고 나머지를 놓치는 것이 이 저장소의 반복 실패 모드였다).
  const calls = [...html.matchAll(/\$\{CFG\.api\}\/geocode(?:\/batch)?`[\s\S]{0,420}?JSON\.stringify\(\{[\s\S]{0,300}?\}\)/g)]
    .map(m => m[0]);
  assert.ok(calls.length >= 3, `geocode 호출을 ${calls.length}곳만 찾았다 — 형태가 바뀌었다면 이 테스트도 갱신할 것`);
  for (const c of calls) {
    assert.match(c, /sigungu\s*:/, `sigungu 를 안 넘기는 geocode 호출이 있다:\n${c.slice(0, 160)}`);
    assert.match(c, /umdNm\s*:/, `umdNm 을 안 넘기는 geocode 호출이 있다:\n${c.slice(0, 160)}`);
  }
});
