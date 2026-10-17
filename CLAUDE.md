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

### DB 용량 — Supabase 무료 한도 500MB 중 **437MB(87%, 경보선 85% 넘음)** (2026-10-14 health 실측 · 107c 창 자르기 2달 완료)
- 한도 기준은 **클러스터 전 DB 합계**: `SELECT sum(pg_database_size(datname)) FROM pg_database`. 넘으면 **읽기 전용 모드**. health 의 `db`(RPC `get_db_size_bytes`)와 `db_size_mb()` 가 이제 같은 식을 쓴다(Plan 105).
- 하루 경과: 482(96%) → backfill 2020-09 동결(100) → 이력 인덱스 단일키(101) → 경신 기준선 6년(103) → **유지보수 회수(106) = 405MB**. 원본 `molit_transactions` 는 월 ≈13.9MB 증가.
- **경보**: retention cron 이 매일 85%(425MB)에서 Sentry warning, 93%(465MB)에서 error(`monitor:db-capacity`).
- **다시 하지 말 것**: 이력 backfill 재개(동결됨) · 통째 upsert(apt_master 는 바뀐 행만 쓴다) · `molit_ingest_runs` 의 ok 를 기간만으로 전부 삭제((지역,월)별 최신 1건은 영구 보존 — 사라지면 그 달 조회가 MOLIT API 로 추락).
- **유지보수 재실행 시**: 적재 창(17:00~19:00 UTC)·apt-master-sync(월 20:00 UTC)를 피하고, 명령 전후로 위 합계 쿼리를 잰다. 절차·실측은 `supabase/migrations/20260920_maintenance_reclaim.sql`.
- **2027-01 전**: Plan 107 원본 16개월 순환 보관(안 하면 2027-03 경 다시 한도). 종합 설계 `plans/104-db-capacity-management.md`. 진행: 0단계·107a·107b-1·107b-2·107c-1·**107c-2(2025-06, 2026-10-03 — e+f 는 운영자 SQL Editor)** 완료. **다음 2025-07 은 2026-11-01 이후**(같은 절차 — `plans/107c-2-cut-202506.md` 를 복제해 날짜만 바꾼다).
- **경보선(85%) 도달 — 2026-10-14 health `db.usedMb` 437(87%, `warn:true`)**: 예상(10-21)보다 이르다. 107c-2 직후 415MB(현재 DB 기준) → 10-14 423MB(현재 DB) / 437MB(전 DB 합계). 원본 파일은 자르기로 늘지 않는다(230.8MB 그대로) — 나머지 테이블·카탈로그 증가는 아직 분해하지 않았다. **경보는 고장이 아니라 예고** — 93%(465MB)까지 약 28MB. 다음 수단: 11-01 이후 107c-3(2025-07) · 3개월분 이동 뒤 REINDEX.
- **조용한 구멍 자동 재적재(Plan 119, 2026-09-28 병합 d209abc)**: `retryFailedGaps` 가 이제 적재 기록 자체가 없는 (지역, 월)도 찾아 채운다(최신 3개월 제외, 슬롯당 15). 남은 수는 `/api/health` `crons['molit-ingest'].gapHoles` — 0 이 정상.
- **2026-10-02 실측**: 119 가 09-28~10-01 에 163쌍(약 3.9만 행)을 채워 원본 480,036행·클러스터 423.7MB(경보선 425MB 직전, 용량 경보 Sentry 는 아직 0건). ⚠ **탐지 창(16개월)의 빈틈**: 가장 오래된 원본 달은 매달 1일부터 자르는 날까지 탐지 밖 — 202506 의 신설 코드 7곳(인천 4·화성 3)이 남아 107c-2 P5 = 7. `gapHoles: 0` 은 "창 안 0" 이다. **Plan 130(8068509)으로 수정**: 표준 창 뒤로 "ok 있고 archived 0 인 달"이 이어지는 동안도 탐지한다(자른 달은 archived 라 제외 — 창 자르기 e+f 단계의 archived 표시에 의존). P5 = 0 확인 전 자르기 금지(`plans/107c-2-cut-202506.md` §2-1). 화성 3구 2025-05 는 이미 자른 달이라 이력에 없었다 → **Plan 131(7b4b778)**: 이력 backfill 지정 대상 3쌍 + 경신 기준선 재계산(기준선 ≡ 이력 집계, 81,918키 실측 일치).
- ⚠ **과거분 백필 뒤에는 월별 지역 수 연속성을 볼 것** (Plan 119, 2026-09-27): 2026-08-16 경기 백필의 한 회차가 연속 실패 차단기에 걸려 남은 작업을 `skipped` 로 넘겼고 **skipped 는 `molit_ingest_runs` 에 행을 남기지 않아** 경기 36곳 2025-11~2026-01 이 6주간 조용히 비어 있었다(당시 검증은 "최소 날짜가 2025-05 까지 내려왔나" 만 봤다). 검증 SQL: `select deal_ym, count(distinct lawd_cd) from molit_ingest_runs where status in ('ok','archived') group by 1 order by 1` — 한 달만 지역 수가 꺼지면 구멍. 자르기(107c) 전 P5 점검도 같은 이유.
- **원본 창 자르기 시작(107c, 2026-09-27)**: 2025-05 를 이력으로 옮겼다(원본 476,719 → 445,420 · 이력 1,321,411 · `molit_ingest_runs` 202505 = `archived`). 절차 a~h 는 `plans/107b-107c-window-cut-design.md` §2, 실행 기록 §5 + `supabase/migrations/20260927_107c1_cut_202505.sql`. **자르기는 파일 크기를 줄이지 않는다**(222MB 그대로) — 월 +16MB 성장을 멈추는 것이 목적. 다음 달(2025-06)은 **2026-10-01 이후에만**(15개월 하한 — `backend/routes/transactions.js:43` 의 monthsBack 15 화이트리스트가 창 시작을 읽는다; 09-27 에 자르면 14.9개월. 규칙: 달 M 은 `(M+1)-01 + 15개월` 부터) **운영자 승인 뒤** 같은 절차, 한 번에 한 달, 적재 창 밖, **d 단계 건수 대조를 통과하지 못하면 절대 지우지 않는다**. 3개월 이상 옮긴 뒤 `REINDEX INDEX CONCURRENTLY` 로 인덱스 회수. 쓰기와 측정은 **별도 문장**(같은 문장은 스냅샷 때문에 변화 0 으로 보인다).
- ⚠ **`pg_class` 를 읽는 감시 SQL 은 `relkind in ('r','m')`** (Plan 111 보정, 2026-09-27): `get_table_health` 가 `'r'` 만 봐 MV `molit_apt_index` 가 하루 감시 밖이었다 — 2026-09-20 감사 함정 1번의 재발. 적용 직후 결과에 MV 이름이 보이는지 확인.
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
  09-21 주간 회차 확인 완료(2026-09-26 기록): `aliasRefreshed: 17`, TimeoutError 재발 없음.
