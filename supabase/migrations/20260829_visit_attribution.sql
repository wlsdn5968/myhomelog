-- ATTRIBUTION-2026-08-29 (Sprint NNNNNNN-31): 유입 채널 자체 기록.
--
-- ⚠ 파일 존재 ≠ 적용. 적용은 execute_sql 로 했고 pg_catalog 로 확인했다.
--
-- [왜] Vercel Web Analytics 는 계측은 되지만 **이 플랜에서 조회 API 가 404** 다(2026-08-29 확인).
--   게다가 프론트엔 `utm_` 를 다루는 코드가 **0건**이었다(grep). 스레드·인스타 자동화가 돌아도
--   어느 채널이 먹히는지 판단할 근거가 없었다. 광고를 집행하면 더 심해진다.
--
-- [개인정보를 만들지 않는다] user_id · IP · User-Agent 를 저장하지 않는다.
--   목적이 "채널별 몇 건"이라 식별자가 필요 없다(PIPA 최소수집). 그래서 이 표는 개인정보가 아니다.
--   가입 귀속도 user_id 없이 event='signup' 으로만 센다.
--
-- [보존] retention cron 이 180일 경과분을 지운다 — 무료 DB 500MB 중 이미 60% 사용 중이라
--   무한 증식을 두면 안 된다. 채널 비교엔 반년이면 충분하다.
create table if not exists public.visit_attribution (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  event text not null,              -- first_load | signup | search | report (라우트에서 화이트리스트 검증)
  utm_source text,
  utm_medium text,
  utm_campaign text,
  referrer_host text,
  landing_path text
);
comment on table public.visit_attribution is
  'ATTRIBUTION-2026-08-29: 유입 채널 집계. 개인 식별자(user_id·IP·UA)를 저장하지 않는다.';
create index if not exists idx_visit_attr_created on public.visit_attribution (created_at desc);
create index if not exists idx_visit_attr_event on public.visit_attribution (event, created_at desc);

-- anon/authenticated 는 직접 접근하지 않는다 — 쓰기도 읽기도 백엔드(service_role)를 통한다.
alter table public.visit_attribution enable row level security;
revoke all on public.visit_attribution from anon, authenticated;
grant select, insert, delete on public.visit_attribution to service_role;
grant usage, select on sequence public.visit_attribution_id_seq to service_role;
