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

### 배포 예산 (2026-10-19, Plan 167 — 하루 71회 배포로 한도 거절 2회 뒤)
- Vercel Hobby 는 **git 푸시마다(모든 브랜치) 배포 1회**가 생기고 하루 한도가 있다(2026-10-18: myhomelog 71회 뒤 거절, 해제까지 약 6.5시간). 유료 전환 금지라 기다리는 것 외 방법 없음.
- **규칙**: 미리보기 푸시는 묶음당 1회(실측은 그 1회로 전부) · 운영 푸시는 하루 3회 이하 · 문서만 바뀐 커밋은 다음 코드 배포에 묶는다 · 실행 에이전트용 기준 브랜치를 원격에 올리지 않는다(계획 전문을 지시문에 넣는다) · 끝난 미리보기 브랜치는 원격에서 지운다.
- 배포 확인 루프가 deploy id 를 못 찾으면 `api.github.com/repos/wlsdn5968/myhomelog/commits/<sha>/status` 로 Vercel 상태부터 본다. 막혔을 때 프런트 로직은 미리보기 페이지에 바뀐 함수만 주입해 검증할 수 있다(서버 코드는 불가).

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

### DB 용량 — Supabase 무료 한도 500MB 중 **411MB(82%)** (2026-11-11 SQL 실측 · 헛쓰기 차단 트리거 + 인덱스 재구축 뒤)
- 자세한 기록(원문 그대로): `docs/ops/db-capacity.md`. 아래는 그 기록 가운데 경고, 금지, 꼭 알아야 할 규칙만 남긴 것이다.
- **원본 창 자르기 시작(107c, 2026-09-27)**: 2025-05 를 이력으로 옮겼다(원본 476,719 → 445,420 · 이력 1,321,411 · `molit_ingest_runs` 202505 = `archived`). 절차 a~h 는 `plans/107b-107c-window-cut-design.md` §2, 실행 기록 §5 + `supabase/migrations/20260927_107c1_cut_202505.sql`. **자르기는 파일 크기를 줄이지 않는다**(222MB 그대로) — 월 +16MB 성장을 멈추는 것이 목적. 다음 달(2025-06)은 **2026-10-01 이후에만**(15개월 하한 — `backend/routes/transactions.js:43` 의 monthsBack 15 화이트리스트가 창 시작을 읽는다; 09-27 에 자르면 14.9개월. 규칙: 달 M 은 `(M+1)-01 + 15개월` 부터) **운영자 승인 뒤** 같은 절차, 한 번에 한 달, 적재 창 밖, **d 단계 건수 대조를 통과하지 못하면 절대 지우지 않는다**. 3개월 이상 옮긴 뒤 `REINDEX INDEX CONCURRENTLY` 로 인덱스 회수. 쓰기와 측정은 **별도 문장**(같은 문장은 스냅샷 때문에 변화 0 으로 보인다).
- **2027-01 전**: Plan 107 원본 16개월 순환 보관(안 하면 2027-03 경 다시 한도). 종합 설계 `plans/104-db-capacity-management.md`. 진행: 0단계·107a·107b-1·107b-2·107c-1·**107c-2(2025-06, 2026-10-03 — e+f 는 운영자 SQL Editor)** 완료. **다음 2025-07 은 2026-11-01 이후** — 계획·SQL 준비 완료(`plans/107c-3-cut-202507.md` · `supabase/migrations/20261101_107c3_cut_202507.sql`, 2a1bc7d). 10-27 사전 점검 P2~P5 통과·P1 날짜 대기. 세 달째라 자른 뒤 i 단계(REINDEX) 처음 수행.
- **2026-11-11 (plans/190)**: 매일 적재가 값이 같은 행까지 다시 써서(하루 약 8만 행, 실제 새 거래 약 2천) 원본 인덱스가 이틀에 약 30MB 불어 441.4MB(88%)였다. 원본 표에 `zz_skip_same` 트리거(내장 `suppress_redundant_updates_trigger`)를 걸어 같은 값 갱신을 건너뛰게 했고, 인덱스 8개를 `reindex index concurrently` 로 다시 지어 410.9MB 가 됐다(인덱스 120.0 → 89.4MB). **이 트리거를 지우지 말 것**. `molit_ingest_runs.rows_inserted` 는 이제 "새로 들어오거나 바뀐 행 수"다(받은 행 수는 rows_fetched). 원본 창은 2025-08 부터(107c-3 까지 완료), 다음 자르기 2025-08 은 2026-12-01 이후.
- **다시 하지 말 것**: 이력 backfill 재개(동결됨) · 통째 upsert(apt_master 는 바뀐 행만 쓴다) · `molit_ingest_runs` 의 ok 를 기간만으로 전부 삭제((지역,월)별 최신 1건은 영구 보존 — 사라지면 그 달 조회가 MOLIT API 로 추락).
- **2026-10-02 실측**: 119 가 09-28~10-01 에 163쌍(약 3.9만 행)을 채워 원본 480,036행·클러스터 423.7MB(경보선 425MB 직전, 용량 경보 Sentry 는 아직 0건). ⚠ **탐지 창(16개월)의 빈틈**: 가장 오래된 원본 달은 매달 1일부터 자르는 날까지 탐지 밖 — 202506 의 신설 코드 7곳(인천 4·화성 3)이 남아 107c-2 P5 = 7. `gapHoles: 0` 은 "창 안 0" 이다. **Plan 130(8068509)으로 수정**: 표준 창 뒤로 "ok 있고 archived 0 인 달"이 이어지는 동안도 탐지한다(자른 달은 archived 라 제외 — 창 자르기 e+f 단계의 archived 표시에 의존). P5 = 0 확인 전 자르기 금지(`plans/107c-2-cut-202506.md` §2-1). 화성 3구 2025-05 는 이미 자른 달이라 이력에 없었다 → **Plan 131(7b4b778)**: 이력 backfill 지정 대상 3쌍 + 경신 기준선 재계산(기준선 ≡ 이력 집계, 81,918키 실측 일치).
- ⚠ **과거분 백필 뒤에는 월별 지역 수 연속성을 볼 것** (Plan 119, 2026-09-27): 2026-08-16 경기 백필의 한 회차가 연속 실패 차단기에 걸려 남은 작업을 `skipped` 로 넘겼고 **skipped 는 `molit_ingest_runs` 에 행을 남기지 않아** 경기 36곳 2025-11~2026-01 이 6주간 조용히 비어 있었다(당시 검증은 "최소 날짜가 2025-05 까지 내려왔나" 만 봤다). 검증 SQL: `select deal_ym, count(distinct lawd_cd) from molit_ingest_runs where status in ('ok','archived') group by 1 order by 1` — 한 달만 지역 수가 꺼지면 구멍. 자르기(107c) 전 P5 점검도 같은 이유.
- ⚠ **자른 달은 이제 이력에서 읽힌다 — archived 표시가 읽기 경로의 조건(Plan 170, 2026-10-30 b852612)**: `getTransactions` 는 원본에 ok 기록이 없는 달을 `getTransactionsFromHist` 로 `molit_apt_dim`(lawd_cd) + `molit_transactions_hist`(apt_seq IN 100개씩, ㎡×100 → ㎡)에서 읽는다. 대상 = 그 달 `archived` 가 **어느 지역에든** 있음(자르기는 전 지역 한 번에) 또는 `molit_hist_runs` 에 (지역, 달). 그 밖은 국토부 API 경로(운영에서 원본 창 밖 달은 이 API 가 실패했다 — 비교 24개월이 16개월로 조용히 줄었던 원인). **107c f 단계의 archived 표시를 빠뜨리면 그 달이 다시 국토부 API 로 가서 빈다.** 기록 `plans/170-tx-hist-region.md`.
- ⚠ **`pg_class` 를 읽는 감시 SQL 은 `relkind in ('r','m')`** (Plan 111 보정, 2026-09-27): `get_table_health` 가 `'r'` 만 봐 MV `molit_apt_index` 가 하루 감시 밖이었다 — 2026-09-20 감사 함정 1번의 재발. 적용 직후 결과에 MV 이름이 보이는지 확인.
- ⚠ **`create table` 에는 `enable row level security` 를 붙일 것** (Plan 107a, 2026-09-20): Supabase 는 public 스키마 신규 테이블에 `anon`·`authenticated` 기본 DML 권한을 준다 — **RLS 가 꺼져 있으면 PostgREST 로 누구나 쓸 수 있다**. `molit_apt_dim` 이 약 20분간 그 상태였다(쓰기 0건 실증 후 차단). 내부 전용 테이블은 **RLS on + 정책 0**(= service_role 만 통과, `molit_hist_peaks` 패턴). 만든 직후 점검: `select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity=false` → **0행**이어야 한다.
- ⚠ **컬럼을 payload 에서 빼기 전에 `not null` 부터 풀 것** (Plan 112, 2026-09-20): 코드를 먼저 배포하면 신규 INSERT 가 NOT NULL 위반, `DROP COLUMN` 을 먼저 하면 구버전 upsert 가 전부 실패한다. **제약을 먼저 느슨하게** 만들면 두 버전이 동시에 동작해 무중단 창이 0 이 된다.
- ⚠ **상태 문자열은 DB CHECK 과 대조할 것** (Plan 110, 2026-09-20): `molit_ingest_runs_status_chk` 가 코드가 쓰는 `'timeout'` 을 금지해 적재기록 정리가 **90일간 매일 조용히 실패**했다(그 상태 행 0건·멈춘 `running` 21건·gap-retry 의 timeout 분기 사문화). 같은 try 안 **뒤 단계까지** 막았고, `run()` 이 결과를 중첩시켜 `cronStats._pick`(최상위 키만 본다)이 못 봐 health 에도 안 보였다. → 독립 정리 단계는 **각자 try**, cron 결과는 **평탄화 + `NUM` 등록**, "그 값을 가진 행이 0건" 은 쓰기 실패 신호.

