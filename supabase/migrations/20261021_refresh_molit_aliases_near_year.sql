-- ============================================================================
-- 2026-10-21 — 운영자 SQL Editor 실행용(이 환경의 도구는 함수 교체를 거절한다). 아직 적용 안 됨.
-- refresh_molit_aliases v3 — v2(20260910) 그대로 + near0/near CTE 1개 추가(건축년도 ±1·지번 일치·같은 해 후보 없는 이름만)
--   [읽기 전용 실측 2026-10-21] 기존 연결 11,166쌍 변화 0 · 새 연결 43쌍(벽적골우성→벽적골두산한신우성,
--   신나무실풍림→영통신나무실극동풍림, 충무주공(872)→산본주공충무1, 강선마을6단지(금호,한양)→주엽강선마을6단지금호한양 등).
--   권한: CREATE OR REPLACE 는 기존 GRANT(service_role 전용)를 유지한다.
-- 실행 순서: ① 아래 전체를 붙여 넣고 Run(함수 정의만 바뀜, 데이터 변경 없음) ② 맨 아래 "적용" 한 줄을 따로 Run(별칭 갱신, 10~20초)
--   ③ "확인" 쿼리 결과를 계획자에게 전달. 되돌리기: 20260910_refresh_molit_aliases_materialized.sql 의 CREATE OR REPLACE 를 다시 Run.
-- ============================================================================
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
  ), near0 AS (
    -- ALIAS-NEAR-YEAR-2026-10-21: 건축년도가 1년 다르지만 지번이 같은 신고 이름(건설사별로 나뉜 신고·이름 변경 — 벽적골우성 1998 ↔
    --   공동주택 정보 벽적골두산한신우성 1997). 같은 해 경로에서 후보가 하나도 없던 이름만 받는다 — 기존 연결·충돌 판정에 끼어들지 않는다
    --   (단순히 조인을 ±1 로 넓히면 우만주공1·2단지, 군자주공11·12 등 기존 30쌍이 충돌로 끊긴다 — 2026-10-21 읽기 전용 실측).
    SELECT DISTINCT m.kapt_code, m.lawd_cd, m.umd_nm, i.apt_name AS molit
    FROM m JOIN i ON i.lawd_cd=m.lawd_cd AND i.umd_nm=m.umd_nm AND abs(i.build_year - m.yr) = 1
    JOIN mj ON mj.lawd_cd=m.lawd_cd AND mj.umd_nm=m.umd_nm AND mj.build_year=i.build_year AND mj.apt_name=i.apt_name AND mj.jibun=m.jb
    WHERE i.apt_name !~ '상가|근린|근생|판매시설|오피스텔'
      AND NOT EXISTS (SELECT 1 FROM acc0 a WHERE a.molit=i.apt_name AND a.lawd_cd=m.lawd_cd AND a.umd_nm=m.umd_nm)
  ), near AS (
    SELECT * FROM near0 WHERE (molit,lawd_cd,umd_nm) NOT IN
      (SELECT molit,lawd_cd,umd_nm FROM near0 GROUP BY 1,2,3 HAVING count(DISTINCT kapt_code)>1)
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
    UNION SELECT kapt_code, molit FROM near
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

-- ② 적용(별도로 Run): 바뀐 단지 수가 숫자로 나온다
-- select public.refresh_molit_aliases();

-- ③ 확인(별도로 Run): 벽적골우성이 정식 단지에 연결됐는지 — 결과 1행이면 성공
-- select apt_name, molit_aliases from public.apt_master where kapt_code = 'A44347025' and molit_aliases ? '벽적골우성';
