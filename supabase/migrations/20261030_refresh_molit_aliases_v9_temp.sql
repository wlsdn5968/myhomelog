-- ============================================================================
-- 2026-10-30 — Plan 177: 별칭 갱신 함수 v9 (규칙은 v8 과 같다, 실행 방식만 바꿈) (운영자 승인 "권고대로", 2026-10-30)
--   문제: v8 이 99초(v7 도 pg_stat_statements 실측 35~102초). 주간 aptMasterSync 의 30초 끊기에 걸려 기록이 TimeoutError 로 남았다
--   (DB 쪽 UPDATE 는 끝까지 완료). 원인: 거래 원본 46만 행을 두 CTE 가 각자 읽고, 큰 CTE 끼리 인덱스 없이 조인.
--   v9: 원본은 한 번만 집계(_ma_g) → 중간 결과를 임시 표(ON COMMIT DROP)로 만들고 인덱스·ANALYZE 를 붙인다.
--   운영 실측: 건조 실행(p_apply=false) 바뀔 단지 0 · 17.2초 / 11.1초. 규칙 문장은 v8 마이그레이션에서 생성(gen_v9.py)해 손으로 바꾸지 않았다.
--   refresh_molit_aliases() 는 시그니처·권한(postgres·service_role)·호출 코드가 그대로이고 본문만 core(true) 호출로 바뀐다.
-- ============================================================================
CREATE OR REPLACE FUNCTION public._refresh_molit_aliases_core(p_apply boolean)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '300s'
AS $function$
DECLARE n integer;
BEGIN
  DROP TABLE IF EXISTS pg_temp._ma_g, pg_temp._ma_mj, pg_temp._ma_jn, pg_temp._ma_m, pg_temp._ma_i, pg_temp._ma_acc0, pg_temp._ma_tgt;
  -- 거래 원본은 한 번만 읽는다(v8 은 mj·jn 이 각자 46만 행을 읽었다). mj·jn 은 같은 (지역·동·이름·건축년도·지번) 집계에서 나온다.
  CREATE TEMP TABLE _ma_g ON COMMIT DROP AS
    SELECT lawd_cd, umd_nm, apt_name, build_year, jibun, count(*) cnt FROM molit_transactions
    WHERE jibun IS NOT NULL AND jibun<>'' GROUP BY 1,2,3,4,5;
  CREATE TEMP TABLE _ma_mj ON COMMIT DROP AS
    SELECT lawd_cd, umd_nm, apt_name, build_year, jibun
    FROM (SELECT g.*, row_number() OVER (PARTITION BY lawd_cd,umd_nm,apt_name,build_year ORDER BY cnt DESC, jibun) AS rn FROM pg_temp._ma_g g) r
    WHERE rn = 1;
  CREATE TEMP TABLE _ma_jn ON COMMIT DROP AS
    SELECT lawd_cd, umd_nm, apt_name, build_year, count(DISTINCT jibun) AS nj FROM pg_temp._ma_g GROUP BY 1,2,3,4;
  CREATE TEMP TABLE _ma_m ON COMMIT DROP AS
    SELECT kapt_code, apt_name, lawd_cd, umd_nm,
           left(facility->>'kaptUsedate',4)::int AS yr,
           (regexp_match(facility->>'kaptAddr','(?:^|\s)([0-9]+(?:-[0-9]+)?)(?:\s|$)'))[1] AS jb,
           regexp_replace(replace(apt_name,' ',''),'\([^)]*\)','','g') AS nn,
           (SELECT array_agg(z[1]) FROM regexp_matches(apt_name,'([0-9]+)\s*(?:단지|차)','g') z) AS dset
    FROM apt_master WHERE facility->>'kaptUsedate' ~ '^[0-9]{8}';
  CREATE TEMP TABLE _ma_i ON COMMIT DROP AS
    SELECT apt_name, lawd_cd, umd_nm, build_year,
           regexp_replace(replace(apt_name,' ',''),'\([^)]*\)','','g') AS nn,
           (SELECT array_agg(z[1]) FROM regexp_matches(apt_name,'([0-9]+)\s*(?:단지|차)','g') z) AS dset
    FROM molit_apt_index;
  CREATE INDEX ON pg_temp._ma_mj (lawd_cd, umd_nm, build_year, apt_name, jibun);
  CREATE INDEX ON pg_temp._ma_jn (lawd_cd, umd_nm, apt_name, build_year);
  CREATE INDEX ON pg_temp._ma_m (lawd_cd, umd_nm, yr);
  CREATE INDEX ON pg_temp._ma_i (lawd_cd, umd_nm, build_year);
  ANALYZE pg_temp._ma_mj; ANALYZE pg_temp._ma_jn; ANALYZE pg_temp._ma_m; ANALYZE pg_temp._ma_i;
  CREATE TEMP TABLE _ma_acc0 ON COMMIT DROP AS
    SELECT * FROM (
    SELECT m.kapt_code, m.apt_name AS master, m.lawd_cd, m.umd_nm, i.apt_name AS molit, i.build_year,
           (mj.jibun IS NOT NULL) AS by_jibun,
           (replace(m.apt_name,' ','')=replace(i.apt_name,' ','')) AS name_exact,
           (i.nn <> '' AND m.nn <> '' AND (m.nn=i.nn OR starts_with(i.nn,m.nn) OR starts_with(m.nn,i.nn))
            AND (m.dset IS NULL OR i.dset IS NULL OR m.dset <@ i.dset OR i.dset <@ m.dset)) AS by_name,
           (regexp_replace(m.nn,'[^0-9]','','g')=regexp_replace(i.nn,'[^0-9]','','g')
            OR regexp_replace(m.nn,'[^0-9]','','g')='' OR regexp_replace(i.nn,'[^0-9]','','g')='') AS digits_ok,
           (regexp_replace(m.apt_name,'[^0-9]','','g')<>'' AND regexp_replace(m.apt_name,'[^0-9]','','g')=regexp_replace(i.apt_name,'[^0-9]','','g')) AS digits_full_eq
    FROM pg_temp._ma_m m JOIN pg_temp._ma_i i ON i.lawd_cd=m.lawd_cd AND i.umd_nm=m.umd_nm AND i.build_year=m.yr
    LEFT JOIN pg_temp._ma_mj mj ON mj.lawd_cd=m.lawd_cd AND mj.umd_nm=m.umd_nm
                AND mj.build_year=m.yr AND mj.apt_name=i.apt_name AND mj.jibun=m.jb
    ) cand
    WHERE (by_jibun OR (by_name AND digits_ok))
      AND molit !~ '상가|근린|근생|판매시설|오피스텔';
  CREATE INDEX ON pg_temp._ma_acc0 (molit, lawd_cd, umd_nm);
  ANALYZE pg_temp._ma_acc0;
  CREATE TEMP TABLE _ma_tgt ON COMMIT DROP AS
  WITH acc AS (
    SELECT * FROM pg_temp._ma_acc0 WHERE (molit,lawd_cd,umd_nm) NOT IN
      (SELECT molit,lawd_cd,umd_nm FROM pg_temp._ma_acc0 GROUP BY 1,2,3 HAVING count(DISTINCT kapt_code)>1)
  ), tie0 AS (
    SELECT a.* FROM pg_temp._ma_acc0 a
    JOIN (SELECT molit,lawd_cd,umd_nm FROM pg_temp._ma_acc0 GROUP BY 1,2,3 HAVING count(DISTINCT kapt_code)>1) c USING (molit,lawd_cd,umd_nm)
    WHERE a.by_name AND a.by_jibun AND a.digits_full_eq AND NOT (a.master ~ '임대' AND a.molit !~ '임대')
  ), tie AS (
    SELECT * FROM tie0 WHERE (molit,lawd_cd,umd_nm) IN
      (SELECT molit,lawd_cd,umd_nm FROM tie0 GROUP BY 1,2,3 HAVING count(DISTINCT kapt_code)=1)
  ), tjb0 AS (
    SELECT a.* FROM pg_temp._ma_acc0 a
    JOIN (SELECT molit,lawd_cd,umd_nm FROM pg_temp._ma_acc0 GROUP BY 1,2,3 HAVING count(DISTINCT kapt_code)>1) c USING (molit,lawd_cd,umd_nm)
    JOIN pg_temp._ma_jn jn ON jn.lawd_cd=a.lawd_cd AND jn.umd_nm=a.umd_nm AND jn.apt_name=a.molit AND jn.build_year=a.build_year
    WHERE a.by_jibun AND jn.nj = 1 AND NOT (a.master ~ '임대' AND a.molit !~ '임대')
      AND NOT EXISTS (SELECT 1 FROM pg_temp._ma_acc0 o WHERE o.molit=a.molit AND o.lawd_cd=a.lawd_cd AND o.umd_nm=a.umd_nm AND o.kapt_code<>a.kapt_code AND o.name_exact)
  ), tjb AS (
    SELECT * FROM tjb0 WHERE (molit,lawd_cd,umd_nm) IN
      (SELECT molit,lawd_cd,umd_nm FROM tjb0 GROUP BY 1,2,3 HAVING count(DISTINCT kapt_code)=1)
  ), near0 AS (
    SELECT DISTINCT m.kapt_code, m.lawd_cd, m.umd_nm, i.apt_name AS molit
    FROM pg_temp._ma_m m JOIN pg_temp._ma_i i ON i.lawd_cd=m.lawd_cd AND i.umd_nm=m.umd_nm AND abs(i.build_year - m.yr) = 1
    JOIN pg_temp._ma_mj mj ON mj.lawd_cd=m.lawd_cd AND mj.umd_nm=m.umd_nm AND mj.build_year=i.build_year AND mj.apt_name=i.apt_name AND mj.jibun=m.jb
    WHERE i.apt_name !~ '상가|근린|근생|판매시설|오피스텔'
      AND NOT EXISTS (SELECT 1 FROM pg_temp._ma_acc0 a WHERE a.molit=i.apt_name AND a.lawd_cd=m.lawd_cd AND a.umd_nm=m.umd_nm)
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
  ), sibd0 AS (
    SELECT DISTINCT a.kapt_code, a.lawd_cd, a.umd_nm, s.apt_name AS molit
    FROM (SELECT kapt_code, lawd_cd, umd_nm, molit FROM acc UNION SELECT kapt_code, lawd_cd, umd_nm, molit FROM tie) a
    JOIN molit_apt_index base ON base.lawd_cd=a.lawd_cd AND base.umd_nm=a.umd_nm AND base.apt_name=a.molit
    JOIN molit_apt_index s ON s.lawd_cd=a.lawd_cd AND s.umd_nm=a.umd_nm AND s.build_year=base.build_year
    WHERE base.apt_name ~ '[0-9]+동$' AND s.apt_name ~ '[0-9]+동$'
      AND length(regexp_replace(base.apt_name,'[0-9]+동$','')) >= 2
      AND regexp_replace(base.apt_name,'[0-9]+동$','') = regexp_replace(s.apt_name,'[0-9]+동$','')
      AND s.apt_name <> base.apt_name
      AND s.apt_name !~ '상가|근린|근생|판매시설|오피스텔'
      AND NOT EXISTS (SELECT 1 FROM pg_temp._ma_acc0 x WHERE x.molit=s.apt_name AND x.lawd_cd=a.lawd_cd AND x.umd_nm=a.umd_nm AND x.kapt_code<>a.kapt_code)
  ), sibd AS (
    SELECT * FROM sibd0 WHERE (molit,lawd_cd,umd_nm) IN
      (SELECT molit,lawd_cd,umd_nm FROM sibd0 GROUP BY 1,2,3 HAVING count(DISTINCT kapt_code)=1)
  ), sbase0 AS (
    SELECT DISTINCT m.kapt_code, i.lawd_cd, i.umd_nm, i.apt_name AS molit
    FROM (SELECT x.*, regexp_replace(replace(regexp_replace(x.apt_name,'\(?[0-9,]+동\)?$',''),' ',''),'\([^)]*\)','','g') AS base,
                 left((regexp_match(x.apt_name,'([0-9]+)[0-9,]*동\)?$'))[1],1) AS d1
          FROM molit_apt_index x WHERE x.apt_name ~ '[0-9]+동\)?$') i
    JOIN (SELECT mm.*, (SELECT array_agg(z[1]) FROM regexp_matches(mm.apt_name,'([0-9]+)\s*(?:단지|차)','g') z) AS ph FROM pg_temp._ma_m mm) m
      ON m.lawd_cd=i.lawd_cd AND m.umd_nm=i.umd_nm AND m.yr=i.build_year AND position(i.base in m.nn) > 0
    WHERE length(i.base) >= 3
      AND m.apt_name !~ '[0-9]+\s*(~|,)\s*[0-9]+\s*동'
      AND (i.base ~ '[0-9]' OR m.ph IS NULL OR i.d1 = ANY(m.ph))
      AND i.apt_name !~ '상가|근린|근생|판매시설|오피스텔'
      AND NOT EXISTS (SELECT 1 FROM pg_temp._ma_acc0 a WHERE a.molit=i.apt_name AND a.lawd_cd=i.lawd_cd AND a.umd_nm=i.umd_nm)
      AND NOT EXISTS (SELECT 1 FROM sibd s WHERE s.molit=i.apt_name AND s.lawd_cd=i.lawd_cd AND s.umd_nm=i.umd_nm)
      AND NOT EXISTS (SELECT 1 FROM near0 n WHERE n.molit=i.apt_name AND n.lawd_cd=i.lawd_cd AND n.umd_nm=i.umd_nm)
  ), sbase AS (
    SELECT * FROM sbase0 WHERE (molit,lawd_cd,umd_nm) IN
      (SELECT molit,lawd_cd,umd_nm FROM sbase0 GROUP BY 1,2,3 HAVING count(DISTINCT kapt_code)=1)
  ), fin AS (
    SELECT kapt_code, molit FROM acc
    UNION SELECT kapt_code, molit FROM tie
    UNION SELECT kapt_code, molit FROM tjb
    UNION SELECT kapt_code, molit FROM sib
    UNION SELECT kapt_code, molit FROM sibd
    UNION SELECT kapt_code, molit FROM sbase
    UNION SELECT kapt_code, molit FROM near
  ), fin2 AS (
    SELECT kapt_code, molit FROM fin
    WHERE NOT EXISTS (SELECT 1 FROM apt_alias_overrides o WHERE o.action='remove' AND o.kapt_code=fin.kapt_code AND o.molit_name=fin.molit)
    UNION SELECT o.kapt_code, o.molit_name FROM apt_alias_overrides o JOIN apt_master am ON am.kapt_code=o.kapt_code WHERE o.action='add'
  ), agg AS (
    SELECT kapt_code, jsonb_agg(DISTINCT molit ORDER BY molit) AS aliases FROM fin2 GROUP BY kapt_code
  ), cur AS MATERIALIZED (
    SELECT a.kapt_code, a.apt_name, x.molit FROM apt_master a
    CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(a.molit_aliases)='array' THEN a.molit_aliases ELSE '[]'::jsonb END) x(molit)
  ), miss AS (
    SELECT kapt_code, molit FROM cur EXCEPT SELECT kapt_code, molit FROM fin2
  ), bad AS (
    SELECT c.kapt_code, c.molit FROM cur c JOIN miss USING (kapt_code, molit)
    CROSS JOIN LATERAL (SELECT (SELECT array_agg(z[1]) FROM regexp_matches(c.apt_name,'([0-9]+)\s*(?:단지|차)','g') z) AS pa,
                               (SELECT array_agg(z[1]) FROM regexp_matches(c.molit,'([0-9]+)\s*(?:단지|차)','g') z) AS px) p
    WHERE (regexp_replace(replace(c.molit,' ',''),'\([^)]*\)','','g') = ''
           OR EXISTS (SELECT 1 FROM apt_alias_overrides o WHERE o.action='remove' AND o.kapt_code=c.kapt_code AND o.molit_name=c.molit)
           OR NOT (p.pa IS NULL OR p.px IS NULL OR p.pa <@ p.px OR p.px <@ p.pa))
      AND NOT EXISTS (SELECT 1 FROM apt_alias_overrides o WHERE o.action='add' AND o.kapt_code=c.kapt_code AND o.molit_name=c.molit)
  ), tgt AS (
    SELECT kapt_code, aliases FROM agg
    UNION ALL
    SELECT b.kapt_code, coalesce((SELECT jsonb_agg(DISTINCT c.molit ORDER BY c.molit) FROM cur c
                                  WHERE c.kapt_code=b.kapt_code AND (c.kapt_code, c.molit) NOT IN (SELECT kapt_code, molit FROM bad)), '[]'::jsonb)
    FROM (SELECT DISTINCT kapt_code FROM bad) b LEFT JOIN agg g ON g.kapt_code=b.kapt_code
    WHERE g.kapt_code IS NULL
  )
  SELECT kapt_code, aliases FROM tgt;
  IF p_apply THEN
    UPDATE apt_master a
    SET molit_aliases = t.aliases, updated_at = now()
    FROM pg_temp._ma_tgt t
    WHERE a.kapt_code = t.kapt_code
      AND a.molit_aliases IS DISTINCT FROM t.aliases;
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    SELECT count(*) INTO n FROM pg_temp._ma_tgt t JOIN apt_master a ON a.kapt_code = t.kapt_code
    WHERE a.molit_aliases IS DISTINCT FROM t.aliases;
  END IF;
  RETURN n;
END
$function$;
REVOKE ALL ON FUNCTION public._refresh_molit_aliases_core(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._refresh_molit_aliases_core(boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_molit_aliases()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
BEGIN
  RETURN public._refresh_molit_aliases_core(true);
END
$function$;
COMMENT ON FUNCTION public._refresh_molit_aliases_core(boolean)
  IS '별칭 갱신 v9 본체(Plan 177) — p_apply=false 는 바뀔 단지 수만 센다(건조 실행). service_role 전용.';
