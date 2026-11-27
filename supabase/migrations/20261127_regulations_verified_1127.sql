-- 20261127_regulations_verified_1127.sql
-- 운영자 실행용(운영 DB 는 운영자가 SQL Editor 에서 실행한다). 작성 2026-11-27 KST 정기 점검.
--
-- 무엇을: regulations_snapshot 두 행의 검증일(source_effective_date)을 2026-11-27 로 올린다. 저장값(data)은 바꾸지 않는다. note 끝에 이번 대조 한 문단을 붙인다.
--   housing_loan_2025: 2026-11-19 -> 2026-11-27
--   acquisition_tax_2025: 2026-11-15 -> 2026-11-27
-- 왜: 정책 감지 대기 수(pendingReview)가 8 이었다(health 2026-11-26 21:55 UTC 회차, 소스 실패 0/4). 원문을 대조했고 저장값을 바꾸는 발표가 없었다.
--
-- 대조 범위와 근거(AUDIT_REPORT.md 19절에 같은 내용):
--   네 기관(금융위원회, 국토교통부, 재정경제부, 국세청) 보도자료 목록에서 2026-11-19 ~ 2026-11-27 글 전부(낱말로 거르지 않음).
--   금융위원회 27건 가운데 20건 본문 확인: 주택담보, 주담대, LTV, DSR, 스트레스, 가계부채, 규제지역, 전세대출 낱말 0.
--     11-26 「건전성 규제, 금융 공급, 연체채권 관리체계…」는 "대출" 35회가 모두 신용대출과 포용 온렌딩(직접 확인).
--   국토교통부 26건: 대기 글 4건 본문 확인. 11-26 「내년 수도권 공공주택 5.6만호 입주자 모집」은 첨부 「(별첨1)_국토교통부_제1차관_브리핑문.pdf」
--     (94,156바이트, 운영자 허락 받고 내려받음) 8쪽을 끝까지 읽음. "수도권 규제지역"은 미분양 매입확약 대상 지역, "금융 지원"은 사업자 대상이고
--     개인 대출 한도, LTV, DSR, 스트레스 금리, 토지거래허가 문장 없음. 나머지 국토부 한글 첨부(hwpx)는 읽지 않음(확인 불가로 note 에 남김).
--   재정경제부 15건: 11-26 종합부동산세 고지 보도참고는 본문이 첨부 안내 한 줄, 11-22 긴급 시장상황점검회의 본문에 대출과 부동산 낱말 0.
--   국세청 2건: 11-26 「2026년 종합부동산세, 12월 15일까지 납부하세요」 본문 "주택 9억 원(1세대 1주택자 12억 원)"(직접 확인), 저장한 기본공제 12억과 같음.
--   세금 행은 지방세법이 감지 소스 밖이라 국가법령정보센터 현행 판을 크롬으로 확인: 지방세법 [시행 2026. 7. 1.] 법률 제21308호,
--     지방세특례제한법 [시행 2026. 6. 2.] 제21738호, 종합부동산세법 [시행 2026. 1. 1.] 제21224호. 모두 11-15 검증 전 판 그대로.
--     (지방세법에 2027. 9. 9. 시행 예정 조문 제7조, 제10조의5 표시가 있으나 지금 값에 닿지 않고 내용은 열지 않음)
--
-- 실행 전 확인(지금 값: housing_loan_2025 2026-11-19, acquisition_tax_2025 2026-11-15):
select key, source_effective_date, length(note) as note_len from public.regulations_snapshot order by key;

-- 적용: 지금 값이 위와 같을 때만 바뀐다(다른 사람이 먼저 고쳤으면 0행).
update public.regulations_snapshot
set source_effective_date = '2026-11-27',
    note = coalesce(note, '') || ' | 2026-11-27 확인(금융위, 국토부, 재정경제부, 국세청 보도자료 목록 11-19~11-27 전부, 대출 관련 가능 글은 본문 확인, 국토부 11-26 브리핑문 pdf 8쪽 확인): 대출 저장값을 바꾸는 발표 없음. 국토부 한글 첨부는 미확인.'
where key = 'housing_loan_2025'
  and valid_to is null
  and source_effective_date = '2026-11-19';

update public.regulations_snapshot
set source_effective_date = '2026-11-27',
    note = coalesce(note, '') || ' | 2026-11-27 확인: 국가법령정보센터 현행 판 지방세법 시행 2026.7.1(제21308호), 지방세특례제한법 시행 2026.6.2(제21738호), 종합부동산세법 시행 2026.1.1(제21224호)로 11-15 검증 뒤 바뀐 조문 없음. 국세청 11-26 종부세 납부 안내 본문의 1세대 1주택자 12억 원 확인. 네 기관 보도자료 11-15~11-27 에 세율 변경 발표 없음.'
where key = 'acquisition_tax_2025'
  and valid_to is null
  and source_effective_date = '2026-11-15';

-- 실행 뒤 확인: 두 행 모두 2026-11-27, note 끝 문단이 "2026-11-27 확인" 으로 시작.
select key, source_effective_date, length(note) as note_len, right(note, 90) as note_tail from public.regulations_snapshot order by key;

-- 되돌리기(필요할 때만): 검증일을 이전 값으로 되돌리고 덧붙인 문단을 뗀다.
-- update public.regulations_snapshot set source_effective_date = '2026-11-19', note = regexp_replace(note, ' \| 2026-11-27 확인\(.*$', '') where key = 'housing_loan_2025' and source_effective_date = '2026-11-27';
-- update public.regulations_snapshot set source_effective_date = '2026-11-15', note = regexp_replace(note, ' \| 2026-11-27 확인: .*$', '') where key = 'acquisition_tax_2025' and source_effective_date = '2026-11-27';
