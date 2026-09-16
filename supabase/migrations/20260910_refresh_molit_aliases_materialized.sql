-- ============================================================================
-- 2026-09-10 — 이미 프로덕션에 적용됨(운영자 명시 승인 후 execute_sql 로 실행). 이 파일은 **적용 기록**이다(Plan 026 관례).
--   아래 정의는 적용 후 pg_get_functiondef() 로 다시 읽은 원문이다.
-- ============================================================================
--
-- refresh_molit_aliases v2 — 로직 동일, CTE mj·m·i 를 MATERIALIZED 로 고정 (Plan 077)
--   [왜] 067 의 cron 호출이 30초 클라이언트 중단에 걸려 2026-09-07 회차 실패(Sentry NODE-D).
--        본문이 108.5초 걸렸다: mj LEFT JOIN 조건이 apt_master 의 표현식이라 인라인 CTE 로는 해시 조인이
--        안 되고 Nested Loop 가 7.7억 행을 필터했다(EXPLAIN ANALYZE 실측).
--   [실측] 적용 후 EXPLAIN ANALYZE SELECT refresh_molit_aliases(): **9,867 ms** (기존 108,541 ms). 첫 실행 갱신 8행 — 09-14 회차는 클라이언트(30s)만 끊기고 DB 쪽 UPDATE 는 완료돼 있었다(별칭 보유 10,506 → 10,660행).
--
CREATE OR REPLACE FUNCTION public.refresh_molit_aliases()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE n integer;
BEGIN
  WITH mj AS MATERIALIZED (
    SELECT lawd_cd, umd_nm, apt_name, build_year, jibun
    FROM (SELECT lawd_cd, umd_nm, apt_name, build_year, jibun,
                 row_number() OVER (PARTITION BY lawd_cd,umd_nm,apt_name,build_year ORDER BY cnt DESC, jibun) AS rn
          FROM (SELECT lawd_cd,umd_nm,apt_name,build_year,jibun,count(*) cnt FROM molit_transactions
                WHERE jibun IS NOT NULL AND jibun<>'' GROUP BY 1,2,3,4,5) t) r
    WHERE rn = 1
  ), m AS MATERIALIZED (
    SELECT kapt_code, apt_name, lawd_cd, umd_nm,
           left(facility->>'kaptUsedate',4)::int AS yr,
           (regexp_match(facility->>'kaptAddr','(?:^|\s)([0-9]+(?:-[0-9]+)?)(?:\s|$)'))[1] AS jb,
           regexp_replace(replace(apt_name,' ',''),'\([^)]*\)','','g') AS nn
    FROM apt_master WHERE facility->>'kaptUsedate' ~ '^[0-9]{8}'
  ), i AS MATERIALIZED (
    SELECT apt_name, lawd_cd, umd_nm, build_year,
           regexp_replace(replace(apt_name,' ',''),'\([^)]*\)','','g') AS nn
    FROM molit_apt_index
  ), cand AS (
    SELECT m.kapt_code, m.lawd_cd, m.umd_nm, i.apt_name AS molit,
           (mj.jibun IS NOT NULL) AS by_jibun,
           (m.nn=i.nn OR starts_with(i.nn,m.nn) OR starts_with(m.nn,i.nn)) AS by_name,
           (regexp_replace(m.nn,'[^0-9]','','g')=regexp_replace(i.nn,'[^0-9]','','g')
            OR regexp_replace(m.nn,'[^0-9]','','g')='' OR regexp_replace(i.nn,'[^0-9]','','g')='') AS digits_ok
    FROM m JOIN i ON i.lawd_cd=m.lawd_cd AND i.umd_nm=m.umd_nm AND i.build_year=m.yr
    LEFT JOIN mj ON mj.lawd_cd=m.lawd_cd AND mj.umd_nm=m.umd_nm
                AND mj.build_year=m.yr AND mj.apt_name=i.apt_name AND mj.jibun=m.jb
  ), acc0 AS (
    SELECT * FROM cand
    WHERE (by_jibun OR (by_name AND digits_ok))
      AND molit !~ '상가|근린|근생|판매시설|오피스텔'
  ), acc AS (
    SELECT * FROM acc0 WHERE (molit,lawd_cd,umd_nm) NOT IN
      (SELECT molit,lawd_cd,umd_nm FROM acc0 GROUP BY 1,2,3 HAVING count(DISTINCT kapt_code)>1)
  ), sib AS (
    SELECT DISTINCT a.kapt_code, s.apt_name AS molit
    FROM acc a
    JOIN molit_apt_index base ON base.lawd_cd=a.lawd_cd AND base.umd_nm=a.umd_nm AND base.apt_name=a.molit
    JOIN molit_apt_index s ON s.lawd_cd=a.lawd_cd AND s.umd_nm=a.umd_nm AND s.build_year=base.build_year
    WHERE base.apt_name ~ '[A-Za-z가나다라]$' AND s.apt_name ~ '[A-Za-z가나다라]$'
      AND length(regexp_replace(base.apt_name,'[A-Za-z가나다라]$','')) >= 2
      AND regexp_replace(base.apt_name,'[A-Za-z가나다라]$','') = regexp_replace(s.apt_name,'[A-Za-z가나다라]$','')
      AND right(base.apt_name,1) <> right(s.apt_name,1)
      AND s.apt_name !~ '상가|근린|근생|판매시설|오피스텔'
  ), fin AS (
    SELECT kapt_code, molit FROM acc
    UNION SELECT kapt_code, molit FROM sib
  ), agg AS (
    SELECT kapt_code, jsonb_agg(DISTINCT molit) AS aliases FROM fin GROUP BY kapt_code
  )
  UPDATE apt_master a
  SET molit_aliases = agg.aliases, updated_at = now()
  FROM agg
  WHERE a.kapt_code = agg.kapt_code
    AND a.molit_aliases IS DISTINCT FROM agg.aliases;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$function$
;
