#!/usr/bin/env node
/**
 * scripts/build-sgg-geo.js — 지도 "구별 옅은 음영"용 시군구 경계(frontend/geo/sgg-<시도>.json) 만들기.
 *
 * 원자료: vuski/admdongkor ver20261001 행정동 경계(통계청 SGIS 공공누리 제1유형 → CC BY 4.0). 출처 표기 의무 —
 *   화면 지도 범례 옆과 이 파일들의 attribution 필드에 남긴다(LICENSE-DATA §3).
 * 절차(재현용 — 2026-10-21 실행):
 *   npx mapshaper@0.6.102 -i HangJeongDong_ver20261001.geojson \
 *     -filter '["11","26","27","28","30","31","36","41","43"].indexOf(sido)>=0' \
 *     -dissolve sgg copy-fields=sido,sggnm -simplify 4% keep-shapes -o sgg_all.json format=geojson precision=0.0001
 *   npx mapshaper@0.6.102 -i sgg_all.json -points inner -o sgg_pts.json format=geojson precision=0.0001
 *   node scripts/build-sgg-geo.js sgg_all.json sgg_pts.json
 * 하는 일: 우리 시군구 코드(regionPopularService.lawdsOfSido)만 남기고, 맞닿은 구끼리 다른 색 번호(k: 0~5)를
 *   주고(경계 좌표 공유로 이웃 판정 → 이웃 많은 순 탐욕 색칠), 이름표 자리(라벨 점 — 다각형 안쪽)를 붙여 시도별로 쓴다.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const rp = require(path.join(__dirname, '..', 'backend', 'services', 'regionPopularService'));

const [allPath, ptsPath] = process.argv.slice(2);
if (!allPath || !ptsPath) { console.error('사용법: node scripts/build-sgg-geo.js sgg_all.json sgg_pts.json'); process.exit(1); }
const all = JSON.parse(fs.readFileSync(allPath, 'utf8'));
const pts = JSON.parse(fs.readFileSync(ptsPath, 'utf8'));
const ptOf = new Map(pts.features.map((f) => [f.properties.sgg, f.geometry.coordinates]));
const outDir = path.join(__dirname, '..', 'frontend', 'geo');
fs.mkdirSync(outDir, { recursive: true });
const ATTR = '행정구역 경계: 통계청 SGIS(공공누리 제1유형) 가공 vuski/admdongkor ver20261001, CC BY 4.0';
const PALETTE = 6;

const rings = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);
const r4 = (n) => Math.round(n * 1e4) / 1e4;

let bad = 0;
for (const sido of Object.keys(rp.SIDOS)) {
  const codes = rp.lawdsOfSido(sido);
  const feats = codes.map((c) => all.features.find((f) => f.properties.sgg === c));
  const missing = codes.filter((c, i) => !feats[i]);
  if (missing.length) { bad++; console.error(`✖ ${sido}: 경계 없음 ${missing.join(' ')}`); continue; }
  // 이웃 판정: 좌표 점을 2개 이상 공유하면 맞닿음(단순화 뒤에도 공유 경계는 같은 좌표 — mapshaper 위상 보존)
  const ptSets = feats.map((f) => { const s = new Set(); rings(f.geometry).forEach((poly) => poly.forEach((ring) => ring.forEach(([x, y]) => s.add(`${r4(x)},${r4(y)}`)))); return s; });
  const adj = feats.map(() => new Set());
  for (let i = 0; i < feats.length; i++) for (let j = i + 1; j < feats.length; j++) {
    let n = 0; for (const p of ptSets[i]) if (ptSets[j].has(p) && ++n >= 2) break;
    if (n >= 2) { adj[i].add(j); adj[j].add(i); }
  }
  const order = feats.map((_, i) => i).sort((a, b) => adj[b].size - adj[a].size || a - b);
  const color = new Array(feats.length).fill(-1);
  for (const i of order) {
    const used = new Set([...adj[i]].map((j) => color[j]));
    let k = 0; while (used.has(k)) k++;
    if (k >= PALETTE) { bad++; console.error(`✖ ${sido} ${codes[i]}: 색 ${PALETTE}개로 부족`); }
    color[i] = k % PALETTE;
  }
  const out = {
    type: 'FeatureCollection', attribution: ATTR, sido,
    features: feats.map((f, i) => ({
      type: 'Feature',
      properties: { c: codes[i], n: f.properties.sggnm, k: color[i], lp: ptOf.get(codes[i]) || null },
      geometry: f.geometry,
    })),
  };
  const file = path.join(outDir, `sgg-${sido}.json`);
  fs.writeFileSync(file, JSON.stringify(out));
  const conflicts = feats.reduce((n, _, i) => n + [...adj[i]].filter((j) => color[j] === color[i]).length, 0) / 2;
  console.log(`✔ ${sido}: ${feats.length}개 · 이웃 쌍 ${adj.reduce((n, a) => n + a.size, 0) / 2} · 같은 색 이웃 ${conflicts} · ${(fs.statSync(file).size / 1024).toFixed(1)}KB`);
}
process.exit(bad ? 1 : 0);
