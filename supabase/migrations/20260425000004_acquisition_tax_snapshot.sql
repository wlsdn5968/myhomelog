-- ============================================================================
-- 세제 스냅샷 — acquisition_tax_2025
--
-- 왜 필요한가:
--   - 취득세·복비·등기비는 매년 변경 (예: 2024 생애최초 감면 한도, 2025 다주택 중과)
--   - 기존: backend analysisService.calcTotalCost + frontend calcTotalCostHTML 모두
--           rate/threshold 하드코딩 → 변경 시 재배포 + 수정 누락 위험
--   - 개선: regulations_snapshot 패턴 그대로 재사용 → migration 1개로 모든 환경 갱신
--
-- 데이터 출처:
--   - 지방세법 제11조 (주택 취득세율)
--   - 「공인중개사법 시행규칙」 별표1 (중개 수수료 상한)
--   - 행정안전부 지방세 운영지침 (2025년 기준)
--
-- 적용 패턴:
--   1) GET /api/regulations 응답에 tax 필드로 동봉 (frontend 부팅 시 1회 fetch)
--   2) backend analysisService.calcTotalCost(price, loan, house, isFirst, taxConfig)
--      — taxConfig 없으면 하드코딩 fallback (backwards-compat)
--   3) frontend window.__TAX_CONFIG 캐시 → calcTotalCostHTML 에서 사용
--
-- 향후 변경 시:
--   - 새 valid_from 으로 INSERT (이전 row 의 valid_to 자동 채워지진 않음 — 운영자 수동)
--   - 또는 새 key 'acquisition_tax_2026' 식으로 분리
-- ============================================================================

INSERT INTO regulations_snapshot (key, valid_from, data, source_url, source_effective_date, note, created_by)
VALUES (
  'acquisition_tax_2025',
  '2025-01-01 00:00:00+09',
  jsonb_build_object(
    'lastUpdated', '2026-04-25',
    'source', '지방세법 제11조 + 공인중개사법 시행규칙 별표1',
    'sourceUrl', 'https://www.law.go.kr/법령/지방세법',
    -- 취득세 — 주택 보유 상태별 (rate 는 소수, 0.01 = 1%)
    'acquisitionTax', jsonb_build_object(
      'noHouse', jsonb_build_object(
        'firstBuyerDiscount', jsonb_build_object(
          'underAuk', 1.5,
          'rate', 0.008,
          'note', '생애최초 1.5억 이하 50% 감면'
        ),
        'tiers', jsonb_build_array(
          jsonb_build_object('underAuk', 6, 'rate', 0.01),
          jsonb_build_object('underAuk', 9, 'rate', 0.02),
          jsonb_build_object('underAuk', 999, 'rate', 0.03)
        )
      ),
      'oneHouse', jsonb_build_object(
        'tiers', jsonb_build_array(
          jsonb_build_object('underAuk', 6, 'rate', 0.01),
          jsonb_build_object('underAuk', 9, 'rate', 0.02),
          jsonb_build_object('underAuk', 999, 'rate', 0.03)
        )
      ),
      'twoHousePlus', jsonb_build_object(
        'rate', 0.08,
        'note', '조정대상지역 다주택 중과 8% (지방세법 시행령 제22조의2)'
      )
    ),
    -- 부속세
    'eduTaxRate',       0.1,    -- 지방교육세 = 취득세의 10%
    'spclTaxRate',      0.002,  -- 농어촌특별세 = 매매가의 0.2%
    'spclTaxThreshold', 0.01,   -- rate <= 0.01 (1주택 6억 이하 등) 이면 면제
    -- 중개 수수료 (공인중개사법 시행규칙 별표1, 매매)
    'commission', jsonb_build_array(
      jsonb_build_object('underAuk', 0.5, 'rate', 0.006),
      jsonb_build_object('underAuk', 2,   'rate', 0.005),
      jsonb_build_object('underAuk', 9,   'rate', 0.004),
      jsonb_build_object('underAuk', 12,  'rate', 0.005),
      jsonb_build_object('underAuk', 15,  'rate', 0.006),
      jsonb_build_object('underAuk', 999, 'rate', 0.007)
    ),
    -- 등기비 (법무사 + 등록면허세 추정)
    'regFee', jsonb_build_object(
      'rate', 0.0015,
      'baseManwon', 20,
      'note', '약 0.15% + 기본 20만원. 실제는 법무사·지역에 따라 ±50만원 변동'
    ),
    -- 사용자 노출용 면책
    'disclaimer', '취득세·복비·등기비는 매년 변경되며, 본 계산은 추정치입니다. 실제 비용은 ±1,500만원 이상 차이 가능. 최종 금액은 세무사·법무사 확인 필수.'
  ),
  'https://www.law.go.kr/법령/지방세법',
  '2025-01-01',
  '2025년 지방세법 기준 취득세·복비·등기비 스냅샷',
  'seed'
)
ON CONFLICT DO NOTHING;