### 완료되어 목록에서 제거 (이력)
- 자세한 기록(원문 그대로): `docs/ops/done-history.md`. 아래는 그 기록 가운데 경고와 금지 문장만 남긴 것이다.
- **apt_master.molit_aliases** — ⚠ **"자동 backfill 완료" 는 사실이 아니었다.** 2026-09-06 실측:

### 폐기 (운영자 방침·판정)
- AI RAG 컨텍스트 — AI 비용 최소화 방침과 충돌 (2026-07-15 폐기)
- 시행일자별 법령 효력 비교 — 가치 대비 복잡도 과다, 2회 '하지 말 것' 판정 (2026-07-15 폐기)

### 구성요소 버전 정책 (2026-09-28, Plan 126)
- 자세한 기록(원문 그대로): `docs/ops/components.md`. 아래는 그 기록 가운데 경고, 금지, 꼭 알아야 할 규칙만 남긴 것이다.
- **백엔드 Sentry 는 `@sentry/node-core/light` 10.76.2 고정**(2026-11-10, plans/188): 시작 CPU 절감(로컬 중앙값 1,022ms 에서 609ms). 오류 수집만, 성능 추적 없음. 일반 node-core 는 OpenTelemetry 없이 요청 분리가 없어 태그가 섞인다(backend/test/sentry-light-isolation.test.js 가 막는다). 백엔드 코드는 `@sentry/node` 를 직접 부르지 말고 `../sentry` 를 부른다.
- **Sentry 로 나가는 데이터는 `backend/sentry.js` 의 `scrubEvent` 가 오류(beforeSend)·성능(beforeSendTransaction) 모두 거른다**(Plan 128, 2026-09-28): `sendDefaultPii:false` 만으로는 요청 본문·쿠키가 나갔고, 성능 표본에는 beforeSend 가 안 걸려 Authorization·OIDC 토큰·클라이언트 IP 까지 나갔다(운영 30일 93,230건 실측). 규칙: 본문·쿠키 삭제 · 헤더 허용목록 · 클라이언트 주소 삭제 · 환경변수 비밀값·PostgREST 필터 값·UUID 치환. ⚠ **11 은 성능 데이터를 span 항목으로 보내 beforeSendTransaction 을 우회**(실측) — `backend/test/sentry-scrub.test.js` 의 실제 SDK E2E 가 막는다. 새 외부 API 키 환경변수는 이름에 KEY/SECRET/TOKEN/PASSWORD 를 넣어야 자동 치환된다.

