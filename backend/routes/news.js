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
const { filterAdviceOutput } = require('../services/aiOutputFilter');

const NAVER_NEWS_URL = 'https://openapi.naver.com/v1/search/news.json';

// 부동산 키워드 풀 (탭별 분류)
const KEYWORDS = {
  hot: ['부동산', '아파트 시세', '집값'],
  policy: ['부동산 규제', 'LTV DSR', '주택 정책', '부동산 세금'],
  region: ['강남 아파트', '서울 아파트', '경기 부동산'],
  reno: ['재건축', '재개발'],
  // Phase 4 (2026-04-26): 카테고리 2개 추가 — 사용자 의사결정 핵심 영역
  lease: ['전세', '임대차', '전세대출', '역전세'],
  tax: ['취득세', '양도세', '종부세', '부동산 세제'],
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
  // Phase 2.15: 본문 인용은 90자 이내 + 말줄임 처리 — 저작권법 인용 범위(필요 최소한) 준수.
  // 180자는 displacive summary 위험 (네이버 뉴스 API 약관 + 저작권법 28조).
  return (r.data?.items || []).map(it => {
    const desc = stripHtml(it.description);
    const short = desc.length > 90 ? desc.slice(0, 90) + '…' : desc;
    return {
      title: stripHtml(it.title),
      description: short,
      link: it.originallink || it.link,
      pubDate: it.pubDate,
      source: 'naver',
    };
  });
}

