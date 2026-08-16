-- POLICY-ROLE-DRIFT-2026-08-16 (Plan 021) — RLS 정책의 role 스코프를 설계 의도로 복원
--
-- [드리프트 경위 — 파일 이력 실측]
--   · 20260426000003_field_notes.sql / 20260425000009_ai_feedback.sql 은 정책을 `TO authenticated` 로 만들었다.
--   · 20260504000003_security_perf_advisor_fixes.sql 이 advisor 의 auth_rls_initplan 경고를 잡으려고
--     `auth.uid()` → `(SELECT auth.uid())` 로 바꾸면서 **DROP + CREATE 를 했는데 `TO` 절을 빠뜨렸다**
--     → role 이 PUBLIC 으로 격하.
--   · 20260531000001 이 `ai_feedback_insert_own` **하나만** 되돌렸고 나머지 5개는 그대로 남았다.
--   2026-08-16 프로덕션 실측(pg_policy.polroles)에서 아래 5개가 PUBLIC 인 것을 확인했다.
--
-- [영향 판정 — 뚫린 구멍은 아니었다]
--   5개 모두 USING/WITH CHECK 가 `(SELECT auth.uid()) = user_id` 다. anon 은 auth.uid() 가 NULL 이라
--   비교가 NULL → 행이 보이지도, INSERT 되지도 않는다. 즉 **기능적으로는 이미 차단**돼 있었다.
--   그래서 이건 취약점 수정이 아니라 **"의도와 실제의 불일치"를 없애는 심층방어 정리**다.
--
-- [안전성 근거 — 이 변경으로 깨지는 경로가 없다]
--   · backend/routes/fieldNotes.js 는 `getUserScopedClient(token)` 로 **사용자 JWT** 를 실어 부른다
--     → PostgREST 가 role 을 `authenticated` 로 해석하므로 정책이 그대로 적용된다.
--   · backend/routes/feedback.js·account.js 는 service_role(getSupabaseAdmin) → RLS 자체를 우회한다.
--   · frontend/index.html 에서 이 두 테이블을 직접 조회하는 코드는 **0건**(grep 실측).
--
-- [적용 방식] DROP+CREATE 가 아니라 `ALTER POLICY … TO authenticated` 만 쓴다.
--   USING/WITH CHECK 식을 손대지 않으므로 20260504000003 이 만든 initplan 최적화 형태가 보존된다.
--   (같은 실수를 반복하지 않는 방법이기도 하다 — DROP+CREATE 를 하면 또 무언가를 빠뜨릴 수 있다.)
ALTER POLICY field_notes_select_own  ON public.field_notes  TO authenticated;
ALTER POLICY field_notes_insert_own  ON public.field_notes  TO authenticated;
ALTER POLICY field_notes_update_own  ON public.field_notes  TO authenticated;
ALTER POLICY field_notes_delete_own  ON public.field_notes  TO authenticated;
ALTER POLICY ai_feedback_select_own  ON public.ai_feedback  TO authenticated;

-- [적용 후 실측 확인 — 2026-08-16]
--   위 5개 polroles = {authenticated}, USING/WITH CHECK 는 전부 `(SELECT auth.uid()) = user_id` 유지.
--   `ai_feedback_insert_anon`(TO anon, `user_id IS NULL`)과 `ai_feedback_service_all`(TO service_role)은
--   의도된 정책이라 건드리지 않았다.
--
-- [건드리지 않은 PUBLIC 정책들 — 의도적]
--   molit_transactions·apt_geocache·regulations_snapshot·popular_apts_snapshot·building_register 의
--   `USING (true)` 공개 read 정책과 molit_ingest_runs 의 `USING (false)` 는 **설계된 공개/차단**이다.
--   billing_plans_public_read 는 `USING (active = true)` 로 요금제 노출이 목적이다.