### 🚨 Upstash Redis 무료 한도 초과 (2026-10-14 발견)
- 자세한 기록(원문 그대로): `docs/ops/redis.md`. 아래는 그 기록 가운데 경고와 금지 문장만 남긴 것이다.
- 운영 Redis 가 **월 500,000 명령**을 넘어 모든 명령이 `ERR max requests limit exceeded` 로 실패 중(Vercel 런타임 로그). **쓰기 실패 시작 = 2026-10-05 16:49Z 경**(health 의 cron 기록이 그 시각에서 멈춤, 읽기는 간헐 성공 — 10-14 계획자 실측 10회 중 6회). 소진 원인·초기화 시점은 **Upstash 콘솔에서만** 보인다(운영자). 유료 전환 금지 방침. 운영자 크롬은 Upstash 콘솔에 로그인돼 있지 않았다(2026-10-14 확인 — 계획자는 로그인하지 않는다).

### 보안 — 운영자 결정 대기 (2026-09-28)
- 자세한 기록(원문 그대로): `docs/ops/security.md`. 아래는 그 기록 가운데 경고, 금지, 꼭 알아야 할 규칙만 남긴 것이다.
- **공개 입력을 저장하거나 캐시 키로 쓸 때(run-6, 2026-11-14)**: 시군구와 동 이름은 `utils/regionText.js` 의 `isSafeRegionText` 를 거친다. Kakao 를 부르는 공개 경로는 `createKakaoGate` 로 IP 예산과 전역 일일 상한에 넣는다. 자유 입력으로 만든 캐시 키 접두어를 새로 만들면 `cache.js` 의 `FREE_TEXT_PREFIXES` 에 더한다. 결제를 다시 켜기 전에 `docs/ops/security.md` 의 run-6 결제 4건부터 정한다.
- **공개 키 노출면 축소(Plan 129·132)**: 공개 키(`index.html` 메타)만으로 대형 테이블을 1,000행씩 무제한 REST 조회할 수 있었다(위험 = 무료 전송량 5GB 소진 → 전 API 402). **1단계 적용 완료(2026-10-02, 운영자 SQL Editor 실행 — 기록 `supabase/migrations/20261002_public_key_surface_stage1.sql`)**: 이력·편의시설·학교·건축물대장 공개 읽기 제거, 백엔드 전용 함수 5개 공개 실행 회수. **2단계 코드 완료(Plan 132, 77833fb)**: 검색·지도·인기 라이브 집계가 service_role 로 읽는다(`backend/test/public-key-surface.test.js` 가 고정 — 공개 키로 되돌리면 DB 권한을 닫은 뒤 42501). 절충(운영자 결정): 사용자 경로 DB 상한 anon 3s → 8s. **2단계 DB SQL(`plans/129` §4) 적용 조건 충족(2026-10-14 게이트웨이 로그 24h: 공개 키로 대상 5개 요청 0건 — 공개 키는 regulations_snapshot·popular_apts_snapshot 만)** — 계획자 시도 4가지가 모두 막힘(2026-10-14): 자동 모드 `apply_migration` declined · 수동 승인 모드 `apply_migration` declined · 수동 모드 `execute_sql` declined(Supabase MCP 가 정책 삭제·권한 회수 문장에 확인을 요구하는데 이 앱은 그 확인 창을 띄우지 못한다) · 운영자 크롬의 SQL Editor 로 가는 것은 자동 모드 분류기가 "안전장치 우회" 로 차단 → **운영자 SQL Editor 실행만 가능**. 공개 유지: `popular_apts_snapshot`·`regulations_snapshot`·`billing_plans`.

### 구성요소 점검 (2026-10-14) — `plans/audit-components-2026-10-14.md`
- 자세한 기록(원문 그대로): `docs/ops/components.md`.

