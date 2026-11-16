-- 2026-11-16 전면 감사 발견 13: anon 과 authenticated 역할에 쓰지 않는 쓰기 권한이 24개 표에 남아 있었다.
-- 운영자가 SQL Editor 에서 실행한다(운영 DB 쓰기는 운영자 몫).
--
-- 원칙: 지금 동작을 바꾸지 않는다. 행 단위 보안(RLS) 정책이 이미 허용하지 않는 권한만 걷는다.
--   1) 조회(SELECT) 권한은 하나도 건드리지 않는다.
--   2) TRUNCATE, REFERENCES, TRIGGER 는 두 역할 모두에서 걷는다. TRUNCATE 는 RLS 가 막는 대상이 아니다.
--   3) anon 의 INSERT, UPDATE, DELETE 는 모두 걷는다. anon 에게 쓰기를 허용하는 정책이 하나도 없다(2026-11-16 pg_policies 조회).
--   4) authenticated 는 쓰기 정책이 있는 표와 명령만 남긴다.
--        bookmarks, chat_sessions, field_notes: INSERT, UPDATE, DELETE 유지(정책 있음)
--        chat_messages, search_history: INSERT, DELETE 유지(정책 있음), UPDATE 는 정책이 없어 걷는다
--        그 밖 19개 표: 쓰기 정책이 없어 INSERT, UPDATE, DELETE 를 걷는다
--   서버의 적재와 관리 작업은 service_role 로 하므로 영향이 없다.
--
-- 되돌리기: 아래 revoke 를 같은 표와 역할에 grant 로 바꿔 실행한다.

begin;

-- 2) 두 역할 모두: TRUNCATE, REFERENCES, TRIGGER
revoke truncate, references, trigger on table
  public.account_deletion_requests, public.activity_counters, public.ai_feedback, public.apt_dim_recovery_queue,
  public.audit_log, public.billing_plans, public.bookmarks, public.briefing_snapshots,
  public.chat_messages, public.chat_sessions, public.data_error_reports, public.field_notes,
  public.kakao_notify_tokens, public.molit_apt_dim, public.molit_hist_peaks, public.molit_hist_runs,
  public.molit_ingest_runs, public.payments, public.popular_apts_snapshot, public.push_subscriptions,
  public.regulations_snapshot, public.search_history, public.user_billing, public.user_budget
from anon, authenticated;

-- 3) anon: 쓰기 전부
revoke insert, update, delete on table
  public.account_deletion_requests, public.activity_counters, public.ai_feedback, public.apt_dim_recovery_queue,
  public.audit_log, public.billing_plans, public.bookmarks, public.briefing_snapshots,
  public.chat_messages, public.chat_sessions, public.data_error_reports, public.field_notes,
  public.kakao_notify_tokens, public.molit_apt_dim, public.molit_hist_peaks, public.molit_hist_runs,
  public.molit_ingest_runs, public.payments, public.popular_apts_snapshot, public.push_subscriptions,
  public.regulations_snapshot, public.search_history, public.user_billing, public.user_budget
from anon;

-- 4) authenticated: 쓰기 정책이 없는 19개 표
revoke insert, update, delete on table
  public.account_deletion_requests, public.activity_counters, public.ai_feedback, public.apt_dim_recovery_queue,
  public.audit_log, public.billing_plans, public.briefing_snapshots, public.data_error_reports,
  public.kakao_notify_tokens, public.molit_apt_dim, public.molit_hist_peaks, public.molit_hist_runs,
  public.molit_ingest_runs, public.payments, public.popular_apts_snapshot, public.push_subscriptions,
  public.regulations_snapshot, public.user_billing, public.user_budget
from authenticated;

-- 4) authenticated: UPDATE 정책이 없는 두 표
revoke update on table public.chat_messages, public.search_history from authenticated;

commit;

-- 실행 뒤 확인(조회만). 기대: anon 줄은 0, authenticated 줄은 5개 표만 나온다.
--   bookmarks DELETE,INSERT,UPDATE / chat_sessions DELETE,INSERT,UPDATE / field_notes DELETE,INSERT,UPDATE
--   chat_messages DELETE,INSERT / search_history DELETE,INSERT
select grantee, table_name, string_agg(privilege_type, ',' order by privilege_type) as privs
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated')
  and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
group by 1, 2 order by 1, 2;
