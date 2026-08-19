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
// NEWS-ZERO-COST-2026-08-16 (Sprint PPPPPPP): 3줄 시황의 Anthropic 유료 호출을 **구조적으로 제거**했다.
//   callAI / filterAdviceOutput import 도 함께 삭제 — 재유입은 scripts/security-regression-check.js 가 차단.
//   (필터는 AI 생성문 전용 사후 안전망이었다. 이제 시황 문구는 우리가 조립한 사실 서술뿐이라 대상이 없다.)

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
// REG-STRUCT-2026-08-19 (Sprint NNNNNNN-15): 시황을 구조화(text·src·date) — 시안의 출처·기준일 캡션 분리 렌더용.
//   문자열 버전은 _deriveMarketLines 로 파생(바이트 동일 — 구 스냅샷·캐시·아카이브와 호환, 사본 금지).
function _deriveMarketLines(items) {
  return (items || []).map(it => (it.srcInline ? `${it.text} — ${it.src}` : it.text));
}
async function _dataMarketItems() {
  const items = [];
  try {
    const ecos = await require('../services/ecosService').getEcosRates();
    if (ecos && (ecos.baseRate != null || ecos.mortgageRate != null)) {
      const m = String(ecos.mortgageRateMonth || '').replace(/^(\d{4})(\d{2})$/, '$1.$2');
      const parts = [];
      if (ecos.baseRate != null) parts.push(`한국은행 기준금리 ${ecos.baseRate}%`);
      if (ecos.mortgageRate != null) parts.push(`시중 주담대 평균 ${ecos.mortgageRate}%${m ? ` (${m} 신규취급)` : ''}`);
      items.push({ text: `💰 ${parts.join(' · ')}`, src: '한국은행 ECOS', date: m || null, srcInline: true });
    }
  } catch (_) {}
  try {
    // KOSIS 시도 합계 행(C2_NM='계') — kosisService 실측 주석 근거. 미존재 시 null → 줄 생략.
    const unsold = await require('../services/kosisService').getUnsoldTrend('서울', '계');
    if (unsold && unsold.latest && Number.isFinite(unsold.latest.cnt)) {
      const ym = String(unsold.latest.ym || '').replace(/^(\d{4})(\d{2})$/, '$1.$2');
      const prev = unsold.months && unsold.months.length >= 2 ? unsold.months[unsold.months.length - 2] : null;
      const diff = prev && Number.isFinite(prev.cnt) ? unsold.latest.cnt - prev.cnt : null;
      items.push({ text: `🏘 서울 미분양 ${unsold.latest.cnt.toLocaleString()}호${ym ? ` (${ym})` : ''}${diff != null ? ` · 전월 대비 ${diff >= 0 ? '+' : ''}${diff.toLocaleString()}호` : ''}`, src: '국토부 KOSIS', date: ym || null, srcInline: true });
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
      // 종전 문자열엔 출처 표기가 없던 라인 — 구조화로 처음 출처가 생긴다(srcInline:false 라 문자열은 불변).
      items.push({ text: `🏛 2025.10.15 안정화 대책 · 2026.6.30 규제지역 확대 적용 중${latest ? ` · 실거래 ${latest.slice(0, 7).replace('-', '.')}월분까지 반영` : ''}`, src: '금융위·국토부 고시', date: latest ? latest.slice(0, 7).replace('-', '.') : null, srcInline: false });
    }
  } catch (_) {}
  return items;
}
async function _dataMarketLines() {
  return _deriveMarketLines(await _dataMarketItems());
}