### 2026-11-11 에 생긴 규칙 (plans/190~194)
- **자원 실측(Vercel 사용량 화면, 10-12~11-11)**: 팀 CPU 9시간 6분(한도 4시간, 12-08 까지 임시 12시간) 중 내집로그 3시간 16분. 전송량 팀 67GB 중 내집로그 58.7GB — 원인은 Sentry 가동 감시 봇이 1분마다 첫 화면(1.28MB)을 받아 간 것. `vercel.json` 첫 두 route 가 막은 수집기 차단과 감시 봇용 작은 응답(`frontend/up.txt`)을 한다. **이 두 route 를 지우거나 순서를 바꾸지 말 것**(`backend/test/ops-1111.test.js`).
- **원본 표의 `zz_skip_same` 트리거를 지우지 말 것**: 값이 같은 갱신을 건너뛰어 인덱스가 불어나지 않게 한다(위 DB 용량 절).
- **느린 정규식 기준선**: `scripts/check-regexp-ratchet.js` 가 verify 와 CI 에서 돈다. 새 정규식이 걸리면 입력을 먼저 자르거나(.slice) 반복에 상한을 둔다. 정규식을 고쳐 건수가 줄면 `node scripts/check-regexp-ratchet.js --update`.
- **화면 변경 확인 방법**: launch 설정 `home-preview`(= `scripts/dev-preview-proxy.cjs`, 화면 파일은 로컬·API 는 운영으로 넘김)로 띄워 1440x709 와 375x812 에서 잰다. 기준과 실측표는 `plans/192` 8절.
- **문구**: 문장 안 긴 줄표·가운뎃점으로 이은 나열·짧은 절 사이 연결어미 뒤 쉼표를 쓰지 않는다(`plans/193`). 면책 문장과 법적 고지는 글자 그대로 둔다.
- **Claude Design**: 시안 요청 전에 기획 문서 승인이 먼저다. 모델 표시가 바뀐 것을 확인한 뒤 보낸다(2026-11-11 두 번 실수).
- **보안 점검 산출물**: `C:/Users/Woo/security-audit-skill/myhomelog/run-1~3`. 결제를 열기 전에 반드시: payments 의 user_id 외래 키가 CASCADE 라 탈퇴 때 결제 기록이 지워진다(5년 보관 고지와 충돌, run-3).

