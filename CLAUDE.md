# myhomelog — Claude Code 작업 가이드

내집로그(myhomelog.vercel.app)는 공공 실거래 자료로 아파트 정보를 정리해 보여 주는 무료 서비스다. 화면은 단일 파일(`frontend/index.html`), 서버는 Express 를 Vercel 함수 하나로 돌리고, 자료는 Supabase 에 있다.
운영자(wlsdn5968) 와의 작업 시 적용되는 운영 룰 + 컨텍스트 빠른 복원. 지금 상태와 다음 할 일은 `HANDOFF.md`.

---

## 📌 고정 규칙 (2026-11-15 정기 점검에서 운영자 지시로 넣음)

1. 과정은 한국어로 설명
2. 추측 금지·근거 제시
3. 확인 불가는 확인 불가로 표기

운영자가 이 저장소 작업에 거듭 붙인 말(원문)
- "절대 추측하지말고 환각 배제해서 작업 진행해라. 크로스체크해서 빠지는 거 없이 진행해. 병렬로 작업이 필요할 경우, 낮은 등급의 모델 에이전트들을 사용해서 토큰 값을 아껴줘. 그대신 품질은 낮아지지 않도록 주의해서 너가 잘 판단해서 작업시키고 판단해줘. 너가 할수있는것들은 너가 해 나한테 시키지말고."
- "우리 서비스의 db, 메모리, cpu, api 호출 등등 최대한 효율화를 진행해서 우리 서비스도 과부하가 걸리지 않도록, 사용자도 과부하가 걸려서 리밋이 걸리지 않도록 해줘야 되는게 가장 중요해." (2026-11-15)
- "저번에도 메모리랑 cpu, db많이 사용해서 vercel 제한당했잖아. 그런일 없도록 잘 하라니까??" (2026-11-15)
- "운영 DB 는 조회만. 쓰기 SQL 은 나에게 준다." (2026-11-15)
- "유료 서비스 금지. .env.local 읽지 않기." (2026-11-15)

글쓰기와 일하는 방식의 전체 원칙은 전역 지침 `C:\Users\Woo\.claude\CLAUDE.md` 에 있다(한국어, 굵게와 긴 줄표와 가운뎃점 나열 금지, 추측 금지, 교차 확인, 낮은 등급 모델 병렬, 직접 끝까지, 결론과 근거와 남은 일 순서).

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
- 되돌리기 어려운 일(브랜치 병합, 운영 DB 적용, 배포)만 운영자 확인 뒤에 진행한다. 그 밖의 일은 작게 끊어 승인받지 않고 묶어서 끝까지 한 뒤 한 번 보고한다. (2026-11-14 운영자 승인으로 고침. 고치기 전 문장: "자동 진행 X (운영자 확인 후 다음 작업 시작)")

**4. SPRINT_NOTES 업데이트**
- 오늘 commit chain table 갱신
- 신규 sprint 섹션 추가 (변경 사항 + 검증 결과 + 회귀 위험)
- 운영자 결정 대기 사항 정리

---

> SPRINT_NOTES 는 메인 폴더의 `.local-notes`(git 밖)에만 있고 작업 폴더에서는 보이지 않는다(2026-11-15 확인). 2026-11-14 부터 기록은 `docs/ops/` 주제 문서와 `HANDOFF.md`, 감사 기록은 `AUDIT_REPORT.md` 에 적는다. 위 문장의 SPRINT_NOTES 는 이 문서들로 읽는다(운영자 승인 2026-11-15).

## 🛠 작업 패턴

### Sprint naming
- 날짜와 주제로 붙인다. 예: `Sprint 1114-audit6`, `Sprint 1114-improve-e` (2026-11-14 운영자 승인으로 실제 쓰는 방식에 맞춤. 고치기 전 규칙: "`Sprint A` ~ `Sprint Z` ~ `Sprint AA` ~ `Sprint ZZ` 순차")
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

## ▶ 실행·검증·배포 명령

- 작업 폴더: `C:\Users\Woo\Downloads\myhomelog_deploy_1\myhomelog\.claude\worktrees\p144` (브랜치 `ui-155`)
- 검증: 루트에서 `npm run verify` (한 번에 하나만 돌린다)
- 검사 하나만: `cd backend` 뒤 `node --test test/<파일>.test.js` (시간대는 UTC 로 맞춘다)
- 화면 확인: launch 설정 `home-preview`(`scripts/dev-preview-proxy.cjs`, 화면 파일은 로컬, API 는 운영으로 넘기고 응답을 600초 기억). 설정 파일은 `C:\Users\Woo\Downloads\myhomelog_deploy_1\.claude\launch.json`. 방금 운영 값이 필요하면 주소에 `_fresh=1`.
- 배포: 작업 폴더에서 `git push origin HEAD:master`. KST 하루 3회 이하. 운영자가 배포를 가리킨 한 줄("배포해")이 있을 때만 한다. "권고대로 진행"으로는 자동 권한 검사가 막는다.
- 배포 뒤: `/api/health` 의 deploy 값, 런타임 오류, `cpuDay` 와 `crons.<이름>.cpuMs`.
- 운영 DB: 조회만 한다. 쓰기 SQL 은 운영자에게 주고 운영자가 SQL Editor 에서 실행한다.

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

