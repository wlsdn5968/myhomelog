/**
 * APT-RESOLVE-2026-09-06: 단지명 매칭 규칙을 한 곳에.
 *   [왜] 챗·검색이 각자 다른 정규화를 쓰다가 "공릉 풍림아이원"이 양쪽 다 0건이 됐다
 *   (운영자 재현 — Plan 051). apt_master(정식명)와 molit_apt_index(국토부 원본명)
 *   사이의 공백·A/B 분리 표기 차이를 순수 함수로 흡수해 챗이 재사용한다.
 *   ⚠ 유사도(dice)는 **후보 나열용**이다. 자동 채택 판정에 쓰지 마라(IDENTITY-GATE —
 *   이름 유사도만으로 단지를 동일시했다가 전국 956건을 오매칭한 이력이 이 저장소에 있다).
 *
 * DB 를 모르는 순수 모듈 — 테스트가 쉽고, 다른 경로(search.js 등)가 안전하게 재사용할 수 있다.
 */

// 질의·이름 비교용 정규화: %·_ 제거 후 모든 공백 제거. 소문자화하지 않는다
// (한글이 대부분이고 기존 ilike 가 이미 대소문자 무시).
function normalizeName(s) {
  return String(s == null ? '' : s).replace(/[%_]/g, '').replace(/\s+/g, '');
}

// chatDataRouter._stripAptSuffix 를 그대로 옮긴 것 — 사본을 두 벌 만들지 않는다.
// 끝의 "아파트"/"아파트단지"만 제거(중간에 낀 "신동아아파트1" 류는 보존),
// 제거 후 2자 미만이면 원본을 돌려준다(과도한 축약 방지).
function stripAptSuffix(q) {
  const s = String(q || '').replace(/\s*아파트(?:단지)?$/, '').trim();
  return s.length >= 2 ? s : String(q || '').trim();
}

// A/B 형제 규칙용 키 추출. 이름이 `<stem><단일 접미문자>` 형태일 때만 값을 준다.
//   접미문자 = [A-Za-z가나다라] 1글자, stem 길이 >= 2.
function siblingKey(name) {
  const s = String(name || '').trim();
  const m = /^(.{2,})([A-Za-z가나다라])$/.exec(s);
  if (!m) return null;
  return { stem: m[1], suffix: m[2] };
}

// [{apt_name, build_year}] 를 받아 A/B 형제 규칙 3조건을 전부 만족하는 그룹만 반환한다.
//   1) 각 이름이 <stem><단일 접미문자> 형태이고 stem 이 완전히 동일
//   2) 집합 안에 서로 다른 접미문자가 2개 이상 존재
//   3) 집합의 build_year 가 전부 같다
// ⚠ 조건 미달이면 그룹을 만들지 않는다 — "태강CITY"(접미문자 동일)·"현대A/C/D"(build_year 불일치)
//   같은 오매칭을 막는 것이 이 함수의 존재 이유다.
function groupSiblings(rows) {
  const byStem = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !r.apt_name) continue;
    const key = siblingKey(r.apt_name);
    if (!key) continue;
    if (!byStem.has(key.stem)) byStem.set(key.stem, []);
    byStem.get(key.stem).push({ name: r.apt_name, suffix: key.suffix, buildYear: r.build_year });
  }
  const out = [];
  for (const [stem, members] of byStem) {
    const suffixes = new Set(members.map(m => m.suffix));
    if (suffixes.size < 2) continue; // 접미문자가 전부 같다 — 같은 이름의 중복일 뿐
    const years = new Set(members.map(m => m.buildYear));
    if (years.size !== 1) continue;  // build_year 불일치 — 다른 연식의 별개 단지
    out.push({ stem, names: members.map(m => m.name), buildYear: members[0].buildYear });
  }
  return out;
}

// 두 문자열의 bigram Dice 계수(0~1). 후보 정렬용으로만 쓴다 — 자동 채택 금지.
function dice(a, b) {
  const s1 = String(a == null ? '' : a);
  const s2 = String(b == null ? '' : b);
  if (!s1.length || !s2.length) return 0;
  if (s1 === s2) return 1;
  if (s1.length < 2 || s2.length < 2) return 0;
  const bigrams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      m.set(bg, (m.get(bg) || 0) + 1);
    }
    return m;
  };
  const m1 = bigrams(s1), m2 = bigrams(s2);
  let intersection = 0;
  for (const [bg, c1] of m1) {
    const c2 = m2.get(bg);
    if (c2) intersection += Math.min(c1, c2);
  }
  let total = 0;
  for (const c of m1.values()) total += c;
  for (const c of m2.values()) total += c;
  return total ? (2 * intersection) / total : 0;
}

// REGION-SPLIT-2026-09-06 (Plan 057): "지역 + 단지명" 한 문장을 공백 기준 분할점마다
//   { region, name } 후보로 낸다. [왜] normalizeName 은 공백을 전부 지워 "대치 은마"를
//   "대치은마"로 붙이기만 한다 — MOLIT·apt_master 는 "은마"로만 저장하므로 붙인 문자열은
//   원리적으로 0건이다(계획서 057 DB 실측). 지역 토큰을 분리해야 "은마"만 남길 수 있다.
//   이 함수는 어디서 자를지 후보만 순수하게 만든다 — 실제 DB 조회는 호출부(chatDataRouter)
//   책임이다(이 모듈은 DB 를 모르는 순수 모듈이라는 파일 상단 원칙 유지).
//   ⚠ name·region 둘 다 2자 미만인 분할은 버린다 — 이 파일의 기존 가드(siblingKey 의
//   stem 2자 이상 요구 등)와 같은 취지로, 너무 짧은 조각은 전체매칭 위험을 키운다.
//   반환 순서는 name 이 짧은(= region 을 더 많이 떼어낸) 후보 우선 — 좁을수록 정확하다.
//   왕복 상한과 짝을 맞추기 위해 최대 3개까지만 반환한다.
function splitRegionName(q) {
  const tokens = String(q == null ? '' : q).trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return []; // 토큰 1개 이하면 지역/이름을 나눌 대상이 없다.
  const out = [];
  for (let i = 1; i < tokens.length; i++) {
    const region = tokens.slice(0, i).join(' ');
    const name = tokens.slice(i).join(' ');
    if (region.length < 2 || name.length < 2) continue;
    out.push({ region, name });
  }
  out.sort((a, b) => a.name.length - b.name.length);
  return out.slice(0, 3);
}

module.exports = { normalizeName, stripAptSuffix, siblingKey, groupSiblings, dice, splitRegionName };
