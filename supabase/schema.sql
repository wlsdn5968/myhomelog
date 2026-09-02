-- ============================================================================
-- myhomelog — 프로덕션 public 스키마 스냅샷
-- ============================================================================
-- 생성: 2026-09-02 (감사 후속 P2)
--
-- [왜 이 파일이 필요한가]
--   supabase/migrations/ 만으로는 프로덕션을 **재현할 수 없다**. 전수 대조 결과:
--     · CREATE TABLE 이 어느 마이그레이션에도 없는 테이블이 있다
--       (bookmarks · search_history · chat_sessions · chat_messages · user_billing ·
--        payments · billing_plans · building_register · popular_apts_snapshot)
--     · 파일명에 시퀀스가 없는 마이그레이션이 7개(같은 날짜끼리 적용 순서 불명)
--     · "이미 프로덕션에 적용된 것을 나중에 커밋" 이라고 스스로 밝힌 파일이 8개
--   이 저장소는 이미 "마이그레이션 파일 존재 ≠ 프로덕션 적용" 사고를 겪었다
--   (regulations overlap GIST 제약이 3개월 넘게 미적용이었다).
--
-- [무엇인가]
--   pg_catalog 를 직접 읽어 만든 **현재 상태의 사진**이다. 마이그레이션을 대체하지 않는다.
--   · 데이터는 포함하지 않는다(스키마만). 소유자/권한(GRANT) 구문도 제외했다.
--   · 이 파일을 그대로 실행해 빈 DB 를 만들 수 있다는 보장은 없다 —
--     확장·auth 스키마·시퀀스 소유권 등 Supabase 관리 영역이 빠져 있다.
--   · 용도는 **대조**다: 코드가 가정하는 스키마와 실제가 어긋났는지 볼 때 여기를 본다.
--
-- [갱신 방법]
--   DDL 을 적용한 뒤 같은 pg_catalog 질의로 다시 뽑아 이 파일을 교체한다.
--   ⚠ 뽑은 결과에 키·토큰 문자열이 없는지 확인할 것(생성 스크립트가 자동 검사한다).
-- ============================================================================
-- ============ EXTENSIONS ============
create extension if not exists btree_gist with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_stat_statements with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists supabase_vault with schema vault;
create extension if not exists "uuid-ossp" with schema extensions;

-- ============ TABLES ============

create table if not exists public.account_deletion_requests (
  user_id uuid not null,
  requested_at timestamp with time zone default now() not null,
  scheduled_hard_delete_at timestamp with time zone default (now() + '30 days'::interval) not null,
  status text default 'pending'::text not null,
  restored_at timestamp with time zone,
  hard_deleted_at timestamp with time zone,
  reason text,
  email_at_request text,
  ip_masked text,
  user_agent text
);