## 🚫 금지 사항 (이유와 원문은 옆 문서)

자원과 비용
- Vercel 팀 Active CPU 는 30일 합계 4시간이다. 순간 부하가 아니라 누적으로 판단한다. 새 예약 작업이나 무거운 경로를 넣기 전에 CPU 를 먼저 잰다. → `docs/ops/operations-rules.md`, `AUDIT_REPORT.md` 11절
- 하루 CPU 합계 장치(`backend/services/cpuBudget.js`)를 지우지 말 것. → `docs/ops/operations-rules.md`
- 서비스는 무료다. 유료 API 를 다시 붙이지 말 것. 화면에 "유료 플랜 출시", "AI 가 만든다" 문구를 쓰지 않는다. → `docs/ops/operations-rules.md`
- `vercel.json` 첫 두 route(수집기 차단, 감시 봇용 작은 응답)를 지우거나 순서를 바꾸지 말 것. → `docs/ops/operations-rules.md`
- 점검은 운영 함수를 아껴서 한다. 운영 주소를 직접 두드리는 점검과 배포는 묶어서 한다. → `docs/ops/operations-rules.md`
- 방화벽 규칙은 크롬의 Firewall > Rules 화면에서만 고친다. 이상 트래픽 경보가 오면 바로 차단한다. → `docs/ops/operations-rules.md`

DB
- 원본 표의 `zz_skip_same` 트리거를 지우지 말 것. → `docs/ops/db-capacity.md`
- **다시 하지 말 것**: 이력 backfill 재개(동결됨) · 통째 upsert(apt_master 는 바뀐 행만 쓴다) · `molit_ingest_runs` 의 ok 를 기간만으로 전부 삭제((지역,월)별 최신 1건은 영구 보존 — 사라지면 그 달 조회가 MOLIT API 로 추락).
- 원본 창 자르기는 운영자 승인 뒤, 한 번에 한 달, 적재 창 밖에서 한다. d 단계 건수 대조를 통과하지 못하면 절대 지우지 않는다. P5 = 0 확인 전 자르기 금지. f 단계의 archived 표시를 빠뜨리지 말 것. → `docs/ops/db-capacity.md`
- `create table` 에는 `enable row level security` 를 붙일 것. 컬럼을 payload 에서 빼기 전에 `not null` 부터 풀 것. 상태 문자열은 DB CHECK 과 대조할 것. `pg_class` 를 읽는 감시 SQL 은 `relkind in ('r','m')`. → `docs/ops/db-capacity.md`
- 이 DB 에서 `explain analyze` 시간은 부풀려 나온다. 시간은 `pg_stat_statements` 평균과 최소, 최대로 본다. 측정 조회는 하나씩. → `HANDOFF.md`

코드
- 백엔드 코드는 `@sentry/node` 를 직접 부르지 말고 `../sentry` 를 부른다. Sentry 로 나가는 데이터는 `scrubEvent` 를 거친다. → `docs/ops/components.md`
- 공개 입력을 저장하거나 캐시 키로 쓸 때는 `isSafeRegionText`, `createKakaoGate`, `FREE_TEXT_PREFIXES` 를 거친다. → `docs/ops/security.md`
- `cronStats` NUM 의 마지막 항목은 `canceledRemoved` 로 둔다. → `docs/ops/operations-rules.md`
- 별칭 대응표는 반드시 `aliasCanon(map, 이름, 동, 준공연도)` 로 읽을 것. 손 보정은 `apt_alias_overrides` 와 좌표 `source='manual'` 로만. 이름 합치기 규칙에서 괄호 안 내용은 지우지 말 것. → `docs/ops/feature-history.md`
- 구 경계 자료의 CC BY 4.0 출처 표기를 지우지 말 것. → `docs/ops/feature-history.md`
- 사이드바 노드와 고지 띠 노드는 지우지 말 것(숨김만). 헤더 넘침은 `header.scrollWidth` 로 재지 말 것. 캐시 키 `meta:dataCounts:v2` 이름을 바꾸지 말 것. → `docs/ops/ui-design-v2.md`
- 인기 단지 실시간 응답을 쓰는 화면은 반드시 `_popRows(j)` 를 거칠 것. → `docs/ops/ui-design-v2.md`
- 테스트에서 줄바꿈을 `'\n'` 문자로 비교하지 말 것(`\r?\n`). Windows 에서 heredoc 으로 정규식이나 `\n` 이 든 문자열을 바꾸지 말 것(Edit 도구나 node 스크립트 파일). → `docs/ops/ui-design-v2.md`, `docs/ops/operations-rules.md`

