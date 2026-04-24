# 내집로그 (MyHomeLog)

> AI 기반 아파트 매수 전략 컨설팅 서비스  
> 도메인: **myhomelog.vercel.app** (또는 커스텀 도메인)

---

## 서비스 소개

- 2025.10.15 규제 기준 실시간 LTV·DSR 대출 계산
- 국토부 실거래가 API 기반 AI 단지 추천
- 네이버 지도 + 카카오 지오코딩으로 정확한 위치 표시
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
| 네이버 지도 | [console.ncloud.com](https://console.ncloud.com) → Maps | 월 100만건 무료 |

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

### 5. 네이버 지도 연동 (선택)

`frontend/index.html` 다음 주석 해제 후 `YOUR_NAVER_CLIENT_ID` 교체:

```html
<script src="https://openapi.map.naver.com/openapi/v3/maps.js?ncpClientId=YOUR_NAVER_CLIENT_ID&submodules=geocoder"></script>
```

네이버 클라우드 플랫폼 → Application → Maps → 웹 서비스 URL 등록 필수

---

## Vercel 배포 (프론트엔드)

```bash
npm i -g vercel
cd myhomelog
vercel

# 커스텀 도메인 연결
vercel domains add myhomelog.com
```

배포 후 `frontend/index.html`의 `API` 상수를 백엔드 URL로 변경:
```js
const API = 'https://your-backend.railway.app/api';
```

## Railway 배포 (백엔드)

```bash
# Railway CLI
npm i -g @railway/cli
cd backend
railway login
railway init
railway up

# 환경변수 설정
railway variables set ANTHROPIC_API_KEY=sk-ant-...
railway variables set MOLIT_API_KEY=...
railway variables set KAKAO_REST_API_KEY=...
railway variables set ALLOWED_ORIGINS=https://myhomelog.vercel.app
```

---

## API 엔드포인트

| Method | Path | 설명 |
|--------|------|------|
| POST | /api/chat | AI 채팅 |
| POST | /api/properties/recommend | AI 단지 추천 |
| GET | /api/transactions | 실거래가 조회 |
| GET | /api/regulations | 현행 규제 정보 |
| POST | /api/clause | 맞춤 특약 생성 |
| POST | /api/clause/risk | 리스크 시나리오 |
| POST | /api/geocode | 카카오 지오코딩 |
| POST | /api/geocode/batch | 배치 지오코딩 |
| GET | /api/health | 서버 상태 |

---

## 레퍼런스 & 차별화

| 서비스 | 타겟 | 차별화 |
|--------|------|--------|
| 호갱노노 / 네이버부동산 | 정보 탐색 | 내집로그: **의사결정 지원** |
| 내집스캔 | 전세 임차인 | 내집로그: **매수자 투자 전략** |
| KB부동산 | 시세 조회 | 내집로그: **AI 맞춤 전략 + 특약** |
