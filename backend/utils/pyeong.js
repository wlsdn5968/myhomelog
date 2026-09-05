/**
 * PYEONG-SSOT-2026-09-05 (감사 P2-11): 평↔㎡ 계수의 단일 출처.
 *
 * 종전엔 analysisService 의 로컬 상수 + report.js 의 리터럴 4곳이 각자 계수를 들고 있었다. 값은 같았지만
 * 한쪽만 고치면 갈린다 — 취득세 사본 2개가 3주간 다른 값을 낸 사고와 같은 구조다.
 * 계약 테스트가 "리터럴이 이 파일 밖에 있는가"를 검사한다.
 * 정확값은 1평 = 3.305785㎡. 표시용 정밀도(소수 4자리)는 기존 화면 값과 동일하게 유지한다.
 */
'use strict';

const PYEONG_M2 = 3.3058;

/** ㎡ → 평. 숫자가 아니면 null(0 이나 NaN 으로 흘리지 않는다). */
function toPyeong(m2) {
  const n = Number(m2);
  return Number.isFinite(n) ? n / PYEONG_M2 : null;
}

module.exports = { PYEONG_M2, toPyeong };
