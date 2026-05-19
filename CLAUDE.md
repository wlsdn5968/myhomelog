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
- backend syntax: `node -c <file>`
- frontend syntax: inline `<script>` 블록 `new Function()` validate
- vercel.json: `JSON.parse()`
- deploy verify: `/api/health` deploy id 매치
- Sentry: `is:unresolved firstSeen:-30m`
- Chrome MCP (UI): 핵심 flow screenshot

---

## 📚 데이터 출처 (환각 차단)

| 카테고리 | 공식 출처 | 우리 통합 |
|---|---|---|
| 실거래가 | MOLIT (data.go.kr) | molit_transactions table |
| 단지정보 | KAPT (한국부동산원) | apt_master + facility |
| 좌표 | Kakao Map API | apt_geocache (Sprint LL 점수 매칭) |
| 학교 | Kakao + NEIS 학교알리미 | nearbySchools |
| 학원 | Kakao Map API | nearbyAcademies (Sprint OO) |
| 학군 권역 | 강연 자료 + KB 보고서 | schoolClusters static (Sprint OO) |
| 정책/규제 | korea.kr 정책브리핑 + 금융위 RSS | regulations_snapshot (Sprint QQ) |
| **법령 원문** | **law.go.kr → 9bow/legalize-kr (MIT)** | **/api/legal/** (Sprint RR) |

---

## 🔑 외부 자격증명

- **NCP Maps Client ID**: `pkiho4sd0p` (Vercel env `NAVER_MAPS_CLIENT_ID`)
- **Supabase project**: `brxorvxdfrbxcavufspe` (myhomelog)
- **GitHub repo**: `wlsdn5968/myhomelog`
- **Vercel deploy**: production master branch auto-deploy

---

## 📊 진행 중 / 운영자 결정 대기 (2026-05-19 기준)

### DB 직접 update 필요 (auto-mode 차단 → 운영자 SQL 실행)
- regulations_snapshot 에 4.17/5.9/5.12 정책 + 1.5% 목표 추가 (SPRINT_NOTES Section 26 SQL)

### 미진행 (long-term)
- apt_master.molit_aliases 자동 backfill
- AI RAG 컨텍스트 (legalize-kr 법령 검색)
- 단지 모달 inline 법령 노출 (재건축 단지 → 도시정비법)
- 시행일자별 법령 효력 비교

---

## 📂 핵심 파일 위치

- 본 가이드: `CLAUDE.md` (repo 루트)
- Sprint 기록: `.local-notes/SPRINT_NOTES_20260512.md` (gitignored, sandbox local)
- NCP setup: `.local-notes/NAVER_MAPS_SETUP_GUIDE.md`
- vercel cron: `vercel.json`
- backend services: `backend/services/` (geocodeCacheService / schoolService / academyService / schoolClusterService / legalCorpusService 등)
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

마지막 갱신: 2026-05-19 (Sprint RR 후 운영자 프로세스 룰 명시)
