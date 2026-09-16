'use strict';
// APT-DISPLAY-NAME-2026-09-16 (Plan 090): 표시 전용. 조회 키(aptName/aptSeq)는 절대 이 결과로 바꾸지 않는다.
const UNNAMED_RE = /^\(?\s*\d+(?:-\d+)?\s*\)?$/;
const PAREN_ONLY_RE = /^\([^)]*\)$/;
const JIBUN_SUFFIX_RE = /\s*\(\s*(\d+(?:-\d+)?)\s*\)\s*$/;
function isUnnamedApt(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return true;
  if (UNNAMED_RE.test(s) || PAREN_ONLY_RE.test(s)) return true;
  return s.replace(/[^가-힣A-Za-z]/g, '').length < 2;
}
function displayAptName(name, { umdNm, jibun, kaptName } = {}) {
  if (kaptName && String(kaptName).trim()) return String(kaptName).trim();
  const s = String(name == null ? '' : name).trim();
  if (isUnnamedApt(s)) {
    const jb = (jibun && String(jibun).trim()) || (s.match(/\d+(?:-\d+)?/) || [''])[0];
    return [umdNm ? String(umdNm).trim() : '', jb ? `${jb}번지` : '', '단지 (이름 미등록)'].filter(Boolean).join(' ');
  }
  const m = s.match(JIBUN_SUFFIX_RE);
  return m ? `${s.slice(0, m.index).trim()} (${m[1]}번지)` : s;
}
module.exports = { isUnnamedApt, displayAptName, UNNAMED_RE, JIBUN_SUFFIX_RE };
