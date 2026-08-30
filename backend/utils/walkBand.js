/**
 * WALK-BAND-2026-08-30 (Sprint PPPPPPP)
 *
 * KAPT `kaptdWtimesub` / `kaptdWtimebus` 는 5단계 문자열로 들어온다:
 *   "5분이내" / "5~10분이내" / "10~15분이내" / "15~20분이내" / "20분초과"
 *
 * ⚠ **부분문자열(includes) 매칭 금지 — 실제로 프로덕션을 망가뜨렸다.**
 *   `"10~15분이내".includes("5분이내")` 는 **참**이다("1|5분이내"). 그래서 도보 10~15분
 *   단지 2,429곳이 교통 만점(30점)을 받아 검색 상위를 점거했다. 만점 단지의 55.7% 가 가짜였다.
 *   (발견 경위: 운영자가 서동탄역더샵파크시티를 보고 "누가봐도 도보 30분 이상인데
 *    5분 이내가 무슨 소리냐" 고 지적 → KAPT 원본은 "10~15분이내" 였고, 카카오 도보 실측은
 *    1,783m / 26.8분 이었다. 즉 **코드 버그와 원본 오류가 겹쳐** 있었다.)
 *
 * 그래서 여기서 **닫힌 집합으로 정규화**하고, 소비자는 이 enum 만 쓴다.
 * 새 값이 오면 조용히 통과시키지 말고 null 을 돌려 '모름' 으로 만든다
 * ('모름' 은 뒤에서 중간값을 받는다 — [[unknown-treated-as-value]]).
 */

/** @typedef {'LE5'|'M5_10'|'M10_15'|'M15_20'|'GT20'} WalkBand */

/** 정규화된 밴드 → 대표 도보 분(상한값). 표시·환산용. */
const WALK_BAND_MINUTES = { LE5: 5, M5_10: 10, M10_15: 15, M15_20: 20, GT20: 25 };

/** 정규화된 밴드 → 사람이 읽는 문구. */
const WALK_BAND_LABEL = {
  LE5: '5분 이내', M5_10: '5~10분', M10_15: '10~15분', M15_20: '15~20분', GT20: '20분 초과',
};

/**
 * KAPT 도보시간 문자열을 닫힌 enum 으로 정규화한다.
 * @param {string|null|undefined} raw
 * @returns {WalkBand|null} 인식 못 하면 null(= 모름)
 */
function parseWalkBand(raw) {
  const s = String(raw == null ? '' : raw).replace(/\s/g, '');
  if (!s) return null;
  // 숫자 경계를 **앵커** 로 잡는다 — 앞에 다른 숫자가 붙어 있으면 그 밴드가 아니다.
  if (/^5분이내$/.test(s)) return 'LE5';
  if (/^5~10분/.test(s)) return 'M5_10';
  if (/^10~15분/.test(s)) return 'M10_15';
  if (/^15~20분/.test(s)) return 'M15_20';
  if (/^20분(초과|이상)/.test(s)) return 'GT20';
  return null;
}

module.exports = { parseWalkBand, WALK_BAND_MINUTES, WALK_BAND_LABEL };
