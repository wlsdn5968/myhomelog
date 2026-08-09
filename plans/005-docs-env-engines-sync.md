# Plan 005: README·.env.example·engines 를 실동작과 일치시킨다 (문서·설정 정합 일괄)

> **Executor instructions**: 단계 순서대로, 각 검증 통과 후 진행. STOP 발생 시 보고.
> 완료 시 `plans/README.md` 상태 갱신. 이 계획은 문서·매니페스트만 수정한다 — **소스 코드(.js)
> 로직 변경은 한 줄도 없다.**
>
> **Drift check (가장 먼저)**: `git diff --stat b63da64..HEAD -- README.md backend/.env.example package.json backend/package.json`
> 변경 시 해당 부분을 현재 상태 기준으로 재확인 후 진행(문서 계획이므로 드리프트는 STOP 이 아니라
> "최신 상태 기준으로 정정" — 단 코드 쪽 사실관계가 발췌와 다르면 STOP).

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (문서·매니페스트만)
- **Depends on**: none
- **Category**: docs / dx
- **Planned at**: commit `b63da64`, 2026-08-09

## Why this matters

README 가 실동작과 **반대**를 서술한다: "네이버 지도 현재 미사용 — Leaflet 기본"(README.md:43,
64-68)이라 적혀 있으나 실제 프로덕션은 네이버 지도가 기본 엔진이고 Leaflet 은 인증 실패 시
폴백이다(frontend/index.html 의 NAVER-MAPS-2026-05-13 주석·CLAUDE.md 의 NCP Client ID 등록).
cron 목록은 8개로 적혀 있으나 vercel.json 에는 10개가 등록돼 있다(building-register-backfill·
push-notify 누락 — push-notify 는 사용자에게 실제 알림을 보내는 cron 이라 장애 조사 시 치명적 누락).
.env.example 은 코드가 참조하는 env 다수(VAPID·KAKAO_CLIENT_SECRET·DATAGOKR_RELAY_OFF·
REB_RONE_API_KEY 등)를 빠뜨려 온보딩·복구 문서로서 기능하지 못한다. engines 부재는 로컬(Node 24)
/CI(Node 20) 불일치 재발 방지 장치가 없다는 뜻이다(2026-07-25 "로컬 초록/CI 빨강" 실사고 이력).

## Current state

- `README.md:43` — API 표: "네이버 지도 | ... (선택, 현재 미사용 — Leaflet/OSM 기본)"
- `README.md:64-68` — "### 5. 네이버 지도 연동 (선택, 현재 미사용) / 현재 기본 구현은 Leaflet +
  OpenStreetMap ..." ← **실동작과 반대**
- `README.md:93` — "cron 8개(라우트 기준)는 `vercel.json` 의 `crons` 배열로 자동 등록됩니다 —
  retention · molit-ingest(3슬롯 분할) · apt-master-sync(월요일) · regulations-check ·
  regulations-auto-fetch · audit-prune · geocache-backfill · facility-backfill."
- `README.md:174` — cron 라우트 표에도 같은 8개만.
- 실제 `vercel.json` crons(10개): retention(18:00) · molit-ingest×3슬롯(17:00/17:15/17:30) ·
  apt-master-sync(월 20:00) · regulations-check(21:00) · regulations-auto-fetch(21:30) ·
  audit-prune(03:00) · geocache-backfill(04:00) · facility-backfill(05:00) ·
  **building-register-backfill(06:00)** · **push-notify(22:30)** (전부 UTC).
- `backend/.env.example` — 코드가 참조하나 누락된 env 존재. 대표 확인분: `VAPID_PUBLIC_KEY`/
  `VAPID_PRIVATE_KEY`/`VAPID_SUBJECT`(jobs/pushNotify.js), `KAKAO_CLIENT_SECRET`
  (services/kakaoMemoService.js), `DATAGOKR_RELAY_OFF`(services/dataGoKrClient.js — 릴레이 긴급
  차단 스위치), `REB_RONE_API_KEY`(services/roneService.js). **전수 목록은 Step 3 에서 실행자가
  grep 으로 직접 도출**한다(이 계획의 목록을 믿지 말 것).
- `package.json`·`backend/package.json` — 둘 다 `engines` 필드 없음. CI 는 Node 20
  (.github/workflows/ci.yml), Vercel 런타임은 Node 24 (2026-08 Sentry 이벤트 실측 `node v24.18.0`).
