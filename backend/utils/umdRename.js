'use strict';
// UMD-RENAME-2026-11-14: 이름이 바뀐 읍면(시군구별 옛 이름 -> 새 이름).
//   국토부 원본이 2025-10 부터 달성군 구지면을 구지읍으로 바꿔 보내 같은 단지 거래가 두 동 이름으로 나뉘었다
//   (운영 실측 2026-11-14: 구지면 3개 리 93행, 구지읍 191행, 지오코드 9개 단지가 두 이름 행을 함께 가짐).
//   운영 원본에서 같은 리가 두 이름으로 함께 있는 경우만 넣는다. 원본 데이터는 바꾸지 않고 비교와 집계에서만 맞춘다.
const UMD_RENAME = { '달성군': { '구지면': '구지읍' } };

function umdCanon(sgg, umd) {
  if (!umd) return umd;
  const m = UMD_RENAME[sgg];
  if (!m) return umd;
  const parts = String(umd).split(' ');
  return m[parts[0]] ? [m[parts[0]], ...parts.slice(1)].join(' ') : umd;
}

// 조회 목록에 새 이름과 옛 이름을 함께 넣는다(시군구를 모를 때도 쓸 수 있게 이름만 본다)
function umdWithLegacy(list) {
  const out = new Set(list);
  for (const u of list) {
    const parts = String(u).split(' ');
    for (const m of Object.values(UMD_RENAME)) {
      for (const [oldH, newH] of Object.entries(m)) if (parts[0] === newH) out.add([oldH, ...parts.slice(1)].join(' '));
    }
  }
  return [...out];
}

module.exports = { UMD_RENAME, umdCanon, umdWithLegacy };
