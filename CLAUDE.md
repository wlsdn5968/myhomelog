# myhomelog — Claude Code 작업 가이드

운영자(wlsdn5968) 와의 작업 시 적용되는 운영 룰 + 컨텍스트 빠른 복원.

---

## 🔒 절대 룰 (운영자 명시 위반 금지)

1. **매수·매도 추천 X / 미래 가격 예측 X / 정보 정리 도구만**
   - 모든 사용자 노출 카드에 disclaimer 명시
   - "이 단지 사세요" 식 표현 절대 금지

2. **환각 차단 — 공식 출처만 인용**
   - 뉴스만 기반 부정확 정보 ❌
   - 정부 공식 (law.go.kr, korea.kr, 금융위, 국토교통부) + 검증된 GitHub (MIT/공공저작물) ✅
   - 출처 + 검증 일자 명시 필수

3. **공유 production DB 직접 수정 금지** (auto-mode classifier 차단 정상)
   - 운영자 명시 승인 (예: "진행") 받은 후만 적용
   - SQL 은 SPRINT_NOTES 에 사전 기록 → 운영자 검토 후 실행

---

## 📋 작업 종료 시 무조건 실행하는 프로세스 (운영자 ASSERT 2026-05-19)

### 모든 task 끝마다 다음 4단계 수행:

**1. 디버깅 + 저장 검증**
- `git status --short` (clean 확인)
- syntax check (backend: `node -c`, frontend: inline JS validate)
- production deploy 검증 (`/api/health` deploy id 일치)
- Sentry 신규 0건 확인 (최근 30분 ~ 2시간)
- SPRINT_NOTES 누락 섹션 없음 확인

**2. 후속 작업 우선순위 제안 (의무)**
다음 형식으로 *반드시* 마지막에 제안:

```
### 📌 후속 / 미완료 작업 (우선순위 순)

| 순위 | 작업 | 출처 | 작업량 | 환각 위험 |
|---|---|---|---|---|
| 1 | ... | ... | ... | ... |
| 2 | ... | ... | ... | ... |
```

출처 종류:
- SPRINT_NOTES 의 "미진행/운영자 결정 대기" 섹션
- 작업 중 발견된 향후 확장 옵션
- 운영자 이전 ASSERT 중 부분 적용된 항목
- 시장 신규 정책/뉴스/GitHub 발견 자료

**3. 운영자 결정 요청**
- "진행 / 다른 우선순위 / 나중에" 명확히 묻기
- 자동 진행 X (운영자 확인 후 다음 작업 시작)

**4. SPRINT_NOTES 업데이트**
- 오늘 commit chain table 갱신
- 신규 sprint 섹션 추가 (변경 사항 + 검증 결과 + 회귀 위험)
- 운영자 결정 대기 사항 정리

---

## 🛠 작업 패턴

### Sprint naming
- `Sprint A` ~ `Sprint Z` ~ `Sprint AA` ~ `Sprint ZZ` 순차
- 의미 있는 단위로 묶기 (3-10 commit)
- commit message 에 `(Sprint XX)` 명시

### Commit 규칙
- `feat(area): 한글 설명 (Sprint XX)`
- `fix(area): 한글 설명 (Sprint XX)`
- body 에 [근본 원인] [Fix 내용] [회귀 위험] 명시
- 최근 12 commit history 는 SPRINT_NOTES table 에 기록

### 검증 체크리스트

**로컬**: `npm run verify` (린트·JSON·의존성·환경·보안·backend test 6종 게이트)

⚠ backend test 는 `scripts/run-backend-tests-utc.js` 래퍼로 **TZ=UTC** 강제 실행된다 —
프로덕션(Vercel) 런타임이 UTC 고정인데 개발 호스트는 Asia/Seoul(KST)이라, 호스트 TZ 로만
돌리면 host-local getter 회귀(예: rentService.monthsWindow, Plan 047)를 로컬에서 못 잡는다.

⚠ **verify 가 덮지 않는 것**:
- `Clause XSS raw-pattern guard` (CI 전용 인라인 스크립트)
- `gitleaks` (비밀 스캔 CI 전용)

**배포 후**:
- `/api/health` deploy id 일치 확인
- Sentry `is:unresolved firstSeen:-30m` 신규 오류 확인

---

## 📚 데이터 출처 (환각 차단)

