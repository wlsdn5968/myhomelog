/**
 * backend/test/pin-dedup.test.js — PIN-DEDUP-2026-10-21: "이 지역 단지 보기"에서 같은 단지가 신고 이름 둘로 남아 핀이 겹치던 것.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const merge = require('../routes/search')._mergeNearDuplicateGroups;
const G = (n, lat, lng, c, umd = '덕이동', src = 'molit') => ({ aptName: n, umdNm: umd, lat, lng, sum: c * 50000, n: c, source: src });

test('이름이 바뀐 같은 단지(포함 관계·같은 숫자·80m 안)는 하나로, 거래가 많은 이름이 남고 건수는 합산', () => {
  const r = merge([G('일산파밀리에4단지', 37.69, 126.75, 3), G('하이파크시티일산파밀리에4단지', 37.69, 126.75, 8)]);
  assert.equal(r.length, 1);
  assert.equal(r[0].aptName, '하이파크시티일산파밀리에4단지');
  assert.equal(r[0].n, 11);
  assert.deepEqual(r[0]._mergedNames, ['일산파밀리에4단지']);
  // "아파트" 접미·괄호 동 표기 차이도 같은 단지
  assert.equal(merge([G('두산1차', 35.1, 129.1, 2), G('두산1차아파트', 35.1, 129.1, 1)]).length, 1);
});

test('숫자(단지 번호·차수)가 다르거나, 동이 다르거나, 80m 를 넘으면 합치지 않는다 · 정식 단지가 이름을 가진다', () => {
  assert.equal(merge([G('관저더샵2차아파트', 36.3, 127.3, 2), G('관저더샵아파트', 36.3, 127.3, 4)]).length, 2);
  assert.equal(merge([G('e편한세상신촌2단지', 37.5, 126.9, 1), G('e편한세상신촌3단지', 37.5, 126.9, 1)]).length, 2);
  assert.equal(merge([G('다우훼밀리', 37.6, 127.1, 1, '신내동'), G('신내다우훼밀리', 37.6, 127.1, 1, '묵동')]).length, 2);
  assert.equal(merge([G('다우훼밀리', 37.6, 127.1, 1), G('신내다우훼밀리', 37.601, 127.1, 1)]).length, 2, '약 111m');
  const r = merge([G('공릉풍림아이원', 37.62, 127.07, 2, '공릉동', 'master'), G('풍림아이원', 37.62, 127.07, 9, '공릉동')]);
  assert.equal(r.length, 1); assert.equal(r[0].aptName, '공릉풍림아이원'); assert.equal(r[0].n, 11);
});

test('괄호 안 이름이 다르면 다른 단지 — 후곡마을(대창) ↔ 후곡마을(동양) 은 합치지 않는다(2026-10-21 미리보기 실측 결함)', () => {
  assert.equal(merge([G('후곡마을(대창)', 37.682, 126.764, 9, '일산동'), G('후곡마을(동양)', 37.682, 126.7642, 3, '일산동')]).length, 2);
  assert.equal(merge([G('탄현마을(진로)', 37.693, 126.766, 6, '탄현동'), G('탄현마을(경남)', 37.693, 126.766, 2, '탄현동')]).length, 2);
});

test('끝 글자(A·B·가·나)만 다른 신고 이름은 80m 안이면 같은 단지 — 숫자가 다르면 여전히 따로 (AB-SUFFIX-2026-10-21)', () => {
  const r = merge([G('상목에버빌A', 37.48, 126.93, 2, '신림동'), G('상목에버빌B', 37.48, 126.9301, 2, '신림동')]);
  assert.equal(r.length, 1); assert.equal(r[0].n, 4);
  assert.equal(merge([G('경성A', 37.29, 127.03, 2, '연무동'), G('경성B', 37.29, 127.031, 2, '연무동')]).length, 2, '약 88m — 거리 상한');
  assert.equal(merge([G('e편한세상신촌2단지', 37.5, 126.9, 1, '북아현동'), G('e편한세상신촌3단지', 37.5, 126.9, 1, '북아현동')]).length, 2);
});