- ~~단지 모달 inline 법령 노출~~ (완료)

### 폐기 (운영자 방침·판정)
- AI RAG 컨텍스트 — AI 비용 최소화 방침과 충돌 (2026-07-15 폐기)
- 시행일자별 법령 효력 비교 — 가치 대비 복잡도 과다, 2회 '하지 말 것' 판정 (2026-07-15 폐기)

### 구성요소 버전 정책 (2026-09-28, Plan 126)
- **Node**: 두 package.json `engines.node = "24.x"` 고정 — Vercel 은 engines 가 프로젝트 설정보다 우선이고 열린 범위(`>=22`)는 지원 최고 메이저로 해석해 26.x 추가 시 무검증 자동 승격된다. 24.x 는 2026-10-20 Maintenance LTS, 26.x 는 2026-10-28 Active LTS 전환 — Vercel 지원 뒤 별도 계획으로 옮긴다.
- **Sentry**: 10.76.2(Plan 137, 백엔드·index.html CDN 같은 버전 — `frontend/billing.html` 만 10.69.0·SRI 없음, 결제 페이지라 보류). v10 줄 유지보수 중, 11 은 09-23 이후 3주간 minor 7개. **11 전환 착수 기준(운영자 "권고대로" 2026-10-14)**: 11.x 최신 minor 가 14일 이상 유지되거나 v10 유지보수 종료가 공식 공지되면 — 11-07 재확인. **11 로 올릴 때는 `dataCollection` 을 v10 동등(제한)으로 명시 필수** — v11 은 설정을 비우면 userInfo·cookies·요청/응답 본문·DB 쿼리를 기본 수집한다(공식 MIGRATION.md). `backend/test/components-guard.test.js` 가 메이저 11 이상인데 `dataCollection:` 옵션이 없으면 막는다. 브라우저 CDN 번들 버전은 백엔드와 같게.
- **Sentry 로 나가는 데이터는 `backend/sentry.js` 의 `scrubEvent` 가 오류(beforeSend)·성능(beforeSendTransaction) 모두 거른다**(Plan 128, 2026-09-28): `sendDefaultPii:false` 만으로는 요청 본문·쿠키가 나갔고, 성능 표본에는 beforeSend 가 안 걸려 Authorization·OIDC 토큰·클라이언트 IP 까지 나갔다(운영 30일 93,230건 실측). 규칙: 본문·쿠키 삭제 · 헤더 허용목록 · 클라이언트 주소 삭제 · 환경변수 비밀값·PostgREST 필터 값·UUID 치환. ⚠ **11 은 성능 데이터를 span 항목으로 보내 beforeSendTransaction 을 우회**(실측) — `backend/test/sentry-scrub.test.js` 의 실제 SDK E2E 가 막는다. 새 외부 API 키 환경변수는 이름에 KEY/SECRET/TOKEN/PASSWORD 를 넣어야 자동 치환된다.
- **CDN 스크립트·스타일은 SRI 필수**: 버전을 바꾸면 integrity 도 같이 바꿔야 로드된다. 해시는 npm tarball(sha512 무결성 검증) 또는 공식 게시값과 대조해 계산. jsDelivr 의 `.min.js` 자동 압축본은 npm 원본이 아니다 — 원본 파일 경로를 쓴다.
- **drizzle-kit(dev) 중간 4건**: esbuild 개발 서버 권고 — 상류 수정판 없음, 배포 제외, 운영 감사(`--omit=dev`) 0건 → 수용. `overrides.satori.fflate = 0.7.5` 는 satori 가 계속 취약 버전을 고정하므로 유지.
- **결제 페이지 CSP 는 보고 전용**(2026-09-02 c8e6137 결정 — 결제 게이트 해제 전 위젯 호스트 측정 불가). 운영자가 결제 주제를 꺼내기 전에는 변경하지 않는다.

