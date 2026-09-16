/**
 * SITEMAP-DYNAMIC-2026-08-19 (Sprint NNNNNNN-7B): GET /sitemap.xml — 동적 생성.
 *
 * [왜 동적인가] /briefing/:date 아카이브가 매일 1개씩 늘어난다 — 정적 파일(frontend/sitemap.xml,
 * lastmod 2026-05-04 고정)로는 크롤러에 새 페이지를 알릴 수 없다. URL 은 기존과 동일(/sitemap.xml)
 * 이라 Search Console 재등록 불필요.
 *
 * [원칙] DB 조회 실패 시에도 정적 5개 URL 은 항상 반환한다(fail-open) — sitemap 이 500 이면
 * 크롤러가 사이트 전체 재수집을 미룬다.
 *
 * SITEMAP-INDEX-SPLIT-2026-09-16 (Plan 087): Search Console 은 사이트맵 파일 단위로 커버리지를
 * 보여주는데, 기존엔 정적·지역·브리핑·단지가 한 urlset(16,625 URL)에 섞여 있어 유형별 색인률을
 * 볼 수 없었다. 이 라우트는 이제 <sitemapindex> 만 반환하고(DB 조회 없음 → 항상 6시간 캐시),
 * 실제 URL 목록은 backend/routes/sitemaps.js 의 유형별 라우트
 * (/sitemaps/{static,region,briefing,apt}.xml)가 낸다. 블록별 로직(조건·필터·상한·로그 문구)은
 * 그대로 이 파일의 빌더 함수로 옮겼다(module.exports._builders 로 공유).
 */
'use strict';

const express = require('express');
const logger = require('../logger');
const { kstDayString } = require('../services/briefingService');
const router = express.Router();

const ORIGIN = 'https://myhomelog.vercel.app';

// 정적 페이지 — 구 frontend/sitemap.xml 의 5개 항목 그대로(법적 문서 lastmod 는 실제 변경일 유지)
const STATIC_URLS = [
  { loc: '/', changefreq: 'daily', priority: '1.0' }, // lastmod 는 렌더 시점의 오늘(브리핑이 매일 갱신)
  { loc: '/billing', lastmod: '2026-05-04', changefreq: 'weekly', priority: '0.6' },
  { loc: '/terms.html', lastmod: '2026-05-04', changefreq: 'monthly', priority: '0.3' },
  { loc: '/privacy.html', lastmod: '2026-05-04', changefreq: 'monthly', priority: '0.3' },
  { loc: '/refund.html', lastmod: '2026-05-04', changefreq: 'monthly', priority: '0.3' },
];

function urlTag({ loc, lastmod, changefreq, priority }) {
  return '  <url>\n'
    + `    <loc>${ORIGIN}${loc}</loc>\n`
    + (lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : '')
    + (changefreq ? `    <changefreq>${changefreq}</changefreq>\n` : '')
    + (priority ? `    <priority>${priority}</priority>\n` : '')
    + '  </url>';
}

function buildStaticEntries(today) {
  return STATIC_URLS.map(u => urlTag(u.loc === '/' ? { ...u, lastmod: today } : u));
}

// REGION-PAGE-2026-08-29 (Sprint NNNNNNN-31): 지역 페이지 118개 + 허브 1개.
//   이 sitemap 이 16개 URL 뿐이던 것이 유입 0 의 직접 원인이었다(실측).
//   목록은 LAWD_CODES 에서 파생한다 — DB 조회가 없어 실패 경로가 없다(항상 나간다).
function buildRegionEntries(today) {
  const entries = [];
  let degraded = false;
  try {
    const { LAWD_CODES } = require('../services/transactionService');
    const codes = [...new Set(Object.values(LAWD_CODES).map(String))].sort();
    entries.push(urlTag({ loc: '/region', lastmod: today, changefreq: 'weekly', priority: '0.8' }));
    for (const c of codes) {
      if (!/^\d{5}$/.test(c)) continue;
      entries.push(urlTag({ loc: `/region/${c}`, lastmod: today, changefreq: 'daily', priority: '0.7' }));
    }
  } catch (e) {
    degraded = true;
    logger.warn({ err: e.message }, 'sitemap: 지역 URL 생성 실패 — 나머지는 정상 반환');
  }
  return { entries, degraded };
}

