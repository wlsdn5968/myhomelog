/**
 * 정부 공식 법령 API (Sprint RR, 2026-05-19)
 *
 * 출처: 9bow/legalize-kr (MIT + 공공저작물, 국가법령정보센터 OpenAPI 원천)
 * 인증 불필요 — 공개 법령 정보
 *
 * Endpoints:
 *   GET /api/legal/laws            — 부동산 핵심 법령 리스트 (메타만)
 *   GET /api/legal/laws/:slug      — 단건 법령 fetch (frontmatter + body)
 *   GET /api/legal/search?q=...    — 키워드 검색 (모든 법령 body 스캔)
 */
const express = require('express');
const router = express.Router();
const { getLaw, listLaws, searchLaws, REAL_ESTATE_LAWS, FILE_TYPES } = require('../services/legalCorpusService');
const logger = require('../logger');

// 모든 법령 목록 (메타만, fetch 0)
router.get('/laws', (req, res) => {
  res.json({
    laws: listLaws(),
    fileTypes: FILE_TYPES,
    source: '9bow/legalize-kr (MIT) ← 국가법령정보센터 OpenAPI',
    note: '법령 원문은 공공저작물 (자유 이용). 본 서비스는 정보 정리 도구이며, 법적 자문이 아닙니다.',
  });
});

// 단건 법령 fetch
router.get('/laws/:slug', async (req, res) => {
  const { slug } = req.params;
  const fileType = String(req.query.fileType || '법률');
  try {
    const law = await getLaw(slug, fileType);
    if (!law) return res.status(404).json({ error: '법령 또는 파일타입 미발견', slug, fileType });
    res.json(law);
  } catch (e) {
    logger.warn({ err: e.message, slug, fileType }, 'legal getLaw 실패');
    res.status(500).json({ error: '법령 조회 실패' });
  }
});

// 키워드 검색
router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.status(400).json({ error: '검색어는 2글자 이상' });
  const maxResults = Math.min(parseInt(req.query.max) || 5, 10);
  try {
    const results = await searchLaws(q, maxResults);
    res.json({
      query: q,
      count: results.length,
      results,
      note: '본 검색은 정보 정리 도구. 법적 효력은 국가법령정보센터(law.go.kr) 원본 기준.',
    });
  } catch (e) {
    logger.warn({ err: e.message, q }, 'legal search 실패');
    res.status(500).json({ error: '법령 검색 실패' });
  }
});

module.exports = router;
