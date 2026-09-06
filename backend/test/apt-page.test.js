/**
 * backend/test/apt-page.test.js
 *
 * characterization.test.js(Plan 066, 10,056줄·327 test 단일 파일)를 도메인별로 분할한 조각.
 * 동작을 하나도 바꾸지 않는 이동이다 — 테스트 이름·개수·본문은 원본과 동일하다.
 * 공용 목/스텁 유틸은 ./_helpers 에서 가져온다. 새 테스트는 이 파일의 주제와 맞으면 여기에,
 * 아니면 backend/test/README.md 규칙대로 새 도메인 파일을 만든다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _P063_STAT, _p063Idx, _p063Run } = require('../testSupport/_helpers');



test('APT-PAGE-INFO — molit_aliases 정확일치로 매칭되면 단지정보 카드가 나온다 (Plan 063 Step 1-2)', async () => {
  const row = {
    kapt_code: 'P063A1', apt_name: '정식단지명', molit_aliases: ['정식단지명별칭'],
    facility: {
      kaptdaCnt: '520', hoCnt: '520', kaptDongCnt: '6', kaptUsedate: '19990305',
      codeHeatNm: '개별난방', codeHallNm: '복도식', kaptTopFloor: '20',
      _dtl: { kaptdPcnt: '300', kaptdPcntu: '250', kaptdEcnt: '12', kaptdCccnt: '80' },
    },
  };
  // apt_master.apt_name('정식단지명')은 aptName('정식단지명별칭')과 정규화해도 다르다 — alias 경로만으로 매칭되는지 격리.
  const res = await _p063Run({ aptMasterRows: [row], idxRow: _p063Idx('정식단지명별칭'), statFixture: _P063_STAT });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('한국부동산원 공동주택관리정보시스템(K-apt)'), 'alias 정확일치인데 단지정보 카드가 안 나왔다');
  assert.ok(res.body.includes('<span class="k">총 세대수</span>') && res.body.includes('520세대'), '세대수 행이 없다');
});



test('APT-PAGE-INFO — 공백 제거 후 이름 완전일치로 매칭되면 단지정보 카드가 나온다 (Plan 063 Step 1-2)', async () => {
  const row = {
    kapt_code: 'P063A2', apt_name: '공백 있는 단지', molit_aliases: [],
    facility: { kaptdaCnt: '300', kaptDongCnt: '3', kaptUsedate: '20050101' },
  };
  // alias 는 비어 있다 — 정규화 이름 경로만으로 매칭되는지 격리.
  const res = await _p063Run({ aptMasterRows: [row], idxRow: _p063Idx('공백있는단지'), statFixture: _P063_STAT });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('한국부동산원 공동주택관리정보시스템(K-apt)'), '공백 제거 완전일치인데 단지정보 카드가 안 나왔다');
  assert.ok(res.body.includes('300세대'));
});



test('APT-PAGE-INFO — 후보가 2개 이상이면 카드를 만들지 않는다(확신 없으면 안 보여준다) (Plan 063 Step 1)', async () => {
  const rows = [
    { kapt_code: 'P063B1', apt_name: '중복단지', molit_aliases: ['중복이름'], facility: { kaptdaCnt: '400' } },
    { kapt_code: 'P063B2', apt_name: '중복단지2', molit_aliases: ['중복이름'], facility: { kaptdaCnt: '450' } },
  ];
  const res = await _p063Run({ aptMasterRows: rows, idxRow: _p063Idx('중복이름'), statFixture: _P063_STAT });
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.includes('한국부동산원 공동주택관리정보시스템(K-apt)'), '후보 2개인데 단지정보 카드가 나왔다 — 오매칭 위험');
  assert.ok(!res.body.includes('400세대') && !res.body.includes('450세대'), '어느 후보의 세대수도 노출되면 안 된다');
  // 모호함은 조회 오류가 아니다(쿼리 자체는 성공) — 캐시 정책은 평소 그대로(긴 캐시)여야 한다.
  assert.equal(res.headers['Cache-Control'], 'public, max-age=0, s-maxage=21600, stale-while-revalidate=86400',
    '후보 모호(쿼리 성공)인데 조회 오류처럼 캐시가 막혔다');
});



test('APT-PAGE-INFO — 값이 없는 항목은 행 자체가 없다("미상"·"0" 금지, 미확인 원칙) (Plan 063 Step 2)', async () => {
  const row = {
    kapt_code: 'P063C1', apt_name: '부분정보단지', molit_aliases: ['부분정보단지'],
    facility: { kaptdaCnt: '300', hoCnt: '300' }, // 세대수만 있고 동수·층수·준공일·주차·난방·구조·승강기·CCTV 는 전부 없음
  };
  const res = await _p063Run({ aptMasterRows: [row], idxRow: _p063Idx('부분정보단지'), statFixture: _P063_STAT });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('<span class="k">총 세대수</span>') && res.body.includes('300세대'), '있는 값(세대수)마저 안 나왔다');
  for (const label of ['총 동수', '층수', '준공일', '총 주차대수', '난방방식', '구조', '승강기', 'CCTV']) {
    assert.ok(!res.body.includes(`<span class="k">${label}</span>`), `값이 없는 "${label}" 행이 만들어졌다`);
  }
  assert.ok(!res.body.includes('미상'), '"미상" 문자열이 나왔다 — 미확인 원칙 위반(0·미상 금지)');
});



test('APT-PAGE-INFO — apt_master 조회가 오류로 실패하면 긴 캐시를 붙이지 않는다(thin·noindex 은 그대로) (Plan 063 Step 4)', async () => {
  const res = await _p063Run({
    aptMasterRows: [], aptMasterError: new Error('APT-PAGE-TEST 주입 오류'),
    idxRow: _p063Idx('아무단지'), statFixture: _P063_STAT,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store', '단지정보 조회 오류인데 긴 캐시가 붙었다 — 열화 응답이 엣지에 굳는다');
  assert.ok(!res.body.includes('한국부동산원 공동주택관리정보시스템(K-apt)'), '조회가 실패했는데 단지정보 카드가 나왔다 — "못 읽음"과 "없음"을 못 지켰다');
  assert.ok(res.body.includes('<meta name="robots" content="index, follow">'),
    '거래는 있는데(thin=false) noindex 로 바뀌었다 — 캐시 판정과 색인 판정이 섞였다');
});



test('APT-PAGE-INFO — 거래 0 페이지는 단지정보가 있어도 여전히 noindex+no-store 다(색인 정책 불변, out-of-scope 확인) (Plan 063 Step 4)', async () => {
  const row = {
    kapt_code: 'P063D1', apt_name: '거래없는단지', molit_aliases: ['거래없는단지'],
    facility: { kaptdaCnt: '900', kaptDongCnt: '8' },
  };
  const res = await _p063Run({ aptMasterRows: [row], idxRow: _p063Idx('거래없는단지'), statFixture: null });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('한국부동산원 공동주택관리정보시스템(K-apt)'), '단지정보 카드는 직접 링크 대응으로 여전히 보여야 한다');
  assert.ok(res.body.includes('<meta name="robots" content="noindex, follow">'),
    '거래 0인데 단지정보가 있다고 index 로 바뀌었다 — thin 판정이 거래 기반이 아니게 됐다');
  assert.equal(res.headers['Cache-Control'], 'no-store', '거래 0 페이지에 긴 캐시가 붙었다');
});



test('APT-PAGE-INFO — 단지정보 fact 가 더해져도 desc 끝의 절대 룰 문구가 유지된다 (Plan 063 Step 3)', async () => {
  const row = {
    kapt_code: 'P063E1', apt_name: '설명단지', molit_aliases: ['설명단지'],
    facility: { kaptdaCnt: '700', kaptUsedate: '20010101' },
  };
  const res = await _p063Run({ aptMasterRows: [row], idxRow: _p063Idx('설명단지'), statFixture: _P063_STAT });
  assert.equal(res.statusCode, 200);
  const m = res.body.match(/<meta name="description" content="([^"]*)">/);
  assert.ok(m, 'description 메타가 없다');
  const desc = m[1].replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  assert.ok(desc.includes('700세대') || desc.includes('2001년 준공'), '단지정보 fact(세대수·준공년도)가 desc 에 안 들어갔다');
  assert.ok(desc.endsWith('매수 추천이 아닙니다.'), 'desc 끝의 절대 룰 문구가 사라졌다: ' + desc);
});



// ── APT-PAGE-ACCURACY-2026-09-06 (Plan 065): 063 표기 정확성 2건 수정 확인 ──────────────────
//   [실행 테스트] 위 _p063Run·_p063Idx·_P063_STAT 인프라(라인 9560 부근)를 그대로 재사용한다.
//   ① 복도유형(codeHallNm) 값이 "구조" 라벨로 표기되지 않는다(진짜 구조는 codeStr — 별도 필드).
//   ② 거래 0 페이지의 desc 가 "거래 기록 없음" 사실을 유지하고, KAPT 사실에 국토교통부를 붙이지 않는다.
test('APT-PAGE-LABEL — 복도유형 값이 "구조" 라벨로 표기되지 않는다 (Plan 065 Step 1)', async () => {
  const row = {
    kapt_code: 'P065A1', apt_name: '복도유형단지', molit_aliases: ['복도유형단지'],
    facility: { kaptdaCnt: '600', codeHallNm: '계단식' },
  };
  const res = await _p063Run({ aptMasterRows: [row], idxRow: _p063Idx('복도유형단지'), statFixture: _P063_STAT });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('<span class="k">복도유형</span>'), '복도유형 라벨이 없다');
  assert.ok(res.body.includes('계단식'), '복도유형 값(계단식)이 안 보인다');
  assert.ok(!res.body.includes('<span class="k">구조</span>'),
    '복도유형 값이 여전히 잘못된 라벨로 나온다 — 진짜 구조(codeStr)와 다른 값인데 그렇게 말한다');
});



test('APT-PAGE-DESC — 거래 0 + 단지정보 있음: 거래 없음 사실이 남고 KAPT 사실에 국토교통부를 붙이지 않는다 (Plan 065 Step 2)', async () => {
  const row = {
    kapt_code: 'P065B1', apt_name: '무거래단지', molit_aliases: ['무거래단지'],
    facility: { kaptdaCnt: '1601', kaptUsedate: '20010101' },
  };
  const res = await _p063Run({ aptMasterRows: [row], idxRow: _p063Idx('무거래단지'), statFixture: null });
  assert.equal(res.statusCode, 200);
  const m = res.body.match(/<meta name="description" content="([^"]*)">/);
  assert.ok(m, 'description 메타가 없다');
  const desc = m[1].replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  assert.ok(desc.includes('최근 24개월 거래 기록이 없습니다'), '거래 0 인데 거래 없음 사실이 desc 에서 사라졌다: ' + desc);
  assert.ok(!desc.includes('국토교통부'), 'KAPT 출처 사실(세대수·준공년도)에 국토교통부가 붙었다: ' + desc);
  assert.ok(desc.includes('1,601세대') || desc.includes('2001년 준공'), 'KAPT 단지정보 fact 가 desc 에서 사라졌다: ' + desc);
  assert.ok(desc.endsWith('매수 추천이 아닙니다.'), '거래 0 + 단지정보 있음 분기에 절대 룰 문구가 없다: ' + desc);
});



test('APT-PAGE-DESC — 거래 0 + 단지정보 없음: 기존 문구를 유지하되 절대 룰 문구가 붙는다 (Plan 065 Step 2)', async () => {
  const res = await _p063Run({ aptMasterRows: [], idxRow: _p063Idx('정보없는단지'), statFixture: null });
  assert.equal(res.statusCode, 200);
  const m = res.body.match(/<meta name="description" content="([^"]*)">/);
  assert.ok(m, 'description 메타가 없다');
  const desc = m[1].replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  assert.ok(desc.includes('최근 24개월 거래 기록이 없습니다'), '거래 0 사실이 desc 에서 사라졌다: ' + desc);
  assert.ok(desc.endsWith('매수 추천이 아닙니다.'), '거래 0 + 단지정보 없음 분기에 절대 룰 문구가 없다: ' + desc);
});



test('APT-PAGE-DESC — 거래 있음: desc 형식이 변하지 않는다(하위호환) (Plan 065 Step 2)', async () => {
  // APT-PAGE-DESC-SRC-2026-09-06 (Plan 069): 이 fixture 는 원래 kaptdaCnt/kaptUsedate 를 채워
  //   KAPT fact 가 있는 상태였다. Plan 069 가 "거래 있음 + KAPT fact 있으면 출처 문구에 K-apt 를
  //   덧붙인다"를 **의도적으로** 추가해 그 조합의 출처 문구가 바뀌었다(하위호환 대상이 아니게 됨) —
  //   이 테스트의 "형식 불변" 취지는 KAPT fact 가 없는 기본 케이스로 좁혀 유지하고, KAPT fact
  //   있는 조합의 새 문구는 backend/test/apt-page-enrich.test.js 가 별도로 검증한다.
  const row = {
    kapt_code: 'P065C1', apt_name: '거래있는단지', molit_aliases: ['거래있는단지'],
    facility: {},
  };
  const res = await _p063Run({ aptMasterRows: [row], idxRow: _p063Idx('거래있는단지'), statFixture: _P063_STAT });
  assert.equal(res.statusCode, 200);
  const m = res.body.match(/<meta name="description" content="([^"]*)">/);
  assert.ok(m, 'description 메타가 없다');
  const desc = m[1].replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  assert.ok(desc.includes('국토교통부 실거래 신고 자료 정리'), '거래 있는 페이지의 desc 형식이 바뀌었다: ' + desc);
  assert.ok(!desc.includes('거래 기록이 없습니다'), '거래가 있는데 거래 기록 없음 문구가 들어갔다: ' + desc);
  assert.ok(desc.endsWith('매수 추천이 아닙니다.'), '거래 있는 분기의 절대 룰 문구가 사라졌다: ' + desc);
});
