-- 2026-11-15 취득세 기준 재검증 기록 (운영자가 SQL Editor 에서 실행. 2026-11-16 운영자 실행, DB 조회로 반영 확인)
--
-- [왜] 화면 상단 띠에 "취득세 정책은 갱신 검토 중" 경고가 계속 떠 있다. 원인은 regulations_snapshot 의
--   acquisition_tax_2025 행의 source_effective_date(마지막 검증일)가 2026-05-04 로 180일을 넘었기 때문이다
--   (backend/server.js 의 regulations.acquisition_tax.stale = daysSinceEffective > 180, 운영 health 실측 195일).
--
-- [무엇을 검증했나] 2026-11-15 에 국가법령정보센터(law.go.kr) 원문을 크롬으로 직접 열어 확인했다.
--   · 지방세법 [시행 2026. 7. 1.] [법률 제21308호, 2025. 12. 31., 일부개정]
--       제11조 제1항 제8호: 6억원 이하 1천분의 10, 6억원 초과 9억원 이하 (취득당시가액 x 2/3억원 - 3) x 1/100,
--                          9억원 초과 1천분의 30
--       제6조 제19호: 중과기준세율 1천분의 20
--       제13조의2 제1항 제2호: 조정대상지역 1세대 2주택 또는 그 외 지역 1세대 3주택 = 1천분의 40 + 중과기준세율의 100분의 200 (8%)
--       제13조의2 제1항 제3호: 조정대상지역 1세대 3주택 이상 또는 그 외 지역 1세대 4주택 이상 = 1천분의 40 + 중과기준세율의 100분의 400 (12%)
--       제151조 제1항 제1호: 주택 유상거래의 지방교육세 = (해당 세율 x 100분의 50) 의 100분의 20 (취득세의 10%)
--   · 지방세특례제한법 [시행 2026. 6. 2.] [법률 제21738호] 제36조의3: 생애최초, 취득당시가액 12억원 이하,
--       2028년 12월 31일까지, 일반 주택은 산출세액에서 200만원 공제(200만원 이하면 면제)
--   · 농어촌특별세법 [시행 2026. 5. 12.] [법률 제21611호] 제5조 제1항 제6호: 표준세율을 100분의 2로 적용해 산출한 취득세액의 100분의 10
--   → 저장된 값(acquisitionTax tiers, twoHousePlus, eduTaxRate 0.1, spclTaxRate 0.002, firstBuyerExempt)과 어긋나는 것은 없었다.
--
-- [이번에 원문으로 확인하지 못한 것] 같은 행에 들어 있는 중개보수 요율표(공인중개사법 시행규칙 별표 1)와 등기 비용,
--   농어촌특별세 비과세 대상 서민주택의 범위(농어촌특별세법 시행령). 중개보수 요율표는 2026-10-29~30 점검에서 확인한 기록이 있다(저장소 CLAUDE.md).
--
-- [함께 알아 둘 것] 코드의 부대 세금 근사가 법과 다른 곳이 있다(값 저장과는 별개, docs/audit/AUDIT_REPORT_2026-11-14_light.md 16절).
--
-- 실행 전 확인: 대상이 정확히 1행인지 본다.
--   select id, key, source_effective_date, left(note, 80) from public.regulations_snapshot where key = 'acquisition_tax_2025' and valid_to is null;

update public.regulations_snapshot
   set source_effective_date = date '2026-11-15',
       note = coalesce(note, '') || ' | 2026-11-15 재검증(law.go.kr 원문 직접 확인): 지방세법 시행 2026.7.1 제11조1항8호, 제6조19호, 제13조의2, 제151조 / 지방세특례제한법 제36조의3 / 농어촌특별세법 제5조1항6호. 세율과 감면 변동 없음. 중개보수 별표와 농특세 비과세 시행령은 이번에 미확인.'
 where key = 'acquisition_tax_2025'
   and valid_to is null;

-- 실행 뒤 확인: /api/health 의 regulations.acquisition_tax.stale 이 false, daysSince 가 0 근처인지 본다(스냅샷 캐시 600초).
