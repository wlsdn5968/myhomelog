# 190 자원 관리: DB 헛쓰기 차단, 수집기 차단, 상한 (2026-11-11)

## 그날 잰 상태
| 항목 | 값 | 출처 |
|---|---|---|
| DB(클러스터 합계) | 441.4MB, 88% | `select sum(pg_database_size(datname)) from pg_database` |
| 원본 거래 표 | 본문 104.4MB, 인덱스 120.0MB | pg_relation_size, pg_indexes_size |
| 원본 표 누적 쓰기 | 갱신 9,502,867, 삽입 315,449 | pg_stat_user_tables |
| 하루 다시 쓴 행 | 11-05 47,035, 11-08 82,559, 11-10 84,298 | molit_ingest_runs |
| 운영 CPU 47분 표본 | 약 11.0초. 서버 시작 4.8초(6회), 수집 봇 약 3.9초, 가동 감시 0.7초, 사람 화면 2회 1.4초 | cpuMeter 로그 10:31~11:18 UTC |
| 운영 오류 24시간 | 0건 | Vercel 런타임 오류 |
| Vercel 실제 사용량 화면 | 미확인(크롬 확장 연결 안 됨, 요금 API 는 Hobby 라 404) | |

## 한 일
1. 원본 표에 같은 값 갱신을 건너뛰는 트리거 `zz_skip_same`(운영 적용). 되돌리는 시험 3종으로 확인한 뒤 적용. 기록: `supabase/migrations/20261111_molit_skip_same_update.sql`.
2. 원본 표 인덱스 8개 재구축(`reindex index concurrently`). 인덱스 120.0 → 89.4MB, 클러스터 441.4 → 410.9MB(82%).
3. robots.txt 에서 막은 수집기를 vercel.json 첫 route(`mitigate: deny`)로 함수 실행 전에 차단. Bytespider 를 목록에 추가. robots.txt 자체는 읽게 둔다.
   근거: exauser.crawler 는 Disallow 하루 뒤에도 47분에 10건을 가져갔다.
4. `HEAD /api/health` 는 본문 계산 없이 200. 가동 감시가 5분마다 부르며 회당 CPU 46~125ms 와 Redis 조회를 썼다.
5. 전월세 실시간 조회 기록을 같은 내용 10분에 한 번으로. 한 회차 5초에 14번 쓰면서 warm-rent 자신의 기록을 덮어 지웠다(11-02, 04, 05, 07, 08, 10 누락의 원인. warm-rent 자체는 돌았다).
6. 알림 공개 키 응답을 CDN 에 저장(첫 화면마다 함수 호출 1회 제거).
7. 보안 점검 run-1 의 5, 6, 8번(낮은 등급 에이전트 구현, 변경 내용 직접 검토):
   - 시설 조회의 Kakao 호출이 지오코딩과 같은 전역 일일 상한을 거친다. 닿으면 좌표 없음 경로.
   - 지오코딩 IP 하나의 하루 Kakao 시도 1,500(전역 20,000 의 7.5%). 전에는 IP 하나가 18,000 까지 쓸 수 있었다.
   - ai_feedback 10,000행, data_error_reports 5,000행 상한(2026-11-11 실제 4행, 0행). visit_attribution 은 이미 180일 정리.

## 하지 않은 것과 이유
- PerplexityBot, OAI-SearchBot 차단: 검색 답변에 출처로 노출되는 길이라 그대로 뒀다. 47분 표본에서 CPU 약 18%. 막을지는 운영자 결정.
- Sentry 를 첫 오류 때 읽기: 서버 시작 590ms 중 196ms(로컬 측정). 다만 처리되지 않은 거부를 Sentry 가 받아 주는 동작과 첫 오류의 요청 정보가 달라져 따로 설계가 필요하다.
- 단지 페이지 요청당 CPU(약 55ms): 로컬에 DB 접속 정보가 없어 분석하지 못했다. DB 왕복 8회를 하나로 묶는 것이 후보.
- 점검 7번(AI 전역 예산을 무료와 유료로 나누기): 요금 정책이라 운영자 결정.
- visit_attribution 의 daily_visit 행: 누적 방문 수를 세는 행이라 지우지 않았다(6,588행, 1.3MB).

## 확인할 것
- 11-11 17:00~17:45 UTC 적재 뒤: rows_inserted 가 rows_fetched 보다 훨씬 작은지, DB 가 다시 늘지 않는지.
- 11-16 20:00 UTC apt-master-sync: 11-09 회차는 250초 동안 0건(이전 3주는 약 55초에 정상). 외부 API 장애로 보이나 미확인.
- 차단 route 가 운영에서 403 을 주는지, 검색엔진 UA 는 200 인지.
