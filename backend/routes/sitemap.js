/**
 * SITEMAP-DYNAMIC-2026-08-19 (Sprint NNNNNNN-7B): GET /sitemap.xml — 동적 생성.
 *
 * [왜 동적인가] /briefing/:date 아카이브가 매일 1개씩 늘어난다 — 정적 파일(frontend/sitemap.xml,
 * lastmod 2026-05-04 고정)로는 크롤러에 새 페이지를 알릴 수 없다. URL 은 기존과 동일(/sitemap.xml)
 * 이라 Search Console 재등록 불필요.
 *
 * [원칙] DB 조회 실패 시에도 정적 5개 URL 은 항상 반환한다(fail-open) — sitemap 이 500 이면
 * 크롤러가 사이트 전체 재수집을 미룬다.
 */
'use strict';

const express = require('express');
const logger = require('../logger');
const { getSupabaseAdmin } = require('../db/client');
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

router.get('/', async (req, res) => {
  const today = kstDayString();
  const entries = STATIC_URLS.map(u => urlTag(u.loc === '/' ? { ...u, lastmod: today } : u));

  try {
    const admin = getSupabaseAdmin();
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
        logger.warn({ err: error.message }, 'sitemap: briefing 날짜 조회 실패 — 정적 URL 만 반환');
      }
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'sitemap: briefing 날짜 조회 예외 — 정적 URL 만 반환');
  }

  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + entries.join('\n') + '\n'
    + '</urlset>\n';

  res.set('Cache-Control', 'public, max-age=0, s-maxage=21600, stale-while-revalidate=86400');
  res.type('application/xml').send(xml);
});

module.exports = router;
