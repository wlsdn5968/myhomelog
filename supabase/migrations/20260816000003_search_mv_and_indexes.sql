-- SEARCH-MV-2026-08-16 (Plan 026) — 오늘 프로덕션에 적용한 DDL 3종을 **사후 기록**한다.
--
-- ⚠ 이 파일은 "앞으로 적용할 것"이 아니라 **"이미 적용된 것의 기록"** 이다.
--   [경위] 검색 성능 작업(Sprint TTTTTTT)과 계획 009 에서 `execute_sql` 로 프로덕션에 직접 적용했고,
--     그 SQL 은 gitignored 인 `.local-notes/SPRINT_NOTES` 에만 남겼다. 저장소만 보면 존재를 알 수 없었다.
--   [왜 문제인가] 같은 날 계획 019 가 "마이그레이션 파일 ↔ 프로덕션 대조"를 하며 **파일에 없는 객체가
--     프로덕션에 있는 상황**(`tg_set_updated_at`)을 문제로 지적했는데, 바로 그 상황을 내가 3건 더 만들었다.
--     감사 워크플로가 이 모순을 잡아냈다.
--   [정합성] 아래 정의는 추측이 아니라 **2026-08-16 프로덕션에서 그대로 덤프**한 것이다
--     (`pg_get_viewdef` · `pg_indexes.indexdef` · `pg_get_functiondef` · `pg_class.relacl`).
--     따라서 이 파일을 빈 DB 에 실행하면 현재 프로덕션과 같은 상태가 된다.
--   전부 IF NOT EXISTS / OR REPLACE 라 **프로덕션에 재실행해도 무해**하다.

-- ── 1. 검색용 단지 집계 MV ────────────────────────────────────────────────────
--   [배경] 검색이 340K행 `molit_transactions` 를 2글자 ILIKE 로 훑어 7.4초 + 간헐 500(anon
--     statement_timeout 3s). 단지 단위로 미리 집계해 917ms → 32ms 가 됐다(실측).
--   [주의] `deal_count` 는 **단지 누적 거래 수**다. 조회 창(예: 최근 6개월) 내 건수가 아니다 —
--     search.js 가 이 값을 `_w` 가중치로 쓰므로 그룹핑 시 "1행 = 1거래" 전제로 세면 안 된다.
CREATE MATERIALIZED VIEW IF NOT EXISTS public.molit_apt_index AS
 SELECT apt_name,
    lawd_cd,
    sigungu,
    umd_nm,
    build_year,
    max(deal_date) AS recent_deal_date,
    count(*)::integer AS deal_count,
    (array_agg(apt_seq ORDER BY deal_date DESC))[1] AS apt_seq
   FROM molit_transactions
  GROUP BY apt_name, lawd_cd, sigungu, umd_nm, build_year;

--   REFRESH ... CONCURRENTLY 는 **유니크 인덱스가 반드시 있어야** 동작한다.
CREATE UNIQUE INDEX IF NOT EXISTS uq_molit_apt_index
  ON public.molit_apt_index USING btree (apt_name, lawd_cd, sigungu, umd_nm, build_year);

-- ── 2. MV 갱신 RPC (cron 이 호출) ─────────────────────────────────────────────
--   SECURITY DEFINER + search_path 고정. EXECUTE 는 service_role 만(아래 REVOKE/GRANT).
CREATE OR REPLACE FUNCTION public.refresh_molit_apt_index()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.molit_apt_index;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_molit_apt_index() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.refresh_molit_apt_index() TO service_role;

-- ── 3. deal_date 단독 정렬 인덱스 ─────────────────────────────────────────────
--   [배경] `ORDER BY deal_date DESC LIMIT 1`(최신 적재일 조회)이 2,236ms 였다.
--     기존 `idx_molit_lawd_date (lawd_cd, deal_date DESC)` 는 선행 컬럼이 없어 이 정렬을 못 탄다.
--     이 인덱스 추가 후 **0.119ms**(Sort 노드 소멸, Heap Fetches 0) — 실측.
--   ⚠ 프로덕션 최초 적용은 `CREATE INDEX CONCURRENTLY` 로 했다(테이블 잠금 회피).
--     CONCURRENTLY 는 트랜잭션 블록 안에서 못 쓰므로 이 파일에는 일반 형태로 적는다.
--     **운영 중 재적용이 필요하면 반드시 CONCURRENTLY 로** 따로 실행할 것.
CREATE INDEX IF NOT EXISTS idx_molit_deal_date
  ON public.molit_transactions USING btree (deal_date DESC);

-- ── 보안 메모 (2026-08-16 실측) ───────────────────────────────────────────────
-- · MV 의 relacl 은 `anon=arwdDxtm / authenticated=arwdDxtm / service_role=arwdDxtm` 로
--   Supabase 기본 광범위 grant 그대로다. 일반 테이블이라면 RLS+정책이 실제 방어선인데
--   **MV 에는 RLS 를 걸 수 없다**(relkind='m').
-- · 그럼에도 쓰기는 **구조적으로 불가능**하다 — Postgres 가 권한과 무관하게 거부한다.
--   실측(2026-08-16, 롤백 블록): INSERT/UPDATE/DELETE 모두
--   `42809: cannot change materialized view "molit_apt_index"`.
-- · anon SELECT 는 **의도**다(검색이 공개 키로 읽는다). 담긴 값은 `molit_transactions`
--   (공개 read 정책 `molit_tx_public_read USING(true)` 보유)의 집계라 노출이 늘지 않는다.
--   → Supabase advisor 의 `materialized_view_in_api`(WARN)는 이 근거로 **의도적 잔존**이다.
--   권한을 회수하면 검색이 깨진다.
