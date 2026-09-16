# 091 — 과거 실거래 backfill (무료 티어 안에서 최대한): 협폭 이력 테이블 + 최신월부터 거꾸로 적재 + 용량 자동 정지

**작성 기준 커밋**: `dc5a30f` (2026-09-16) · 우선순위 **P1** · 작업량 M · 의존: DDL(리뷰어가 운영자 승인 하에 적용) → 코드(실행자) → cron 등록

## 전제 확인 (계획자가 실측·코드로 확인한 것)
- **용량**: DB 342 / 500 MB. `molit_transactions` 234 MB = 468,303행(2025-05~2026-09), **행당 0.5 KB**(힙 191 B + 인덱스 8개 130 MB). 힙 191 B 의 내역: dedup_key 33 · apt_name 22 · sigungu/umd_nm ~23 · deal_year/month/day 12 · ingested_at 8 · id 8 · source ~5 등 — **이력 조회에 불필요한 컬럼이 절반 이상**.
- 이력 전용 협폭 테이블은 행당 ≈ **65 B**(힙 ~45 B + 인덱스 1개 ~20 B) → 여유 128 MB(안전 30 MB 제외) ≈ **1.9M 행**. 2025-06~2026-08 평균 28,703행/월이지만 2020~2021 호황기는 월 5~6만 행일 수 있어 "몇 년"은 미리 단정하지 않고 **적재하면서 용량으로 정지**한다.
- **원천 API**: `backend/jobs/molitIngest.js:94` `fetchRegionMonth(lawdCd, dealYm)` — `getRTMSDataSvcAptTradeDev`, `numOfRows=1000`, 최대 10페이지, 재시도 3회, 해제거래 제외, 반환 필드 `apt_seq, apt_name, umd_nm, jibun, exclu_use_ar, build_year, floor, deal_date, deal_amount`(`:158~184`). **export 되어 있지 않다**(`:498` `module.exports = { runMolitIngest, molitErrReason }`) → export 추가.
- `LAWD_CODES`: `backend/services/transactionService`(124개 시군구). 기존 cron 은 `vercel.json` 에 17개 이상 등록돼 있어 **Pro 플랜**(시간 단위 cron 가능). 함수 `maxDuration 300`.
- cron 인증·통계 기록 관례: `backend/routes/cron.js`(각 job 이 `cronStats` 로 `health.crons[name]` 에 요약 기록, 화이트리스트 `backend/services/cronStats.js`).

## 목표
1. `molit_transactions_hist`(협폭)에 **2025-04 부터 과거로** 월 단위 적재. 현재 테이블(2025-05~)과 겹치지 않는다.
2. 매 실행 시 `pg_database_size` 를 읽어 **총 470 MB 를 넘으면 정지**(그 달은 완료 상태로 두지 않음), `health.crons['molit-hist-backfill']` 에 `dbMb·lastYm·regionMonthsDone·stopped` 기록.
3. 재실행 안전: 완료한 (lawd_cd, deal_ym) 쌍을 `molit_hist_runs` 에 기록하고 건너뛴다(유니크 인덱스 없이 멱등 확보 → 인덱스 1개만).

## DDL (리뷰어가 운영자 승인 후 execute_sql 로 적용 — 실행자는 DB 에 접속하지 않는다)
```sql
CREATE TABLE public.molit_transactions_hist (
  apt_seq      text     NOT NULL,           -- '11500-10189' (molit_apt_index 와 조인 키)
  deal_date    date     NOT NULL,
  exclu_use_ar smallint NOT NULL,           -- ㎡ × 100 (예: 84.99 → 8499). 655㎡ 초과는 32767 로 캡
  deal_amount  integer  NOT NULL,           -- 만원
  floor        smallint
);
CREATE INDEX idx_molit_hist_seq_date ON public.molit_transactions_hist (apt_seq, deal_date);
CREATE TABLE public.molit_hist_runs (
  lawd_cd  text NOT NULL, deal_ym text NOT NULL, rows integer NOT NULL, finished_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lawd_cd, deal_ym)
);
ALTER TABLE public.molit_transactions_hist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.molit_hist_runs ENABLE ROW LEVEL SECURITY;
-- 읽기: anon/authenticated 는 hist 만 SELECT 허용(공개 실거래 통계), runs 는 service_role 전용
CREATE POLICY hist_read ON public.molit_transactions_hist FOR SELECT TO anon, authenticated USING (true);
```
(`apt_name`·`umd_nm`·`jibun`·`build_year` 는 `molit_apt_index`/현재 테이블에서 조인 — 이력 행에 중복 저장하지 않는다. `apt_seq` 가 null 인 원천 행은 **버린다**(이력에서 단지 식별 불가).)

