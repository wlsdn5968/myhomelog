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
const logger = require('../logger');
const router = express.Router();

const HTML_PATH = path.join(__dirname, '..', '..', 'frontend', 'index.html');
let cachedHtml = null;
function loadHtml() {
  if (cachedHtml) return cachedHtml;
  try {
    cachedHtml = fs.readFileSync(HTML_PATH, 'utf8');
    return cachedHtml;
  } catch (e) {
    logger.error({ err: e, htmlPath: HTML_PATH }, 'share: index.html 로드 실패');
    return null;
  }
}

function escapeHtml(s) {
  // SHARE-REPLACE-LITERAL-2026-09-06: `$` 도 함께 이스케이프한다 — 아래 lit() 이 이미 확장을
  //   막지만, 나중에 문자열 형태 치환이 다시 들어와도 안전하도록 두 겹으로 둔다.
  return String(s || '').replace(/[<>"'&$]/g, c => ({
    '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;', '$': '&#36;',
  }[c]));
}

// SHARE-REPLACE-LITERAL-2026-09-06:
// [왜] String.replace 의 replacement 가 **문자열**이면 JS 가 그 안의 특수 패턴
//   (매치 전체 / 매치 앞부분 / 매치 뒷부분 / 리터럴 달러) 4종을 다시 확장한다.
//   여기 들어가는 값은 요청 쿼리에서 오고, 치환 8개가 커지는 문자열 위에서 연쇄되므로
//   증폭이 곱으로 쌓인다.
// [실측 2026-09-06] apt 에 확장 패턴 10개(20자) → 응답 35,784,867자(원본 823,777자의 43배).
//   20개(40자)면 V8 문자열 상한을 넘겨 RangeError. apt 상한이 60자이므로 상한 입력은 항상 그 구간이다.
//   결제·인증·cron 이 같은 서버리스 함수에 있어 그 인스턴스가 함께 죽는다.
// [해결] replacement 를 **함수**로 준다 — 함수 반환값은 절대 재스캔되지 않는다.
const lit = (s) => () => s;

router.get('/', (req, res) => {
  const html = loadHtml();
  if (!html) return res.redirect(302, '/');
  const apt = (req.query.apt || '').toString().slice(0, 60);
  const area = (req.query.area || '').toString().slice(0, 40);
  const cmp = (req.query.cmp || '').toString().slice(0, 2000);
  // 비교 공유 딥링크(?cmp=) — OG 메타에 단지명 나열 (COMPARE-SHARE-2026-06-21)
  //   복원은 클라이언트 handleCompareUrl 이 수행. 여기선 크롤러 프리뷰 제목만 치환.
  if (!apt && cmp) {
    let names = [];
    try {
      let s = cmp.replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4) s += '=';
      const arr = JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
      if (Array.isArray(arr)) names = arr.map(a => (a && a.aptName) ? String(a.aptName).slice(0, 40) : '').filter(Boolean).slice(0, 6);
    } catch (_) { names = []; }
    const label = names.length >= 2 ? names.join(' vs ') : '단지';
    const title = `${label} — 내집로그 평당가 비교`;
    const desc = `${label} 전용면적 기준 평당가·단지정보 비교 (국토부 실거래). 매수 추천 아님.`;
    const origin = `${req.protocol}://${req.get('host')}`;
    const shareUrl = `${origin}/share?cmp=${encodeURIComponent(cmp)}`;
    const t = escapeHtml(title), d = escapeHtml(desc), u = escapeHtml(shareUrl);
    const rewritten = html
      .replace(/<title>[^<]*<\/title>/, lit(`<title>${t}</title>`))
      .replace(/<meta name="description" content="[^"]*">/, lit(`<meta name="description" content="${d}">`))
      .replace(/<meta property="og:title" content="[^"]*">/, lit(`<meta property="og:title" content="${t}">`))
      .replace(/<meta property="og:description" content="[^"]*">/, lit(`<meta property="og:description" content="${d}">`))
      .replace(/<meta property="og:url" content="[^"]*">/, lit(`<meta property="og:url" content="${u}">`))
      .replace(/<meta name="twitter:title" content="[^"]*">/, lit(`<meta name="twitter:title" content="${t}">`))
      .replace(/<meta name="twitter:description" content="[^"]*">/, lit(`<meta name="twitter:description" content="${d}">`))
      .replace(/<link rel="canonical" href="[^"]*">/, lit(`<link rel="canonical" href="${u}">`))
    // SHARE-NOINDEX-2026-09-02 (감사 P1-8): robots.txt 가 /share 를 Disallow 하고 있어서
    //   카카오톡·X·스레드의 링크 미리보기 크롤러가 이 페이지를 아예 못 읽었다 — OG 메타를
    //   동적 치환하는 라우트인데 정작 그 목적이 막혀 있던 셈이다(운영자 SNS 자동화와 직결).
    //   → robots.txt 에서 Disallow 를 풀고, 대신 여기서 noindex 로 **중복 색인만** 막는다.
    //   follow 는 유지해 링크 그래프는 살린다.
    .replace(/<meta name="robots" content="[^"]*">/, lit(`<meta name="robots" content="noindex, follow">`));
    res.set('Cache-Control', 'public, max-age=600, s-maxage=600');
    return res.type('html').send(rewritten);
  }
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
    .replace(/<title>[^<]*<\/title>/, lit(`<title>${t}</title>`))
    .replace(/<meta name="description" content="[^"]*">/, lit(`<meta name="description" content="${d}">`))
    .replace(/<meta property="og:title" content="[^"]*">/, lit(`<meta property="og:title" content="${t}">`))
    .replace(/<meta property="og:description" content="[^"]*">/, lit(`<meta property="og:description" content="${d}">`))
    .replace(/<meta property="og:url" content="[^"]*">/, lit(`<meta property="og:url" content="${u}">`))
    .replace(/<meta name="twitter:title" content="[^"]*">/, lit(`<meta name="twitter:title" content="${t}">`))
    .replace(/<meta name="twitter:description" content="[^"]*">/, lit(`<meta name="twitter:description" content="${d}">`))
    .replace(/<link rel="canonical" href="[^"]*">/, lit(`<link rel="canonical" href="${u}">`))
    // SHARE-NOINDEX-2026-09-02 (감사 P1-8): robots.txt 가 /share 를 Disallow 하고 있어서
    //   카카오톡·X·스레드의 링크 미리보기 크롤러가 이 페이지를 아예 못 읽었다 — OG 메타를
    //   동적 치환하는 라우트인데 정작 그 목적이 막혀 있던 셈이다(운영자 SNS 자동화와 직결).
    //   → robots.txt 에서 Disallow 를 풀고, 대신 여기서 noindex 로 **중복 색인만** 막는다.
    //   follow 는 유지해 링크 그래프는 살린다.
    .replace(/<meta name="robots" content="[^"]*">/, lit(`<meta name="robots" content="noindex, follow">`));
  // 크롤러 캐시 친화 + 동일 쿼리 재방문 시 빠르게
  res.set('Cache-Control', 'public, max-age=600, s-maxage=600');
  res.type('html').send(rewritten);
});

module.exports = router;
