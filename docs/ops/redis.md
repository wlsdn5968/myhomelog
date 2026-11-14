# Upstash Redis 무료 한도

> 2026-11-14 에 저장소 CLAUDE.md 의 "진행 중 / 운영자 결정 대기" 구역에서 원문 그대로 옮겼다(내용 변경 없음).
> 경고와 금지 문장은 CLAUDE.md 에도 남아 있다. 새 기록은 이 파일에 덧붙이고, 새 경고는 CLAUDE.md 에도 한 줄 적는다.

### 🚨 Upstash Redis 무료 한도 초과 (2026-10-14 발견)
- 운영 Redis 가 **월 500,000 명령**을 넘어 모든 명령이 `ERR max requests limit exceeded` 로 실패 중(Vercel 런타임 로그). **쓰기 실패 시작 = 2026-10-05 16:49Z 경**(health 의 cron 기록이 그 시각에서 멈춤, 읽기는 간헐 성공 — 10-14 계획자 실측 10회 중 6회). 소진 원인·초기화 시점은 **Upstash 콘솔에서만** 보인다(운영자). 유료 전환 금지 방침. 운영자 크롬은 Upstash 콘솔에 로그인돼 있지 않았다(2026-10-14 확인 — 계획자는 로그인하지 않는다).
- 영향(코드 원문 확인, 2026-10-14 당시 기록. 2026-11-13 유료 AI 제거 뒤로는 `/api/report` 는 데이터 전용판, `/api/clause` 는 410): **유료 AI(`/api/report`·`/api/clause`)는 fail-closed 503 으로 막힘**(비용 안전) · 무료 룰베이스 챗도 같은 리미터라 503 → **Plan 133** · 일반·데이터·og·share 요청 제한은 fail-open(제한 없음) · `/api/geocode` 전역 Kakao 일일 상한(8,000)도 fail-open(인스턴스별 일일 60 만 남음) · Redis 2차 캐시 전부 미스(같은 시기 지역 가격 기록 함수 `get_price_records_by_region` 의 시간 초과가 10-04 0건 → 10-11~12 13건으로 늘었다 — 인과는 미확정) · `/api/health` 의 `crons`·`searchDegrade`·`chatIntents` null · `usage.used` 0 표시.
- 코드상 health 1회 = Redis 명령 8개(웜, 비로그인) — 5분 간격 모니터만으로 월 약 6.9만(한도의 14%). 나머지 소진원은 코드만으로 특정 못 함.
- **2026-10-30 실측: 쓰기 복구** — health `crons` 가 다시 채워지고 당일 시각으로 갱신(ecos·hf 08:20Z, molit-ingest 10-29 17:45Z ok 126). 초기화 시점은 여전히 콘솔에서만 보인다. 같은 날 상태 확인·데이터 경로의 중복 Redis 요청 제한을 뺐다(017728f). 11-01 재확인은 계속.