### 2026-11-12~13 에 생긴 규칙 (plans/195, 중국 클라우드 수집기 사고)
- **서비스는 무료다(운영자 확정 2026-11-13)**: 유료 AI(Anthropic)는 서버에서 제거됐다(SDK 의존성 삭제, `aiService.callAI` 는 네트워크 없이 `AiDisabledError`). 맞춤 보고서는 늘 데이터 전용판(`buildDataOnlyReport`), `/api/clause` 는 410. **유료 API 를 다시 붙이지 말 것.** 결제 쓰기 경로(checkout, confirm, webhook, refund)는 `BILLING_ENABLED='true'` 가 아니면 410(`routes/billing.js` NO-BILLING). 화면에 "유료 플랜 출시", "AI 가 만든다" 문구를 쓰지 않는다(`backend/test/home-panel.test.js` 가 막는다).
- **Vercel 방화벽 규칙 "Block China and scraper ASNs"(Deny)**: 국가 CN, HK, MO + ASN 20개(Tencent 132203·45090·132591·133478, Huawei 136907·55990·131444·141180, Alibaba 45102·37963·134963, Baidu 38365, Volcano Engine 137718, BytePlus 150436, UCloud HK 135377, 중국 통신 4134·4837·9808·17621·63835). ASN 은 RIPE `stat.ripe.net/data/as-overview` 로 소유 회사를 확인한 것만 넣는다. 이 프로젝트는 Vercel API 로 방화벽 설정을 읽고 쓸 수 없다(404 Seawall Config not found) — **크롬의 Firewall > Rules 화면에서만** 고친다. Hobby 는 사용자 규칙 3개, 속도 제한 규칙 3개, IP 차단 10개까지.
- **두 번째 방화벽 규칙 "Challenge non-KR traffic with restrictions"(Challenge, 2026-11-13 00:39 KST 게시)**: 국가가 KR 이 아니고, 경로가 `/api/cron` 으로 시작하지 않고, `/api/health` 가 아니고, UA 가 `(bot|Bot|BOT|crawl|Crawl|spider|Spider|Slurp|Yeti|Daum|Google|google|bing|Bing|Sentry|sentry|vercel|facebookexternalhit|kakaotalk|KAKAOTALK|curl)` 에 맞지 않으면 도전 과제를 낸다. 근거: 중국 차단 뒤에도 미국, 프랑스, 스웨덴, 영국, 세르비아 등 가정용 회선 수십 곳(Verizon, Comcast, Charter, AT&T, Bouygues, SFR …)이 평범한 크롬 UA 로 나눠 들어와 방문 기록이 시간당 26~89건(정상 최대 8)이었다(11-12 하루 2,080건). 게시 뒤 규칙 일치가 바로 잡혔고 방문 기록이 멈췄다. Vercel 규칙 입력 칸은 `(?i)` 를 받지 않는다. 해외 정상 호출(Sentry 감시 봇, GitHub CI 의 curl, Vercel 예약 작업, 검색 로봇)을 새로 붙이면 이 예외에 들어가는지 먼저 본다.
- **이상 트래픽 감지**: 방문 기록이 한 시간에 40건(`VISIT_SURGE_HOURLY`, 정상 최대 8건의 5배)에 닿으면 Sentry 경보 `monitor:visit-surge`, 400건에서 한 번 더(`routes/attribution.js` SURGE-ALERT). 경보가 오면 방화벽 Traffic 화면의 AS 이름 상위를 보고 바로 차단한다. 수집기는 평범한 크롬 UA 와 흔한 JA4 를 써서 UA, JA4 로는 못 가른다. ASN 으로 막는다.
- **수집기 사고 사실(2026-11-12)**: Tencent 1.5만, Huawei 7.5천 건/24시간, 공개 API 만 호출, 회원·DB 직접 접근 0, 개인정보 유출 흔적 없음. 방문 수 977(정상 1~69). 이 날의 visit_attribution 행은 지우지 않았다(누적 방문 표시에 섞여 있음).
- **보고서 후보 첫 페이지 재시도**: 서울 전체 첫 페이지가 차가운 DB 에서 8초(57014)를 넘으면 한 번만 다시 묻는다(COLD-RETRY). 인덱스 추가는 DB 용량 때문에 하지 않았다.
- **개인정보처리방침 11-17 시행 개정 때 할 일**: 예고 표대로 본문에서 Anthropic 위탁(5절)·국외이전(6절) 행을 지우고, 1절 "AI 기반 정보 정리"를 "공공 데이터 정보 정리"로 바꾼다. 초안 브랜치 `preview/privacy-136`(adb4859) 에도 같은 수정이 필요하다. → 2026-11-13 현재 main 위에 시행본을 로컬 브랜치 `privacy-1117`(9355c94, 작업 폴더 `.claude/worktrees/privacy-1117`, 원격 미게시)로 준비했다. 11-17 KST 에 그 커밋을 main 에 합쳐 배포한다(시행일 전 배포 금지).
- **apt-master-sync 관측(2026-11-13)**: 11-09 회차는 125개 중 35개 지역만 돌고 받은 행 0 으로 295초에 끝났다(원인은 Hobby 로그 1시간 보관이라 미확인). health 의 `crons['apt-master-sync']` 에 이제 `fetched`, `errors`, `throttleHits`, `intervalMs`, `fetchErrorSample` 이 실린다. `cronStats` NUM 의 마지막 항목은 `canceledRemoved` 로 둔다(`molit-cancel-sync.test.js` 가 확인).
- **운영자에게 남은 일(2026-11-13 기준)**: (완료: Anthropic 키는 운영자가 2026-11-14 모두 지웠다고 확인, Vercel 변수 `ANTHROPIC_API_KEY` 는 11-13 삭제 확인), Vercel 2단계 인증, GitHub 2단계 인증 확인, 저장소 공개 여부 결정(지금 공개, 비밀값 0), NCP 지도 과금 확인.
- **보안 점검 run-4(2026-11-13~14, quick)**: 산출물 `C:/Users/Woo/security-audit-skill/myhomelog/run-4`. 이 호스트는 OS 강제 샌드박스를 만들 수 없어 확정 0, 검증 필요 15. 공식 검증기는 Windows 에 O_NOFOLLOW 가 없어 파일을 못 연다(공식 검사 함수를 부르는 감싸개로 검증). 소스로 확인된 7건을 고쳤다(AUDIT4-1114, `backend/test/audit4-1114.test.js`): 결제 410 차단 대소문자(고치기 전 /CONFIRM 이 410 이 아닌 것을 로컬 실행으로 재현), 인기 단지 limit 하한, 카카오 items 와 푸시 cron 의 지역 코드 허용 목록, 익명 동의 기록 Redis 하루 상한(IP 60, 전체 500), 공개 건축물대장 Kakao 관문, bump_activity_counter 회수 기록(운영은 이미 회수됨). 2차(AUDIT4B-1114, `backend/test/audit4b-1114.test.js`): in-bounds 서버 반올림(1e-6 오차 흡수, 경도에서 9% 한 칸 밀림을 독립 검토가 찾음)과 5분 기억 300개, 인증 IP 실패 계수(Supabase 가 무효라고 답한 경우만 1분 20번, exp 없는 토큰은 외부 미호출), 건축물대장 동별 키(지번 비교), 북마크 500, 현장 메모 300과 이름 100자 초과 거절, 검색 기록 최근 500건, 대화 전체 1000건과 하루 200건, search_popular_apts 회수 기록. 보안 점검 run-5(미뤄 둔 5개 영역, 8b9e7ef 고정 폴더 audit-8b9e7ef): 후보 1(결제 재개 시 등급 섞임, 결제 410 이라 지금 도달 불가). 3차: 가짜 푸시 구독 정리(retention runFakePushPrune: 30일 넘고 항목이 그 지역 실거래 이름, 마스터 이름, 별칭과 알림 매칭과 같은 정규화로 하나도 안 맞는 구독만, 조회 실패나 빈 지역이면 안 지움), 달성군 구지면 -> 구지읍 이름 변경 맞춤(`backend/utils/umdRename.js`, 지도 집계와 상세 거래 필터, 원본은 그대로, 이름 맞춘 뒤 좌표 중복 제거). 남은 것: payments FK CASCADE 와 결제 등급 정산(결제 재개 전), geocache_in_bounds DB 함수의 동 이름 비교(구지 9개 단지 거래 수 0 정렬).
- **편집 도구 함정**: Windows 에서 Python heredoc 으로 정규식이나 `\n` 이 든 문자열을 바꾸면 이스케이프가 깨진다(이 세션에서 세 번). 정규식 줄은 Edit 도구나 node `String.raw` 로 바꾼다.

