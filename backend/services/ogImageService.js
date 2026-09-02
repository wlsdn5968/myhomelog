/**
 * OG-IMAGE-DYNAMIC-2026-09-02 (Sprint RRRRRRR): 단지별 링크 미리보기 이미지(1200×630 PNG) 생성.
 *
 * [왜] SSR 페이지 3종(/apt·/region·/briefing)은 og:image 가 전부 같은 정적 og.png 였다.
 *   카카오톡·X 에 단지 링크를 붙이면 어떤 단지든 같은 그림이 떠서, 타임라인에서 무엇을 공유한
 *   것인지 알 수 없었다. 한국에서 링크 유통의 대부분은 카카오톡이고, 미리보기 카드가
 *   그 링크의 사실상 유일한 광고면이다.
 *
 * [무엇을 그리나] 지역 · 단지명 · 실거래 요약(건수/평균/범위/최근 거래일). **과거 사실만.**
 *   추천·예측·권유 표현을 넣지 않는다(절대 룰). 출처를 이미지 안에 박아 넣는다.
 *
 * [구현 선택 — 실측 근거]
 *   · `@vercel/og`(1.0.2, 유일한 최신)는 **로드 자체가 실패**한다: 내부 harfbuzzjs 가
 *     `Dynamic require of "fs" is not supported` 로 죽는다(자기 engines 인 node>=22 를
 *     만족하는 Node 24 에서 재현). 게다가 sharp 를 끌고 와 node_modules 가 53MB 였다.
 *   · 그래서 그 래퍼가 감싸고 있는 것을 직접 쓴다: satori(→SVG) + @resvg/resvg-js(→PNG).
 *     둘 합쳐 약 11.6MB 이고 CommonJS 에서 정상 동작한다.
 *     실측: SVG 3~59ms · PNG 약 200ms · 결과 18~24KB.
 *   · 폰트는 @fontsource/noto-sans-kr(OFL-1.1). 통짜 한글 폰트는 5MB 가 넘는데, 이 패키지는
 *     125개 유니코드 서브셋으로 쪼개져 있다 → **그릴 글자에 필요한 서브셋만** 고른다.
 *     실측: 실제 단지명 기준 5~8개 파일 · 52~86KB · 미커버 글자 0.
 *
 * [번들 크기] @fontsource/noto-sans-kr 는 통째로 **55MB·2,250파일**(9개 굵기 x woff/woff2)이다.
 *   우리는 400·700 의 woff 만 쓰므로 vercel.json 의 excludeFiles 로 나머지를 함수 번들에서 뺐다
 *   → 6.9MB. ⚠ 그 제외 규칙이 400·700 까지 지우면 이 서비스는 폰트를 못 찾아 폴백으로만 돈다
 *   (계약 테스트가 그 실수를 막는다).
 *
 * [비용 통제] satori·resvg 는 이 파일 안에서 **지연 로드**한다. 앱의 다른 모든 요청은
 *   이 코드를 건드리지 않으므로 콜드스타트가 무거워지지 않는다.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const logger = require('../logger');

const W = 1200;
const H = 630;

// ── 폰트 서브셋 인덱스 ────────────────────────────────────────────────────────
//   @fontsource 의 CSS 에 적힌 unicode-range 를 파싱해 [파일 → 코드포인트 구간] 표를 만든다.
//   파싱은 최초 1회. 실패해도 렌더 전체를 죽이지 않고 null 을 돌려 호출부가 폴백하게 한다.
let _fontIndex = null;      // { weight: [{file, ranges:[[a,b],…]}] }
const _fontCache = new Map(); // 파일명 → Buffer

function fontDir() {
  return path.dirname(require.resolve('@fontsource/noto-sans-kr/package.json'));
}

function parseWeight(weight) {
  const css = fs.readFileSync(path.join(fontDir(), `${weight}.css`), 'utf8');
  const out = [];
  for (const block of css.split('@font-face')) {
    const fm = block.match(/files\/(noto-sans-kr-\d+-\d+-normal)\.woff\)/);
    const um = block.match(/unicode-range:\s*([^;]+);/);
    if (!fm || !um) continue;
    const ranges = um[1].split(',').map((s) => {
      const m = s.trim().match(/^U\+([0-9a-fA-F]+)(?:-([0-9a-fA-F]+))?$/);
      if (!m) return null;
      const a = parseInt(m[1], 16);
      return [a, m[2] ? parseInt(m[2], 16) : a];
    }).filter(Boolean);
    if (ranges.length) out.push({ file: `${fm[1]}.woff`, ranges });
  }
  return out;
}

function fontIndex() {
  if (_fontIndex) return _fontIndex;
  _fontIndex = { 400: parseWeight(400), 700: parseWeight(700) };
  return _fontIndex;
}

/**
 * 주어진 텍스트를 그리는 데 필요한 서브셋 폰트만 고른다.
 *
 * ⚠ FONT-FAMILY-DISTINCT-2026-09-02: 고른 서브셋을 **전부 같은 family 이름**으로 넘기면
 *   satori 는 그중 하나만 쓰고 나머지 글자를 전부 두부(□)로 그린다 — 첫 구현에서 실제로
 *   한글 대부분이 □ 로 나왔다. 서브셋마다 **다른 이름**을 주고 fontFamily 에 그 목록을
 *   콤마로 이어 넘겨야 satori 가 폰트 폴백 체인을 탄다.
 *
 * ⚠ 커버되지 않는 글자가 있으면 그 글자는 두부로 그려진다 — 조용히 넘기지 않고 로그를 남긴다.
 *
 * @returns {{fonts: Array, family: string}}
 */
