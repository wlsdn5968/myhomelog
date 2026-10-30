-- ============================================================================
-- 2026-10-30 — Plan 176: 단지 별칭 손 보정표 + refresh_molit_aliases v8 (운영자 승인 "권고대로", 2026-10-30)
--   1) apt_alias_overrides: 사람이 대조해 정한 연결 추가(add)·제외(remove). 매주 함수가 다시 계산해도 마지막에 적용된다.
--      내부 전용(RLS on + 정책 0 = service_role 만). 값은 공식 근거(공동주택 정보 주소·사용승인·건축물대장)를 reason 에 적는다.
--   2) v8 = v7 + 이름 비교에서 빈 이름 제외(지번형 "(807-1)" 오연결 111개, 10단지) + 단지·차 번호 집합 포함 관계(plans/169 §5)
--      + 손 보정 적용 + 규칙이 거부하는 기존 연결만 골라 제거(전체 비우기 아님).
--   [읽기 전용 실측 2026-10-30, 보정표 비어 있을 때] 11,572 → 11,462 · 제거 114(지번형 111 · 번호 어긋남 3) · 추가 4 · 그 밖 변화 0.
--   되돌리기: 20261029_refresh_molit_aliases_dongbase_v7.sql 의 CREATE OR REPLACE 실행 후 select public.refresh_molit_aliases().
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.apt_alias_overrides (
  id          bigserial PRIMARY KEY,
  kapt_code   text NOT NULL,
  molit_name  text NOT NULL,
  action      text NOT NULL CHECK (action IN ('add','remove')),
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kapt_code, molit_name)
);
ALTER TABLE public.apt_alias_overrides ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apt_alias_overrides FROM anon, authenticated;
COMMENT ON TABLE public.apt_alias_overrides IS '단지 별칭 손 보정(Plan 176) — refresh_molit_aliases() 가 규칙 결과 뒤에 적용. 내부 전용.';

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
  ), jn AS MATERIALIZED (
    -- 신고 이름(같은 동·건축년도)별로 관측된 서로 다른 지번 수 — 1개일 때만 지번 단독 근거를 믿는다(1·2단지를 한 이름으로 신고한 경우 배제)
    SELECT lawd_cd, umd_nm, apt_name, build_year, count(DISTINCT jibun) AS nj FROM molit_transactions
    WHERE jibun IS NOT NULL AND jibun<>'' GROUP BY 1,2,3,4
  ), m AS MATERIALIZED (
    SELECT kapt_code, apt_name, lawd_cd, umd_nm,
           left(facility->>'kaptUsedate',4)::int AS yr,
           (regexp_match(facility->>'kaptAddr','(?:^|\s)([0-9]+(?:-[0-9]+)?)(?:\s|$)'))[1] AS jb,
           regexp_replace(replace(apt_name,' ',''),'\([^)]*\)','','g') AS nn,
           (SELECT array_agg(z[1]) FROM regexp_matches(apt_name,'([0-9]+)\s*(?:단지|차)','g') z) AS dset
    FROM apt_master WHERE facility->>'kaptUsedate' ~ '^[0-9]{8}'
  ), i AS MATERIALIZED (
    SELECT apt_name, lawd_cd, umd_nm, build_year,
           regexp_replace(replace(apt_name,' ',''),'\([^)]*\)','','g') AS nn,
           (SELECT array_agg(z[1]) FROM regexp_matches(apt_name,'([0-9]+)\s*(?:단지|차)','g') z) AS dset
    FROM molit_apt_index
  ), cand AS (
    SELECT m.kapt_code, m.apt_name AS master, m.lawd_cd, m.umd_nm, i.apt_name AS molit, i.build_year,
           (mj.jibun IS NOT NULL) AS by_jibun,
           (replace(m.apt_name,' ','')=replace(i.apt_name,' ','')) AS name_exact,
           -- v8 (Plan 176): 괄호를 지워 빈 이름이 되는 신고 이름("(807-1)")은 이름으로 잇지 않는다 — starts_with(x,'')가 늘 참이라
           --   같은 동·같은 해 공식 단지가 하나면 남의 건물이 붙었다(10곳 111개 실측). 원래 이름 속 숫자 집합도 포함 관계여야 한다
           --   ("양지마을(2단지)(청구)" ↔ "양지마을 금호 1단지" 차단, plans/169 §5).
           (i.nn <> '' AND m.nn <> '' AND (m.nn=i.nn OR starts_with(i.nn,m.nn) OR starts_with(m.nn,i.nn))
            AND (m.dset IS NULL OR i.dset IS NULL OR m.dset <@ i.dset OR i.dset <@ m.dset)) AS by_name,
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
  ), tjb0 AS (
    -- ALIAS-TIE-JIBUN-2026-10-29 (v6): 충돌 이름 중 **지번이 같은 후보가 정확히 하나**면 그 단지(지번 = 같은 필지, 가장 강한 근거).
    --   예: 교문(동양고속) 809-3 → 구리교문(대우,동양고속) 809-3 · 효자촌(삼환) 301 → 서현효자촌삼환 301 (다른 후보는 이름만 맞았다).
    --   안전장치: ① 그 신고 이름의 거래 지번이 한 가지뿐 ② 다른 후보 중 이름이 통째로 같은 단지가 없음(인왕산현대 460-1 같은 경우 배제)
    --   ③ 임대 단지는 신고 이름에도 임대가 있을 때만.
    --   [읽기 전용 실측 2026-10-29] 새 연결 217쌍 · 다른 단지에 이미 연결된 이름 침범 0 · 표본 49+25쌍 개별 대조(지번·건축년도·건축물대장 이름) 오연결 0.
    SELECT a.* FROM acc0 a
    JOIN (SELECT molit,lawd_cd,umd_nm FROM acc0 GROUP BY 1,2,3 HAVING count(DISTINCT kapt_code)>1) c USING (molit,lawd_cd,umd_nm)
    JOIN jn ON jn.lawd_cd=a.lawd_cd AND jn.umd_nm=a.umd_nm AND jn.apt_name=a.molit AND jn.build_year=a.build_year
    WHERE a.by_jibun AND jn.nj = 1 AND NOT (a.master ~ '임대' AND a.molit !~ '임대')
      AND NOT EXISTS (SELECT 1 FROM acc0 o WHERE o.molit=a.molit AND o.lawd_cd=a.lawd_cd AND o.umd_nm=a.umd_nm AND o.kapt_code<>a.kapt_code AND o.name_exact)
  ), tjb AS (
    SELECT * FROM tjb0 WHERE (molit,lawd_cd,umd_nm) IN
      (SELECT molit,lawd_cd,umd_nm FROM tjb0 GROUP BY 1,2,3 HAVING count(DISTINCT kapt_code)=1)
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
  ), sbase0 AS (
    -- ALIAS-DONG-BASE-2026-10-29 (v7): 동 단위로 신고된 이름("대원칸타빌(103동)")이 어떤 경로로도 후보가 없을 때,
    --   동 번호를 뗀 공통 이름(3자 이상)을 이름에 품은 공식 단지가 같은 동·같은 건축년도에 **정확히 하나**면 연결.
    --   안전장치: 공식 이름에 동 목록("1~4동","2,3동")이 있으면 제외 · 공통 이름에 숫자가 없고 공식 이름에 'N단지/N차'가 있으면
    --   동 번호 첫 자리가 그 N 과 같을 때만(유호엔시티201동 → 1단지, 개포현대200동 → 3차 차단).
    --   [읽기 전용 실측 2026-10-29] 26쌍 전수 대조(지도에서 한 단지가 동마다 따로 핀이던 당정한솔솔파크 5개·당정대원칸타빌 5개 등).
    SELECT DISTINCT m.kapt_code, i.lawd_cd, i.umd_nm, i.apt_name AS molit
    FROM (SELECT x.*, regexp_replace(replace(regexp_replace(x.apt_name,'\(?[0-9,]+동\)?$',''),' ',''),'\([^)]*\)','','g') AS base,
                 left((regexp_match(x.apt_name,'([0-9]+)[0-9,]*동\)?$'))[1],1) AS d1
          FROM molit_apt_index x WHERE x.apt_name ~ '[0-9]+동\)?$') i
    JOIN (SELECT mm.*, (SELECT array_agg(z[1]) FROM regexp_matches(mm.apt_name,'([0-9]+)\s*(?:단지|차)','g') z) AS ph FROM m mm) m
      ON m.lawd_cd=i.lawd_cd AND m.umd_nm=i.umd_nm AND m.yr=i.build_year AND position(i.base in m.nn) > 0
    WHERE length(i.base) >= 3
      AND m.apt_name !~ '[0-9]+\s*(~|,)\s*[0-9]+\s*동'
      AND (i.base ~ '[0-9]' OR m.ph IS NULL OR i.d1 = ANY(m.ph))
      AND i.apt_name !~ '상가|근린|근생|판매시설|오피스텔'
      AND NOT EXISTS (SELECT 1 FROM acc0 a WHERE a.molit=i.apt_name AND a.lawd_cd=i.lawd_cd AND a.umd_nm=i.umd_nm)
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
    -- v8 (Plan 176): 손 보정표(apt_alias_overrides)를 규칙 결과 마지막에 적용 — 매주 다시 계산해도 손 보정이 지워지지 않는다.
    SELECT kapt_code, molit FROM fin
    WHERE NOT EXISTS (SELECT 1 FROM apt_alias_overrides o WHERE o.action='remove' AND o.kapt_code=fin.kapt_code AND o.molit_name=fin.molit)
    UNION SELECT o.kapt_code, o.molit_name FROM apt_alias_overrides o JOIN apt_master am ON am.kapt_code=o.kapt_code WHERE o.action='add'
  ), agg AS (
    SELECT kapt_code, jsonb_agg(DISTINCT molit ORDER BY molit) AS aliases FROM fin2 GROUP BY kapt_code
  ), cur AS MATERIALIZED (
    -- 지금 저장된 연결(단지 이름 포함) — 아래 비교는 상관 하위쿼리 대신 해시 비교로(1만여 쌍 × 규칙 결과 반복 스캔을 피한다)
    SELECT a.kapt_code, a.apt_name, x.molit FROM apt_master a
    CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(a.molit_aliases)='array' THEN a.molit_aliases ELSE '[]'::jsonb END) x(molit)
  ), miss AS (
    SELECT kapt_code, molit FROM cur EXCEPT SELECT kapt_code, molit FROM fin2
  ), bad AS (
    -- v8: 규칙이 이제 거부하는 연결만 골라 뺀다 — 괄호를 지우면 빈 이름(지번형 "(807-1)")이거나, 손 보정표에서 제외됐거나,
    --   단지·차 번호 집합이 공식 이름과 포함 관계가 아닌 것. (단지 별칭 전체를 비우면 9월 일괄 적용 때 들어간 정상 연결
    --   176개까지 지워진다 — 2026-10-30 읽기 전용 실측. 그래서 전체 교체가 아니라 이 목록만 뺀다.)
    SELECT c.kapt_code, c.molit FROM cur c JOIN miss USING (kapt_code, molit)
    CROSS JOIN LATERAL (SELECT (SELECT array_agg(z[1]) FROM regexp_matches(c.apt_name,'([0-9]+)\s*(?:단지|차)','g') z) AS pa,
                               (SELECT array_agg(z[1]) FROM regexp_matches(c.molit,'([0-9]+)\s*(?:단지|차)','g') z) AS px) p
    WHERE (regexp_replace(replace(c.molit,' ',''),'\([^)]*\)','','g') = ''
           OR EXISTS (SELECT 1 FROM apt_alias_overrides o WHERE o.action='remove' AND o.kapt_code=c.kapt_code AND o.molit_name=c.molit)
           OR NOT (p.pa IS NULL OR p.px IS NULL OR p.pa <@ p.px OR p.px <@ p.pa))
      AND NOT EXISTS (SELECT 1 FROM apt_alias_overrides o WHERE o.action='add' AND o.kapt_code=c.kapt_code AND o.molit_name=c.molit)
  ), tgt AS (
    -- 규칙·보정 결과가 있는 단지는 그 결과로, 없는 단지는 기존 연결에서 bad 만 뺀다(그 밖의 기존 연결은 그대로).
    SELECT kapt_code, aliases FROM agg
    UNION ALL
    SELECT b.kapt_code, coalesce((SELECT jsonb_agg(DISTINCT c.molit ORDER BY c.molit) FROM cur c
                                  WHERE c.kapt_code=b.kapt_code AND (c.kapt_code, c.molit) NOT IN (SELECT kapt_code, molit FROM bad)), '[]'::jsonb)
    FROM (SELECT DISTINCT kapt_code FROM bad) b LEFT JOIN agg g ON g.kapt_code=b.kapt_code
    WHERE g.kapt_code IS NULL
  )
  UPDATE apt_master a
  SET molit_aliases = tgt.aliases, updated_at = now()
  FROM tgt
  WHERE a.kapt_code = tgt.kapt_code
    AND a.molit_aliases IS DISTINCT FROM tgt.aliases;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$function$
;
