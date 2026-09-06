-- ============================================================================
-- 2026-09-06 — 이미 프로덕션에 적용됨(운영자 명시 승인 "권고대로 진행해줘. 승인할게" 후 execute_sql 로 실행).
--   이 파일은 **적용 기록**이다(Plan 026 관례). 아래 정의는 적용 후 pg_get_functiondef() 로 다시 읽은 원문이다.
-- ============================================================================
--
-- [1] refresh_molit_apt_index — statement_timeout 120s 부여 (Plan 058 근본 수정, 리뷰어 적용)
--   [왜] PostgREST 가 접속하는 authenticator 역할의 statement_timeout 이 8초라
--        REFRESH MATERIALIZED VIEW CONCURRENTLY 가 매일 취소됐다(health.crons.mvRefreshError 에
--        "canceling statement due to statement timeout" 이 21일간 기록돼 있었으나 경보가 없었다).
--        검색 색인이 2026-08-14 에 멈춰 418개 단지가 검색·챗에서 사라졌다.
--   [실측] 적용 직후 갱신: MV 최신 거래일 2026-08-14 → 2026-09-04, 단지 22,473 → 22,891, 합계 460,358(원본과 일치).
--   ⚠ 함수 로컬 SET 은 사용자 대기 경로(경신 카드 RPC)에는 답이 아니다 — 이 함수는 cron 전용이라 옳다.
CREATE OR REPLACE FUNCTION public.refresh_molit_apt_index()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.molit_apt_index;
END;
$function$
;

-- [2] refresh_molit_aliases — apt_master.molit_aliases 를 규칙대로 다시 채운다 (Plan 053 부록 A-5 → Plan 067 cron 호출)
--   [규칙] 같은 (lawd_cd, umd_nm) + KAPT 사용승인 연도 == MOLIT build_year 필수.
--          채택: ① kaptAddr 지번 == 그 MOLIT 이름의 최빈 jibun ② 정규화(공백·괄호 제거) 완전일치/접두 + 숫자열 일치.
--          거부: 이름에 상가|근린|근생|판매시설|오피스텔 · 한 MOLIT 이름이 2개 이상 kapt_code 에 걸림.
--          확장: A/B 형제(같은 동·같은 연도·stem 동일·끝 1글자만 다름) 함께.
--   [실측] 1회 적용 1 → 10,505행(별칭 10,785개). 챗 도달률 23.4% → 72.8%.
--          공릉풍림아이원 → ["풍림아파트A","풍림아파트B"] / 풍납대아아파트(상가동) → [] / 강일리버파크11단지(연도 불일치) → [].
--   [멱등] 갱신 행수(integer)를 반환. 변화 없으면 0.
CREATE OR REPLACE FUNCTION public.refresh_molit_aliases()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE n integer;
BEGIN
  WITH mj AS (
    SELECT lawd_cd, umd_nm, apt_name, build_year, jibun,
           row_number() OVER (PARTITION BY lawd_cd,umd_nm,apt_name,build_year ORDER BY cnt DESC, jibun) AS rn
    FROM (SELECT lawd_cd,umd_nm,apt_name,build_year,jibun,count(*) cnt FROM molit_transactions
          WHERE jibun IS NOT NULL AND jibun<>'' GROUP BY 1,2,3,4,5) t
  ), m AS (
    SELECT kapt_code, apt_name, lawd_cd, umd_nm,
           left(facility->>'kaptUsedate',4)::int AS yr,
           (regexp_match(facility->>'kaptAddr','(?:^|\s)([0-9]+(?:-[0-9]+)?)(?:\s|$)'))[1] AS jb,
           regexp_replace(replace(apt_name,' ',''),'\([^)]*\)','','g') AS nn
    FROM apt_master WHERE facility->>'kaptUsedate' ~ '^[0-9]{8}'
  ), i AS (
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
    LEFT JOIN mj ON mj.rn=1 AND mj.lawd_cd=m.lawd_cd AND mj.umd_nm=m.umd_nm
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
REVOKE EXECUTE ON FUNCTION public.refresh_molit_aliases() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.refresh_molit_aliases() TO service_role;