function pickFonts(text, weight, prefix) {
  const idx = fontIndex()[weight] || [];
  const need = new Set();
  const missing = [];
  for (const ch of new Set([...String(text)])) {
    const cp = ch.codePointAt(0);
    if (cp === 32 || cp === 10) continue;
    const hit = idx.find((s) => s.ranges.some(([a, b]) => cp >= a && cp <= b));
    if (hit) need.add(hit.file); else missing.push(ch);
  }
  if (missing.length) logger.warn({ missing: missing.join(''), weight }, 'og: 폰트 서브셋이 못 덮는 글자');
  const dir = path.join(fontDir(), 'files');
  const fonts = [...need].map((f, i) => {
    if (!_fontCache.has(f)) _fontCache.set(f, fs.readFileSync(path.join(dir, f)));
    return { name: `${prefix}${i}`, data: _fontCache.get(f), weight, style: 'normal' };
  });
  return { fonts, family: fonts.map((f) => f.name).join(', ') };
}

// ── satori 엘리먼트 헬퍼 (JSX 없이) ───────────────────────────────────────────
const h = (type, style, ...children) => ({
  type,
  key: null,
  props: {
    style,
    children: children.length === 0 ? undefined : (children.length === 1 ? children[0] : children),
  },
});

const C = {
  bg: '#080E18', card: '#101B2B', bd: '#22334A',
  tx: '#E8EFFA', sub: '#93A4BD', amb: '#FFC93C',
};

/** 단지명이 길면 글자를 줄인다 — 한글은 폭이 넓어 글자수 기준이 실제 폭과 잘 맞는다. */
function titleSize(name) {
  const n = String(name || '').length;
  if (n <= 8) return 84;
  if (n <= 12) return 68;
  if (n <= 16) return 56;
  if (n <= 22) return 46;
  return 38;
}

/**
 * 카드 하나를 PNG 로 만든다.
 * @param {{eyebrow:string, title:string, lines:string[], footer:string}} card
 * @returns {Promise<Buffer>}
 */
async function renderCard(card) {
  const satori = (await import('satori')).default;
  const { Resvg } = require('@resvg/resvg-js');

  const all = [card.eyebrow, card.title, ...(card.lines || []), card.footer, 'MYHOMELOG'].join(' ');
  const reg = pickFonts(all, 400, 'R');
  const bold = pickFonts(all, 700, 'B');
  const fonts = [...reg.fonts, ...bold.fonts];
  if (!fonts.length) throw new Error('사용할 수 있는 폰트 서브셋이 없다');

  const el = h('div', {
    width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
    justifyContent: 'space-between', padding: '64px 72px',
    backgroundColor: C.bg, color: C.tx, fontFamily: reg.family,
  },
    h('div', { display: 'flex', flexDirection: 'column' },
      h('div', { fontSize: 26, color: C.amb, letterSpacing: 4, fontFamily: bold.family, display: 'flex' }, 'MYHOMELOG'),
      h('div', { fontSize: 30, color: C.sub, marginTop: 22, display: 'flex' }, card.eyebrow),
      h('div', {
        fontSize: titleSize(card.title), fontFamily: bold.family, marginTop: 8,
        display: 'flex', lineHeight: 1.15,
      }, card.title),
    ),
    h('div', { display: 'flex', flexDirection: 'column' },
      ...(card.lines || []).map((t, i) => h('div', {
        fontSize: i === 0 ? 46 : 30, color: i === 0 ? C.tx : C.sub,
        marginTop: i === 0 ? 0 : 12, display: 'flex',
        fontFamily: i === 0 ? bold.family : reg.family,
      }, t)),
      h('div', {
        fontSize: 22, color: C.sub, marginTop: 26, paddingTop: 18,
        borderTop: `1px solid ${C.bd}`, display: 'flex',
      }, card.footer),
    ),
  );

  const svg = await satori(el, { width: W, height: H, fonts });
  return Buffer.from(new Resvg(svg).render().asPng());
}

module.exports = { renderCard, pickFonts, titleSize, W, H };