| 카테고리 | 공식 출처 | 우리 통합 |
|---|---|---|
| 실거래가 | MOLIT (data.go.kr) | molit_transactions table |
| 단지정보 | KAPT (한국부동산원) | apt_master + facility |
| 좌표 | Kakao Map API | apt_geocache (Sprint LL 점수 매칭) |
| 학교 | Kakao + NEIS 학교알리미 | nearbySchools |
| 학원 | Kakao Map API | nearbyAcademies (Sprint OO) |
| 정책/규제 | korea.kr 정책브리핑 + 금융위 RSS | regulations_snapshot (Sprint QQ) |

---

## 🔑 외부 자격증명

- **NCP Maps Client ID**: `pkiho4sd0p` (Vercel env `NAVER_MAPS_CLIENT_ID`)
- **Supabase project**: `brxorvxdfrbxcavufspe` (myhomelog)
- **GitHub repo**: `wlsdn5968/myhomelog`
- **Vercel deploy**: production master branch auto-deploy

---

## 📊 진행 중 / 운영자 결정 대기 (2026-09-20 갱신)

### DB 용량 — Supabase 무료 한도 500MB 중 **404MB(81%)** (2026-09-20 정리 완료)
- 한도 기준은 **클러스터 전 DB 합계**: `SELECT sum(pg_database_size(datname)) FROM pg_database`. 넘으면 **읽기 전용 모드**. health 의 `db`(RPC `get_db_size_bytes`)와 `db_size_mb()` 가 이제 같은 식을 쓴다(Plan 105).
- 하루 경과: 482(96%) → backfill 2020-09 동결(100) → 이력 인덱스 단일키(101) → 경신 기준선 6년(103) → **유지보수 회수(106) = 405MB**. 원본 `molit_transactions` 는 월 ≈13.9MB 증가.
- **경보**: retention cron 이 매일 85%(425MB)에서 Sentry warning, 93%(465MB)에서 error(`monitor:db-capacity`).
- **다시 하지 말 것**: 이력 backfill 재개(동결됨) · 통째 upsert(apt_master 는 바뀐 행만 쓴다) · `molit_ingest_runs` 의 ok 를 기간만으로 전부 삭제((지역,월)별 최신 1건은 영구 보존 — 사라지면 그 달 조회가 MOLIT API 로 추락).
- **유지보수 재실행 시**: 적재 창(17:00~19:00 UTC)·apt-master-sync(월 20:00 UTC)를 피하고, 명령 전후로 위 합계 쿼리를 잰다. 절차·실측은 `supabase/migrations/20260920_maintenance_reclaim.sql`.
- **2027-01 전**: Plan 107 원본 16개월 순환 보관(안 하면 2027-03 경 다시 한도). 종합 설계 `plans/104-db-capacity-management.md`.
- **첫 경보(425MB)는 2026-10-21 전후**로 예상된다(증가 ≈16MB/월 실측). **경보는 고장이 아니라 예고** — 울린 뒤 107(L 규모)을 시작하면 늦다. 남은 무손실 절약은 사실상 소진됐고(104 §8.2) 구조적 답은 107 뿐이다.
- ⚠ **`create table` 에는 `enable row level security` 를 붙일 것** (Plan 107a, 2026-09-20): Supabase 는 public 스키마 신규 테이블에 `anon`·`authenticated` 기본 DML 권한을 준다 — **RLS 가 꺼져 있으면 PostgREST 로 누구나 쓸 수 있다**. `molit_apt_dim` 이 약 20분간 그 상태였다(쓰기 0건 실증 후 차단). 내부 전용 테이블은 **RLS on + 정책 0**(= service_role 만 통과, `molit_hist_peaks` 패턴). 만든 직후 점검: `select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity=false` → **0행**이어야 한다.
- ⚠ **컬럼을 payload 에서 빼기 전에 `not null` 부터 풀 것** (Plan 112, 2026-09-20): 코드를 먼저 배포하면 신규 INSERT 가 NOT NULL 위반, `DROP COLUMN` 을 먼저 하면 구버전 upsert 가 전부 실패한다. **제약을 먼저 느슨하게** 만들면 두 버전이 동시에 동작해 무중단 창이 0 이 된다.
- ⚠ **상태 문자열은 DB CHECK 과 대조할 것** (Plan 110, 2026-09-20): `molit_ingest_runs_status_chk` 가 코드가 쓰는 `'timeout'` 을 금지해 적재기록 정리가 **90일간 매일 조용히 실패**했다(그 상태 행 0건·멈춘 `running` 21건·gap-retry 의 timeout 분기 사문화). 같은 try 안 **뒤 단계까지** 막았고, `run()` 이 결과를 중첩시켜 `cronStats._pick`(최상위 키만 본다)이 못 봐 health 에도 안 보였다. → 독립 정리 단계는 **각자 try**, cron 결과는 **평탄화 + `NUM` 등록**, "그 값을 가진 행이 0건" 은 쓰기 실패 신호.


