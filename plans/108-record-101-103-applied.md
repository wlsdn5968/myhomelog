# 108 — 101·103 프로덕션 적용분을 저장소에 기록 (마이그레이션 2 · schema.sql · 캐시 키 · 주석) — DB 는 건드리지 않는다

**작성 기준 커밋**: `3501c49` (2026-09-20) · 우선순위 P1 · 작업량 S · 의존: 없음(DDL 은 리뷰어가 이미 적용함) · **실행자는 DB·외부 API 를 호출하지 않는다**

## 전제 확인 (리뷰어가 프로덕션에서 확인)
- 2026-09-20 적용 완료: ① 이력 인덱스 교체 — `idx_molit_hist_seq (apt_seq)` 9.3 MB 생성, `idx_molit_hist_seq_date` 48.6 MB 삭제 → Supabase 기준 DB **482.2 → 442.9 MB** ② `molit_hist_peaks` 81,462쌍(7.6 MB, RLS 켬·정책 없음) + 함수 `get_price_records`·`get_price_records_by_region` 교체 → 전국 7일 **최고 경신 351 → 159 · 최저 137 → 61**, `sinceDate` 2020-09-01, 웜 실행 98 → 104 ms. 최종 450.5 MB.
- 적용한 SQL 원문은 **`C:\Users\Woo\Downloads\myhomelog_deploy_1\myhomelog\plans\103-appendix-applied.sql`**(원본 저장소 절대 경로 — 워크트리에는 없다). 기록은 이 파일의 문장을 **그대로** 옮긴다.
- `supabase/schema.sql` 의 두 함수(`:549`·`:595`)는 프로덕션보다 **옛 본문**이다(2026-09-05 PERF 판이 반영 안 된 기존 드리프트) — 이번에 부록의 정의로 통째 교체하면 함께 해소된다. 같은 파일 `:919` `CREATE INDEX idx_molit_hist_seq_date ON public.molit_transactions_hist USING btree (apt_seq text_pattern_ops, deal_date);`, `:910~917` 에 `molit_hist_runs` 테이블·PK 선언.
- 캐시 키: `backend/services/priceRecordsService.js:23~24` `const CK = 'records:price:v1';`·`const CK_REGION = 'records:priceByRegion:v1';`(Redis 30시간). 같은 리터럴을 `backend/test/cron-observability.test.js` 가 9곳에서 쓴다(`:705`~`:837`). `:last`·`:computeFailedAt` 키는 바꾸지 않는다(마지막 성공 스냅샷은 자기 `sinceDate` 를 담고 있어 섞여도 거짓이 아니다).

## Step 1 — 마이그레이션 기록 2개 (형식은 `supabase/migrations/20260916_molit_hist.sql` 의 헤더를 따른다: "이미 프로덕션에 적용됨 — 적용 기록")
- `supabase/migrations/20260920_hist_index_swap.sql`: 헤더(적용일, 근거: 옛 인덱스의 `idx_scan` 7,000 = backfill 삭제-후-삽입 횟수와 일치해 다른 사용처 0 · 같은 서버 `idx_molit_apt_seq` 12.7 B/행 → 단일 키는 B-tree 중복 제거로 9.3 MB · 482.2 → 442.9 MB · 되돌리기 SQL) + 부록의 "Plan 101" 두 문장.
- `supabase/migrations/20260920_price_records_6y_baseline.sql`: 헤더(근거: 351→159·137→61, 이력 힙 직접 조회는 콜드 13.9초라 요약 테이블, 면적 조인식의 32767 캡 이유 = 327㎡ 초과에서 smallint 범위 오류 방지, 되돌리기) + 부록의 "Plan 103 ①②" 전문.

## Step 2 — `supabase/schema.sql`
1. `:919` 줄을 `CREATE INDEX idx_molit_hist_seq ON public.molit_transactions_hist USING btree (apt_seq);` 로 교체.
2. `molit_hist_runs` PK 선언 줄(`alter table public.molit_hist_runs add constraint molit_hist_runs_pkey …`) **다음**에 같은 표기법으로 추가:
   ```sql

   create table if not exists public.molit_hist_peaks (
     apt_seq text not null,
     exclu_use_ar smallint not null,
     mx integer not null,
     mn integer not null,
     n integer not null
   );

   alter table public.molit_hist_peaks add constraint molit_hist_peaks_pkey PRIMARY KEY (apt_seq, exclu_use_ar);
   ```
   그리고 `alter table public.molit_hist_runs enable row level security;` 줄 다음에 `alter table public.molit_hist_peaks enable row level security;`.