// RSS Fallback — Google News RSS 검색 (Naver 키 부재/전체 실패 시)
// NEWS-CAT-2026-07-16 (Sprint RRRRR, 운영자 발견): 기존 고정 쿼리 '한국 부동산'이 카테고리를 무시해
//   Naver 키 없는 프로덕션에서 6개 카테고리 전부 동일 뉴스가 나오던 근본 원인.
//   KEYWORDS 를 단일 소스로 재사용해 카테고리별 검색 쿼리 구성 (재건축 쿼리 실측: 5/5 관련 기사).
async function fetchRssFallback(cat) {
  try {
    const kws = KEYWORDS[cat] || KEYWORDS.hot;
    const q = encodeURIComponent(kws.join(' OR '));
    const r = await axios.get(`https://news.google.com/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko`, {
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
      // Phase 2.15: 90자 인용 한도 (RSS도 동일 정책)
      let desc = (block.match(/<description>([\s\S]*?)<\/description>/)?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '');
      if (desc.length > 90) desc = desc.slice(0, 90) + '…';
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
  // CDN-CACHE-2026-06-14: 공개·비개인화 뉴스 → Vercel 엣지가 함수 호출 없이 서빙 → 콜드스타트/캐시미스 latency 제거.
  const NEWS_CDN = 'public, max-age=0, s-maxage=600, stale-while-revalidate=1800';
  if (hit) { res.set('Cache-Control', NEWS_CDN); return res.json({ ...hit, fromCache: true }); }

  // 키워드별 합쳐서 가져오기 (중복 제거)
  let items = [];
  try {
    const results = await Promise.all(keywords.map(k => fetchNaverNews(k, 6).catch(() => null)));
    if (results.every(r => r === null)) {
      // 네이버 키 없음 → RSS fallback (카테고리별 쿼리)
      items = await fetchRssFallback(cat);
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
    items = await fetchRssFallback(cat);
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
  if (items.length) res.set('Cache-Control', NEWS_CDN); // 빈 결과(전체 실패)는 캐시 안 함 — 다음 요청서 재시도
  res.json(out);
});

/**
 * 데이터 시황 폴백 — NEWS-SUM-2026-07-16 (Sprint RRRRR, 운영자 발견 "3줄 시황 공백")
 * 근본 원인(Vercel 런타임 로그 실측): Anthropic 크레딧 소진 400 → catch 의 무의미한 한 줄 폴백만 표시.
 * AI 실패 시 이미 자동화된 공식 통계(ECOS 금리·KOSIS 미분양·실거래 기준월 — 전부 무료·기존 서비스 재사용)로
 * 사실 서술 3줄 구성. 예측·권유 없음(절대룰). 값 없는 줄은 생략(graceful).
 */
async function _dataMarketLines() {
  const lines = [];
  try {
    const ecos = await require('../services/ecosService').getEcosRates();
    if (ecos && (ecos.baseRate != null || ecos.mortgageRate != null)) {
      const m = String(ecos.mortgageRateMonth || '').replace(/^(\d{4})(\d{2})$/, '$1.$2');
      const parts = [];
      if (ecos.baseRate != null) parts.push(`한국은행 기준금리 ${ecos.baseRate}%`);
      if (ecos.mortgageRate != null) parts.push(`시중 주담대 평균 ${ecos.mortgageRate}%${m ? ` (${m} 신규취급)` : ''}`);
      lines.push(`💰 ${parts.join(' · ')} — 한국은행 ECOS`);
    }
  } catch (_) {}
  try {
    // KOSIS 시도 합계 행(C2_NM='계') — kosisService 실측 주석 근거. 미존재 시 null → 줄 생략.
    const unsold = await require('../services/kosisService').getUnsoldTrend('서울', '계');
    if (unsold && unsold.latest && Number.isFinite(unsold.latest.cnt)) {
      const ym = String(unsold.latest.ym || '').replace(/^(\d{4})(\d{2})$/, '$1.$2');
      const prev = unsold.months && unsold.months.length >= 2 ? unsold.months[unsold.months.length - 2] : null;
      const diff = prev && Number.isFinite(prev.cnt) ? unsold.latest.cnt - prev.cnt : null;
      lines.push(`🏘 서울 미분양 ${unsold.latest.cnt.toLocaleString()}호${ym ? ` (${ym})` : ''}${diff != null ? ` · 전월 대비 ${diff >= 0 ? '+' : ''}${diff.toLocaleString()}호` : ''} — 국토부 KOSIS`);
    }
  } catch (_) {}
  try {
    const { getSupabaseAdmin } = require('../db/client');
    const admin = getSupabaseAdmin();
    if (admin) {
      const CK = 'news:txlatest';
      let latest = cache.get(CK);
      if (latest === undefined) {
        const { data } = await admin.from('molit_transactions').select('deal_date').order('deal_date', { ascending: false }).limit(1);
        latest = data && data[0] && data[0].deal_date ? String(data[0].deal_date) : null;
        cache.set(CK, latest, 21600);
      }
      lines.push(`🏛 2025.10.15 안정화 대책 · 2026.6.30 규제지역 확대 적용 중${latest ? ` · 실거래 ${latest.slice(0, 7).replace('-', '.')}월분까지 반영` : ''}`);
    }
  } catch (_) {}
  return lines;
}

/**
 * GET /api/news/summary
 * 오늘의 부동산 3줄 시황 (AI 자동 요약)
 * - 핫이슈 뉴스 타이틀 15건 → Claude로 중립적 3줄 요약
 * - 3시간 캐시 (AI 호출 절약)
 * - AI 실패 시 데이터 시황 폴백(mode:'data', 30분 캐시 — 크레딧 복구 시 자동 재개)
 */
router.get('/summary', async (req, res) => {
  const cacheKey = 'news:summary:v2';
  let hit = cache.get(cacheKey);
  // CDN-CACHE-2026-06-14: AI 3줄 시황(전역·비개인화) — 성공 응답만 엣지 캐시(fallback 은 무캐시).
  const SUM_CDN = 'public, max-age=0, s-maxage=1800, stale-while-revalidate=7200';
  // REDIS-CACHE-2026-07-14 (Sprint KKKKK): 전역·비개인화 AI 응답인데 인스턴스 로컬 캐시뿐이라
  //   인스턴스 미스마다 AI 재호출(3h 캐시 무력화) — Redis 2차 조회로 인스턴스 간 공유.
  if (!hit) {
    hit = await require('../services/redisCache').rget(cacheKey);
    if (hit) cache.set(cacheKey, hit, 10800);
  }
  if (hit) { res.set('Cache-Control', SUM_CDN); return res.json({ ...hit, fromCache: true }); }

  // Phase 4 (2026-04-26): Vercel serverless 인스턴스별 cache 분리 문제 fix.
  // `/news?cat=hot` 호출한 인스턴스와 `/news/summary` 호출한 인스턴스가 다르면 cache miss
  // → 사용자가 뉴스 탭 정상 진입 후에도 fallback "준비되지 않았어요" 표시되던 root cause.
  // 해결: cache 우선, 없으면 직접 fetch (lazy chain).
  let hot = cache.get('news:hot');
  let policy = cache.get('news:policy');

  async function _fetchCat(catKey, perKwLimit) {
    const kws = KEYWORDS[catKey] || [];
    try {
      const results = await Promise.all(kws.map(k => fetchNaverNews(k, perKwLimit).catch(() => null)));
      if (results.every(r => r === null)) {
        return { items: await fetchRssFallback(catKey) };
      }
      const seen = new Set();
      const items = [];
      for (const it of results.flat().filter(Boolean)) {
        if (seen.has(it.link)) continue;
        seen.add(it.link);
        items.push(it);
      }
      items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
      return { items: items.slice(0, 15) };
    } catch {
      return { items: [] };
    }
  }

  if (!hot?.items?.length) hot = await _fetchCat('hot', 6);
  if (!policy?.items?.length) policy = await _fetchCat('policy', 4);

  let titles = [];
  [hot, policy].forEach(h => {
    if (h?.items) titles.push(...h.items.slice(0, 8).map(i => i.title));
  });

  if (titles.length === 0) {
    // 뉴스 전체 실패 시에도 공식 통계 시황은 독립적으로 성립
    const dataLines = await _dataMarketLines();
    return res.json({
      summary: dataLines.length ? dataLines : ['📌 뉴스 데이터를 가져오지 못했어요. 잠시 후 다시 시도해주세요.'],
      mode: dataLines.length ? 'data' : undefined,
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
    const result = await callAI([{ role: 'user', content: prompt }], false, { userId: req.user?.id });
    const cleaned = result.content.replace(/```json|```/g, '').trim();
    // Phase 4 (2026-04-26): AI 가 JSON 뒤에 추가 텍스트 붙이는 경우 대응 — 첫 { 부터 마지막 } 까지만 추출.
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
    const _rawLines = Array.isArray(parsed.lines) ? parsed.lines : [];
    // 정책 안전망(절대룰 — 매수·매도 추천 금지): SYS prompt 만으론 100% 차단 불가 → chat/report 와 동일 사후필터 적용
    const _safeLines = _rawLines.map(l => { const f = filterAdviceOutput(l); return f.filtered ? f.text : l; });
    const out = {
      summary: _safeLines,
      updatedAt: new Date().toISOString(),
      disclaimer: '본 시황 요약은 뉴스 헤드라인 기반 정보 정리이며, 매수·매도 추천이 아닙니다.',
    };
    cache.set(cacheKey, out, 10800); // 3시간
    require('../services/redisCache').rset(cacheKey, out, 10800); // Sprint KKKKK — 인스턴스 간 공유
    res.set('Cache-Control', SUM_CDN);
    res.json({ ...out, fromCache: false });
  } catch (e) {
    require('../logger').error({ err: e, source: 'news-summary' }, '뉴스 AI 요약 실패');
    const dataLines = await _dataMarketLines();
    if (dataLines.length) {
      const out = {
        summary: dataLines,
        mode: 'data',
        updatedAt: new Date().toISOString(),
        disclaimer: '본 시황은 공식 통계 수치 정리이며, 매수·매도 추천이 아닙니다.',
      };
      // 30분 캐시 — 실패마다 AI 재시도(비용 0이지만 지연 1s+)하지 않되, 크레딧 복구 시 30분 내 AI 재개
      cache.set(cacheKey, out, 1800);
      require('../services/redisCache').rset(cacheKey, out, 1800);
      return res.json({ ...out, fromCache: false });
    }
    res.json({
      summary: ['📌 오늘 뉴스를 불러왔어요. 상세는 아래 목록을 확인하세요.'],
      updatedAt: new Date().toISOString(),
      fromCache: false,
    });
  }
});

module.exports = router;