문구와 화면
- 화면 문구는 **해요체 · 문장 속 화살표/줄표 나열 금지 · 내부 용어(KAPT·MOLIT·캐시·세션) 금지**. 면책 문장과 법적 고지는 글자 그대로 둔다. → `docs/ops/ui-design-v2.md`, `docs/ops/operations-rules.md`
- **법·기한 숫자는 law.go.kr·생활법령·금융위 원문을 크롬으로 직접 열어 확인한 것만**, 화면엔 근거·확인일 표시, 매수·매도 추천·예측 금지, 높았던 값은 낮았던 값과 함께. → `docs/ops/feature-history.md`
- 디자인 개편은 기획 문서 승인, 그다음 Claude Design 시안 승인이 먼저다. → `docs/ops/operations-rules.md`
- 배포 뒤 운영 실측으로 "화면이 말하는 기간 = 실제 집계"를 확인할 것. 가짜 응답 미리보기는 서버 데이터 경로를 검증하지 못한다. → `docs/ops/feature-history.md`

일정이 걸린 것
- 개인정보처리방침 시행본(`privacy-1117`)은 2026-11-17 KST 전에 배포하지 않는다. 그 브랜치와 작업 폴더를 지우지 말 것. → `HANDOFF.md`
- 결제를 다시 켜기 전에 `docs/ops/security.md` 의 run-6 결제 4건부터 정한다.

### 폐기 (운영자 방침·판정)
- AI RAG 컨텍스트 — AI 비용 최소화 방침과 충돌 (2026-07-15 폐기)
- 시행일자별 법령 효력 비교 — 가치 대비 복잡도 과다, 2회 '하지 말 것' 판정 (2026-07-15 폐기)

### 폐기 추가 (운영자 확정)
- 전월세 DB 캐시 테이블 — 운영자 기존 거부, 2026-07-15 재확인. **재제안 금지** (기존 전세가율 표시 기능은 유지)

---

## 📂 핵심 구조와 상세 문서

- 화면: `frontend/index.html` (단일 파일 SPA), `frontend/sw.js`, 구 경계 `frontend/geo/`
- 서버: `backend/server.js`, `backend/routes/`, `backend/services/`, `backend/jobs/`(예약 작업), `backend/middleware/`, 진입점 `api/index.js`
- 예약 작업과 경로 연결: `vercel.json` (예약 작업 14개)
- 검사: `backend/test/`, 묶음 실행은 `scripts/run-backend-tests-utc.js`
- DB 변경 기록: `supabase/migrations/`
- 인계 문서: `HANDOFF.md`. 새 세션은 이 파일부터 읽는다.
- 감사 기록: `AUDIT_REPORT.md`(2026-11-15 전면 감사와 CPU 재측정), `docs/audit/`(지난 감사 보관)
- 주제별 기록 `docs/ops/`: `db-capacity.md`(DB 용량, 원본 창 자르기) · `components.md`(구성요소 버전, 점검) · `redis.md`(Upstash 한도) · `security.md`(보안 결정) · `ui-design-v2.md`(문구 규칙, 디자인 v2 화면) · `feature-history.md`(기능별 변경) · `done-history.md`(완료 항목) · `operations-rules.md`(CPU 한도, 2026-11-11 과 11-12~13 규칙 원문)
  새 기록은 맞는 파일에 덧붙이고, 새 금지 규칙은 이 파일 "금지 사항"에도 한 줄 남긴다. 한 파일에 몰지 않는다.
- 계획 문서: `plans/README.md`(지금 열려 있는 것), `plans/STATUS-HISTORY.md`(지난 실행 순서와 상태 표), 개별 계획 `plans/<번호>-*.md`. 다음 새 계획 번호는 201부터.
- Sprint 기록: `.local-notes/SPRINT_NOTES_20260512.md` (gitignored, 메인 폴더에만 있음)
- NCP setup: `.local-notes/NAVER_MAPS_SETUP_GUIDE.md`

---

## 🚨 위험 신호 (운영자에게 즉시 알릴 것)

1. Sentry 신규 오류 spike (>10건/시간)
2. /api/health 응답 deploy id 미일치 (배포 실패)
3. naver.maps.Map 미정의 (NCP 키 만료/한도 초과)
4. molit-ingest cron 실패 3일 연속
5. 외부 API (KAPT/MOLIT/Kakao) 응답률 < 80%

---

마지막 갱신: 2026-11-15 (정기 점검: 날짜별 기록과 경고 원문을 docs/ops 로 옮기고 이 파일은 원칙, 명령, 구조, 금지 사항만 남김 · 하루 CPU 합계 장치 · 부하 정리 · 뒤로 가기와 구별 순위 시간 상한 · 지도 첫 화면 서울 구별 보기 · 직장 위치는 통근 계산에만 · plans/201 1번과 3번 · 테스트 1223). 이전 갱신 이력은 `docs/ops/done-history.md` 끝.