create table if not exists public.activity_counters (
  user_id uuid not null,
  year integer not null,
  kind text not null,
  cnt bigint default 0 not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.ai_feedback (
  id bigint default nextval('ai_feedback_id_seq'::regclass) not null,
  user_id uuid,
  session_id uuid,
  message_hash text not null,
  rating smallint not null,
  comment text,
  reply_preview text,
  source text default 'chat'::text,
  created_at timestamp with time zone default now()
);

create table if not exists public.apt_amenities (
  cache_key text not null,
  lat numeric not null,
  lng numeric not null,
  category text not null,
  radius integer not null,
  count integer not null,
  fetched_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create table if not exists public.apt_geocache (
  id bigint default nextval('apt_geocache_id_seq'::regclass) not null,
  apt_key text not null,
  apt_name text not null,
  sigungu text,
  umd_nm text,
  address text,
  place_name text,
  lat numeric(10,7) not null,
  lng numeric(10,7) not null,
  source text default 'kakao'::text not null,
  cached_at timestamp with time zone default now() not null
);

create table if not exists public.apt_master (
  kapt_code text not null,
  apt_name text not null,
  lawd_cd text not null,
  sigungu text,
  umd_nm text,
  facility jsonb,
  facility_fetched_at timestamp with time zone,
  source text default 'aptinfo'::text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  molit_aliases jsonb default '[]'::jsonb
);

create table if not exists public.apt_schools (
  apt_key text not null,
  apt_name text,
  sigungu text,
  umd_nm text,
  schools jsonb default '[]'::jsonb not null,
  source text default 'kakao'::text,
  fetched_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create table if not exists public.audit_log (
  id bigint default nextval('audit_log_id_seq'::regclass) not null,
  user_id uuid,
  actor text default 'system'::text not null,
  action text not null,
  target_type text,
  target_id text,
  meta jsonb default '{}'::jsonb not null,
  ip_masked text,
  user_agent text,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.billing_plans (
  id text not null,
  name text not null,
  price_krw integer not null,
  features jsonb default '[]'::jsonb not null,
  active boolean default true not null,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.bookmarks (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  kapt_code text not null,
  display_name text not null,
  address text,
  memo text,
  tags text[] default '{}'::text[] not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  avg_price numeric
);

create table if not exists public.briefing_snapshots (
  day date not null,
  payload jsonb not null,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.building_register (
  id bigint not null,
  apt_key text not null,
  sigungu_cd text,
  bjdong_cd text,
  bun text,
  ji text,
  title jsonb,
  source text default 'bldrgsthub'::text,
  fetched_at timestamp with time zone default now()
);

create table if not exists public.chat_messages (
  id uuid default gen_random_uuid() not null,
  session_id uuid not null,
  role text not null,
  content text not null,
  meta jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  client_msg_id uuid
);

create table if not exists public.chat_sessions (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  title text default '새 대화'::text not null,
  last_message_at timestamp with time zone default now() not null,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.data_error_reports (
  id bigint not null,
  created_at timestamp with time zone default now() not null,
  apt_name text,
  lawd_cd text,
  field text,
  detail text not null,
  user_id uuid,
  page text
);

create table if not exists public.field_notes (
  user_id uuid not null,
  apt_name text not null,
  checks jsonb default '[]'::jsonb,
  rating smallint,
  memo text,
  visit_date date,
  updated_at timestamp with time zone default now(),
  created_at timestamp with time zone default now()
);

create table if not exists public.kakao_notify_tokens (
  user_id uuid not null,
  access_token text not null,
  refresh_token text,
  expires_at timestamp with time zone,
  items jsonb default '[]'::jsonb not null,
  linked_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  last_notified_at timestamp with time zone,
  fail_count integer default 0 not null
);

create table if not exists public.molit_ingest_runs (
  id bigint default nextval('molit_ingest_runs_id_seq'::regclass) not null,
  started_at timestamp with time zone default now() not null,
  finished_at timestamp with time zone,
  lawd_cd character(5) not null,
  deal_ym character(6) not null,
  rows_fetched integer,
  rows_inserted integer,
  status text default 'running'::text not null,
  error_message text
);

create table if not exists public.molit_transactions (
  id bigint default nextval('molit_transactions_id_seq'::regclass) not null,
  lawd_cd character(5) not null,
  apt_seq text,
  apt_name text not null,
  sigungu text,
  umd_nm text,
  exclu_use_ar numeric(7,2) not null,
  build_year integer,
  floor integer,
  deal_year integer not null,
  deal_month integer not null,
  deal_day integer not null,
  deal_date date not null,
  deal_amount bigint not null,
  source text default 'molit'::text not null,
  ingested_at timestamp with time zone default now() not null,
  dedup_key text default md5(((((((((((COALESCE(apt_seq, ((apt_name || ':'::text) || COALESCE(umd_nm, ''::text))) || '|'::text) || (exclu_use_ar)::text) || '|'::text) || (deal_year)::text) || '-'::text) || (deal_month)::text) || '-'::text) || (deal_day)::text) || '|'::text) || (COALESCE(floor, 0))::text)),
  jibun text
);

create table if not exists public.payments (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  order_id text not null,
  toss_payment_key text,
  amount numeric(12,2) not null,
  currency text default 'KRW'::text not null,
  status text default 'requested'::text not null,
  plan text not null,
  method text,
  failure_reason text,
  raw_response jsonb,
  created_at timestamp with time zone default now() not null,
  approved_at timestamp with time zone
);

create table if not exists public.popular_apts_snapshot (
  id integer default 1 not null,
  payload jsonb not null,
  computed_at timestamp with time zone default now() not null
);

create table if not exists public.push_subscriptions (
  id bigint not null,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  items jsonb default '[]'::jsonb not null,
  user_id uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  last_notified_at timestamp with time zone,
  fail_count integer default 0 not null
);

create table if not exists public.regulations_snapshot (
  id bigint default nextval('regulations_snapshot_id_seq'::regclass) not null,
  key text not null,
  valid_from timestamp with time zone not null,
  valid_to timestamp with time zone,
  data jsonb not null,
  source_url text,
  source_effective_date date,
  note text,
  created_at timestamp with time zone default now(),
  created_by text
);

create table if not exists public.search_history (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  query text not null,
  query_type text not null,
  result_count integer,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.user_billing (
  user_id uuid not null,
  plan text default 'free'::text not null,
  status text default 'active'::text not null,
  toss_billing_key text,
  toss_customer_key text,
  current_period_start timestamp with time zone,
  current_period_end timestamp with time zone,
  canceled_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.user_budget (
  user_id uuid not null,
  month date not null,
  input_tokens bigint default 0 not null,
  output_tokens bigint default 0 not null,
  cost_usd_x1000 bigint default 0 not null,
  request_count integer default 0 not null,
  last_request_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.visit_attribution (
  id bigint default nextval('visit_attribution_id_seq'::regclass) not null,
  created_at timestamp with time zone default now() not null,
  event text not null,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  referrer_host text,
  landing_path text
);

-- ============ CONSTRAINTS ============
alter table public.account_deletion_requests add constraint account_deletion_requests_pkey PRIMARY KEY (user_id);
alter table public.account_deletion_requests add constraint account_deletion_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'restored'::text, 'hard_deleted'::text])));
alter table public.activity_counters add constraint activity_counters_kind_check CHECK ((kind = ANY (ARRAY['detail_view'::text, 'search'::text])));
alter table public.activity_counters add constraint activity_counters_pkey PRIMARY KEY (user_id, year, kind);
alter table public.ai_feedback add constraint ai_feedback_pkey PRIMARY KEY (id);
alter table public.ai_feedback add constraint ai_feedback_rating_check CHECK ((rating = ANY (ARRAY['-1'::integer, 1])));
alter table public.ai_feedback add constraint ai_feedback_session_id_fkey FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE SET NULL;
alter table public.ai_feedback add constraint ai_feedback_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public.apt_amenities add constraint apt_amenities_pkey PRIMARY KEY (cache_key);
alter table public.apt_geocache add constraint apt_geocache_apt_key_key UNIQUE (apt_key);
alter table public.apt_geocache add constraint apt_geocache_lat_range CHECK (((lat >= (33)::numeric) AND (lat <= (39)::numeric)));
alter table public.apt_geocache add constraint apt_geocache_lng_range CHECK (((lng >= (124)::numeric) AND (lng <= (132)::numeric)));
alter table public.apt_geocache add constraint apt_geocache_pkey PRIMARY KEY (id);
alter table public.apt_master add constraint apt_master_pkey PRIMARY KEY (kapt_code);
alter table public.apt_schools add constraint apt_schools_pkey PRIMARY KEY (apt_key);
alter table public.audit_log add constraint audit_log_pkey PRIMARY KEY (id);
alter table public.billing_plans add constraint billing_plans_pkey PRIMARY KEY (id);
alter table public.bookmarks add constraint bookmarks_pkey PRIMARY KEY (id);
alter table public.bookmarks add constraint bookmarks_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.bookmarks add constraint bookmarks_user_id_kapt_code_key UNIQUE (user_id, kapt_code);
alter table public.briefing_snapshots add constraint briefing_snapshots_pkey PRIMARY KEY (day);
alter table public.building_register add constraint building_register_apt_key_key UNIQUE (apt_key);
alter table public.building_register add constraint building_register_pkey PRIMARY KEY (id);
alter table public.chat_messages add constraint chat_messages_pkey PRIMARY KEY (id);
alter table public.chat_messages add constraint chat_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text])));
alter table public.chat_messages add constraint chat_messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE;
alter table public.chat_sessions add constraint chat_sessions_pkey PRIMARY KEY (id);
alter table public.chat_sessions add constraint chat_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.data_error_reports add constraint data_error_reports_pkey PRIMARY KEY (id);
alter table public.field_notes add constraint field_notes_pkey PRIMARY KEY (user_id, apt_name);
alter table public.field_notes add constraint field_notes_rating_check CHECK (((rating >= 0) AND (rating <= 5)));
alter table public.field_notes add constraint field_notes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.kakao_notify_tokens add constraint kakao_notify_tokens_pkey PRIMARY KEY (user_id);
alter table public.kakao_notify_tokens add constraint kakao_notify_tokens_user_fk FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.molit_ingest_runs add constraint molit_ingest_runs_pkey PRIMARY KEY (id);
alter table public.molit_ingest_runs add constraint molit_ingest_runs_status_chk CHECK ((status = ANY (ARRAY['running'::text, 'ok'::text, 'error'::text, 'skipped'::text])));
alter table public.molit_transactions add constraint molit_transactions_pkey PRIMARY KEY (id);
alter table public.payments add constraint payments_order_id_key UNIQUE (order_id);
alter table public.payments add constraint payments_pkey PRIMARY KEY (id);
alter table public.payments add constraint payments_status_check CHECK ((status = ANY (ARRAY['requested'::text, 'authorized'::text, 'captured'::text, 'canceled'::text, 'failed'::text])));
alter table public.payments add constraint payments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.popular_apts_snapshot add constraint popular_apts_snapshot_id_check CHECK ((id = 1));
alter table public.popular_apts_snapshot add constraint popular_apts_snapshot_pkey PRIMARY KEY (id);
alter table public.push_subscriptions add constraint push_subscriptions_endpoint_key UNIQUE (endpoint);
alter table public.push_subscriptions add constraint push_subscriptions_pkey PRIMARY KEY (id);
alter table public.regulations_snapshot add constraint regulations_snapshot_no_overlap EXCLUDE USING gist (key WITH =, tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamp with time zone)) WITH &&);
alter table public.regulations_snapshot add constraint regulations_snapshot_pkey PRIMARY KEY (id);
alter table public.search_history add constraint search_history_pkey PRIMARY KEY (id);
alter table public.search_history add constraint search_history_query_type_check CHECK ((query_type = ANY (ARRAY['recommend'::text, 'address'::text, 'kapt'::text, 'keyword'::text])));
alter table public.search_history add constraint search_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.user_billing add constraint user_billing_pkey PRIMARY KEY (user_id);
alter table public.user_billing add constraint user_billing_plan_check CHECK ((plan = ANY (ARRAY['free'::text, 'pro'::text, 'team'::text])));
alter table public.user_billing add constraint user_billing_status_check CHECK ((status = ANY (ARRAY['active'::text, 'past_due'::text, 'canceled'::text, 'incomplete'::text])));
alter table public.user_billing add constraint user_billing_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.user_budget add constraint user_budget_pkey PRIMARY KEY (user_id, month);
alter table public.visit_attribution add constraint visit_attribution_pkey PRIMARY KEY (id);