### 문구·기능 연결 (2026-10-14) — `plans/147-149-copy-and-feature-links.md`
- 자세한 기록(원문 그대로): `docs/ops/ui-design-v2.md`. 아래는 그 기록 가운데 경고와 금지 문장만 남긴 것이다.
- 화면 문구는 **해요체 · 문장 속 화살표/줄표 나열 금지 · 내부 용어(KAPT·MOLIT·캐시·세션) 금지**. 기능 이름은 대출 계산 · 맞춤 보고서 · 특약 초안 · 규제 요약 · 청약 일정 · 브리핑 · 데이터 도우미로 통일(탭 라벨은 짧게). 새 문구도 이 규칙을 따른다.

### 디자인 v2 화면 A·B (2026-10-15) — `plans/150-151-screens-AB.md` · 사양 `plans/design-spec-v2-screens-AB-2026-10-15.md`
- 자세한 기록(원문 그대로): `docs/ops/ui-design-v2.md`. 아래는 그 기록 가운데 경고, 금지, 꼭 알아야 할 규칙만 남긴 것이다.
- **인기 단지 대체 경로 표기 정직화(운영 449a725, 2026-10-18)**: 프런트 공용 `_popRows(j)` — `degraded` 응답이면 평균가·건수를 비우고 `_degraded` 표식. 실시간 응답 소비자(소개 화면·브리핑·랭킹 카드·지도 마커)는 반드시 이 함수를 거칠 것(`backend/test/popular-degraded-label.test.js`). 랭킹 카드는 대체 경로 순위로 만들지 않는다. 서버 렌더 브리핑·도우미는 스냅샷(정상 품질만 저장)만 읽어 해당 없음.
- **151a 완료(운영 e539286, 2026-10-18)** — `plans/151-home-screen.md`: 데스크톱 지도 화면 왼쪽 = `#homePanel`(인기 12곳·**60일 평균가**·데이터에 있는 시도 칩), 검색 띠(헤더 `.hsearch` 노드 이동). **목록 화면은 사이드바 유지**. ⚠ 사이드바 노드는 지우지 말 것(doSearch·renderPList·cl·renderBookmarks 가 널 가드 없이 읽는다 — 숨김만). 인기 API 대체 경로 응답은 `degraded:true`(그 값은 최근 1건 가격·2주 표본 건수). 테스트 681.
- **153 헤더 더보기 메뉴(운영 60b7db3, 2026-10-18, 운영자 승인)** — 사양 `plans/design-spec-v2-screen-C-header-2026-10-18.md`·계획 `plans/153-header-more-menu.md`: 데스크톱 헤더에서 벨·데이터 상태 버튼 → 로그아웃 '더보기'(알림 설정·데이터 상태·서비스 정보와 사용량·사용법) / 로그인 아바타 메뉴(다크 모드 항목 제거). 빨간 점 `body.ntc-unsub`(_updateNtcDot), 데이터 상태 둘째 줄은 `window._syncData.kst`(#syncTime 은 띠 재렌더 때 사라지므로 읽지 말 것), 헤더 메뉴는 하나만 열림·ESC, 오른쪽 순서는 **마크업 순서**(CSS order 금지 — Tab 순서). 모바일 변화 없음. 테스트 705.
- **155 좁은 폭 보정(운영 5ea29c0, 2026-10-18)**: 남은 검색 칩을 button 으로(키보드로 서비스 정보 창) · 701~900px 홈 목록 2단(`.hp` 접두 — 뒤에 선언된 151 기본 규칙에 같은 특이성으로 진다) · 가로 모드(높이 ≤480) 시트 min 시작 · 헤더 검색 최소 폭 701~760 140(장애 시 100)·1120~1199 215 · 장애 시 남은 검색 칩 숨김 1120~1439. ⚠ **헤더 넘침은 `header.scrollWidth` 로 재지 말 것** — 끝 여백을 세지 않아 153 의 1120 넘침(41px)을 놓쳤다. 오른쪽 끝 요소 right − (창 폭 − padding-right) 로, 지도·지도 밖 × 평소·사용량·장애·둘 다 8가지. 테스트 711.
- **지도 화면 아래 고지 띠 숨김(운영 ab6db58, 2026-10-18, 운영자 요청)**: ≥701px 지도 화면(`body.hp-on`)은 `footer.legal-footer` 를 숨기고 그 내용 전부를 왼쪽 패널 하단 줄(`.hp-ft`, 사업자 정보는 버튼 펼침)로 옮겼다 — 지도 +75px(1440×900). 목록 화면·모바일은 그대로, 띠 노드는 지우지 말 것(앱 안 서버 렌더 페이지 링크). 테스트 712.
- **⚠ Vercel 하루 배포 한도(2026-10-18 실측)**: 푸시가 잦으면 "Deployment rate limited — retry in 24 hours" 로 운영 배포가 거절된다(유료 금지). 문서 커밋은 따로 푸시하지 말고 묶을 것, 미리보기 푸시 최소화. 거절 확인은 `api.github.com/repos/wlsdn5968/myhomelog/commits/<sha>/statuses`. (2026-10-18 에 이 이유로 미반영됐던 a7f8aa4 는 이후 배포로 master 에 들어갔다. 2026-11-14 `git branch -r --contains a7f8aa4` 로 확인, 재푸시 불필요.) 배포 방법은 그대로 `.claude/worktrees/p144` 에서 `git push origin HEAD:master`, 운영자 지시 한 줄이 있을 때만.
- **161 health 건수 스냅샷(운영 569a808)**: `getDataCounts`·`getFacilityQuality` 는 이제 `backend/services/healthCounts.js`. health 는 `readDataCounts()`·`readFacilityQuality()` 로 메모리 → `computed_snapshots`(키 `health:dataCounts:v1`·`health:facilityQuality:v1`) 한 행만 읽고, retention cron(18:00 UTC, POST·GET 둘 다)이 `refreshHealthSnapshots()` 로 하루 1회 갱신(원본·이력·단지 건수가 모두 성공했을 때만 저장). ⚠ 같은 캐시 키(`meta:dataCounts:v2`)를 브리핑이 읽는다 — 키 이름 바꾸지 말 것. **첫 18:00 UTC 뒤 두 키 생성 확인 필요.**
- ⚠ 미리보기 측정 함정: 창이 그려지지 않으면 CSS 전환·ResizeObserver·`:focus` 가 멈춘다 — `getAnimations().finish()` 또는 스크린샷 뒤 재측정.
- ⚠ 테스트에서 줄바꿈을 `'\n'` 문자로 비교하지 말 것 — Windows 작업 트리는 CRLF 체크아웃이라 실패했다(`\r?\n` 정규식). 2026-10-18 `.gitattributes` 로 작업 트리가 LF 가 됐지만 다른 환경 대비로 `\r?\n` 습관은 유지.

### 방문 현황 (2026-10-20, 운영 c4a0de6)
- 자세한 기록(원문 그대로): `docs/ops/feature-history.md`.

### 구별 TOP10·지도 중복·검색 보조 (2026-10-21)
- 자세한 기록(원문 그대로): `docs/ops/feature-history.md`. 아래는 그 기록 가운데 경고와 금지 문장만 남긴 것이다.
- **이름 합치기 규칙에서 괄호 안 내용은 지우지 말 것** — `후곡마을(대창)` ↔ `후곡마을(동양)` 은 다른 단지다(2026-10-21 미리보기 실측 결함). 괄호 기호만 뺀다.
- **(2026-10-21 밤) 9개 시도 확장 + 구 색 구역(REGION-SHADE, 운영 67b20dd)**: `SIDOS` = 실거래 적재 시도 전부(11·41·28·26·27·30·31·36·43, 스냅샷 키 v5). 목록 "전체"는 구마다 5곳, 지도는 **구 경계 옅은 색 구역 + 구마다 1위만**(전 구 TOP 을 찍으면 서울만 125~250개 — 겹침 정리로 숫자만 남아 운영자 "무슨 의미인지 모르겠고 어지럽다"). 구역·칩을 누르면 그 구만 진하게 + TOP10. 경계 = `frontend/geo/sgg-<시도>.json`(`scripts/build-sgg-geo.js`, 통계청 SGIS 행정동 경계 → vuski/admdongkor ver20261001, **CC BY 4.0 출처 표기 의무** — 목록 끝·범례 title 에 표기 중, 지우지 말 것). 맞닿은 구는 다른 색(빌드 때 같은 색 이웃 0 검사). 채움 0.11 은 안 보였다 → 0.2. ⚠ 모바일 시트 하한은 "목록 밖 시트 자식 전부 합"(하나씩 더하던 식이 칩 줄·방문자 배지를 빼먹어 목록 15px). 경계 갱신(행정구역 개편) 때는 admdongkor 최신판으로 빌드 스크립트 재실행.

### 첫 방문 화면 v5·보안 점검 (2026-10-21 밤)
- 자세한 기록(원문 그대로): `docs/ops/feature-history.md`. 아래는 그 기록 가운데 경고, 금지, 꼭 알아야 할 규칙만 남긴 것이다.
- **운영 DB 쓰기는 이 PC 의 자동 안전 검사가 모든 경로(Supabase MCP·관리 API 토큰·SQL Editor 입력)를 막는다** — 운영자가 SQL Editor 에서 직접 실행하거나, 설정에 허용 규칙을 넣어야 한다.

### 소비자 A~Z 점검 후속 (2026-10-29~30, 운영 b852612 · 테스트 963)
- 자세한 기록(원문 그대로): `docs/ops/feature-history.md`. 아래는 그 기록 가운데 경고와 금지 문장만 남긴 것이다.
- 운영자가 "사는 사람·파는 사람·갈아타는 사람이 되어 크롬으로 A~Z 눌러 보라" 고 해 두 차례 점검 → 결함 수정(SEC-1030·CON-1030B) + 새 화면. 공통 원칙: **법·기한 숫자는 law.go.kr·생활법령·금융위 원문을 크롬으로 직접 열어 확인한 것만**(에이전트는 법령 별표·JS 화면을 못 읽었다), 화면엔 근거·확인일 표시, 매수·매도 추천·예측 금지, 높았던 값은 낮았던 값과 함께.
- ⚠ **계획 번호 중복**: 154·156·159·160 이 두 파일씩 있다(10-18 감사 계획과 10-29~30 계획). 커밋 메시지의 Sprint 이름으로 구분하고, **다음 새 계획은 180부터**(171~179 사용).
- **175·176 단지 정체성(2026-10-30, 운영자 승인 — 관리 지역 125개 코드)**: 조사 `plans/175-apt-identity-audit.md`, 수정 `plans/176-apt-identity-fixes.md`. ① 별칭 함수 v8(빈 이름·단지/차 번호·거부 연결만 제거) ② **손 보정은 `apt_alias_overrides`(add/remove, reason) 와 좌표 `source='manual'` 로만** — 별칭은 매주 규칙으로 다시 계산되고 좌표는 매일 검증되므로 그 밖의 손 수정은 되돌아간다. manual 좌표는 일일 작업 대상 출처 밖 + `saveToDb` 보호 ③ 지도 영역은 `geocache_in_bounds`(거래 많은 순, service_role 전용) ④ 인기 TOP12·자동완성도 별칭으로 공식 단지 묶기 ⑤ 표시 이름: 단지 법정동과 같은 '동,' 접두·끝 (고층)/(저층) 제거(백엔드 `tidyMolitName` = 프런트 `_dispAptName`). ⚠ 별칭은 '신고 이름+동' 단위라 같은 동의 같은 이름 두 단지는 구분 못 한다(숲속마을·어울림) — 보정표로도 넣지 말 것. 단, 준공 연도로 갈리는 경우는 **178 연도 별칭 `이름#연도`**(보정표 add)로 나눈다(시흥 능곡동 우남퍼스트빌 1차 2008·2차 2011, 전국 1건). 별칭 대응표는 반드시 `aliasCanon(map, 이름, 동, 준공연도)` 로 읽을 것 — `map.get(`이름|동`)` 직접 조회는 테스트가 막는다(`plans/178-alias-year.md`). 검색은 **179**: 두 어절 이상이면 지역 분리(동·시군구)도 함께 하고 지역+이름 일치 단지를 앞에 둔다(카카오맵 기준, `plans/179-region-name-search.md`). 지역 결과를 합칠 때는 같은 행을 한 번만 셀 것(전에는 송파동이 동·시군구 두 경로로 두 번 세어졌다). 별칭 함수는 **177 에서 v9(임시 표 방식, 규칙 동일)로 99초 → 11~17초**(`_refresh_molit_aliases_core(p_apply)` — false 는 바뀔 단지 수만 세는 건조 실행, `refresh_molit_aliases()` 는 core(true) 껍데기), 주간 작업 끊기는 고정 30초 → 남은 예산(최대 120초) — `plans/177-alias-refresh-speed.md`. ⚠ 규칙을 고칠 때는 v8 마이그레이션이 아니라 v9 본체를 고치고, 고치기 전 건조 실행으로 바뀔 단지 수부터 잰다.
- ⚠ **배포 뒤 운영 실측으로 "화면이 말하는 기간 = 실제 집계" 를 확인할 것**: 160 은 테스트·미리보기(가짜 응답)가 다 초록이었는데 운영에서 24개월이 16개월이었다(국토부 API 실패를 경고 로그만 남기고 삼킴). 가짜 응답 미리보기는 서버 데이터 경로를 검증하지 못한다.

### 서비스 전면 검토 (2026-10-14) — `plans/review-2026-10-14.md`
- 자세한 기록(원문 그대로): `docs/ops/feature-history.md`.

### 미진행 (long-term, 게이트 있음)
- 전면 IA 재편(헤더·사이드바 너머의 정보구조 전체) — 계획 문서 없음, 원하면 운영자 "시안 먼저" (헤더 pill 8→3 은 84cf075, 사이드바 검색 콕핏 재구성은 d8d4538 로 2026-07-16 시안 승인 후 **이미 구현**됨 — 2026-09-27 대조)
- ~~건축물대장 기반 KAPT 소형단지 갭 보강 확대~~ → 완료: 2026-07-19 운영자 승인으로 `get_br_backfill_candidates` 게이트 개통 + cron `building-register-backfill` 매일 자동 실행(2026-07-22 cap 300) — 지금은 신규 유입분만 채우는 유지 속도(2026-09-27 대조)

### 폐기 추가 (운영자 확정)
- 전월세 DB 캐시 테이블 — 운영자 기존 거부, 2026-07-15 재확인. **재제안 금지** (기존 전세가율 표시 기능은 유지)

---

## 📂 핵심 파일 위치

- 본 가이드: `CLAUDE.md` (repo 루트). 날짜별 상세 기록은 2026-11-14 부터 `docs/ops/` 에 주제별로 나눠 둔다:
  `db-capacity.md`(DB 용량, 원본 창 자르기) · `components.md`(구성요소 버전, 점검) · `redis.md`(Upstash 한도) · `security.md`(보안 결정) · `ui-design-v2.md`(문구 규칙, 디자인 v2 화면) · `feature-history.md`(기능별 변경) · `done-history.md`(완료 항목).
  새 기록은 맞는 파일에 덧붙이고, 새 경고나 금지 규칙은 이 파일 해당 구역에도 한 줄 남긴다. 한 파일에 몰지 않는다.
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

마지막 갱신: 2026-11-13 (중국 클라우드 수집기 차단 · 유료 AI 제거 · 결제 쓰기 경로 차단 · 방문 급증 경보 · 보고서 첫 페이지 재시도 · plans/195 · 테스트 1101) · 이전: 2026-11-11 (자원 관리 190 · 디자인 1~3단계 192 · 문구 193 · 도구 194 · 보안 점검 run-2, run-3 · 테스트 1086) · 이전: 2026-10-30 (소비자 A~Z 점검 후속 154~160 · Plan 170 자른 달 이력 읽기 b852612 · DB 442MB 88% · Redis 쓰기 복구 · 테스트 963) · 이전: 2026-10-18 (151a·151b 첫 화면 · 인기 대체 경로 표기 · 줄바꿈 LF 통일 · 152 헤더 v2 · VIEW-TOP · 153 헤더 더보기 60b7db3 · 155 좁은 폭 보정 5ea29c0 · 데스크톱 고지 띠 제거 44620c5 · 테스트 713) · 이전: 2026-10-15 (150 단지 상세 "다음에 할 일" 운영 637d5c1 · 다음 151 첫 화면 `plans/150-151-screens-AB.md` · 147~149 문구·기능 연결 · 129 2단계 SQL·136 처리방침 운영자 · 테스트 670)
