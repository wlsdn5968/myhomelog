-- ACQ-TAX-FIRSTBUYER-RECORD (사후 기록, 2026-09-02 작성)
--
-- [무엇을 기록하는가]
--   `20260425000004_acquisition_tax_snapshot.sql` 는 생애최초 취득세 항목을 **구법 필드명**
--   `firstBuyerDiscount`(1.5억 이하 0.8% 고정세율)로 시드했다. 그런데 코드가 실제로 읽는 필드는
--   `firstBuyerExempt.deductManwon` 이다(backend/services/analysisService.js · frontend/index.html).
--   운영자가 2026-06-27 에 직접 SQL 로 현행(지방세특례제한법 §36의3, 2026-06-02 시행)으로 고쳤고,
--   그 변경이 저장소에는 남아 있지 않았다.
--
-- [프로덕션 실측 — 2026-09-02]
--   regulations_snapshot.acquisition_tax_2025 → data.acquisitionTax.noHouse.firstBuyerExempt =
--     { eligibleUnderAuk: 12, deductManwon: 200, deductManwonSmall: 300,
--       validUntil: '2028-12-31',
--       note: '생애최초 12억↓ 무주택 거주목적 산출세액 200만원 공제(소형·인구감소지역 300만)·면제 §36의3' }
--   즉 **DB 는 이미 옳고, 파일만 낡아 있었다**. 이 파일은 그 사실을 저장소에 남기기 위한 기록이다.
--
-- [실행해야 하는가]
--   아니다 — 이미 적용돼 있다. 다만 아래 UPDATE 는 **멱등**이라 다시 돌려도 같은 상태가 된다.
--   새 환경을 세울 때만 실행하면 된다(운영자 직접 실행).
--
-- ⚠ 이 저장소의 반복 교훈: "마이그레이션 파일 존재 ≠ 프로덕션 적용" — 그리고 그 반대도 성립한다.
--   파일이 없거나 낡아도 프로덕션은 고쳐져 있을 수 있다. 확정은 `supabase/schema.sql` 스냅샷과
--   pg_catalog 직접 조회로만 한다.

update public.regulations_snapshot
set data = jsonb_set(
      data #- '{acquisitionTax,noHouse,firstBuyerDiscount}',
      '{acquisitionTax,noHouse,firstBuyerExempt}',
      jsonb_build_object(
        'eligibleUnderAuk', 12,
        'deductManwon', 200,
        'deductManwonSmall', 300,
        'validUntil', '2028-12-31',
        'note', '생애최초 12억↓ 무주택 거주목적 산출세액 200만원 공제(소형·인구감소지역 300만)·면제 §36의3'
      ),
      true
    )
where key = 'acquisition_tax_2025'
  and (data #> '{acquisitionTax,noHouse,firstBuyerExempt,deductManwon}') is distinct from to_jsonb(200);
