#!/usr/bin/env node
/**
 * 카카오 개발자 콘솔 앱 아이콘 생성기
 *
 * 왜 별도 아이콘이 필요한가:
 *   PWA 아이콘(icon-512.png)은 maskable 세이프존 때문에 심볼이 캔버스의 45% 밖에 안 된다.
 *   카카오 로그인 동의화면은 아이콘을 작게(그리고 원형으로) 표시하므로 그대로 쓰면 집이 안 보인다.
 *   → 같은 원본에서 심볼 주변을 좁게 크롭해 62% 로 키운다. 색·형태는 원본 그대로다(재디자인 아님).
 *
 * 카카오 규격 (developers.kakao.com/docs/ko/app-setting/app, 2026-08-16 확인):
 *   - 250KB 미만
 *   - 128x128 이하 권장
 *   - 비즈 앱 전환의 **선행 조건** (아이콘 없으면 비즈니스 정보 등록 불가)
 *
 * 실행: node scripts/make-kakao-icon.js
 *   sharp 는 런타임 의존성이 아니라 이 스크립트 전용이다. 저장소에 추가하지 않으므로
 *   필요할 때만 `npm install sharp --no-save` 로 설치하고 돌린다.
 */
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const SRC = path.join(__dirname, '../frontend/icon-512.png');
const OUT = path.join(__dirname, '../frontend/kakao-app-icon-128.png');

// icon-512.png 에서 실측한 심볼 bounding box (2026-08-16)
const SYMBOL = { minX: 141, maxX: 370, minY: 162, maxY: 387 };
const TARGET_RATIO = 0.62; // 심볼이 캔버스에서 차지할 비율. 원형 마스크(반경 50%) 안에 들어가는 값
const OUT_SIZE = 128;

async function main() {
  const w = SYMBOL.maxX - SYMBOL.minX + 1;
  const h = SYMBOL.maxY - SYMBOL.minY + 1;
  const sym = Math.max(w, h);
  const cx = (SYMBOL.minX + SYMBOL.maxX) / 2;
  const cy = (SYMBOL.minY + SYMBOL.maxY) / 2;

  const crop = Math.round(sym / TARGET_RATIO);
  const left = Math.round(cx - crop / 2);
  const top = Math.round(cy - crop / 2);

  const meta = await sharp(SRC).metadata();
  if (left < 0 || top < 0 || left + crop > meta.width || top + crop > meta.height) {
    throw new Error(`크롭 영역이 원본을 벗어난다: left=${left} top=${top} crop=${crop} src=${meta.width}x${meta.height}`);
  }

  await sharp(SRC)
    .extract({ left, top, width: crop, height: crop })
    .resize(OUT_SIZE, OUT_SIZE, { kernel: 'lanczos3' })
    .png({ compressionLevel: 9, palette: true })
    .toFile(OUT);

  // ── 검증: 규격·정렬·원형 마스크 안전성을 눈이 아니라 숫자로 확인한다 ──
  const bytes = fs.statSync(OUT).size;
  if (bytes >= 250 * 1024) throw new Error(`250KB 제한 초과: ${bytes} bytes`);

  const { data, info } = await sharp(OUT).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => {
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const bg = px(2, 2);
  let bx0 = Infinity, by0 = Infinity, bx1 = -1, by1 = -1;
  for (let y = 0; y < OUT_SIZE; y++) {
    for (let x = 0; x < OUT_SIZE; x++) {
      const p = px(x, y);
      if (Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) > 30) {
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
      }
    }
  }
  const ratio = (bx1 - bx0 + 1) / OUT_SIZE;
  const offX = bx0 - (OUT_SIZE - 1 - bx1);
  const offY = by0 - (OUT_SIZE - 1 - by1);
  const c = (OUT_SIZE - 1) / 2;
  const radius = Math.max(
    Math.hypot(bx0 - c, by0 - c), Math.hypot(bx1 - c, by0 - c),
    Math.hypot(bx0 - c, by1 - c), Math.hypot(bx1 - c, by1 - c)
  );

  if (Math.abs(offX) > 1 || Math.abs(offY) > 1) throw new Error(`중앙 정렬 편차: x=${offX} y=${offY}`);
  if (radius >= OUT_SIZE / 2) throw new Error(`원형 마스크에서 잘린다: 반경 ${radius.toFixed(1)} >= ${OUT_SIZE / 2}`);

  console.log(`생성: ${OUT}`);
  console.log(`  ${OUT_SIZE}x${OUT_SIZE} · ${bytes} bytes (제한 250KB 의 ${((bytes / 256000) * 100).toFixed(1)}%)`);
  console.log(`  배경 #${bg.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()} · 심볼 ${(ratio * 100).toFixed(1)}%`);
  console.log(`  중앙 정렬 편차 x=${offX} y=${offY} · 심볼 최외곽 반경 ${radius.toFixed(1)} / 원형 마스크 ${OUT_SIZE / 2}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