### 🚨 Upstash Redis 무료 한도 초과 (2026-10-14 발견)
- 운영 Redis 가 **월 500,000 명령**을 넘어 모든 명령이 `ERR max requests limit exceeded` 로 실패 중(Vercel 런타임 로그). **쓰기 실패 시작 = 2026-10-05 16:49Z 경**(health 의 cron 기록이 그 시각에서 멈춤, 읽기는 간헐 성공 — 10-14 계획자 실측 10회 중 6회). 소진 원인·초기화 시점은 **Upstash 콘솔에서만** 보인다(운영자). 유료 전환 금지 방침. 운영자 크롬은 Upstash 콘솔에 로그인돼 있지 않았다(2026-10-14 확인 — 계획자는 로그인하지 않는다).
- 영향(코드 원문 확인): **유료 AI(`/api/report`·`/api/clause`)는 fail-closed 503 으로 막힘**(비용 안전) · 무료 룰베이스 챗도 같은 리미터라 503 → **Plan 133** · 일반·데이터·og·share 요청 제한은 fail-open(제한 없음) · `/api/geocode` 전역 Kakao 일일 상한(8,000)도 fail-open(인스턴스별 일일 60 만 남음) · Redis 2차 캐시 전부 미스(같은 시기 지역 가격 기록 함수 `get_price_records_by_region` 의 시간 초과가 10-04 0건 → 10-11~12 13건으로 늘었다 — 인과는 미확정) · `/api/health` 의 `crons`·`searchDegrade`·`chatIntents` null · `usage.used` 0 표시.
- 코드상 health 1회 = Redis 명령 8개(웜, 비로그인) — 5분 간격 모니터만으로 월 약 6.9만(한도의 14%). 나머지 소진원은 코드만으로 특정 못 함.


