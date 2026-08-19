/**
 * GET /api/regulations — 현행 대출 규제 정보
 *
 * Phase 5.3 (4.14): 하드코딩 → regulations_snapshot 테이블 조회
 *   - DB 에 최신 row 삽입하면 재배포 없이 갱신
 *   - DB 장애 시 regulationsService 의 FALLBACK 으로 폴백
 */
const express = require('express');
const router = express.Router();
const { getSnapshot } = require('../services/regulationsService');

router.get('/', async (req, res) => {
  // P1 (2026-04-25): housing_loan + acquisition_tax 동시 반환
  // 프론트가 부팅 시 1회 fetch 로 두 정보 모두 캐시 (LTV 매칭 + calcTotalCost 모두 사용)
  const [housing, tax] = await Promise.all([
    getSnapshot('housing_loan_2025'),
    getSnapshot('acquisition_tax_2025').catch(() => ({ data: null, source: 'missing' })),
  ]);
  // CDN-CACHE-2026-06-14: 규제정보는 정책변경 시에만 갱신(드묾)인데 매 부팅 fetch(loadRegulatedKeywords) → 엣지 캐시 효과 큼.
  res.set('Cache-Control', 'public, max-age=0, s-maxage=1800, stale-while-revalidate=86400');
  res.json({
    ...housing.data,
    tax: tax.data || null,
    _meta: {
      source: housing.source,
      validFrom: housing.validFrom,
      taxSource: tax.source,
    },
  });
});

router.get('/ltv', async (req, res) => {
  const snap = await getSnapshot('housing_loan_2025');
  res.set('Cache-Control', 'public, max-age=0, s-maxage=1800, stale-while-revalidate=86400');
  res.json({
    ltvTable: snap.data.ltvTable,
    lastUpdated: snap.data.lastUpdated,
    _meta: { source: snap.source, validFrom: snap.validFrom },
  });
});

// REG-LOG-2026-08-19 (Sprint NNNNNNN-12): 규정 변동 로그 — regulations_snapshot 버전 체인을 그대로 노출.
// [사실 관계] valid_from = 시행일, source_effective_date = 출처 확인일(검증일) — 둘을 혼동하지 않는다.
// 스냅샷 신규 행은 운영자 수동 검증 후에만 삽입되는 구조(자동 반영 금지 설계)라, 이 로그의 모든
// 행은 검증된 규정 이벤트다. note 의 '/' 뒤는 내부 검증 메모라 사용자 응답에서 제거.
const _regLogCache = require('../cache');
router.get('/log', async (req, res) => {
  const CK = 'reg:log:v1';
  const hit = _regLogCache.get(CK);
  res.set('Cache-Control', 'public, max-age=0, s-maxage=21600, stale-while-revalidate=86400');
  if (hit) return res.json(hit);
  try {
    const { getSupabaseAdmin } = require('../db/client');
    const admin = getSupabaseAdmin();
    if (!admin) return res.json({ items: [] });
    const { data, error } = await admin
      .from('regulations_snapshot')
      .select('key, valid_from, valid_to, source_effective_date, note, source_url')
      .order('valid_from', { ascending: false })
      .limit(50);
    if (error) throw error;
    const KEY_LABEL = { housing_loan_2025: '대출·규제지역', acquisition_tax_2025: '취득세·거래비용' };
    const items = (data || []).map(r => ({
      key: r.key,
      tag: KEY_LABEL[r.key] || r.key,
      effectiveFrom: r.valid_from ? String(r.valid_from).slice(0, 10) : null,
      supersededAt: r.valid_to ? String(r.valid_to).slice(0, 10) : null,
      verifiedAt: r.source_effective_date || null,
      note: r.note ? String(r.note).split('/')[0].trim() : null,
      sourceUrl: r.source_url || null,
    }));
    const out = { items };
    _regLogCache.set(CK, out, 21600);
    return res.json(out);
  } catch (e) {
    require('../logger').warn({ err: e.message }, 'regulations/log 조회 실패');
    return res.json({ items: [] });
  }
});

module.exports = router;
