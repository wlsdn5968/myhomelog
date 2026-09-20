# 101 — 이력 테이블 인덱스 교체로 DB 36~38 MB 회수 (데이터 삭제 없음) — ⚠ 프로덕션 DDL, 운영자 승인 후 실행

**작성 기준 커밋**: `b739076` (2026-09-20) · 우선순위 **P0(용량)** · 작업량 XS(DDL 2문 + 기록) · 의존: **100 배포 완료**(backfill 동결 — 안 그러면 회수한 공간을 backfill 이 다시 채운다)

## 전제 확인 (계획자가 DB·공식 문서로 확인 — 읽기 전용)
- Supabase 기준 DB 크기 **482.2 / 500 MB**(전 DB 합계). 넘으면 무료 플랜은 **읽기 전용 모드**(INSERT 불가 → 일간 적재·관심단지·로그인 기록 전부 실패). `molit_transactions` 가 월 ≈13.9 MB 증가(235.6 MB / 17개월) → 지금대로면 **약 5주 뒤** 도달.
- `molit_transactions_hist`: 1,290,112행 · 힙 74.0 MB · 인덱스 `idx_molit_hist_seq_date (apt_seq text_pattern_ops, deal_date)` **48.6 MB**(항목당 39.5 B). `pg_stat_user_indexes.idx_scan = 7,000` = backfill 의 삭제-후-삽입 7,000회와 정확히 일치 — **backfill 외 사용처 0**(코드 grep: `molit_transactions_hist` 참조는 `backend/jobs/molitHistBackfill.js` 와 테스트·스키마뿐).
- 같은 서버의 `molit_transactions.idx_molit_apt_seq (apt_seq)` 는 472,302행에 **5.7 MB = 항목당 12.7 B** — PostgreSQL 17.6 의 B-tree 중복 제거(deduplication)가 같은 `apt_seq` 를 posting list 로 묶기 때문. 복합키 `(apt_seq, deal_date)` 는 키가 거의 유일해서 이 압축이 안 먹는다.
- 앞으로 이력을 읽을 기능(장기 추세·경신 기준선)은 전부 `WHERE apt_seq = $1` 조회다(단지당 수십~수백 행) → `(apt_seq)` 단일 인덱스로 충분. 월 단위 삭제는 월 1회 순차 스캔으로 족하다.
- 예상: 새 인덱스 ≈ **10~16 MB**(상한 = 1,290,112 × 12.7 B = 15.6 MB) → **−33~38 MB**. 전체 ≈ 445~449 MB → 한도까지 여유 ≈ 51~55 MB(≈ 3개월, 그 안에 계획 104 의 원본 테이블 순환 보관을 끝낸다).

## 실행 SQL (운영자 승인 후 리뷰어가 `execute_sql` 로 실행 — 순서 고정)
```sql
-- ① 새 인덱스. hist 는 backfill 동결(Plan 100) 뒤 쓰는 쪽·읽는 쪽이 모두 없어 잠금 영향 없음.
CREATE INDEX idx_molit_hist_seq ON public.molit_transactions_hist (apt_seq);
-- ② 확인(읽기): 새 인덱스 크기와 유효성
SELECT indexrelid::regclass AS idx, pg_size_pretty(pg_relation_size(indexrelid)) AS size, i.indisvalid
FROM pg_index i WHERE indrelid = 'public.molit_transactions_hist'::regclass;
-- ③ ②에서 새 인덱스가 valid 이고 20 MB 미만일 때만: 옛 인덱스 제거(파일이 즉시 OS 로 반환된다)
DROP INDEX public.idx_molit_hist_seq_date;
-- ④ 확인(읽기)
SELECT round(sum(pg_database_size(datname))/1048576.0,1) AS all_dbs_mb FROM pg_database;
```
- 실행 시각: 일간 적재·MV 갱신 창(17:00~19:00 UTC)을 피한다. ①의 일시 증가분(≤16 MB)을 더해도 500 미만(482.2 + 16 = 498.2)이지만 여유가 작으므로 **적재 창 밖에서, ①→③ 을 연속으로** 실행한다.
- 되돌리기: `CREATE INDEX idx_molit_hist_seq_date ON public.molit_transactions_hist (apt_seq text_pattern_ops, deal_date); DROP INDEX public.idx_molit_hist_seq;`(데이터 변경이 없어 언제든 복구 가능).
- ②에서 새 인덱스가 20 MB 이상이면(중복 제거가 안 먹은 것) ③을 **실행하지 말고** 새 인덱스를 지운 뒤 보고한다.

## 적용 후 기록 (실행자 — haiku, DDL 적용이 끝난 뒤)
- `supabase/migrations/20260920_hist_index_swap.sql` 신설: 위 ①③ 원문 + 헤더 주석(적용일·근거 수치·되돌리기). 형식은 `supabase/migrations/20260916_molit_hist.sql` 을 따른다("이미 프로덕션에 적용됨 — 적용 기록").
- `supabase/schema.sql`: `CREATE INDEX idx_molit_hist_seq_date …` 줄을 `CREATE INDEX idx_molit_hist_seq ON public.molit_transactions_hist USING btree (apt_seq);` 로 교체(그 파일의 기존 인덱스 표기 형식에 맞춘다).
- `backend/jobs/molitHistBackfill.js` 의 GUARD 주석 중 "text_pattern_ops 인덱스로 빠르게 처리된다" 문장을 "Plan 101 로 인덱스가 (apt_seq) 단일로 바뀌어 이 삭제는 순차 스캔이다 — backfill 은 Plan 100 으로 동결되어 호출되지 않는다" 로 고친다(동작 변경 없음).
- `npm run verify` `fail 0`(스키마 스냅샷 테스트 포함). 커밋: `chore(db): 이력 인덱스를 (apt_seq) 단일로 교체 — 48.6→N MB, DB 용량 회수 기록 (Plan 101)`.

## STOP 조건
- 100 이 아직 배포되지 않았거나 `/api/health` 의 `crons['molit-hist-backfill']` 가 `stopped:true, reason:'complete'` 가 아니다 → 실행하지 않는다.
- ① 실행 중 오류(디스크·타임아웃) → 부분 생성된 인덱스가 invalid 로 남았는지 ②로 확인하고 `DROP INDEX` 로 정리 후 보고.
