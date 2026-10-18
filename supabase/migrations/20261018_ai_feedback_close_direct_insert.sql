-- 20261018_ai_feedback_close_direct_insert.sql
-- ⚠ 운영자 SQL Editor 실행용 (이 환경의 apply_migration·execute_sql 은 정책 삭제를 거절한다 — 메모리 public-key-surface-reduction)
--
-- [근거 · 2026-10-18 운영 DB 조회]
--   ai_feedback 에 ai_feedback_insert_anon(anon, with_check user_id IS NULL) · ai_feedback_insert_own(authenticated) 정책이 있다.
--   index.html 메타의 공개 키만으로 POST /rest/v1/ai_feedback 에 길이 제한 없는 comment·reply_preview 를 직접 넣을 수 있다
--   (backend/routes/feedback.js 의 500자·200자 제한과 요청 제한을 거치지 않는다). 이 테이블은 보관 정리도 없다.
--   쓰는 곳은 backend/routes/feedback.js:55 하나이고 getSupabaseAdmin()(service_role)이라 두 INSERT 정책이 필요 없다.
--   프런트에서 ai_feedback 을 직접 읽거나 쓰는 코드는 0건(grep).
--   현재 4행, comment 최대 null · reply_preview 최대 197자 → 아래 CHECK 를 이미 만족한다.

begin;

drop policy if exists ai_feedback_insert_anon on public.ai_feedback;
drop policy if exists ai_feedback_insert_own  on public.ai_feedback;

-- 백엔드 상한(MAX_COMMENT_LEN 500 · MAX_PREVIEW_LEN 200)과 같은 값 — service_role 경로에도 최종 방어선
alter table public.ai_feedback
  add constraint ai_feedback_comment_len_chk       check (comment is null or char_length(comment) <= 500),
  add constraint ai_feedback_reply_preview_len_chk check (reply_preview is null or char_length(reply_preview) <= 200);

commit;

-- [실행 뒤 확인] 아래 두 결과가 각각 0행 · 2행이어야 한다.
-- select policyname from pg_policies where schemaname='public' and tablename='ai_feedback' and cmd='INSERT';
-- select conname from pg_constraint where conrelid='public.ai_feedback'::regclass and conname like 'ai_feedback_%_len_chk';