- 컨벤션: 문서도 한글. ⚠ **시크릿 값은 절대 기재 금지** — .env.example 에는 자리표시자
  (`your_xxx` 형식, 기존 파일 스타일)만.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| JSON 검증 | `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'));JSON.parse(require('fs').readFileSync('backend/package.json','utf8'));console.log('OK')"` | OK |
| 테스트 | `cd backend && npm test` | 전부 pass(무영향 확인) |

## Scope

**In scope**:
- `README.md` — 지도 서술 2곳 + cron 목록 2곳
- `backend/.env.example` — 누락 env 추가(자리표시자만)
- `package.json`, `backend/package.json` — `engines` 추가

**Out of scope**:
- 모든 `.js`/`.ts` 소스 — 로직 수정 금지.
- `.github/workflows/ci.yml`·`vercel.json` — 버전 정책 변경은 이 계획 밖(운영자 결정).
- CLAUDE.md.

## Git workflow

- 커밋: `docs(sync): README 지도·cron 실동작 정합 + .env.example 전수 + engines 명시 (Plan 005)`
- push 금지.

## Steps

### Step 1: README 지도 서술 정정

README.md:43 을 "월 100만건 무료 (기본 — `NAVER_MAPS_CLIENT_ID` 설정 시. 미설정·인증 실패 시
Leaflet/OSM 자동 폴백)" 취지로, 64-68 절 제목·본문을 "### 5. 네이버 지도 (기본 지도 엔진)" 으로
바꾸고 "키 미설정 시 Leaflet 폴백으로도 동작(로컬 개발 가능)" 을 명시.

**Verify**: `grep -n "미사용" README.md` → 지도 관련 매치 0

### Step 2: README cron 목록 10개로 정정

93행·174행 두 곳에 building-register-backfill·push-notify 를 추가하고 "8개"→"10개" 로 정정
(위 "Current state" 의 스케줄 참조).

**Verify**: `grep -n "push-notify" README.md` → ≥2 매치, `grep -n "cron 8개" README.md` → 0

### Step 3: .env.example 누락 전수 도출·추가

실행자가 직접 도출하라(레포 루트에서):
```bash
grep -rhoE "process\.env\.[A-Z_0-9]+" backend/ api/ | sort -u > /tmp/env-used.txt
grep -oE "^[A-Z_0-9]+" backend/.env.example | sort -u > /tmp/env-doc.txt
```
두 목록을 대조해 코드에는 있으나 .env.example 에 없는 것을 전부 추가하라. 각 항목은 기존 파일
스타일대로 한글 주석 1줄 + `NAME=your_xxx` 자리표시자. Vercel 이 자동 주입하는 변수
(`VERCEL_GIT_COMMIT_SHA`, `NODE_ENV`, `VERCEL_*`)는 "Vercel 자동 주입 — 로컬 설정 불요" 주석
그룹으로 분리 표기. **실제 값·실키는 절대 쓰지 마라.**

**Verify**: 위 두 명령 재실행 후 대조 → 누락 0 (Vercel 자동 주입 그룹 제외)

### Step 4: engines 명시

두 package.json 에 추가:
```json
"engines": { "node": ">=20" }
```
(CI 가 20, Vercel 이 24 이므로 최소선만 고정 — 특정 메이저 고정은 운영자 결정 사항이라 하지 않는다.)

**Verify**: JSON 검증 명령 → OK, `cd backend && npm test` → 전부 pass

## Test plan

- 코드 무변경이므로 기존 스위트 통과 + 각 단계 grep 게이트가 전부.

## Done criteria

- [ ] Step 1·2·3·4 의 Verify 전부 통과
- [ ] `git status --short` 에 in-scope 4개 파일만
- [ ] `plans/README.md` 상태 갱신

## STOP conditions

- frontend/index.html 에서 네이버 지도가 기본이 **아니라는** 반대 증거를 발견하면 STOP
  (사실관계가 계획과 다르면 문서를 어느 쪽으로도 고치지 말고 보고).
- .env.example 에 실키로 보이는 값이 이미 들어 있으면 STOP + 해당 사실만 보고(값 인용 금지).

## Maintenance notes

- env 추가 때 .env.example 누락이 재발하는 구조 — Step 3 의 grep 대조를 CI 경고 스텝으로 올리는
  후속은 별도 계획으로(이번 범위 아님).
- 리뷰 포인트: .env.example 에 값처럼 보이는 문자열이 없는지(자리표시자만인지).
