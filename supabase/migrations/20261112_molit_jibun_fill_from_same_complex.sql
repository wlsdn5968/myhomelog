-- 2026-11-12 원본 거래 표의 빈 지번 채우기 (plans/190 후속). 운영 적용: 2026-11-12 13:4x UTC, 적재 창 밖.
--
-- [무엇이 있었나] 지번 칸(jibun)은 2026-07-12 에 생겼다. 그 전에 들어온 행은 지번이 비어 있고, 매일 적재의
--   순환 재적재(4~15개월 전 달, 12일에 한 바퀴)가 그 달을 다시 받을 때 채운다. 2026-11-11 적재가 2025-12 를 다시 받아
--   빈 지번 17,580행을 채웠는데, 값이 바뀐 갱신이라 인덱스에 새 항목이 생겨 하루에 DB 가 8.7MB(인덱스 6.4MB) 늘었다.
--   같은 상태인 행이 94,754행(2025-08~11, 2026-04 등) 남아 있었다.
-- [근거] 같은 단지 번호(apt_seq)의 지번은 하나로 정해져 있다: 단지 20,990곳 중 20,986곳.
--   2026-11-11 에 국토부가 실제로 채운 2025-12 지번 27,370행을 다른 달의 같은 단지 지번과 대조: 같음 27,370, 다름 0.
-- [무엇을 했나] 지번이 비어 있고, 같은 단지의 다른 거래에 지번이 정확히 하나만 있으면 그 값으로 채운다(92,730행 예상).
--   달마다 한 문장씩 나눠 실행했다. 국토부가 같은 값을 다시 주면 zz_skip_same 트리거가 쓰기를 건너뛴다.
--   지번이 여럿인 단지(4곳)와 지번을 아는 거래가 없는 단지(2,018행)는 순환 적재가 채우게 둔다.
-- [이어서] 인덱스 8개를 reindex index concurrently 로 다시 지었다(20261111 마이그레이션과 같은 방법).
-- [되돌리기] 필요 없다(국토부 응답과 같은 값). 되돌려야 한다면 그 시각 이전 백업에서만 가능하다.

-- 달마다 아래를 실행했다(:y, :m 은 대상 달).
with known as (
  select apt_seq, min(jibun) as j
  from public.molit_transactions
  where apt_seq is not null and jibun is not null
  group by apt_seq
  having count(distinct jibun) = 1
)
update public.molit_transactions t
set jibun = k.j
from known k
where t.apt_seq = k.apt_seq
  and t.jibun is null
  and t.deal_year = :y and t.deal_month = :m;

-- 적용 확인:
--   select count(*) filter (where jibun is null) from public.molit_transactions;  -- 약 2,024 남음