async function buildBriefingEntries(admin) {
  const entries = [];
  let degraded = false;
  try {
    if (admin) {
      // ⚠ PostgREST 는 1000행에서 조용히 잘린다(레포 6회 재발) — 명시 limit + 최신순.
      //   1일 1행이라 1000행 = 약 2.7년치. 그때가 오면 sitemap index 분할이 필요하다.
      const { data, error } = await admin
        .from('briefing_snapshots')
        .select('day')
        .order('day', { ascending: false })
        .limit(1000);
      if (!error && Array.isArray(data)) {
        for (const row of data) {
          const day = String(row.day || '').slice(0, 10);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue; // 형식 밖 값은 sitemap 오염 방지 차원에서 제외
          // 과거 브리핑은 불변 기록 — lastmod = 그날, changefreq 생략(힌트 무의미)
          entries.push(urlTag({ loc: `/briefing/${day}`, lastmod: day, priority: '0.5' }));
        }
      } else if (error) {
        degraded = true;
        logger.warn({ err: error.message }, 'sitemap: briefing 날짜 조회 실패 — 정적 URL 만 반환');
      }
    }
  } catch (e) {
    degraded = true;
    logger.warn({ err: e.message }, 'sitemap: briefing 날짜 조회 예외 — 정적 URL 만 반환');
  }
  return { entries, degraded };
}

// APT-PAGE-2026-08-29 (Sprint NNNNNNN-32): 단지 페이지.
//   [문턱 — 실측] 거래 3건 이상 + 최근 1년 = 15,954개(전체 22,473 중). 1~2건짜리는 통계가 아니라
//   잡음이고(TRUST 게이트와 같은 원칙), 얇은 페이지를 대량 색인시키면 사이트 전체 평가에 해롭다.
//   ⚠ PostgREST 는 1000행에서 조용히 잘린다(레포 6회 재발) — **range 페이징**으로만 넘을 수 있다
//     (선례: transactionService.getRegionRecentTransactions · geocacheBackfill).
//     2차 정렬키(apt_seq)로 페이지 경계 중복·누락을 막는다.
async function buildAptEntries(admin, today) {
  const entries = [];
  let degraded = false;
  try {
    if (admin) {
      const since = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
      const PAGE = 1000;
      const MAX_PAGES = 40; // 40,000개 상한 — sitemap 1파일 한도(50,000) 안. 넘으면 경고하고 분할 검토.
      let added = 0;
      for (let p = 0; p < MAX_PAGES; p++) {
        const { data, error } = await admin
          .from('molit_apt_index')
          .select('apt_seq, recent_deal_date')
          .gte('deal_count', 3)
          .gte('recent_deal_date', since)
          .order('recent_deal_date', { ascending: false })
          .order('apt_seq', { ascending: false })
          .range(p * PAGE, p * PAGE + PAGE - 1);
        if (error) throw error;
        const rows = data || [];
        for (const r of rows) {
          const seq = String(r.apt_seq || '');
          if (!/^\d{5}-\d+$/.test(seq)) continue; // 형식 밖은 sitemap 오염 방지 차원에서 제외
          const lm = String(r.recent_deal_date || '').slice(0, 10);
          entries.push(urlTag({ loc: `/apt/${seq}`, lastmod: /^\d{4}-\d{2}-\d{2}$/.test(lm) ? lm : today, priority: '0.6' }));
          added++;
        }
        if (rows.length < PAGE) break;
        if (p === MAX_PAGES - 1) logger.warn({ added }, 'sitemap: 단지 URL 이 페이지 상한에 닿음 — sitemap index 분할 검토');
      }
    }
  } catch (e) {
    // 실패해도 나머지 URL 은 그대로 나간다(fail-open) — sitemap 이 500 이면 크롤러가 재수집을 미룬다.
    degraded = true;
    logger.warn({ err: e.message }, 'sitemap: 단지 URL 생성 실패 — 나머지는 정상 반환');
  }
  return { entries, degraded };
}

function wrapUrlset(entries) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + entries.join('\n') + '\n'
    + '</urlset>\n';
}

function wrapIndex(items) {
  const body = items.map(({ loc, lastmod }) => (
    '  <sitemap>\n'
    + `    <loc>${loc}</loc>\n`
    + `    <lastmod>${lastmod}</lastmod>\n`
    + '  </sitemap>'
  )).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + body + '\n'
    + '</sitemapindex>\n';
}

const CACHE_OK = 'public, max-age=0, s-maxage=21600, stale-while-revalidate=86400';

router.get('/', (req, res) => {
  const today = kstDayString();
  const items = ['static', 'region', 'briefing', 'apt'].map(name => ({
    loc: `${ORIGIN}/sitemaps/${name}.xml`,
    lastmod: today,
  }));
  // 인덱스는 DB 를 조회하지 않는다 — 항상 6시간 캐시(열화 분기 없음).
  res.set('Cache-Control', CACHE_OK);
  res.type('application/xml').send(wrapIndex(items));
});

module.exports = router;
module.exports._builders = {
  buildStaticEntries, buildRegionEntries, buildBriefingEntries, buildAptEntries, wrapUrlset, CACHE_OK,
};