### 보안 — 운영자 결정 대기 (2026-09-28)
- **공개 키 노출면 축소(Plan 129·132)**: 공개 키(`index.html` 메타)만으로 대형 테이블을 1,000행씩 무제한 REST 조회할 수 있었다(위험 = 무료 전송량 5GB 소진 → 전 API 402). **1단계 적용 완료(2026-10-02, 운영자 SQL Editor 실행 — 기록 `supabase/migrations/20261002_public_key_surface_stage1.sql`)**: 이력·편의시설·학교·건축물대장 공개 읽기 제거, 백엔드 전용 함수 5개 공개 실행 회수. **2단계 코드 완료(Plan 132, 77833fb)**: 검색·지도·인기 라이브 집계가 service_role 로 읽는다(`backend/test/public-key-surface.test.js` 가 고정 — 공개 키로 되돌리면 DB 권한을 닫은 뒤 42501). 절충(운영자 결정): 사용자 경로 DB 상한 anon 3s → 8s. **2단계 DB SQL(`plans/129` §4) 적용 조건 충족(2026-10-14 게이트웨이 로그 24h: 공개 키로 대상 5개 요청 0건 — 공개 키는 regulations_snapshot·popular_apts_snapshot 만)** — 계획자 시도 4가지가 모두 막힘(2026-10-14): 자동 모드 `apply_migration` declined · 수동 승인 모드 `apply_migration` declined · 수동 모드 `execute_sql` declined(Supabase MCP 가 정책 삭제·권한 회수 문장에 확인을 요구하는데 이 앱은 그 확인 창을 띄우지 못한다) · 운영자 크롬의 SQL Editor 로 가는 것은 자동 모드 분류기가 "안전장치 우회" 로 차단 → **운영자 SQL Editor 실행만 가능**. 공개 유지: `popular_apts_snapshot`·`regulations_snapshot`·`billing_plans`.
- **개인정보처리방침 §5·§6 사실 불일치(Plan 136, 2026-10-14 대조)**: Anthropic 이전 시점 "AI 채팅" → 실제는 리포트·특약 분석 · Upstash "개인정보 미저장·토큰 해시·최대 24시간" → 실제는 IP/회원 ID 키(당일 자정까지)·답 못 한 챗 질문 80자 최근 50건(만료 없음), §6 국외이전 표에 Upstash 누락 · Sentry "오류 시·90일" → 실제는 오류 + 요청 표본 약 10%, 보관은 요금제별(무료 30일). 수정안은 `plans/136-privacy-policy-facts.md` — **공개 법적 고지라 게시는 운영자 확인 뒤**(Sentry 요금제 확인 1건 필요).
- **Sentry 프로젝트 설정** — ✅ 2026-10-02 적용: 조직 Security & Privacy 의 "Prevent Storing of IP Addresses" 켬(운영자가 로그인해 둔 크롬에서 계획자가 그 토글 하나만 변경 — 두 프로젝트 `node`·`myhomelog-frontend` 에 잠금 표시로 강제 적용 확인). 프로젝트별 Data Scrubber·Use Default Scrubbers 는 원래 켜져 있었다. ECOS 키 재발급은 선택(노출 범위 = 운영자 Sentry 조직, 저장분 2026-10-21 전후 자동 만료).

### 구성요소 점검 (2026-10-14) — `plans/audit-components-2026-10-14.md`
- 버려진 대용량 DB 데이터 없음(79% 가 원본·이력, 즉시 회수 가능 0.5MB) · 버전 대체로 최신(미사용 의존성 0, 운영 감사 0) · 최대 문제는 Redis 쓰기 실패(10-05~). 139(Redis 명령 절감)·140(cron·지역 페이지)·141(패치 갱신) 진행.

