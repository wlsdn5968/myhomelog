/**
 * 부동산 뉴스 라우트
 * - 1순위: 네이버 검색 API (NAVER_CLIENT_ID/SECRET 환경변수 필요)
 * - 2순위(fallback): 다음/네이버 부동산 RSS 피드
 * - 캐시: 30분
 */
const express = require('express');
const router = express.Router();
const axios = require('axios');
const cache = require('../cache');
const { callAI } = require('../services/aiService');

const NAVER_NEWS_URL = 'https://openapi.naver.com/v1/search/news.json';

// 부동산 키워드 풀 (탭별 분류)
const KEYWORDS = {
  hot: ['부동산', '아파트 시세', '집값'],
  policy: ['부동산 규제', 'LTV DSR', '주택 정책', '부동산 세금'],
  region: ['강남 아파트', '서울 아파트', '경기 부동산'],
  reno: ['재건축', '재개발'],
};

function stripHtml(s) {
  return (s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'");
}

async function fetchNaverNews(query, display = 10) {
  const id = process.env.NAVER_CLIENT_ID;
  const secret = process.env.NAVER_CLIENT_SECRET;
  if (!id || !secret) return null;

  const r = await axios.get(NAVER_NEWS_URL, {
    headers: { 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': secret },
    params: { query, display, sort: 'date' },
    timeout: 5000,
  });
  return (r.data?.items || []).map(it => ({
    title: stripHtml(it.title),
    description: stripHtml(it.description).slice(0, 180),
    link: it.originallink || it.link,
    pubDate: it.pubDate,
    source: 'naver',
  }));
}

// RSS Fallback — 네이버 부동산 메인 RSS (간단한 XML 파싱)
async function fetchRssFallback() {
  try {
    const r = await axios.get('https://news.google.com/rss/search?q=%ED%95%9C%EA%B5%AD+%EB%B6%80%EB%8F%99%EC%82%B0&hl=ko&gl=KR&ceid=KR:ko', {
      timeout: 5000,
      headers: { 'User-Agent': 'MyHomeLogBot/1.0' },
    });
    const xml = r.data || '';
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml)) && items.length < 15) {
      const block = m[1];
      const title = (block.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '');
      const link = (block.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '');
      const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '');
      const desc = (block.match(/<description>([\s\S]*?)<\/description>/)?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').slice(0, 180);
      const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || 'Google News');
      items.push({ title: stripHtml(title), description: desc, link, pubDate, source });
    }
    return items;
  } catch {
    return [];
  }
}

/**
 * GET /api/news?cat=hot|policy|region|reno
 */
router.get('/', async (req, res) => {
  const cat = (req.query.cat || 'hot').toLowerCase();
  const keywords = KEYWORDS[cat] || KEYWORDS.hot;
  const cacheKey = `news:${cat}`;
  const hit = cache.get(cacheKey);
  if (hit) return res.json({ ...hit, fromCache: true });

  // 키워드별 합쳐서 가져오기 (중복 제거)
  let items = [];
  try {
    const results = await Promise.all(keywords.map(k => fetchNaverNews(k, 6).catch(() => null)));
    if (results.every(r => r === null)) {
      // 네이버 키 없음 → RSS fallback
      items = await fetchRssFallback();
    } else {
      const seen = new Set();
      results.flat().filter(Boolean).forEach(it => {
        if (!seen.has(it.link)) {
          seen.add(it.link);
          items.push(it);
        }
      });
      items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
      items = items.slice(0, 20);
    }
  } catch {
    items = await fetchRssFallback();
  }

  const out = {
    cat,
    count: items.length,
    items,
    source: items[0]?.source === 'naver' ? '네이버 뉴스' : 'Google News RSS',
    disclaimer: '뉴스 콘텐츠는 각 언론사의 저작권이며, 본 서비스는 단순 인덱싱·링크 제공만 합니다. 기사 내용에 대한 책임은 해당 언론사에 있습니다.',
    updatedAt: new Date().toISOString(),
  };
  cache.set(cacheKey, out, 1800); // 30분
  res.json(out);
});

/**
 * GET /api/news/summary
 * 오늘의 부동산 3줄 시황 (AI 자동 요약)
 * - 핫이슈 뉴스 타이틀 15건 → Claude로 중립적 3줄 요약
 * - 3시간 캐시 (AI 호출 절약)
 */
router.get('/summary', async (req, res) => {
  const cacheKey = 'news:summary:v2';
  const hit = cache.get(cacheKey);
  if (hit) return res.json({ ...hit, fromCache: true });

  // 뉴스 원본 캐시 재활용
  const hot = cache.get('news:hot');
  const policy = cache.get('news:policy');
  let titles = [];
  [hot, policy].forEach(h => {
    if (h?.items) titles.push(...h.items.slice(0, 8).map(i => i.title));
  });

  if (titles.length === 0) {
    return res.json({
      summary: '오늘의 뉴스 데이터가 아직 준비되지 않았어요. 뉴스 탭을 먼저 열어주세요.',
      updatedAt: new Date().toISOString(),
      fromCache: false,
    });
  }

  const prompt = `다음은 오늘 한국 부동산 뉴스 헤드라인 모음이야. 이걸 사실 기반으로 중립적으로 '3줄 시황 요약'해줘.

헤드라인:
${titles.slice(0, 20).map((t, i) => `${i+1}. ${t}`).join('\n')}

규칙:
- 정확히 3줄. 각 줄은 60자 이내.
- 매수·매도 권유 금지. "~오를 것" "~사야" 등 예측 표현 금지.
- 사실·흐름만 요약 ("~가 이슈" "~ 발표" "~ 추세" 식).
- 각 줄 앞에 이모지 1개 (📌 💰 🏛 🔨 📈 📉 중 택).
- JSON만 반환 (\`\`\` 없이): {"lines":["...","...","..."]}`;

  try {
    const result = await callAI([{ role: 'user', content: prompt }], false);
    const cleaned = result.content.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    const out = {
      summary: Array.isArray(parsed.lines) ? parsed.lines : [],
      updatedAt: new Date().toISOString(),
      disclaimer: '본 시황 요약은 뉴스 헤드라인 기반 정보 정리이며, 매수·매도 추천이 아닙니다.',
    };
    cache.set(cacheKey, out, 10800); // 3시간
    res.json({ ...out, fromCache: false });
  } catch (e) {
    require('../logger').error({ err: e, source: 'news-summary' }, '뉴스 AI 요약 실패');
    res.json({
      summary: ['📌 오늘 뉴스를 불러왔어요. 상세는 아래 목록을 확인하세요.'],
      updatedAt: new Date().toISOString(),
      fromCache: false,
    });
  }
});

module.exports = router;