## 범위 (코드)
- 수정: `backend/jobs/molitIngest.js`(export 1줄), `backend/routes/cron.js`(라우트 1개), `backend/services/cronStats.js`(화이트리스트 키), `vercel.json`(cron 1줄), `supabase/migrations/20260916_molit_hist.sql`(위 DDL 기록), `supabase/schema.sql`(테이블 2개 반영 — 함수 치환 사고 재발 방지: **append 만**).
- 신규: `backend/jobs/molitHistBackfill.js`, `backend/test/molit-hist-backfill.test.js`.

## Step 1 — `backend/jobs/molitHistBackfill.js`
```js
'use strict';
// HIST-BACKFILL-2026-09-16 (Plan 091): 과거 실거래를 협폭 테이블에 최신월부터 거꾸로 적재. 용량 임계에서 자동 정지.
const logger = require('../logger');
const { fetchRegionMonth } = require('./molitIngest');
const { LAWD_CODES } = require('../services/transactionService');
const { requireSupabaseAdmin } = require('../db/client'); // molitIngest 와 같은 헬퍼

const START_YM = '202504';                 // 현재 테이블(2025-05~)과 겹치지 않는 첫 달
const FLOOR_YM = '201901';                 // 이론상 하한(용량이 먼저 멈춘다)
const DB_STOP_MB = 470;                    // 무료 티어 500 MB — 30 MB 안전 여유
const REGION_MONTHS_PER_RUN = 30;          // 300s 예산: 실측 region-month 당 2~4s
const CHUNK = 1000;

function prevYm(ym) { const y = +ym.slice(0, 4), m = +ym.slice(4); return m === 1 ? `${y - 1}12` : `${y}${String(m - 1).padStart(2, '0')}`; }
function toHistRow(r) {
  if (!r.apt_seq || !r.deal_date || !(r.deal_amount > 0)) return null;
  const ar = Math.round((parseFloat(r.exclu_use_ar) || 0) * 100);
  return { apt_seq: String(r.apt_seq), deal_date: r.deal_date, exclu_use_ar: Math.min(32767, Math.max(0, ar)), deal_amount: Math.min(2147483647, Math.round(r.deal_amount)), floor: r.floor == null ? null : Math.max(-32768, Math.min(32767, r.floor)) };
}
async function dbSizeMb(admin) { const { data, error } = await admin.rpc('db_size_mb'); if (error) throw error; return Number(data); }
// 다음 대상 (lawd, ym): runs 에 없는 쌍을 START_YM 부터 거꾸로.
async function nextTargets(admin, limit) { … runs 전체를 읽어 Set 으로 두고, ym 을 START_YM 부터 prevYm 으로 내려가며 LAWD_CODES 순회, 없는 쌍을 limit 개 반환 (FLOOR_YM 에서 종료) … }
async function runHistBackfill(opts = {}) {
  const admin = requireSupabaseAdmin('hist backfill 불가');
  const limit = Math.max(1, Math.min(parseInt(opts.limit) || REGION_MONTHS_PER_RUN, 120));
  const mb0 = await dbSizeMb(admin);
  if (mb0 >= DB_STOP_MB) return { stopped: true, reason: 'db-size', dbMb: mb0, done: 0 };
  const targets = await nextTargets(admin, limit);
  let done = 0, rows = 0, err = 0, lastYm = null;
  for (const [lawdCd, ym] of targets) {
    try {
      const raw = await fetchRegionMonth(lawdCd, ym);
      const hist = raw.map(toHistRow).filter(Boolean);
      for (let i = 0; i < hist.length; i += CHUNK) { const { error } = await admin.from('molit_transactions_hist').insert(hist.slice(i, i + CHUNK)); if (error) throw error; }
      const { error: e2 } = await admin.from('molit_hist_runs').upsert({ lawd_cd: lawdCd, deal_ym: ym, rows: hist.length }); if (e2) throw e2;
      done++; rows += hist.length; lastYm = ym;
    } catch (e) { err++; logger.warn({ err: e.message, lawdCd, ym }, 'molit-hist-backfill: region-month 실패(다음 실행에서 재시도)'); }
    if ((done + err) % 10 === 0) { const mb = await dbSizeMb(admin); if (mb >= DB_STOP_MB) return { stopped: true, reason: 'db-size', dbMb: mb, done, rows, err, lastYm }; }
  }
  return { stopped: targets.length === 0, reason: targets.length === 0 ? 'complete' : null, dbMb: await dbSizeMb(admin), done, rows, err, lastYm };
}
module.exports = { runHistBackfill, toHistRow, prevYm, START_YM, DB_STOP_MB };
```
`db_size_mb` 는 DDL 에 함께 만든다: `CREATE FUNCTION public.db_size_mb() RETURNS numeric LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$ SELECT round(pg_database_size(current_database())/1048576.0, 1) $$; REVOKE EXECUTE ON FUNCTION public.db_size_mb() FROM PUBLIC, anon, authenticated; GRANT EXECUTE ON FUNCTION public.db_size_mb() TO service_role;`
⚠ 실패한 region-month 는 runs 에 기록되지 않아 **부분 삽입 뒤 재시도 시 중복**이 생길 수 있다 → 삽입 전에 `DELETE FROM molit_transactions_hist WHERE apt_seq LIKE '<lawd>-%' AND deal_date BETWEEN 그달 1일 AND 말일` 로 그 region-month 를 비우고 넣는다(멱등, 인덱스로 빠름).

