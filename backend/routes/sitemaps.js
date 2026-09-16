/**
 * SITEMAP-INDEX-SPLIT-2026-09-16 (Plan 087): 유형별 sitemap — /sitemap.xml 인덱스가 가리키는 4개 파일.
 * 빌더 함수(조건·필터·상한·로그 문구)는 전부 routes/sitemap.js 의 module.exports._builders 를 그대로 쓴다
 * — 유형 간 실패 격리(한 유형이 실패해도 다른 유형 파일에는 영향 없음, fail-open 은 유형 내부에서 유지).
 */
'use strict';
const express = require('express');
const { getSupabaseAdmin } = require('../db/client');
const { kstDayString } = require('../services/briefingService');
const { _builders: B } = require('./sitemap');
const router = express.Router();
function send(res, { entries, degraded }) {
  res.set('Cache-Control', degraded ? 'no-store' : B.CACHE_OK);
  res.type('application/xml').send(B.wrapUrlset(entries));
}
router.get('/static.xml', (req, res) => send(res, { entries: B.buildStaticEntries(kstDayString()), degraded: false }));
router.get('/region.xml', (req, res) => send(res, B.buildRegionEntries(kstDayString())));
router.get('/briefing.xml', async (req, res) => send(res, await B.buildBriefingEntries(getSupabaseAdmin())));
router.get('/apt.xml', async (req, res) => send(res, await B.buildAptEntries(getSupabaseAdmin(), kstDayString())));
module.exports = router;
