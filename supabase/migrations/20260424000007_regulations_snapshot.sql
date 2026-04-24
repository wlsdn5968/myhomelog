-- regulations_snapshot: 정부 규제 정보의 버전 관리 저장소
--
-- 왜 JSONB 테이블인가:
--   1) 규제는 연 1~2회 큰 변경 (2025.10.15 같은 시행일) — 이력 보관 필요.
--   2) 과거 계산 재현성 — "A가 2025.11에 계산한 대출 한도" 검증 시
--      당시 유효하던 스냅샷으로 재계산 가능.
--   3) LTV table·DSR 룰 구조가 nested·dynamic → JSONB 로 스키마 flexibility.
--   4) 코드 하드코딩은 변경 시 재배포 필요 → DB 값으로 **무중단 갱신** 가능.
--
-- 조회 패턴:
--   SELECT data FROM regulations_snapshot
--   WHERE key = 'housing_loan_2025' AND valid_from <= now()
--         AND (valid_to IS NULL OR valid_to > now())
--   ORDER BY valid_from DESC LIMIT 1;

CREATE TABLE IF NOT EXISTS regulations_snapshot (
  id          BIGSERIAL PRIMARY KEY,
  key         TEXT NOT NULL,             -- 'housing_loan_2025', 'regulated_regions' 등
  valid_from  TIMESTAMPTZ NOT NULL,      -- 시행일 (정부 고시일)
  valid_to    TIMESTAMPTZ,               -- NULL = 현재 유효 / 차기 개정 시 UPDATE
  data        JSONB NOT NULL,
  source_url  TEXT,                      -- 금융위 보도자료 URL 등 근거
  source_effective_date DATE,            -- 실제 정부 고시 날짜 (2025-10-15 등)
  note        TEXT,                      -- 개정 요지 한 줄 요약
  created_at  TIMESTAMPTZ DEFAULT now(),
  created_by  TEXT                       -- 운영자 email / 'seed' / 'import-script'
);

-- 최신 유효 스냅샷 고속 조회용 (key 별 최신 valid_from)
CREATE INDEX IF NOT EXISTS idx_reg_snapshot_key_valid
  ON regulations_snapshot (key, valid_from DESC);

-- RLS: 공개 읽기 (규제 정보는 비밀이 아님), 쓰기는 service_role 만.
ALTER TABLE regulations_snapshot ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reg_snapshot_public_read" ON regulations_snapshot;
CREATE POLICY "reg_snapshot_public_read"
  ON regulations_snapshot FOR SELECT
  USING (true);

-- ── 초기 시드: 2025.10.15 시행 housing_loan_2025 ──────────────
-- 기존 backend/routes/regulations.js 의 REGULATIONS 객체와 **동일한 구조**
-- (application layer 가 DB 응답을 그대로 프록시 가능).
INSERT INTO regulations_snapshot (key, valid_from, data, source_url, source_effective_date, note, created_by)
VALUES (
  'housing_loan_2025',
  '2025-10-15 00:00:00+09',
  jsonb_build_object(
    'lastUpdated', '2025-10-16',
    'source', '금융위원회 2025.10.15 주택시장 안정화 대책',
    'sourceUrl', 'https://fsc.go.kr',
    'regulatedRegions', jsonb_build_object(
      'seoul', '서울 전 지역 (25개 구)',
      'gyeonggi', jsonb_build_array(
        '과천시','광명시','성남시 분당구','성남시 수정구','성남시 중원구',
        '수원시 영통구','수원시 장안구','수원시 팔달구','안양시 동안구',
        '용인시 수지구','의왕시','하남시'
      )
    ),
    'ltvTable', jsonb_build_array(
      jsonb_build_object('condition','무주택 — 규제지역','ltv',40,'cap',jsonb_build_array(
        jsonb_build_object('under',15,'max',6),
        jsonb_build_object('under',25,'max',4),
        jsonb_build_object('over',25,'max',2)
      )),
      jsonb_build_object('condition','생애최초 — 규제지역','ltv',70,'cap',jsonb_build_array(
        jsonb_build_object('under',999,'max',6)
      ),'note','6개월 이내 전입 의무'),
      jsonb_build_object('condition','무주택 — 비규제','ltv',70,'cap',null),
      jsonb_build_object('condition','생애최초 — 비규제','ltv',80,'cap',null),
      jsonb_build_object('condition','지방 생애최초','ltv',80,'cap',null),
      jsonb_build_object('condition','1주택 추가 매수 (규제)','ltv',0,'cap',null,'note','처분조건부 6개월 시 무주택 동일'),
      jsonb_build_object('condition','2주택 이상','ltv',0,'cap',null,'note','규제지역·수도권 구입 불가')
    ),
    'dsrRules', jsonb_build_object(
      'bankDSR', 40,
      'secondFinanceDSR', 50,
      'stressDSRMetro', 1.5,
      'stressDSRLocal', 0.75,
      'stressFloorMetroRegulated', 3.0,
      'maxTerm', 30,
      'threshold', 100000000
    ),
    'additionalRules', jsonb_build_array(
      '전세대출 보유자: 규제지역 3억 초과 아파트 취득 시 전세대출 즉시 회수',
      '신용대출 1억 초과 보유자: 대출 실행 후 1년간 규제지역 주택 구입 제한',
      '1주택자 전세대출 이자: DSR 반영 (2025.10.29~)',
      '토지거래허가구역: 취득 후 2년 실거주 의무, 갭투자 금지',
      '전세보증 비율: 수도권 80% (기존 90% → 강화)',
      '은행권 주담대 위험가중치: 15% → 20% (2026.1월~)'
    ),
    'disclaimer', '규제는 수시 변경됩니다. 최종 대출 가능 여부는 금융기관에서 반드시 확인하세요.'
  ),
  'https://fsc.go.kr',
  '2025-10-15',
  '2025.10.15 금융위 주택시장 안정화 대책 시행',
  'seed'
)
ON CONFLICT DO NOTHING;
