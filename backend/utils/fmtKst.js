'use strict';
/**
 * backend/utils/fmtKst.js — ISO 시각 → 'YYYY.MM.DD HH:mm'(한국 시간). ICU 없이 계산해 환경과 무관하게 같은 문자열.
 * DATA-BASIS-2026-10-19 (plans/167 §1-1): 서버 렌더 단지·지역 페이지의 "실거래 수집 시각" 표기용.
 * 잘못된 입력은 '' — 모름을 값으로 만들지 않는다.
 */
function fmtKst(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const k = new Date(d.getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${k.getUTCFullYear()}.${p(k.getUTCMonth() + 1)}.${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
}
module.exports = { fmtKst };