/**
 * GET /api/news/summary
 * 오늘의 부동산 3줄 시황 — **공식 통계 기반 자동 정리** (AI 생성 아님)
 *
 * NEWS-ZERO-COST-2026-08-16 (Sprint PPPPPPP) — NODE-7(유료 크레딧 소진 400) 의 마지막 활성 유입구.
 *   [실측] Sentry NODE-7 (28일·21건) 을 transaction 별로 분해하니, 오늘 배포(00:42Z) **이후에도
 *   발생한 경로는 이 엔드포인트 하나**였다(08-16 01:26Z). 나머지 유입구는 이미 닫혔거나(chat 08-12
 *   룰베이스 전환·regulations cron 오늘 제거) 사용자가 직접 누르는 경로(clause·report)다.
 *   [원인] 크레딧 0 → callAI 가 400 으로 **100% 실패** → catch 의 데이터 폴백이 사실상 주 경로였다.
 *   즉 이 AI 호출은 28일 동안 지연(+1s 대기)과 Sentry 노이즈만 만들었고 사용자 화면에 닿은 적이 없다.
 *   [조치] 폴백을 **주 경로로 승격**하고 유료 호출을 삭제한다. 사용자 화면은 종전과 동일하다 —
 *   프론트는 Sprint RRRRR 이후 이미 mode:'data' 문구("공식 통계 기반 자동 정리")를 그리고 있었다.
 *   [부수 이득] 헤드라인 수집(_fetchCat 2회 = 외부 최대 7콜)은 요약에 더는 기여하지 않아 함께 제거.
 *   뉴스 탭 첫 진입이 그만큼 빨라진다. 목록 API(GET /news)는 불변이라 헤드라인 자체는 종전대로 보인다.
 *   ⚠ 절대룰② 정합: 헤드라인 기반 생성 요약은 원문에 없는 서술이 섞일 여지가 있었다.
 *   ECOS·KOSIS·실거래는 공식 수치를 그대로 인용하므로 그 위험이 구조적으로 없다.
 *   ⚠ 캐시 키를 v3 로 올린다 — v2 에 남은 구 스키마(mode 없음)가 서빙되면 프론트가 'AI 요약' 문구를
 *   그린다(TTL 만료까지 최대 3h). 키를 바꾸는 것이 확실하다.
 */
router.get('/summary', async (req, res) => {
  const cacheKey = 'news:summary:v4'; // REG-STRUCT: items 필드 추가로 스키마 변경
  // CDN-CACHE-2026-06-14 → NEWS-ZERO-COST: 데이터 시황이 이제 정상 응답이므로 엣지 캐시 대상이다
  //   (종전엔 "AI 성공본만" 캐시하고 폴백은 무캐시였다 — 폴백이 주 경로가 된 지금은 반대가 맞다).
  const SUM_CDN = 'public, max-age=0, s-maxage=1800, stale-while-revalidate=7200';
  let hit = cache.get(cacheKey);
  // REDIS-CACHE-2026-07-14 (Sprint KKKKK): 전역·비개인화 응답인데 인스턴스 로컬 캐시뿐이면
  //   인스턴스 미스마다 외부 API(ECOS·KOSIS) 재조회 → Redis 2차 조회로 인스턴스 간 공유.
  if (!hit) {
    hit = await require('../services/redisCache').rget(cacheKey);
    if (hit) cache.set(cacheKey, hit, 1800);
  }
  if (hit) { res.set('Cache-Control', SUM_CDN); return res.json({ ...hit, fromCache: true }); }

  const dataItems = await _dataMarketItems();
  const dataLines = _deriveMarketLines(dataItems);
  if (dataLines.length) {
    const out = {
      summary: dataLines,
      items: dataItems, // REG-STRUCT: 출처·기준일 분리 렌더용(프론트가 있으면 우선 사용)
      mode: 'data',
      updatedAt: new Date().toISOString(),
      disclaimer: '본 시황은 공식 통계 수치 정리이며, 매수·매도 추천이 아닙니다.',
    };
    cache.set(cacheKey, out, 1800);
    require('../services/redisCache').rset(cacheKey, out, 1800);
    res.set('Cache-Control', SUM_CDN);
    return res.json({ ...out, fromCache: false });
  }
  // 외부 통계 3종이 모두 실패한 경우 — 캐시하지 않는다(다음 요청서 재시도).
  res.json({
    summary: ['📌 오늘 뉴스를 불러왔어요. 상세는 아래 목록을 확인하세요.'],
    updatedAt: new Date().toISOString(),
    fromCache: false,
  });
});

module.exports = router;
// BRIEFING-ARCHIVE-2026-08-19 (Sprint NNNNNNN-6): briefingService 가 3줄 시황 생성기를
// 재사용한다(사본 금지 — 사본이 조용히 갈라지는 사고를 반복 겪은 레포다). 라우터 속성으로 노출.
module.exports._dataMarketLines = _dataMarketLines;
module.exports._dataMarketItems = _dataMarketItems;
module.exports._deriveMarketLines = _deriveMarketLines;