## Step 2 — cron 라우트·통계·스케줄
- `backend/routes/cron.js`: 기존 job 라우트 패턴(인증 미들웨어·`cronStats.record`)을 그대로 따라 `GET /api/cron/molit-hist-backfill` 추가(`?limit=`). 결과 요약 키: `done, rows, err, dbMb, lastYm, stopped, reason`.
- `backend/services/cronStats.js` 화이트리스트에 위 키 추가(숫자/문자열/불리언 규칙 준수).
- `vercel.json` crons: `{ "path": "/api/cron/molit-hist-backfill", "schedule": "20 * * * *" }` (매시 20분 — 기존 cron 과 겹치지 않는 분). `backend/test/cron-observability.test.js` 가 cron 경로 목록과 `CRON_PATH_TO_JOBS` 의 1:1 을 검사한다 → 그 맵에도 추가.
- 정지(`stopped:true, reason:'db-size'`) 시 Sentry 경보가 아니라 **정보 로그**만(설계상 정상 종료).

## Step 3 — 테스트 `backend/test/molit-hist-backfill.test.js`
- `toHistRow`: 정상 변환(84.99→8499, 만원 정수, floor), `apt_seq` 없음 → null, 655㎡ 초과 캡.
- `prevYm('202601')` → `202512`.
- 스텁 admin(`rpc('db_size_mb')` 값 주입, `from().insert/upsert/delete`, runs 조회)으로: ① 용량 ≥ 470 이면 fetch 없이 stopped ② 정상 2개 region-month 처리 시 runs upsert 2회·insert 행수 일치 ③ fetch 예외 시 err 카운트·runs 미기록.
- cron-observability 테스트의 1:1 검사 통과.

## 검증·완료 기준
- `npm run verify` `fail 0`(392 + 신규). `node -e "require('./backend/jobs/molitHistBackfill')"` 로드 OK.
- 리뷰어: DDL 적용 → `?limit=3` 를 cron 인증으로 1회 호출은 불가(비밀)하므로 **첫 정기 회차** 후 `health.crons['molit-hist-backfill']` 로 확인, `SELECT count(*), min(deal_date), max(deal_date) FROM molit_transactions_hist` 로 적재 확인, `db_size_mb()` 추이 기록.
- 커밋: `feat(데이터): 과거 실거래 협폭 이력 backfill — 최신월부터, DB 470MB 에서 자동 정지 (Plan 091)`.

## STOP 조건
- `requireSupabaseAdmin`/cron 인증 미들웨어 이름이 위와 다르다 → 실제 이름을 쓰되(STOP 아님) 보고. `cron-observability` 의 1:1 규칙을 만족시킬 수 없는 구조 → 보고.
- MOLIT 응답에 `aptSeq` 가 대량으로 비어 있어(원천 행의 30% 이상) 이력에서 단지 식별이 안 된다 → 첫 회차 결과로 판단, 계획 재검토.

## 후속(별도 계획, 이 계획 범위 밖)
- 이력 소비: 단지 상세 "실거래가" 탭의 **연도별·평형별 중앙값 표/미니차트**(2020~), 지역 페이지 월별 거래량 24개월 확장. 이력 테이블은 `apt_seq` 로만 조인한다.
