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
// ORG-SUFFIX-2026-10-30 (소비자 체험 점검): 공동주택 정보(K-apt) 단지명 28곳이 관리 조직 이름이었다
//   ('동탄역 포레너스 입주자대표회의'·'녹원아파트관리사무소'·'작전중앙하이츠아파트(부평하이츠A입주자대표회의)').
//   표시할 때만 끝의 조직 꼬리말(괄호 안 포함)을 뗀다 — 조회 키(원문 이름)는 바꾸지 않는다.
const ORG_SUFFIX_RE = /\s*(?:\([^()]*(?:입주자대표회의|관리사무소|관리주체)[^()]*\)|(?:제\d+)?(?:입주자대표회의|관리사무소|관리주체))\s*$/;
function stripOrgSuffix(v) {
  const t = String(v == null ? '' : v).trim();
  const r = t.replace(ORG_SUFFIX_RE, '').trim();
  return r || t;
}
// NAME-TIDY-2026-10-30 (Plan 176): 국토부 신고 이름의 '그 단지 법정동 + 쉼표' 접두("산척동,동탄호수공원…")와 끝의 층 구분
//   ("상계주공7(고층)")을 표시할 때만 뗀다. 접두는 단지의 법정동과 **정확히 같을 때만**(넓게 지우면 "산장아파트가동,나동" → "나동").
//   동 번호 범위("퇴계주공(351~359동)")는 서로 다른 공식 단지를 가르는 정보라 그대로 둔다.
function tidyMolitName(v, umdNm) {
  let t = String(v == null ? '' : v).trim();
  const u = String(umdNm == null ? '' : umdNm).trim();
  if (u && t.startsWith(u + ',')) { const r = t.slice(u.length + 1).trim(); if (r) t = r; }
  const r2 = t.replace(/\s*\((?:고층|저층|중층)\)\s*$/, '').trim();
  return r2 || t;
}
function displayAptName(name, { umdNm, jibun, kaptName } = {}) {
  if (kaptName && String(kaptName).trim()) return stripOrgSuffix(kaptName);
  const s = tidyMolitName(name, umdNm);
  if (isUnnamedApt(s)) {
    const jb = (jibun && String(jibun).trim()) || (s.match(/\d+(?:-\d+)?/) || [''])[0];
    return [umdNm ? String(umdNm).trim() : '', jb ? `${jb}번지` : '', '단지 (이름 미등록)'].filter(Boolean).join(' ');
  }
  const m = s.match(JIBUN_SUFFIX_RE);
  return m ? `${stripOrgSuffix(s.slice(0, m.index))} (${m[1]}번지)` : stripOrgSuffix(s);
}
module.exports = { isUnnamedApt, displayAptName, stripOrgSuffix, tidyMolitName, UNNAMED_RE, JIBUN_SUFFIX_RE, ORG_SUFFIX_RE };