### 완료되어 목록에서 제거 (이력)
- ~~regulations_snapshot 정책 SQL~~ (운영자 실행 완료 2026-06-27)
- **apt_master.molit_aliases** — ⚠ **"자동 backfill 완료" 는 사실이 아니었다.** 2026-09-06 실측:
  14,661행 중 별칭 보유 **1행**뿐이었다(그 1행이 운영자가 반복 지적한 공릉풍림아이원).
  같은 날 **1회 backfill 적용 → 10,505행**(Plan 053 부록 A, 운영자 승인 후 실행).
  판정 규칙: 동+건축년도 필수 · 채택은 지번 또는 이름(숫자열 일치) · 상가류·다중충돌 배제 · A/B 형제 확장.
  **자동화 완료(Plan 067, 2026-09-06)**: `aptMasterSync` cron 이 upsert 뒤 `refresh_molit_aliases()` 를 호출한다.
  ⚠ 2026-09-07·14 회차는 함수가 108초 걸려 cron 의 30초 중단(`TimeoutError`)에 걸렸다(DB 쪽 UPDATE 는 완료됨).
  2026-09-16 운영자 승인 후 CTE 3개를 MATERIALIZED 로 바꿔 **9.9초**(Plan 077, `supabase/migrations/20260910_*`).
  다음 확인: 09-21 주간 회차 `/api/health` crons['apt-master-sync'].aliasRefreshed 가 숫자여야 한다.
- ~~단지 모달 inline 법령 노출~~ (완료)

### 폐기 (운영자 방침·판정)
- AI RAG 컨텍스트 — AI 비용 최소화 방침과 충돌 (2026-07-15 폐기)
- 시행일자별 법령 효력 비교 — 가치 대비 복잡도 과다, 2회 '하지 말 것' 판정 (2026-07-15 폐기)

### 미진행 (long-term, 게이트 있음)
- 건축물대장 기반 KAPT 소형단지 갭 보강 확대 (온디맨드는 동작 중 — 대량 backfill 은 필요 시)
- 헤더 pill 구조·사이드바·IA 재편 — 운영자 "시안 먼저" 보류 (2026-07-15 실측이 헤더 혼잡 정량 실증)

### 폐기 추가 (운영자 확정)
- 전월세 DB 캐시 테이블 — 운영자 기존 거부, 2026-07-15 재확인. **재제안 금지** (기존 전세가율 표시 기능은 유지)

---

## 📂 핵심 파일 위치

- 본 가이드: `CLAUDE.md` (repo 루트)
- Sprint 기록: `.local-notes/SPRINT_NOTES_20260512.md` (gitignored, sandbox local)
- NCP setup: `.local-notes/NAVER_MAPS_SETUP_GUIDE.md`
- vercel cron: `vercel.json`
- backend services: `backend/services/` (geocodeCacheService / schoolService / academyService 등)
- backend jobs (cron): `backend/jobs/` (molitIngest / regulationsAutoFetch / aptMasterSync 등)
- frontend: `frontend/index.html` (단일 파일 SPA)

---

## 🚨 위험 신호 (운영자에게 즉시 알릴 것)

1. Sentry 신규 오류 spike (>10건/시간)
2. /api/health 응답 deploy id 미일치 (배포 실패)
3. naver.maps.Map 미정의 (NCP 키 만료/한도 초과)
4. molit-ingest cron 실패 3일 연속
5. 외부 API (KAPT/MOLIT/Kakao) 응답률 < 80%

---

마지막 갱신: 2026-09-26 (dataSyncedAt 회귀 복구(113) · 방향 검토 문서 114 · 110/111/106/077 라이브 검증 완료 · DB 406.6MB · 테스트 460)