-- ============ INDEXES ============
CREATE UNIQUE INDEX chat_messages_session_client_msg_unique ON public.chat_messages USING btree (session_id, client_msg_id) WHERE (client_msg_id IS NOT NULL);
CREATE INDEX idx_adr_status_scheduled ON public.account_deletion_requests USING btree (status, scheduled_hard_delete_at) WHERE (status = 'pending'::text);
CREATE INDEX idx_ai_feedback_created ON public.ai_feedback USING btree (created_at DESC);
CREATE INDEX idx_ai_feedback_rating ON public.ai_feedback USING btree (rating, created_at DESC);
CREATE INDEX idx_ai_feedback_session ON public.ai_feedback USING btree (session_id);
CREATE INDEX idx_ai_feedback_user ON public.ai_feedback USING btree (user_id, created_at DESC);
CREATE INDEX idx_apt_amenities_fetched ON public.apt_amenities USING btree (fetched_at);
CREATE INDEX idx_apt_geocache_name ON public.apt_geocache USING btree (apt_name);
CREATE INDEX idx_apt_geocache_region ON public.apt_geocache USING btree (sigungu, umd_nm);
CREATE INDEX idx_apt_master_lawd ON public.apt_master USING btree (lawd_cd);
CREATE INDEX idx_apt_master_name_trgm ON public.apt_master USING gin (apt_name gin_trgm_ops);
CREATE INDEX idx_apt_master_sigungu_umd ON public.apt_master USING btree (sigungu, umd_nm);
CREATE INDEX idx_apt_master_umd_trgm ON public.apt_master USING gin (umd_nm gin_trgm_ops);
CREATE INDEX idx_apt_schools_fetched ON public.apt_schools USING btree (fetched_at);
CREATE INDEX idx_audit_log_action_created ON public.audit_log USING btree (action, created_at DESC);
CREATE INDEX idx_audit_log_target ON public.audit_log USING btree (target_type, target_id);
CREATE INDEX idx_audit_log_user_created ON public.audit_log USING btree (user_id, created_at DESC);
CREATE INDEX idx_bookmarks_user ON public.bookmarks USING btree (user_id, created_at DESC);
CREATE INDEX idx_chat_messages_session ON public.chat_messages USING btree (session_id, created_at);
CREATE INDEX idx_chat_sessions_user ON public.chat_sessions USING btree (user_id, last_message_at DESC);
CREATE INDEX idx_field_notes_user_updated ON public.field_notes USING btree (user_id, updated_at DESC);
CREATE INDEX idx_molit_apt_seq ON public.molit_transactions USING btree (apt_seq) WHERE (apt_seq IS NOT NULL);
CREATE INDEX idx_molit_aptname_trgm ON public.molit_transactions USING gin (apt_name gin_trgm_ops);
CREATE INDEX idx_molit_aptseq_area_date ON public.molit_transactions USING btree (apt_seq, exclu_use_ar, deal_date) WHERE (apt_seq IS NOT NULL);
CREATE INDEX idx_molit_deal_date ON public.molit_transactions USING btree (deal_date DESC);
CREATE INDEX idx_molit_lawd_date ON public.molit_transactions USING btree (lawd_cd, deal_date DESC);
CREATE INDEX idx_molit_runs_lawd_ym ON public.molit_ingest_runs USING btree (lawd_cd, deal_ym, status);
CREATE INDEX idx_molit_runs_status ON public.molit_ingest_runs USING btree (status, started_at DESC);
CREATE INDEX idx_molit_umdnm_trgm ON public.molit_transactions USING gin (umd_nm gin_trgm_ops);
CREATE INDEX idx_payments_status ON public.payments USING btree (status) WHERE (status <> 'captured'::text);
CREATE INDEX idx_payments_user_created ON public.payments USING btree (user_id, created_at DESC);
CREATE INDEX idx_push_subs_updated ON public.push_subscriptions USING btree (updated_at DESC);
CREATE INDEX idx_reg_snapshot_key_valid ON public.regulations_snapshot USING btree (key, valid_from DESC);
CREATE INDEX idx_search_history_user ON public.search_history USING btree (user_id, created_at DESC);
CREATE INDEX idx_user_budget_month_cost ON public.user_budget USING btree (month, cost_usd_x1000 DESC);
CREATE INDEX idx_visit_attr_created ON public.visit_attribution USING btree (created_at DESC);
CREATE INDEX idx_visit_attr_event ON public.visit_attribution USING btree (event, created_at DESC);
CREATE UNIQUE INDEX uq_apt_geocache_name_region ON public.apt_geocache USING btree (apt_name, COALESCE(sigungu, ''::text), COALESCE(umd_nm, ''::text));
CREATE UNIQUE INDEX uq_apt_master_name_lawd_umd ON public.apt_master USING btree (apt_name, lawd_cd, COALESCE(umd_nm, ''::text));
CREATE UNIQUE INDEX uq_molit_apt_index ON public.molit_apt_index USING btree (apt_name, lawd_cd, sigungu, umd_nm, build_year);
CREATE UNIQUE INDEX uq_molit_dedup ON public.molit_transactions USING btree (dedup_key);

