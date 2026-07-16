# 내집로그 (MyHomeLog)

> AI 기반 아파트 매수 전략 컨설팅 서비스  
> 도메인: **myhomelog.vercel.app** (또는 커스텀 도메인)

---

## 서비스 소개

- 2025.10.15 규제 기준 실시간 LTV·DSR 대출 계산
- 국토부 실거래가 API 기반 AI 단지 추천
- Leaflet + OpenStreetMap 지도 (위성: Esri World Imagery) + 카카오 지오코딩으로 위치 표시
- 내집스캔 스타일 리포트 (종합의견 / 실거래가 / 리스크 / 맞춤특약)

---

## 빠른 시작

### 1. 환경변수 설정

```bash
cd backend
cp .env.example .env
```

`.env` 파일 편집:
```
ANTHROPIC_API_KEY=sk-ant-...      # Anthropic 콘솔에서 발급
MOLIT_API_KEY=...                  # data.go.kr 국토부 실거래가 API (무료)
KAKAO_REST_API_KEY=...             # developers.kakao.com REST API 키
PORT=3001
NODE_ENV=development
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173
```

### 2. API 키 발급

| API | 발급처 | 무료 여부 |
|-----|--------|---------|
| 국토부 실거래가 | [data.go.kr](https://www.data.go.kr) 검색: "아파트매매 실거래가 상세자료" | ✅ 무료 |
| 카카오 지오코딩 | [developers.kakao.com](https://developers.kakao.com) → REST API 키 | ✅ 무료 (월 30만건) |
| Anthropic Claude | [console.anthropic.com](https://console.anthropic.com) | 유료 (사용량 기반) |
| 네이버 지도 | [console.ncloud.com](https://console.ncloud.com) → Maps | 월 100만건 무료 (선택, 현재 미사용 — Leaflet/OSM 기본) |

### 3. 백엔드 실행

```bash
cd backend
npm install
node server.js
# → http://localhost:3001
```

### 4. 프론트엔드 실행

```bash
cd frontend
python3 -m http.server 3000
# → http://localhost:3000
```

또는 VS Code Live Server / npx serve 사용

### 5. 네이버 지도 연동 (선택, 현재 미사용)

현재 기본 구현은 Leaflet + OpenStreetMap (위성지도는 Esri World Imagery tile). 네이버 지도는 향후 옵션으로 검토 중이며 필수 아님.

기본 동작은 카카오 좌표 검색/캐시(`backend/services/geocodeCacheService.js`) + Leaflet 마커로 처리됨.

---

## Vercel 배포 (frontend + backend 단일 함수)

운영 구조: Vercel single project. `api/index.js` 가 `backend/server.js` (Express 앱) 을 그대로 export → `/api/*`, `/share/*` 처리. 정적 자산 (`frontend/*.html` 등) 은 `vercel.json` route 룰로 직접 서빙. 즉, 프론트엔드와 백엔드가 **같은 Vercel 함수** 에서 동작 — 별도 백엔드 호스트 불필요.

```bash
npm i -g vercel
cd myhomelog
vercel              # 첫 배포 (preview)
vercel --prod       # 프로덕션 배포

# 커스텀 도메인 연결 (선택)
vercel domains add myhomelog.com
```

Vercel Dashboard → Settings → Environment Variables 등록 키:
- 필수 — `ANTHROPIC_API_KEY`, `MOLIT_API_KEY`, `KAKAO_REST_API_KEY`
- Supabase — `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- 선택 — `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (분산 rate-limit. 미설정 시 in-memory fallback)
- 운영 — `CRON_SECRET` (cron 인증), `ADMIN_EMAILS` (admin endpoint 화이트리스트), `HEALTH_API_KEY`, `ALLOWED_ORIGINS`
- 로컬 개발에서 `frontend/index.html` 의 `API` 상수는 `/api` 상대 경로 사용 — 별도 백엔드 URL 교체 불필요.

cron 8개(라우트 기준)는 `vercel.json` 의 `crons` 배열로 자동 등록됩니다 — retention · molit-ingest(3슬롯 분할) · apt-master-sync(월요일) · regulations-check · regulations-auto-fetch · audit-prune · geocache-backfill · facility-backfill. (Hobby plan: daily 만 — hourly 미지원)

## Railway 배포 (현재 미사용 — 옵션 메모)

> ⚠ **현재 운영 구조는 위 Vercel 단일 함수.** 코드·설정에 Railway 흔적은 없으며 (`railway.json` 검사 시 fallback noop), 백엔드만 별도로 띄울 필요가 없습니다. 본 섹션은 향후 Vercel 함수 limit·cold start 등 사유로 백엔드를 분리하는 경우의 메모이며, 그대로 따라 하면 단일 배포가 깨집니다 — 이 sprint 시점엔 사용하지 마세요.

```bash
# (옵션) 백엔드 분리 시 — 현재 미사용
npm i -g @railway/cli
cd backend
railway login && railway init && railway up
railway variables set ANTHROPIC_API_KEY=sk-ant-... MOLIT_API_KEY=... KAKAO_REST_API_KEY=...
railway variables set ALLOWED_ORIGINS=https://myhomelog.vercel.app
```

---

## API 엔드포인트

> 모든 mount 의 출처는 `backend/server.js` (line 177~216).
> `JWT` = `requireAuth` (Supabase access_token 필수) · `optional` = 비로그인 허용 (로그인 시 daily limit bonus)

### 헬스
| Method | Path | Auth | 설명 |
|--------|------|------|------|
| GET | /api/health | optional | 서버 상태 |
| GET | /api/health/apis | x-health-key 헤더 | 외부 API 활성화 진단 (운영자 전용) |

### AI 비용 경로 (chat scope rate-limit + daily limit)
| Method | Path | Auth | 설명 |
|--------|------|------|------|
| POST | /api/chat | optional | AI 채팅 (PII 차단 + filterAdviceOutput) |
| POST | /api/clause | optional | 맞춤 특약 + 리스크 통합 (Phase B-3) |
| POST | /api/clause/risk | optional | 리스크 시나리오 (legacy) |
| POST | /api/report/generate | optional (비로그인 0/일 차단) | 1Page 컨설팅 보고서. server.js mount = `optionalAuth + chatLimiter + dailyLimit{limit:0,scope:'report',loggedInBonus:1}` — 비로그인은 0/일 → 사실상 로그인 필수, 로그인 시 dailyLimit 모듈이 plan별 한도 적용 |
| POST | /api/feedback/ai | optional | 답변 👍/👎 |

### 부동산 데이터
| Method | Path | Auth | 설명 |
|--------|------|------|------|
| GET | /api/properties/info | optional | 단지 메타 |
| POST | /api/properties/recommend | optional | AI 단지 추천 |
| GET | /api/properties/nearby | optional | 주변 단지 |
| POST | /api/properties/transit | optional | 교통 분석 |
| GET | /api/transactions(?...) | — | 실거래가 조회 |
| GET | /api/transactions/analyze | — | 실거래 통계 |
| GET | /api/transactions/codes | — | 시군구 코드 |
| GET | /api/regulations | — | 현행 규제 (LTV·DSR snapshot) |
| GET | /api/regulations/ltv | — | LTV 표 |
| POST | /api/geocode, /api/geocode/batch | — | 카카오 지오코딩 |
| GET | /api/analysis | — | 분석 결과 |
| POST | /api/analysis/total-cost | — | 취득세·금리 등 총비용 |
| GET | /api/news, /api/news/summary | optional | 부동산 뉴스 |
| GET | /api/search/{apt,popular,in-bounds,facility} | — | 단지 검색 |
| POST·GET·DELETE | /api/search/history | JWT | 본인 검색 이력 |

### 결제·구독·즐겨찾기
| Method | Path | Auth | 설명 |
|--------|------|------|------|
| GET | /api/billing/config, /api/billing/plans | — | Toss SDK 설정 / 플랜 |
| GET·POST | /api/billing/{me,checkout,confirm,cancel} | JWT | 결제 흐름 |
| POST | /api/billing/webhook | Toss 서명 | 결제 webhook |
| GET | /api/subscription | — | 구독 정보 |
| GET·POST·PATCH·DELETE | /api/bookmarks(/...) | JWT | 즐겨찾기 |
| GET·PUT·DELETE | /api/field-notes(/...) | JWT | 임장노트 |
| GET·POST·PATCH·DELETE | /api/chat/sessions(/...) | JWT | 채팅 세션·메시지 |

### 계정·자동화 결정 (PIPA / GDPR)
| Method | Path | Auth | 설명 |
|--------|------|------|------|
| POST | /api/account/consent | optional (비로그인 허용) | 4 flag (만 14세·약관·개인정보·국외이전) 동의 시각/버전 audit_log 기록 — OAuth 시작 *전* 호출. 4 flag 모두 `true` 검증 실패 시 400 |
| GET | /api/account/export | JWT | PIPA 35조 데이터 다운로드 |
| GET | /api/account/deletion-status | JWT | 삭제 예약 상태 |
| POST | /api/account/delete | JWT | 30일 유예 소프트 삭제 |
| POST | /api/account/restore | JWT | 유예기간 내 철회 |
| GET | /api/account/automated-decision/explain | JWT | GDPR Art.22 / PIPA 37조의2 설명 |

### 운영자 전용
| Method | Path | Auth | 설명 |
|--------|------|------|------|
| GET·POST | /api/admin/run-geocache-backfill | JWT + ADMIN_EMAILS | 백필 즉시 trigger |
| GET·POST | /api/cron/{retention, molit-ingest, apt-master-sync, regulations-check, regulations-auto-fetch, audit-prune, geocache-backfill, facility-backfill} | CRON_SECRET | `vercel.json` `crons` 자동 등록 8개 라우트 (molit-ingest 는 3슬롯 분할, Hobby plan: daily 만) |
| GET | /share?... | — | 공유 딥링크 (OG 메타 치환 HTML) |

---

## 레퍼런스 & 차별화

| 서비스 | 타겟 | 차별화 |
|--------|------|--------|
| 호갱노노 / 네이버부동산 | 정보 탐색 | 내집로그: **의사결정 지원** |
| 내집스캔 | 전세 임차인 | 내집로그: **매수자 투자 전략** |
| KB부동산 | 시세 조회 | 내집로그: **AI 맞춤 전략 + 특약** |
