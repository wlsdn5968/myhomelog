-- ============================================================================
-- 2026-10-29 — refresh_molit_aliases v5 = v4(20261027, 적용됨) + sibd CTE(연결된 별칭과 끝 동 번호만 다른 이름).
--   계획자 apply_migration(함수 교체 — 데이터 변경 없음) 후 select public.refresh_molit_aliases().
--   [읽기 전용 실측] 새 3쌍(파주 금촌동 동문1차 101동·401동, 동문3차 801동) · 충돌 0. 되돌리기: 20261027 파일의 CREATE OR REPLACE.
--   [적용 2026-10-29] apply_migration 성공 → refresh 12단지 갱신 · 쌍 11,317 → 11,330(+13 = v5 3쌍 + 10-27 이후 새 거래 이름 10쌍)
--     · 같은 동 겹침 0 · 바뀐 12곳 모두 추가만(기존 연결 제거 0). 금촌동문1차 = [101동, 201동, 401동].
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
    SELECT m.kapt_code, m.apt_name AS master, m.lawd_cd, m.umd_nm, i.apt_name AS molit,
           (mj.jibun IS NOT NULL) AS by_jibun,
           (m.nn=i.nn OR starts_with(i.nn,m.nn) OR starts_with(m.nn,i.nn)) AS by_name,
           (regexp_replace(m.nn,'[^0-9]','','g')=regexp_replace(i.nn,'[^0-9]','','g')
            OR regexp_replace(m.nn,'[^0-9]','','g')='' OR regexp_replace(i.nn,'[^0-9]','','g')='') AS digits_ok,
           -- 괄호 안 숫자까지 비교("e편한세상영통2차(2단지)" 22 ↔ "e편한세상 영통2차 2단지" 22)
           (regexp_replace(m.apt_name,'[^0-9]','','g')<>'' AND regexp_replace(m.apt_name,'[^0-9]','','g')=regexp_replace(i.apt_name,'[^0-9]','','g')) AS digits_full_eq
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
  ), tie0 AS (
    -- ALIAS-TIE-2026-10-27: 한 신고 이름이 여러 단지와 맞아 충돌로 버려지던 것 중(예: 상계주공15·16단지가 지번 624·1988년 공유 →
    --   "상계주공16(고층)" 무연결), 이름 일치 + 지번 일치 + 괄호 안까지 숫자 일치인 후보가 **정확히 하나**면 그 단지에 잇는다.
    --   임대 단지는 신고 이름에도 '임대'가 있을 때만(매매가 임대 단지로 가던 표본 1건 차단).
    --   [읽기 전용 실측 2026-10-27] 64쌍, 기존 연결과 겹침 0 — 전부 검수(신원당(동문1)→동신1차 처럼 지번 없는 후보는 제외됨).
    SELECT a.* FROM acc0 a
    JOIN (SELECT molit,lawd_cd,umd_nm FROM acc0 GROUP BY 1,2,3 HAVING count(DISTINCT kapt_code)>1) c USING (molit,lawd_cd,umd_nm)
    WHERE a.by_name AND a.by_jibun AND a.digits_full_eq AND NOT (a.master ~ '임대' AND a.molit !~ '임대')
  ), tie AS (
    SELECT * FROM tie0 WHERE (molit,lawd_cd,umd_nm) IN
      (SELECT molit,lawd_cd,umd_nm FROM tie0 GROUP BY 1,2,3 HAVING count(DISTINCT kapt_code)=1)
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
  ), sibd0 AS (
    -- ALIAS-DONG-SIB-2026-10-29: 이미 연결된 별칭과 '끝의 동 번호만' 다른 신고 이름(같은 동·같은 건축년도)은 같은 단지.
    --   예: 금촌동문1차 ← 동문1차아파트201동(지번 11-13) 연결됨, 동문1차아파트101동(11-7)·401동은 지번·이름 비교에 안 걸려 원본 이름으로 남았다.
    --   [읽기 전용 실측 2026-10-29] 새 연결 3쌍(전부 파주 금촌동 동문 1·3차), 이미 연결 6쌍, 다른 단지와 충돌 0.
    SELECT DISTINCT a.kapt_code, a.lawd_cd, a.umd_nm, s.apt_name AS molit
    FROM (SELECT kapt_code, lawd_cd, umd_nm, molit FROM acc UNION SELECT kapt_code, lawd_cd, umd_nm, molit FROM tie) a
    JOIN molit_apt_index base ON base.lawd_cd=a.lawd_cd AND base.umd_nm=a.umd_nm AND base.apt_name=a.molit
    JOIN molit_apt_index s ON s.lawd_cd=a.lawd_cd AND s.umd_nm=a.umd_nm AND s.build_year=base.build_year
    WHERE base.apt_name ~ '[0-9]+동$' AND s.apt_name ~ '[0-9]+동$'
      AND length(regexp_replace(base.apt_name,'[0-9]+동$','')) >= 2
      AND regexp_replace(base.apt_name,'[0-9]+동$','') = regexp_replace(s.apt_name,'[0-9]+동$','')
      AND s.apt_name <> base.apt_name
      AND s.apt_name !~ '상가|근린|근생|판매시설|오피스텔'
      AND NOT EXISTS (SELECT 1 FROM acc0 x WHERE x.molit=s.apt_name AND x.lawd_cd=a.lawd_cd AND x.umd_nm=a.umd_nm AND x.kapt_code<>a.kapt_code)
  ), sibd AS (
    SELECT * FROM sibd0 WHERE (molit,lawd_cd,umd_nm) IN
      (SELECT molit,lawd_cd,umd_nm FROM sibd0 GROUP BY 1,2,3 HAVING count(DISTINCT kapt_code)=1)
  ), fin AS (
    SELECT kapt_code, molit FROM acc
    UNION SELECT kapt_code, molit FROM tie
    UNION SELECT kapt_code, molit FROM sib
    UNION SELECT kapt_code, molit FROM sibd
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

