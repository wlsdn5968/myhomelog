-- 보안 점검 후속(2026-10-30): 완전 삭제가 계속 실패하는 요청이 pending 으로 남아(SEC-1030-C4 이후 의도된 재시도)
--   정렬 없는 limit(100) 의 앞자리를 차지하면 정상 요청이 굶을 수 있었다 → 시도 횟수가 적은 요청부터 처리한다.
--   적용 전 실측: account_deletion_requests 0행. 열 추가만(기본값 상수 — 기존 행 재작성 없음), 삭제·권한 변경 없음.
--   ⚠ 코드(backend/jobs/retention.js)보다 먼저 적용해야 한다 — 열이 없으면 조회가 통째로 실패한다.
alter table public.account_deletion_requests
  add column if not exists hard_delete_attempts integer not null default 0;
