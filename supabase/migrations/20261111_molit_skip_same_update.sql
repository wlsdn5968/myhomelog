-- 2026-11-11 매일 적재의 헛쓰기 차단 (plans/190). 운영 적용 완료(2026-11-11 11:25 UTC 경, 적재 창 밖).
--
-- [무엇이 있었나] molit-ingest 는 (지역, 월)마다 받은 거래를 전부 upsert 한다(ON CONFLICT DO UPDATE).
--   값이 그대로여도 PostgreSQL 은 새 행 판을 쓴다. 운영 실측(molit_ingest_runs): 11-05 47,035행, 11-08 82,559행,
--   11-10 84,298행을 다시 썼고 그날 실제로 늘어난 거래는 약 2천 건이었다. pg_stat_user_tables 누적은
--   갱신 9,502,867 대 삽입 315,449. 그 결과 인덱스가 이틀에 약 30MB 불어나 2026-11-11 클러스터 441.4MB(88%)였다.
-- [무엇을 했나] PostgreSQL 내장 함수 suppress_redundant_updates_trigger() 를 BEFORE UPDATE 트리거로 건다.
--   새 행이 기존 행과 바이트 단위로 같으면 갱신을 건너뛴다. 값이 하나라도 다르면(정정 신고 금액 등) 그대로 갱신된다.
--   이름을 zz_ 로 시작해 같은 종류 트리거 중 마지막에 돌게 한다(다른 BEFORE 트리거가 생겨도 그 결과까지 보고 판단).
-- [적용 전 되돌리는 시험, 운영 DB] DO 블록 안에서 트리거를 만들고 적재와 같은 모양의 upsert 를 한 뒤 예외로 되돌렸다.
--   1) 최신 행에 같은 값 upsert: 행 위치(ctid) 그대로. 2) 금액 +1 upsert: 갱신됨.
--   3) 가장 오래된 200행에 같은 값 upsert 두 번: 첫 회 102행이 한 번 다시 쓰이고(옛 열 구성으로 저장된 행), 둘째 회 0행.
-- [부수 효과] upsert 의 count 가 "실제로 쓴 행 수"가 된다. molit_ingest_runs.rows_inserted 는 이제 새로 들어오거나 값이 바뀐 행 수다
--   (rows_fetched 는 그대로 받은 행 수).
-- [같은 날 인덱스 재구축] reindex index concurrently 로 이 표의 인덱스 8개를 하나씩 다시 지었다.
--   인덱스 합계 120.0MB -> 89.4MB, 클러스터 441.4MB -> 410.9MB(82%). 표 본문은 104.4MB 그대로.
-- [되돌리기] drop trigger zz_skip_same on public.molit_transactions;

set local lock_timeout = '3s';
create trigger zz_skip_same before update on public.molit_transactions
  for each row execute function suppress_redundant_updates_trigger();

-- 적용 확인:
--   select tgname, tgenabled from pg_trigger where tgrelid = 'public.molit_transactions'::regclass and not tgisinternal;
--   -> zz_skip_same, O
-- 다음 적재 뒤 확인(헛쓰기가 멈췄는지):
--   select to_char(started_at,'MM-DD'), sum(rows_fetched), sum(rows_inserted) from molit_ingest_runs
--   where started_at > now() - interval '3 days' group by 1 order by 1;
--   -> rows_inserted 가 rows_fetched 보다 훨씬 작아야 한다.
