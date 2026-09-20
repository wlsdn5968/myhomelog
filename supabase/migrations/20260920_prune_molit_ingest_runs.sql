-- ============================================================================
-- 2026-09-20 — Plan 106. 운영자 승인 후 리뷰어가 프로덕션에 execute_sql 로 적용 예정
--   (이 커밋 시점에는 아직 미적용 — 코드(backend/jobs/retention.js)는 이 함수 존재를 전제로
--   rpc('prune_molit_ingest_runs', ...) 를 호출하므로, DDL 적용과 코드 배포 순서를 지킬 것:
--   DDL 먼저 → 배포. 적용 후에는 이 헤더를 "적용 기록"으로 갱신한다(Plan 026 관례).
-- ============================================================================
-- [무엇인가]
--   molit_ingest_runs 43,455행(9.6MB) 중 ok 43,097행은 매일 (지역×월) 재적재로 무한 증가한다.
--   기존 retention(90일 무조건 삭제)은 오래된 (지역,월) 쌍의 ok 기록을 전부 지워
--   getTransactionsFromDb(backend/services/transactionService.js:34~47)가 "이 달은 적재된 적 없다"
--   로 오판 → MOLIT API 로 직접 호출하게 만든다(2026-09-20 실측: 2025-11~2026-01 125지역 중
--   84~85곳만 ok 기록 생존, 2026-11 중순이면 3개월보다 오래된 모든 달이 같은 상태가 된다).
--   그래서 (지역,월)별 최신 ok 1건은 영구 보존하고 나머지만 14일 지나면 지운다.
-- [근거 수치 — 리뷰어 드라이런, 2026-09-20 11:4x UTC 읽기 전용]
--   전체 43,455행 = ok 43,097 + error/running 358. DELETE 시뮬레이션: 삭제 36,274행 · 남는 ok 6,823 ·
--   ok 보유 (지역,월) 1,948쌍 중 ok 를 전부 잃는 쌍 0개(불변식 통과) · 14일 이내 ok 5,250행 전부 보존.
-- [되돌리기 SQL]
--   DROP FUNCTION public.prune_molit_ingest_runs(integer);
-- ============================================================================

CREATE OR REPLACE FUNCTION public.prune_molit_ingest_runs(p_keep_days integer DEFAULT 14) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE n integer;
BEGIN
  -- (지역,월)별 가장 최근 ok 1건은 영구 보존 — getTransactionsFromDb 가 "이 달은 적재됐다" 를 이 기록으로 판단한다.
  DELETE FROM public.molit_ingest_runs r
  USING (SELECT lawd_cd, deal_ym, max(id) AS keep_id FROM public.molit_ingest_runs WHERE status = 'ok' GROUP BY 1, 2) k
  WHERE r.status = 'ok' AND r.lawd_cd = k.lawd_cd AND r.deal_ym = k.deal_ym AND r.id <> k.keep_id
    AND r.started_at < now() - make_interval(days => p_keep_days);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $function$;
REVOKE EXECUTE ON FUNCTION public.prune_molit_ingest_runs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_molit_ingest_runs(integer) TO service_role;