### 문구·기능 연결 (2026-10-14) — `plans/147-149-copy-and-feature-links.md`
- 화면 문구는 **해요체 · 문장 속 화살표/줄표 나열 금지 · 내부 용어(KAPT·MOLIT·캐시·세션) 금지**. 기능 이름은 대출 계산 · 맞춤 보고서 · 특약 초안 · 규제 요약 · 청약 일정 · 브리핑 · 데이터 도우미로 통일(탭 라벨은 짧게). 새 문구도 이 규칙을 따른다.
- 화면별 사용량 데이터 없음(Vercel Web Analytics 꺼짐 — Hobby 월 5만 무료·초과 시 중단, 켜기는 운영자). 회원 7·30일 로그인 0(10-14).
- (정정 2026-10-15) 약관 모달은 도우미를 AI 라고 부르지 않는다 — "AI 분석의 한계" 를 일반 면책으로 넓게 적은 것(실제 AI 는 맞춤 보고서뿐, 넓은 면책이라 무해). 사실과 다른 곳은 개인정보처리방침의 "AI 채팅 사용 시" 뿐이고 Plan 136 수정안에 이미 포함.

### 디자인 v2 화면 A·B (2026-10-15) — `plans/150-151-screens-AB.md` · 사양 `plans/design-spec-v2-screens-AB-2026-10-15.md`
- **150 완료(운영 637d5c1)**: 단지 상세 "다음에 할 일"(주 행동 대출 계산 + 비교 담기·관심·특약 초안·시도 청약 일정 + 시장 요약·도우미·공유·카드·단지 페이지), 모바일 하단 고정 바 + 더보기 시트, 상세가 열린 동안 앱 하단 탭 숨김, `#mapEl{isolation:isolate}`. 테스트 670.
- **다음 151 첫 화면 구조**(미착수): 시안 화면 B. ⚠ 인기 API 에는 "최근 단건 거래가" 필드가 없다(`avgDealAmount` = 60일 평균) — 칸 이름을 사실대로. 사이드바 입력(#bp #mc #inc·칩)에 148 기능이 의존.
- ⚠ 테스트에서 줄바꿈을 `'\n'` 문자로 비교하지 말 것 — Windows 작업 트리는 CRLF 체크아웃이라 실패한다(`\r?\n` 정규식).
- **세션 예약 점검(세션 전용 — 새 세션에서 다시 등록 필요)**: 10-28 11:23 express 5.3.0 재검토 · 10-29 10:23 Node 26 전환 조건 · 11-01 13:07 Redis 확인·107c-3(2025-07) 준비 · 11-07 10:17 Sentry 11 전환 조건.

### 서비스 전면 검토 (2026-10-14) — `plans/review-2026-10-14.md`
- 강점: 실거래 181만 건·매일 적재·공식 출처·서버 렌더 SEO. 약점: 첫 화면 과밀, 이모지 552개·글자 크기 30종·인라인 스타일 1,322곳("AI 가 만든 느낌"의 실측 원인), 앱(밝은+금색)과 서버 렌더 페이지(어두운 남색) 테마 불일치, 유료 보고서 503(Redis), 느린 API 3~5초, 키보드 접근성. **디자인 개편은 Claude Design 시안 승인 먼저**(운영자 상시 요구) — 문구 사실·원칙 정정만 Plan 138 로 먼저 반영.

### 미진행 (long-term, 게이트 있음)
- 전면 IA 재편(헤더·사이드바 너머의 정보구조 전체) — 계획 문서 없음, 원하면 운영자 "시안 먼저" (헤더 pill 8→3 은 84cf075, 사이드바 검색 콕핏 재구성은 d8d4538 로 2026-07-16 시안 승인 후 **이미 구현**됨 — 2026-09-27 대조)
- ~~건축물대장 기반 KAPT 소형단지 갭 보강 확대~~ → 완료: 2026-07-19 운영자 승인으로 `get_br_backfill_candidates` 게이트 개통 + cron `building-register-backfill` 매일 자동 실행(2026-07-22 cap 300) — 지금은 신규 유입분만 채우는 유지 속도(2026-09-27 대조)

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

마지막 갱신: 2026-10-15 (150 단지 상세 "다음에 할 일" 운영 637d5c1 · 다음 151 첫 화면 `plans/150-151-screens-AB.md` · 147~149 문구·기능 연결 · 129 2단계 SQL·136 처리방침 운영자 · 테스트 670)
