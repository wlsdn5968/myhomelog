-- molit_transactions.sigungu backfill (Phase 2 후속, 2026-04-25)
--
-- 문제:
--   MOLIT API 응답이 sggCd (숫자코드) 만 채우고 sggNm (구이름) 은 빈값으로 옴.
--   ETL 이 sigungu = '' || null 으로 입력 → 모든 row 의 sigungu = NULL.
--   → /api/search/popular 의 in('sigungu', ['강남구',...]) 필터 fail → 빈 결과.
--
-- 해결:
--   1) ETL 코드에서 LAWD_CODE_TO_NAME 역매핑으로 채우도록 수정 (별도 commit).
--   2) 기존 적재 데이터는 lawd_cd 기반으로 backfill.
--
-- 영향:
--   - 32개 LAWD_CD → 구이름 매핑 (서울 25 + 수도권 7).
--   - 매핑 외 lawd_cd 는 그대로 NULL (앞으로도 ingest 대상 아님).

UPDATE public.molit_transactions
SET sigungu = CASE lawd_cd
  WHEN '11110' THEN '종로구'
  WHEN '11140' THEN '중구'
  WHEN '11170' THEN '용산구'
  WHEN '11200' THEN '성동구'
  WHEN '11215' THEN '광진구'
  WHEN '11230' THEN '동대문구'
  WHEN '11260' THEN '중랑구'
  WHEN '11290' THEN '성북구'
  WHEN '11305' THEN '강북구'
  WHEN '11320' THEN '도봉구'
  WHEN '11350' THEN '노원구'
  WHEN '11380' THEN '은평구'
  WHEN '11410' THEN '서대문구'
  WHEN '11440' THEN '마포구'
  WHEN '11470' THEN '양천구'
  WHEN '11500' THEN '강서구'
  WHEN '11530' THEN '구로구'
  WHEN '11545' THEN '금천구'
  WHEN '11560' THEN '영등포구'
  WHEN '11590' THEN '동작구'
  WHEN '11620' THEN '관악구'
  WHEN '11650' THEN '서초구'
  WHEN '11680' THEN '강남구'
  WHEN '11710' THEN '송파구'
  WHEN '11740' THEN '강동구'
  WHEN '41290' THEN '과천시'
  WHEN '41210' THEN '광명시'
  WHEN '41135' THEN '성남시분당구'
  WHEN '41117' THEN '수원시영통구'
  WHEN '41173' THEN '안양시동안구'
  WHEN '41450' THEN '하남시'
  WHEN '41465' THEN '용인시수지구'
  ELSE sigungu
END
WHERE sigungu IS NULL;