3. 두 함수 교체 — **문자열 `replace` 의 치환 인자에 SQL 을 넣지 말 것**(이 저장소는 SQL 의 `$'` 가 "매치 뒤 전체 삽입" 으로 해석돼 schema.sql 이 663줄 복제된 사고가 있다). 인덱스로 잘라 붙인다:
   ```js
   const fs = require('fs');
   const sp = 'supabase/schema.sql', ap = 'C:/Users/Woo/Downloads/myhomelog_deploy_1/myhomelog/plans/103-appendix-applied.sql';
   let s = fs.readFileSync(sp, 'utf8'); const a = fs.readFileSync(ap, 'utf8').replace(/\r\n/g, '\n');
   const H1 = 'CREATE OR REPLACE FUNCTION public.get_price_records(', H2 = 'CREATE OR REPLACE FUNCTION public.get_price_records_by_region(', H3 = 'CREATE OR REPLACE FUNCTION public.increment_user_budget(';
   const a1 = a.indexOf(H1), a2 = a.indexOf(H2); if (a1 < 0 || a2 < a1) throw new Error('부록 구조가 다르다');
   let block = a.slice(a1).trimEnd() + '\n\n';
   const crlf = s.includes('\r\n'); if (crlf) block = block.replace(/\n/g, '\r\n');
   const i = s.indexOf(H1), j = s.indexOf(H3); if (i < 0 || j < i) throw new Error('schema.sql 구조가 다르다');
   s = s.slice(0, i) + block + s.slice(j); fs.writeFileSync(sp, s, 'utf8');
   ```
   확인: `grep -c "BASELINE-6Y-2026-09-20" supabase/schema.sql` = **2** · `grep -c "^CREATE OR REPLACE FUNCTION public.get_price_records" supabase/schema.sql` = **2** · `grep -c "increment_user_budget(p_user_id" supabase/schema.sql` 가 편집 전과 같다 · `git diff --stat supabase/schema.sql` 의 증감이 **대략 +45 / −20 줄 안팎**(수백 줄이면 복제 사고 — 즉시 `git checkout -- supabase/schema.sql` 후 STOP).

## Step 3 — 코드·주석
- `backend/services/priceRecordsService.js`: `'records:price:v1'` → `'records:price:v2'`, `'records:priceByRegion:v1'` → `'records:priceByRegion:v2'`, 바로 위에 주석 `// BASELINE-6Y-2026-09-20 (Plan 103): 기준선이 2020-09 이후 이력까지 넓어졌다 — v2 로 올려 옛 기준선 결과(최대 30시간)가 섞이지 않게.`
- `backend/test/cron-observability.test.js`: 같은 두 리터럴을 전부 v2 로(9곳, `grep -n "records:price" backend/test/cron-observability.test.js` 로 전수 확인 — `:last`·`:computeFailedAt` 은 그대로).
- `backend/jobs/molitHistBackfill.js:107~109` GUARD 주석의 `(apt_seq LIKE '<lawd>-%' 는 idx_molit_hist_seq_date 의 text_pattern_ops 인덱스로 빠르게 처리된다)` 부분을 `(Plan 101 로 인덱스가 (apt_seq) 단일로 바뀌어 이 삭제는 순차 스캔이다 — backfill 은 Plan 100 으로 동결되어 호출되지 않는다)` 로. 동작 코드는 건드리지 않는다.
- `frontend/index.html:5593` 주석 `우리 적재는 sinceDate(2025-05-01 실측)부터다.` → `우리 적재는 sinceDate(2020-09-01 — 과거 이력 포함, Plan 103)부터다.`(주석 1줄, 동작 무관)

## 검증·완료 기준
- `npm run verify` → `fail 0`(436 유지 — 새 테스트 없음. 스키마 스냅샷 테스트 포함).
- 커밋 2개: `chore(db): 이력 인덱스를 (apt_seq) 단일로 교체한 적용 기록 — 482.2→442.9MB (Plan 101)`(마이그레이션 1 + schema.sql 의 인덱스 줄 + backfill 주석) · `feat(경신): 최고·최저 경신 기준선을 2020-09 이후 이력까지 — molit_hist_peaks 적용 기록·캐시 키 v2 (Plan 103)`(나머지 전부). 각 메시지 끝에 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## STOP 조건
- Step 2-3 의 확인 숫자가 하나라도 다르다 → 원복 후 보고.
- `priceRecordsService.js` 의 키 상수가 위와 다르다 → 보고.