-- ============ MATERIALIZED VIEWS ============
create materialized view if not exists public.molit_apt_index as
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

-- ============ FUNCTIONS ============
CREATE OR REPLACE FUNCTION public.active_lawd_codes(since_date date DEFAULT NULL::date)
 RETURNS TABLE(lawd_cd text, last_deal date)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH RECURSIVE codes AS (
    (SELECT t.lawd_cd FROM molit_transactions t ORDER BY t.lawd_cd LIMIT 1)
    UNION ALL
    SELECT (SELECT m.lawd_cd FROM molit_transactions m
            WHERE m.lawd_cd > c.lawd_cd ORDER BY m.lawd_cd LIMIT 1)
    FROM codes c WHERE c.lawd_cd IS NOT NULL)
  SELECT c.lawd_cd,
         (SELECT max(t.deal_date) FROM molit_transactions t WHERE t.lawd_cd = c.lawd_cd) AS last_deal
  FROM codes c
  WHERE c.lawd_cd IS NOT NULL
    AND (since_date IS NULL
         OR (SELECT max(t.deal_date) FROM molit_transactions t WHERE t.lawd_cd = c.lawd_cd) >= since_date);
$function$
;

CREATE OR REPLACE FUNCTION public.bump_activity_counter(p_user uuid, p_year integer, p_kind text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  INSERT INTO activity_counters(user_id, year, kind, cnt) VALUES (p_user, p_year, p_kind, 1)
  ON CONFLICT (user_id, year, kind) DO UPDATE SET cnt = activity_counters.cnt + 1, updated_at = now();
$function$
;

CREATE OR REPLACE FUNCTION public.geocache_backfill_candidates(p_limit integer, p_since text)
 RETURNS TABLE(apt_name text, sigungu text, umd_nm text)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT t.apt_name::text, t.sigungu::text, t.umd_nm::text
  FROM public.molit_transactions t
  WHERE t.deal_date >= p_since::date
    AND NOT EXISTS (
      SELECT 1 FROM public.apt_geocache g
      WHERE g.apt_name = t.apt_name
        AND g.sigungu = t.sigungu
        AND coalesce(g.umd_nm, '') = coalesce(t.umd_nm, '')
    )
  GROUP BY t.apt_name, t.sigungu, t.umd_nm
  ORDER BY count(*) DESC
  LIMIT p_limit;
$function$
;

CREATE OR REPLACE FUNCTION public.get_br_backfill_candidates(lim integer DEFAULT 100)
 RETURNS TABLE(apt_name text, lawd_cd text, sigungu text, umd_nm text, n bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select t.apt_name, t.lawd_cd, max(t.sigungu) as sigungu, t.umd_nm, count(*) as n
  from molit_transactions t
  where t.deal_date >= (now() - interval '180 days')::date
    and t.apt_name is not null and t.jibun is not null
  group by t.apt_name, t.lawd_cd, t.umd_nm
  having count(*) >= 2
     and not exists (
       select 1 from building_register b
       where b.apt_key = 'name:' || t.apt_name || '|' || t.lawd_cd
     )
  order by count(*) desc
  limit lim;
$function$
;

CREATE OR REPLACE FUNCTION public.get_db_size_bytes()
 RETURNS bigint
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ select pg_database_size(current_database()) $function$
;

CREATE OR REPLACE FUNCTION public.get_price_records(p_days integer DEFAULT 7, p_min_prior integer DEFAULT 3, p_limit integer DEFAULT 6)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
with maxd as (select max(deal_date) as d, min(deal_date) as since from public.molit_transactions),
recent as (
  select t.apt_seq, t.apt_name, t.sigungu, t.lawd_cd, t.umd_nm, t.exclu_use_ar,
         t.deal_date, t.deal_amount, t.floor, t.build_year
  from public.molit_transactions t, maxd
  where t.deal_date > maxd.d - p_days and t.apt_seq is not null
),
pairs as (select distinct apt_seq, exclu_use_ar from recent),
st as (
  select p.apt_seq, p.exclu_use_ar, s.mx, s.mn, s.n from pairs p cross join lateral (
    select max(t.deal_amount) mx, min(t.deal_amount) mn, count(*) n
    from public.molit_transactions t, maxd
    where t.apt_seq = p.apt_seq and t.exclu_use_ar = p.exclu_use_ar and t.deal_date <= maxd.d - p_days
  ) s where s.n >= p_min_prior
),
j as (select r.*, st.mx as prev_max, st.mn as prev_min, st.n as prev_n
      from recent r join st on st.apt_seq = r.apt_seq and st.exclu_use_ar = r.exclu_use_ar),
-- 목록은 단지당 1건(같은 단지의 84.83/84.84㎡ 가 칸을 나눠 먹던 실측). 집계는 그대로 = 실제 총계.
hi as (select * from (select j.*, row_number() over (partition by apt_seq
         order by deal_date desc, prev_n desc, deal_amount desc) rn_apt
       from j where deal_amount > prev_max) q where rn_apt = 1
       order by deal_date desc, prev_n desc, deal_amount desc limit p_limit),
lo as (select * from (select j.*, row_number() over (partition by apt_seq
         order by deal_date desc, prev_n desc, deal_amount asc) rn_apt
       from j where deal_amount < prev_min) q where rn_apt = 1
       order by deal_date desc, prev_n desc, deal_amount asc limit p_limit)
select jsonb_build_object(
  'latestDeal',    (select d from maxd),
  'sinceDate',     (select since from maxd),
  'windowDays',    p_days,
  'minPrior',      p_min_prior,
  'comparedCount', (select count(*) from j),
  'highCount',     (select count(*) from j where deal_amount > prev_max),
  'lowCount',      (select count(*) from j where deal_amount < prev_min),
  'high', coalesce((select jsonb_agg(to_jsonb(h) - 'rn_apt' order by h.deal_date desc, h.prev_n desc, h.deal_amount desc) from hi h), '[]'::jsonb),
  'low',  coalesce((select jsonb_agg(to_jsonb(l) - 'rn_apt' order by l.deal_date desc, l.prev_n desc, l.deal_amount asc)  from lo l), '[]'::jsonb)
);
$function$
;

CREATE OR REPLACE FUNCTION public.get_price_records_by_region(p_days integer DEFAULT 30, p_min_prior integer DEFAULT 3, p_limit integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
with maxd as (select max(deal_date) as d, min(deal_date) as since from public.molit_transactions),
recent as (
  select t.apt_seq, t.apt_name, t.sigungu, t.lawd_cd, t.umd_nm, t.exclu_use_ar,
         t.deal_date, t.deal_amount, t.floor, t.build_year
  from public.molit_transactions t, maxd
  where t.deal_date > maxd.d - p_days and t.apt_seq is not null
),
pairs as (select distinct apt_seq, exclu_use_ar from recent),
st as (
  select p.apt_seq, p.exclu_use_ar, s.mx, s.mn, s.n from pairs p cross join lateral (
    select max(t.deal_amount) mx, min(t.deal_amount) mn, count(*) n
    from public.molit_transactions t, maxd
    where t.apt_seq = p.apt_seq and t.exclu_use_ar = p.exclu_use_ar and t.deal_date <= maxd.d - p_days
  ) s where s.n >= p_min_prior
),
j as (select r.*, st.mx as prev_max, st.mn as prev_min, st.n as prev_n
      from recent r join st on st.apt_seq = r.apt_seq and st.exclu_use_ar = r.exclu_use_ar),
agg as (select lawd_cd, count(*) cmp,
    count(*) filter (where deal_amount > prev_max) hi,
    count(*) filter (where deal_amount < prev_min) lo from j group by 1),
-- 목록은 **단지당 1건**만 싣는다: 같은 단지의 84.83㎡ / 84.84㎡ 가 3칸을 다 차지하던 실측 때문.
-- 집계(agg)는 건드리지 않으므로 표시 건수는 여전히 실제 총계다.
hi as (select * from (select j.*, row_number() over (partition by lawd_cd, apt_seq
         order by deal_date desc, prev_n desc, deal_amount desc) rn_apt
       from j where deal_amount > prev_max) q where rn_apt = 1),
lo as (select * from (select j.*, row_number() over (partition by lawd_cd, apt_seq
         order by deal_date desc, prev_n desc, deal_amount asc) rn_apt
       from j where deal_amount < prev_min) q where rn_apt = 1),
hi_r as (select hi.*, row_number() over (partition by lawd_cd order by deal_date desc, prev_n desc, deal_amount desc) rn from hi),
lo_r as (select lo.*, row_number() over (partition by lawd_cd order by deal_date desc, prev_n desc, deal_amount asc) rn from lo),
hi_top as (select lawd_cd, jsonb_agg(p order by rn) arr from
  (select lawd_cd, rn, to_jsonb(hi_r) - 'rn' - 'rn_apt' - 'prev_min' as p from hi_r where rn <= p_limit) z group by lawd_cd),
lo_top as (select lawd_cd, jsonb_agg(p order by rn) arr from
  (select lawd_cd, rn, to_jsonb(lo_r) - 'rn' - 'rn_apt' - 'prev_max' as p from lo_r where rn <= p_limit) z group by lawd_cd)
select jsonb_build_object(
  'windowDays', p_days, 'minPrior', p_min_prior,
  'latestDeal', (select d from maxd), 'sinceDate', (select since from maxd),
  'regions', coalesce((
    select jsonb_object_agg(a.lawd_cd, jsonb_build_object(
      'comparedCount', a.cmp, 'highCount', a.hi, 'lowCount', a.lo,
      'high', coalesce(h.arr, '[]'::jsonb), 'low', coalesce(l.arr, '[]'::jsonb)))
    from agg a left join hi_top h on h.lawd_cd = a.lawd_cd left join lo_top l on l.lawd_cd = a.lawd_cd
  ), '{}'::jsonb));
$function$
;

CREATE OR REPLACE FUNCTION public.increment_user_budget(p_user_id uuid, p_month date, p_input_tokens bigint, p_output_tokens bigint, p_cost_usd_x1000 bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  INSERT INTO public.user_budget (
    user_id, month, input_tokens, output_tokens, cost_usd_x1000, request_count, last_request_at, updated_at
  ) VALUES (
    p_user_id, p_month, p_input_tokens, p_output_tokens, p_cost_usd_x1000, 1, now(), now()
  )
  ON CONFLICT (user_id, month) DO UPDATE SET
    input_tokens    = user_budget.input_tokens + EXCLUDED.input_tokens,
    output_tokens   = user_budget.output_tokens + EXCLUDED.output_tokens,
    cost_usd_x1000  = user_budget.cost_usd_x1000 + EXCLUDED.cost_usd_x1000,
    request_count   = user_budget.request_count + 1,
    last_request_at = now(),
    updated_at      = now();
END;
$function$
;

CREATE OR REPLACE FUNCTION public.prune_audit_log()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  deleted_count integer;
  retain_actions text[] := ARRAY[
    'account.delete.request',
    'account.delete.start',
    'account.delete.complete',
    'account.restore',
    'account.hard_delete',
    'payment.confirm',
    'payment.cancel',
    'payment.refund',
    'consent.accept'
  ];
BEGIN
  DELETE FROM public.audit_log
  WHERE created_at < (now() - INTERVAL '90 days')
    AND action <> ALL(retain_actions);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.refresh_molit_apt_index()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.molit_apt_index;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.search_popular_apts(p_limit integer DEFAULT 12)
 RETURNS TABLE("aptName" text, sigungu text, "umdNm" text, "lawdCd" text, "buildYear" integer, "recentDealDate" text, "dealCount60d" bigint, "avgDealAmount" numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT
    t.apt_name::text,
    t.sigungu::text,
    t.umd_nm::text,
    (array_agg(t.lawd_cd ORDER BY t.deal_date DESC))[1]::text,
    (array_agg(t.build_year ORDER BY t.deal_date DESC))[1]::integer,
    max(t.deal_date)::text,
    count(*)::bigint,
    round(avg(t.deal_amount)::numeric, 0)
  FROM public.molit_transactions t
  WHERE t.deal_date >= (CURRENT_DATE - 60)
  GROUP BY t.apt_name, t.sigungu, t.umd_nm
  ORDER BY count(*) DESC, max(t.deal_date) DESC
  LIMIT GREATEST(COALESCE(p_limit, 12), 1);
$function$
;

CREATE OR REPLACE FUNCTION public.tg_set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$
;


-- ============ TRIGGERS ============
CREATE TRIGGER bookmarks_set_updated_at BEFORE UPDATE ON public.bookmarks FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();
CREATE TRIGGER trg_user_billing_updated BEFORE UPDATE ON public.user_billing FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();

-- ============ RLS ============
alter table public.account_deletion_requests enable row level security;
alter table public.activity_counters enable row level security;
alter table public.ai_feedback enable row level security;
alter table public.apt_amenities enable row level security;
alter table public.apt_geocache enable row level security;
alter table public.apt_master enable row level security;
alter table public.apt_schools enable row level security;
alter table public.audit_log enable row level security;
alter table public.billing_plans enable row level security;
alter table public.bookmarks enable row level security;
alter table public.briefing_snapshots enable row level security;
alter table public.building_register enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_sessions enable row level security;
alter table public.data_error_reports enable row level security;
alter table public.field_notes enable row level security;
alter table public.kakao_notify_tokens enable row level security;
alter table public.molit_ingest_runs enable row level security;
alter table public.molit_transactions enable row level security;
alter table public.payments enable row level security;
alter table public.popular_apts_snapshot enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.regulations_snapshot enable row level security;
alter table public.search_history enable row level security;
alter table public.user_billing enable row level security;
alter table public.user_budget enable row level security;
alter table public.visit_attribution enable row level security;

-- ============ POLICIES ============
create policy adr_select_own on public.account_deletion_requests as permissive for select to authenticated using ((user_id = ( SELECT auth.uid() AS uid)));
create policy ai_feedback_insert_anon on public.ai_feedback as permissive for insert to anon with check ((user_id IS NULL));
create policy ai_feedback_insert_own on public.ai_feedback as permissive for insert to authenticated with check ((( SELECT auth.uid() AS uid) = user_id));
create policy ai_feedback_select_own on public.ai_feedback as permissive for select to authenticated using ((( SELECT auth.uid() AS uid) = user_id));
create policy ai_feedback_service_all on public.ai_feedback as permissive for all to service_role using (true) with check (true);
create policy apt_amenities_public_read on public.apt_amenities as permissive for select to anon, authenticated using (true);
create policy apt_amenities_service_write on public.apt_amenities as permissive for all to service_role using (true) with check (true);
create policy apt_geocache_public_read on public.apt_geocache as permissive for select to public using (true);
create policy apt_master_public_read on public.apt_master as permissive for select to anon, authenticated using (true);
create policy apt_master_service_write on public.apt_master as permissive for all to service_role using (true) with check (true);
create policy apt_schools_public_read on public.apt_schools as permissive for select to anon, authenticated using (true);
create policy apt_schools_service_write on public.apt_schools as permissive for all to service_role using (true) with check (true);
create policy audit_log_select_own on public.audit_log as permissive for select to authenticated using ((user_id = ( SELECT auth.uid() AS uid)));
create policy billing_plans_public_read on public.billing_plans as permissive for select to public using ((active = true));
create policy bookmarks_delete_own on public.bookmarks as permissive for delete to authenticated using ((( SELECT auth.uid() AS uid) = user_id));
create policy bookmarks_insert_own on public.bookmarks as permissive for insert to authenticated with check ((( SELECT auth.uid() AS uid) = user_id));
create policy bookmarks_select_own on public.bookmarks as permissive for select to authenticated using ((( SELECT auth.uid() AS uid) = user_id));
create policy bookmarks_update_own on public.bookmarks as permissive for update to authenticated using ((( SELECT auth.uid() AS uid) = user_id)) with check ((( SELECT auth.uid() AS uid) = user_id));
create policy br_read on public.building_register as permissive for select to public using (true);
create policy chat_messages_delete_own on public.chat_messages as permissive for delete to authenticated using ((EXISTS ( SELECT 1
   FROM chat_sessions s
  WHERE ((s.id = chat_messages.session_id) AND (s.user_id = ( SELECT auth.uid() AS uid))))));
create policy chat_messages_insert_own on public.chat_messages as permissive for insert to authenticated with check ((EXISTS ( SELECT 1
   FROM chat_sessions s
  WHERE ((s.id = chat_messages.session_id) AND (s.user_id = ( SELECT auth.uid() AS uid))))));
create policy chat_messages_select_own on public.chat_messages as permissive for select to authenticated using ((EXISTS ( SELECT 1
   FROM chat_sessions s
  WHERE ((s.id = chat_messages.session_id) AND (s.user_id = ( SELECT auth.uid() AS uid))))));
create policy chat_sessions_delete_own on public.chat_sessions as permissive for delete to authenticated using ((( SELECT auth.uid() AS uid) = user_id));
create policy chat_sessions_insert_own on public.chat_sessions as permissive for insert to authenticated with check ((( SELECT auth.uid() AS uid) = user_id));
create policy chat_sessions_select_own on public.chat_sessions as permissive for select to authenticated using ((( SELECT auth.uid() AS uid) = user_id));
create policy chat_sessions_update_own on public.chat_sessions as permissive for update to authenticated using ((( SELECT auth.uid() AS uid) = user_id)) with check ((( SELECT auth.uid() AS uid) = user_id));
create policy field_notes_delete_own on public.field_notes as permissive for delete to authenticated using ((( SELECT auth.uid() AS uid) = user_id));
create policy field_notes_insert_own on public.field_notes as permissive for insert to authenticated with check ((( SELECT auth.uid() AS uid) = user_id));
create policy field_notes_select_own on public.field_notes as permissive for select to authenticated using ((( SELECT auth.uid() AS uid) = user_id));
create policy field_notes_update_own on public.field_notes as permissive for update to authenticated using ((( SELECT auth.uid() AS uid) = user_id));
create policy molit_runs_no_read on public.molit_ingest_runs as permissive for select to public using (false);
create policy molit_tx_public_read on public.molit_transactions as permissive for select to public using (true);
create policy payments_select_own on public.payments as permissive for select to authenticated using ((( SELECT auth.uid() AS uid) = user_id));
create policy popular_snapshot_read on public.popular_apts_snapshot as permissive for select to public using (true);
create policy reg_snapshot_public_read on public.regulations_snapshot as permissive for select to public using (true);
create policy search_history_delete_own on public.search_history as permissive for delete to authenticated using ((( SELECT auth.uid() AS uid) = user_id));
create policy search_history_insert_own on public.search_history as permissive for insert to authenticated with check ((( SELECT auth.uid() AS uid) = user_id));
create policy search_history_select_own on public.search_history as permissive for select to authenticated using ((( SELECT auth.uid() AS uid) = user_id));
create policy user_billing_select_own on public.user_billing as permissive for select to authenticated using ((( SELECT auth.uid() AS uid) = user_id));
create policy user_budget_select_own on public.user_budget as permissive for select to authenticated using ((user_id = ( SELECT auth.uid() AS uid)));
