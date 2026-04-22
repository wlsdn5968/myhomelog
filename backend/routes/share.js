/**
 * /share?apt=&area= — 딥링크 공유 URL. 서버 렌더링으로 OG 메타 동적 주입.
 *
 * 크롤러(카카오톡·슬랙·디스코드·페이스북·X)는 JS 미실행이라
 * 클라이언트에서 바꾼 document.title/og:title 을 보지 못함.
 * 여기서 HTML을 읽어 단지명 기반 og:title/description/url 을 치환 후 반환.
 *
 * 일반 클라이언트가 열었을 때도 동작 동일 — 기존 handleShareUrl() 이
 * URLSearchParams(location.search) 로 읽기 때문에 path 변경과 무관.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const HTML_PATH = path.join(__dirname, '..', '..', 'frontend', 'index.html');
let cachedHtml = null;
function loadHtml() {
  if (cachedHtml) return cachedHtml;
  try {
    cachedHtml = fs.readFileSync(HTML_PATH, 'utf8');
    return cachedHtml;
  } catch (e) {
    console.error('[share] index.html 로드 실패:', HTML_PATH, e.message);
    return null;
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[<>"'&]/g, c => ({
    '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;',
  }[c]));
}

router.get('/', (req, res) => {
  const html = loadHtml();
  if (!html) return res.redirect(302, '/');
  const apt = (req.query.apt || '').toString().slice(0, 60);
  const area = (req.query.area || '').toString().slice(0, 40);
  // 쿼리 없으면 원본 그대로
  if (!apt) {
    res.set('Cache-Control', 'public, max-age=300'); // 5분
    return res.type('html').send(html);
  }
  const title = `${apt}${area ? ` · ${area}` : ''} — 내집로그 분석`;
  const desc = `${apt}${area ? ` (${area})` : ''} 국토부 실거래 기반 평균가·평형별 시세·점수 요약. 매수 추천 아님.`;
  const origin = `${req.protocol}://${req.get('host')}`;
  const shareUrl = `${origin}/share?apt=${encodeURIComponent(apt)}${area ? `&area=${encodeURIComponent(area)}` : ''}`;
  const t = escapeHtml(title);
  const d = escapeHtml(desc);
  const u = escapeHtml(shareUrl);
  const rewritten = html
    .replace(/<title>[^<]*<\/title>/, `<title>${t}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${d}">`)
    .replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${t}">`)
    .replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${d}">`)
    .replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${u}">`)
    .replace(/<meta name="twitter:title" content="[^"]*">/, `<meta name="twitter:title" content="${t}">`)
    .replace(/<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${d}">`)
    .replace(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${u}">`);
  // 크롤러 캐시 친화 + 동일 쿼리 재방문 시 빠르게
  res.set('Cache-Control', 'public, max-age=600, s-maxage=600');
  res.type('html').send(rewritten);
});

module.exports = router;
