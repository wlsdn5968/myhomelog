/**
 * backend/test/og-image.test.js
 *
 * characterization.test.js(Plan 066, 10,056줄·327 test 단일 파일)를 도메인별로 분할한 조각.
 * 동작을 하나도 바꾸지 않는 이동이다 — 테스트 이름·개수·본문은 원본과 동일하다.
 * 공용 목/스텁 유틸은 ./_helpers 에서 가져온다. 새 테스트는 이 파일의 주제와 맞으면 여기에,
 * 아니면 backend/test/README.md 규칙대로 새 도메인 파일을 만든다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');



// ── OG-IMAGE-DYNAMIC-2026-09-02 (Sprint RRRRRRR) ────────────────────────────────
//   단지별 링크 미리보기 이미지. 카카오톡·X 에서 이 카드가 사실상 유일한 광고면이라
//   ① 틀린 숫자를 그리면 안 되고 ② 추천·예측 표현이 들어가면 절대 룰 위반이며
//   ③ 렌더가 실패해도 링크 미리보기 자체는 살아 있어야 한다.
test('OG 카드 문구 — 실거래 사실만 싣고, 없는 숫자를 지어내지 않는다', () => {
  const { buildCard } = require('../routes/ogImage');

  const withStat = buildCard({
    region: '서울 성동구', aptName: 'e편한세상옥수파크힐스', umd: '옥수동', buildYear: 2016,
    stat: { dealCount: 63, avgPriceAuk: '19.2', medianPrice: 189000, minPrice: 154000, maxPrice: 231000, recentDeal: '2026-08-20' },
  });
  assert.equal(withStat.title, 'e편한세상옥수파크힐스');
  assert.equal(withStat.eyebrow, '서울 성동구 · 옥수동');
  const joined = withStat.lines.join(' | ');
  assert.match(joined, /최근 24개월 63건/, '거래 건수가 카드에 없다');
  assert.match(joined, /평균 19.2억/, '평균가가 카드에 없다');
  assert.match(joined, /중앙값 18.9억/, '중앙값이 만원→억 변환을 안 거쳤다');
  assert.match(joined, /15.4억~23.1억/, '가격 범위가 없다');
  assert.ok(withStat.lines.length <= 2, '줄이 3개 이상이면 630px 안에서 답답해진다');
  assert.match(withStat.footer, /국토교통부/, '출처가 이미지에 박히지 않는다');

  // ★ 통계가 없으면 숫자를 만들어내지 않는다 (0 건·0 억 같은 거짓 사실 금지)
  const noStat = buildCard({ region: '부산 해운대구', aptName: '테스트', umd: '', buildYear: null, stat: null });
  const nj = noStat.lines.join(' ');
  assert.equal(/[0-9]+건|[0-9.]+억/.test(nj), false, `통계가 없는데 숫자를 그렸다: ${nj}`);

  // ★ 절대 룰 — 추천·예측·권유 표현 금지
  const BANNED = ['추천', '유망', '전망', '오를', '내릴', '매수', '매도', '투자하', '지금이 기회', '저평가'];
  for (const card of [withStat, noStat]) {
    const all = [card.eyebrow, card.title, ...card.lines, card.footer].join(' ');
    for (const w of BANNED) {
      assert.equal(all.includes(w), false, `OG 카드에 금지 표현이 들어갔다: "${w}" in "${all}"`);
    }
  }
});



test('OG 폰트 — 실제 단지명이 서브셋으로 전부 덮인다 (두부 글자 0)', () => {
  const { pickFonts, titleSize } = require('../services/ogImageService');

  // 실제 단지명에서 뽑은 표본 — 영문 혼용·중점·㎡·물결까지 포함한다
  const SAMPLES = [
    'e편한세상옥수파크힐스 서울 성동구 · 옥수동',
    '래미안원베일리 최근 24개월 128건 · 평균 21.7억',
    '경희궁자이2단지 중앙값 18.9억 · 15.4억~23.1억 · 최근 거래 2026-08-20',
    '국토교통부 실거래가 공개시스템 · 층·향 보정 없음',
    'MYHOMELOG 전용 84㎡ 2016년 준공',
  ];
  for (const s of SAMPLES) {
    const r = pickFonts(s, 400, 'T');
    assert.ok(r.fonts.length > 0, `서브셋을 하나도 못 골랐다: ${s}`);

    // ★ FONT-FAMILY-DISTINCT: 서브셋마다 이름이 달라야 satori 가 폴백 체인을 탄다.
    //   같은 이름으로 넘겼다가 한글 대부분이 두부(□)로 그려진 적이 있다.
    const names = r.fonts.map((f) => f.name);
    assert.equal(new Set(names).size, names.length,
      '서브셋 폰트 이름이 겹친다 — satori 가 하나만 쓰고 나머지 글자를 □ 로 그린다');
    assert.equal(r.family, names.join(', '), 'fontFamily 폴백 목록이 폰트 목록과 다르다');
  }

  // 이름이 길수록 글자를 줄인다(넘치면 카드 밖으로 나간다)
  assert.ok(titleSize('파크뷰') > titleSize('e편한세상옥수파크힐스'), '긴 이름이 줄어들지 않는다');
  assert.ok(titleSize('아'.repeat(30)) <= 40, '아주 긴 이름이 충분히 줄지 않는다');
});



test('OG 렌더 — 1200x630 PNG 를 실제로 만든다', async () => {
  const { renderCard, W, H } = require('../services/ogImageService');
  const png = await renderCard({
    eyebrow: '서울 성동구 · 옥수동', title: 'e편한세상옥수파크힐스',
    lines: ['최근 24개월 63건 · 평균 19.2억'], footer: '국토교통부 실거래가 공개시스템',
  });
  assert.ok(Buffer.isBuffer(png) && png.length > 5000, `PNG 가 비정상적으로 작다(${png && png.length})`);
  // PNG 시그니처 + IHDR 에서 실제 픽셀 크기를 읽는다 (헤더만 믿지 않는다)
  assert.equal(png.slice(1, 4).toString('latin1'), 'PNG', 'PNG 시그니처가 아니다');
  assert.equal(png.readUInt32BE(16), W, `가로가 ${W} 가 아니다`);
  assert.equal(png.readUInt32BE(20), H, `세로가 ${H} 가 아니다`);
});



test('OG 라우트 — 실패·미존재는 정적 이미지로 떨어지고 절대 캐시되지 않는다', async () => {
  // 열화된 응답을 엣지에 굳히면 장애가 캐시 수명만큼 지속된다(이 저장소의 실제 사고).
  const router = require('../routes/ogImage');
  const layer = router.stack.find((l) => l.route);
  assert.ok(layer, 'ogImage 라우터에 라우트가 없다');
  const handle = layer.route.stack[0].handle;

  const mkRes = () => {
    const r = { headers: {}, redirected: null, sent: null, code: 200 };
    r.set = (k, v) => { r.headers[k] = v; return r; };
    r.status = (c) => { r.code = c; return r; };
    r.redirect = (c, url) => { r.code = c; r.redirected = url; return r; };
    r.send = (b) => { r.sent = b; return r; };
    return r;
  };

  // ① 형식이 틀린 코드 — 이름으로 조회하지 않는다(동명 단지가 남의 시세를 끌어온다)
  const bad = mkRes();
  await handle({ params: { aptSeq: '반포자이' } }, bad, () => {});
  assert.equal(bad.redirected, '/og.png', '잘못된 코드인데 정적 이미지로 떨어지지 않았다');
  assert.equal(bad.headers['Cache-Control'], 'no-store', '열화 응답에 캐시가 붙었다');
  assert.equal(bad.headers['X-Og-Fallback'], 'bad-seq', '폴백 사유를 남기지 않아 라이브에서 원인을 못 본다');

  // ② 사실 조회가 null (DB 미설정 환경) — 여기서도 캐시 금지
  const none = mkRes();
  await handle({ params: { aptSeq: '11200-1234' } }, none, () => {});
  assert.equal(none.redirected, '/og.png', '데이터가 없는데 정적 이미지로 떨어지지 않았다');
  assert.equal(none.headers['Cache-Control'], 'no-store', '열화 응답에 캐시가 붙었다');
});



test('OG 배선 — 단지 페이지가 사실을 한 곳에서만 만들고, 얇은 페이지엔 동적 이미지를 안 건다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const src = fs2.readFileSync(path2.join(__dirname, '../routes/aptPage.js'), 'utf8');

  // ① 사실 생성은 loadAptFacts 한 곳 — 카드와 페이지가 다른 숫자를 말하면 안 된다
  assert.equal(typeof require('../routes/aptPage').loadAptFacts, 'function',
    'loadAptFacts 가 내보내져 있지 않다 — OG 라우트가 사실을 따로 계산하게 된다');
  // ⚠ 주석에도 이 이름이 나오므로 **호출 형태**(svc.analyzeTransactions()) 로 좁혀 센다.
  assert.equal((src.match(/svc\.analyzeTransactions\(/g) || []).length, 1,
    'analyzeTransactions 호출이 2곳 이상이다 — 사실 계산이 다시 사본이 됐다');

  // ② 거래가 없는 얇은 페이지는 그릴 숫자가 없으므로 기본 이미지를 쓴다
  assert.match(src, /image: thin \? null :/,
    '얇은 페이지에도 동적 이미지를 걸고 있다 — 빈 카드가 공유된다');
});



//   OG-FONT-BUNDLE-2026-09-02: 폰트를 어떻게 함수 번들에 싣느냐로 **배포가 한 번 죽었다.**
//     ① @fontsource 패키지(55MB)를 excludeFiles 로 잘라내려 했더니 그 값이 256자를 넘어
//        Vercel 이 vercel.json 스키마 검증에서 배포를 통째로 거부했다(빌드 로그조차 없다).
//     ② 설령 통과했어도 node_modules 안의 폰트는 런타임 fs 읽기라 파일 추적이 못 잡는다 —
//        배포는 성공하는데 프로덕션에서만 폰트를 못 찾아 카드가 조용히 폴백으로 돌았을 것이다.
//     → 필요한 서브셋만 저장소에 벤더링하고 includeFiles 로 명시한다.
test('OG 폰트 번들 — 벤더 폰트가 함수 번들에 실리고, vercel.json 이 스키마 한도를 지킨다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const root = path2.join(__dirname, '../..');
  const vj = JSON.parse(fs2.readFileSync(path2.join(root, 'vercel.json'), 'utf8'));
  const fn = (vj.functions || {})['api/index.js'] || {};

  // ① 배포를 죽인 바로 그 한도. 넘으면 빌드가 아니라 **배포 자체**가 거부된다.
  for (const k of ['includeFiles', 'excludeFiles']) {
    const v = String(fn[k] || '');
    assert.ok(v.length <= 256,
      `vercel.json 의 ${k} 가 ${v.length}자 — Vercel 스키마 한도(256)를 넘어 배포가 거부된다`);
  }

  // ② 벤더 폰트가 번들에 포함돼야 한다. 빠지면 배포·테스트는 통과하는데 카드만 폴백으로 돈다.
  assert.match(String(fn.includeFiles || ''), /backend\/assets\/fonts/,
    'includeFiles 에 벤더 폰트 경로가 없다 — 프로덕션에서 폰트를 못 찾아 카드가 조용히 기본 이미지로 떨어진다');
  assert.match(String(fn.includeFiles || ''), /frontend\/index\.html/,
    'includeFiles 에서 index.html 이 빠졌다 — 기존 동작이 깨진다');

  // ③ 벤더 파일이 실제로 있어야 한다(패키지 의존을 끊었으므로 저장소가 유일한 출처다)
  const dir = path2.join(root, 'backend/assets/fonts/noto-sans-kr');
  assert.ok(fs2.existsSync(path2.join(dir, 'index.json')), '폰트 인덱스가 없다');
  assert.ok(fs2.existsSync(path2.join(dir, 'LICENSE.txt')), 'OFL 라이선스 사본이 없다 — 재배포 조건 위반');
  const idx = JSON.parse(fs2.readFileSync(path2.join(dir, 'index.json'), 'utf8'));
  for (const w of ['400', '700']) {
    assert.ok(Array.isArray(idx[w]) && idx[w].length > 50, `가중치 ${w} 인덱스가 비었거나 너무 작다`);
    for (const [file] of idx[w]) {
      assert.ok(fs2.existsSync(path2.join(dir, file)), `인덱스가 가리키는 폰트 파일이 없다: ${file}`);
    }
  }

  // ④ 런타임이 npm 패키지에 다시 기대지 않는다(그 경로는 파일 추적이 못 잡는다)
  const svc = fs2.readFileSync(path2.join(root, 'backend/services/ogImageService.js'), 'utf8');
  assert.equal(/require\(['"]@fontsource/.test(svc), false,
    'ogImageService 가 다시 @fontsource 패키지를 require 한다 — 프로덕션에서 폰트를 못 찾는다');
  const pkg = JSON.parse(fs2.readFileSync(path2.join(root, 'package.json'), 'utf8'));
  assert.equal('@fontsource/noto-sans-kr' in (pkg.dependencies || {}), false,
    '@fontsource 의존이 되살아났다 — 55MB 가 함수 번들에 실린다');
});



//   한글 커버리지는 **실행**으로 확인한다 — 인덱스가 있어도 글자를 못 덮으면 두부(□)가 그려진다.
test('OG 폰트 — 한글 음절 전 구간을 서브셋이 덮는다 (표본 실행)', () => {
  const { pickFonts } = require('../services/ogImageService');
  // 가·힣 양끝 + 중간을 고르게 뽑은 표본 + 실제 단지명에 흔한 글자
  const chars = [];
  for (let cp = 0xac00; cp <= 0xd7a3; cp += 97) chars.push(String.fromCodePoint(cp));
  const sample = chars.join('') + '가힣아파트단지동호실거래평균억건년준공전용㎡·~→';
  for (const w of [400, 700]) {
    const r = pickFonts(sample, w, 'X');
    assert.ok(r.fonts.length > 0, `가중치 ${w} 에서 서브셋을 하나도 못 골랐다`);
    // 못 덮는 글자가 있으면 pickFonts 가 경고를 남기지만, 여기서는 커버 자체를 직접 센다
    const idx = require('node:fs').existsSync ? null : null;
    const covered = [...new Set([...sample])].filter((ch) => {
      const one = pickFonts(ch, w, 'Y');
      return one.fonts.length > 0;
    });
    assert.equal(covered.length, new Set([...sample]).size,
      `가중치 ${w} 에서 못 덮는 글자가 있다 — 카드에 □ 로 그려진다`);
  }
});



// ── ROBOTS-OG-ALLOW-2026-09-05 ────────────────────────────────────────────────────
//   [실측] Search Console 이 "robots.txt 에 의해 차단됨" 1건을 보고했다. 동적 OG 이미지가 /api/og/ 아래에 있는데
//   robots.txt 가 /api/ 전체를 막고 있어, robots.txt 를 존중하는 스크래퍼는 카드 이미지를 못 가져간다.
test('robots.txt — /api/ 는 막되 /api/og/ 는 허용 (Allow 가 Disallow 보다 앞)', () => {
  const txt = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../frontend/robots.txt'), 'utf8');
  const star = txt.slice(txt.indexOf('User-agent: *'), txt.indexOf('User-agent: GPTBot'));
  const allow = star.indexOf('Allow: /api/og/'), dis = star.indexOf('Disallow: /api/');
  assert.ok(allow >= 0, 'OG 이미지 경로 허용이 사라졌다 — 카카오톡·X 카드 이미지가 막힌다');
  assert.ok(dis >= 0, '/api/ 차단이 사라졌다');
  assert.ok(allow < dis, '단순 파서(첫 매치 우선)를 위해 Allow 가 Disallow 보다 앞에 있어야 한다');
});



// ── OG-HB-WASM-2026-09-05 (프로덕션 실사고: satori 0.33 의 harfbuzzjs 가 hb.wasm 을 파일로 읽는다) ──────
//   [실측] 로컬(node_modules 있음)은 통과, 프로덕션은 ENOENT /var/task/node_modules/harfbuzzjs/hb.wasm → 302 폴백.
//   런타임 fs 읽기는 Vercel 파일 추적이 못 잡는다(폰트 벤더링 때와 같은 사고 유형) → includeFiles 에 명시.
//   폴백이 무증상이라 prod-smoke 의 OG 프로브가 실제 방어선이다. 이 테스트는 설정이 되돌아가는 것을 막는다.
test('OG 렌더러의 wasm — includeFiles 에 harfbuzzjs/hb.wasm 이 있고 파일이 실재한다', () => {
  const fs = require('node:fs'), path = require('node:path');
  const v = JSON.parse(fs.readFileSync(path.join(__dirname, '../../vercel.json'), 'utf8'));
  const inc = v.functions['api/index.js'].includeFiles;
  assert.ok(inc.includes('node_modules/harfbuzzjs/hb.wasm'), 'hb.wasm 이 includeFiles 에서 빠졌다 — 프로덕션 OG 가 전부 정적 이미지로 떨어진다');
  assert.ok(inc.length <= 256, 'includeFiles 256자 초과 — 배포가 스키마 검증에서 거부된다');
  const exists = ['../../node_modules/harfbuzzjs/hb.wasm', '../node_modules/harfbuzzjs/hb.wasm'].some(p => fs.existsSync(path.join(__dirname, p)));
  assert.ok(exists, 'harfbuzzjs/hb.wasm 이 설치돼 있지 않다 — satori 가 harfbuzzjs 를 더 쓰지 않으면 includeFiles 에서 빼고 이 테스트를 갱신할 것');
  const smoke = fs.readFileSync(path.join(__dirname, '../../scripts/prod-smoke.sh'), 'utf8');
  assert.match(smoke, /\/api\/og\/apt\/43114-58\?smoke=/, 'prod-smoke 의 동적 OG 프로브가 사라졌다 — 폴백은 무증상이라 이 프로브가 유일한 감지선');
});



// ── OG-REGION/BRIEFING-2026-09-05 (감사 P3-14: 지역·브리핑 링크 미리보기 카드) ────────────────────
//   [원칙] 카드 문장은 페이지와 **같은 함수**에서 나온다. 아래 두 순수 함수를 실제로 실행해 값을 고정한다.
test('지역 사실 문장 — regionFacts 는 페이지 description 과 OG 카드의 단일 출처', () => {
  const rp = require('../routes/regionPage');
  const dash = {
    txTrend: { months: [{ ym: '202607', n: 80 }, { ym: '202608', n: 123 }] },
    priceIndex: { months: [{ ym: '202608', sale: 98.2, jeonse: 97.1 }] },
    unsold: { latest: { cnt: 12, ym: '202607' } },
    netMigration: { latest: { net: -340, ym: '202607' } },
  };
  const rec = { windowDays: 30, highCount: 5, lowCount: 2 };
  assert.deepEqual(rp.regionFacts(dash, rec), [
    '최근 30일 최고가 경신 5건 · 최저가 경신 2건', '2026.08 실거래 123건', '2026.08 매매가격지수 98.2', '미분양 12호(2026.07)', '인구 순이동 -340명(2026.07)',
  ]);
  assert.deepEqual(rp.regionFacts(null, null), [], '원자료가 없으면 문장을 지어내지 않는다');
  // WEEKLY-DISCLOSURE-2026-09-05: 신규 공개 건수는 경신 다음 자리 · 0건은 문장 자체를 만들지 않는다(적재 0 을 "거래 없음"으로 읽히지 않게)
  assert.equal(rp.regionFacts(dash, rec, { count: 123, sinceDate: '2026-08-29' })[1], '최근 7일 신규 공개 123건');
  assert.equal(rp.regionFacts(dash, rec, { count: 0 }).length, 5, '0건은 문장을 만들지 않는다');
  assert.equal(rp.regionFacts(dash, rec, null).length, 5);
  assert.equal(require('../routes/ogImage').buildRegionCard('x', ['최근 7일 신규 공개 123건', '2026.08 실거래 60건']).lines[0], '2026.08 실거래 60건',
    'OG 카드 첫 줄은 월별 실거래 건수 — 신규 공개 문장이 그 자리를 가로채면 안 된다');
  // 페이지 본문에 facts.push 가 regionFacts 밖에 남아 있으면 사본이다
  const src = require('node:fs').readFileSync(require.resolve('../routes/regionPage'), 'utf8');
  const fnStart = src.indexOf('function regionFacts('), fnEnd = src.indexOf('\n}', fnStart);
  const inFn = (src.slice(fnStart, fnEnd).match(/facts\.push\(/g) || []).length;
  assert.equal((src.match(/facts\.push\(/g) || []).length, inFn, 'regionFacts 밖에 facts.push 가 있다 — description 과 카드가 갈린다');
  assert.ok(inFn >= 5);
  assert.match(src, /image: facts\.length \? `\$\{ORIGIN\}\/api\/og\/region\/\$\{region\.lawdCd\}` : null/, '지역 페이지가 동적 카드를 가리키지 않는다');
});



test('브리핑 티커 — briefingTicker 는 페이지와 OG 카드의 단일 출처', () => {
  const b = require('../routes/briefing');
  const tk = b.briefingTicker({
    ecos: { baseRate: 2.5, mortgageRate: 3.9, mortgageRateMonth: '202607' }, txTotal: 456561, syncedAt: '2026-09-01T18:08:00Z',
    regLog: [{ key: 'housing_loan_2025', effectiveFrom: '2025-10-15' }],
  });
  assert.deepEqual(tk, [
    { label: '기준금리', value: '2.5%', src: '한국은행' },
    { label: '주담대 평균', value: '3.9%', src: 'ECOS 2026.07' },
    { label: '실거래 누적', value: '456,561건', src: '국토부 · 09.01 동기화' },
    { label: '대출·규제 기준', value: '2025.10.15 시행', src: '금융위' },
  ]);
  assert.deepEqual(b.briefingTicker({}), [], '값이 없으면 항목을 만들지 않는다');
  const src = require('node:fs').readFileSync(require.resolve('../routes/briefing'), 'utf8');
  const fnStart = src.indexOf('function briefingTicker('), fnEnd = src.indexOf('\n}', fnStart);
  assert.equal((src.match(/tk\.push\(/g) || []).length, (src.slice(fnStart, fnEnd).match(/tk\.push\(/g) || []).length, 'briefingTicker 밖에 tk.push 가 있다');
  assert.match(src, /_thin \? null : `\$\{ORIGIN\}\/api\/og\/briefing\/\$\{day\}`/, '브리핑 페이지가 동적 카드를 가리키지 않는다');
});



test('OG 카드 — 지역·브리핑 라우트가 있고, 사실이 없으면 정적 이미지로 폴백(no-store)', async () => {
  const og = require('../routes/ogImage');
  const src = require('node:fs').readFileSync(require.resolve('../routes/ogImage'), 'utf8');
  assert.match(src, /router\.get\('\/region\/:lawdCd'/); assert.match(src, /router\.get\('\/briefing\/:day'/);
  assert.match(src, /fallback\(res, 'no-facts'\)/); assert.match(src, /fallback\(res, 'no-snapshot'\)/);
  const card = og.buildRegionCard('서울 강남구', ['최근 30일 최고가 경신 5건 · 최저가 경신 2건', '2026.08 실거래 123건', '2026.08 매매가격지수 98.2']);
  assert.equal(card.title, '서울 강남구');
  assert.equal(card.lines[0], '2026.08 실거래 123건', '가장 확실하고 짧은 사실(거래 건수)이 첫 줄');
  assert.equal(card.lines[1], '최근 30일 최고가 경신 5건 · 최저가 경신 2건 · 2026.08 매매가격지수 98.2');
  const bc = og.buildBriefingCard('2026-09-05', { ecos: { baseRate: 2.5, mortgageRate: 3.9 }, txTotal: 456561, lines: ['서울 아파트 거래 8월 1,234건'] });
  assert.equal(bc.title, '2026.09.05(토) 브리핑');
  assert.equal(bc.lines[0], '기준금리 2.5% · 주담대 평균 3.9%');
  assert.equal(bc.lines[1], '실거래 누적 456,561건 · 서울 아파트 거래 8월 1,234건');
  const long = og.buildBriefingCard('2026-09-05', { txTotal: 1, lines: ['x'.repeat(60)] });
  assert.equal(long.lines[1], undefined, '긴 시황은 잘라 싣지 않는다(숫자 훼손 방지)');
  // 라이브 실측: 첫 시황이 금리 문장이면 첫 줄과 중복 — 금리와 겹치지 않는 첫 시황을 고른다
  const dup = og.buildBriefingCard('2026-09-05', { ecos: { baseRate: 3 }, lines: ['한국은행 기준금리 3% · 시중 주담대 평균 4.48%', '서울 미분양 1,234호'] });
  assert.equal(dup.lines[0], '기준금리 3%');
  assert.equal(dup.lines[1], '서울 미분양 1,234호', '금리 문장이 카드에 두 번 찍힌다');
  const all = JSON.stringify([card, bc]).replace(/매수(·매도)? 추천이 아닙니다/g, '');
  for (const w of ['추천', '예측', '전망', '유망', '오를', '상승 기대']) assert.equal(all.includes(w), false, '금지어: ' + w);
  // 실제 렌더 1회 — 지역 카드도 1200x630 PNG 로 나온다
  const png = await require('../services/ogImageService').renderCard(card);
  assert.equal(png.readUInt32BE(16), 1200); assert.equal(png.readUInt32BE(20), 630);
});



test('OG 지역 카드 — rec.stale 이면 이미지는 그대로 만들되 캐시만 막는다 (Plan 058 Step 3)', async () => {
  // fallback() 규약(카드를 못 만듦 → no-store + 정적 이미지)과 구별: stale 은 "실제 통계가 있지만
  // 낡았다"는 뜻이라 og.png 로 떨어뜨리면 규약을 깨는 것이다 — 코드를 읽고 판단한 근거를 계획서에 남겼다.
  const og = require('../routes/ogImage');
  const rp = require('../routes/regionPage');
  const saved = rp.loadRegionData;
  try {
    rp.loadRegionData = async () => ({ dash: null, rec: { stale: true, highCount: 2, lowCount: 0 }, weekly: null });
    const layer = og.stack.find(l => l.route && l.route.path === '/region/:lawdCd');
    assert.ok(layer, 'ogImage 라우터에서 /region/:lawdCd 를 못 찾았다');
    const handle = layer.route.stack[layer.route.stack.length - 1].handle;

    const mkRes = () => {
      const r = { headers: {}, code: 200, sent: null, type: null };
      r.set = (k, v) => { r.headers[k] = v; return r; };
      r.status = (c) => { r.code = c; return r; };
      r.send = (b) => { r.sent = b; return r; };
      return r;
    };
    const res = mkRes();
    await handle({ params: { lawdCd: '11680' } }, res, () => {});
    assert.equal(res.headers['Cache-Control'], 'no-store', 'stale 인데 긴 캐시가 붙었다');
    assert.ok(Buffer.isBuffer(res.sent) && res.sent.length > 5000,
      'stale 이라고 fallback(정적 이미지)으로 떨어졌다 — 실제 통계 카드가 있는데 규약을 깼다');
    assert.equal(res.headers['Content-Type'], 'image/png');
  } finally { rp.loadRegionData = saved; }
});
