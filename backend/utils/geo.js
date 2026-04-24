/**
 * 지리 좌표 유틸 — 한반도 범위 검증
 *
 * 배경:
 *   - Kakao keyword 검색에 "강남"만 입력해도 동명 지명이 외국에서 잡힐 수 있음
 *   - MOLIT/공공데이터에서 잘못 입력된 좌표(0,0 또는 음수)가 종종 섞여 들어옴
 *   - 검증 없이 프론트 지도에 마커를 찍으면 한국이 아닌 지점으로 튀어 사용자 혼란
 *
 * 한반도 대략 범위 (제주~함경, 독도 포함 여유 1도씩):
 *   - 위도: 33.0 ~ 43.0  (제주 33.1, 함북 43.0)
 *   - 경도: 124.0 ~ 132.0 (백령도 124.6, 독도 131.9)
 */

function isValidKoreaCoord(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return false;
  if (la < 33 || la > 43) return false;
  if (ln < 124 || ln > 132) return false;
  return true;
}

/**
 * 좌표 객체 정규화 — 검증 실패 시 null 반환
 * input: { lat, lng, ...rest }  →  { lat, lng, ...rest }  or null
 */
function sanitizeCoord(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (!isValidKoreaCoord(obj.lat, obj.lng)) return null;
  return obj;
}

module.exports = { isValidKoreaCoord, sanitizeCoord };
