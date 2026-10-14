# 구성요소·버전·최적화·데이터 관리 점검 — 2026-10-14

**방법**: 네 갈래 읽기 전용 점검(버전·최신화 / DB 객체·잔존 데이터 / 코드·성능 / 데이터 파이프라인 품질, 각 하위 에이전트) + 계획자 재확인(아래 "계획자 확인" 표시). DB 는 SELECT 만, 운영은 공개 GET 만.

## 1. 결론
- **버려진 대용량 데이터는 없다.** DB(현재 DB 423MB, 전 DB 합계 437MB)의 79% 가 원본 거래(231MB)·이력(89MB)이고 둘 다 현역이다. 즉시 지워도 안전한 것은 미사용 인덱스 약 0.5MB 뿐. 용량을 크게 줄이는 길은 구조(월 1회 창 자르기 107c, 3개월분 이동 뒤 REINDEX) 뿐이다.
- **버전은 대체로 최신.** 사용 안 하는 의존성 0 · 운영 감사 0건 · CI 액션 3종 최신 · Node 24.x(Vercel 기본). 뒤처진 것: express 5.3.0·dotenv 18.0.7·satori 0.44.3(패치) → Plan 141, supabase-js CDN 2.117.2(패키지는 2.117.3) → 141, Sentry 11(major, 착수 기준 미충족 — 11-07 재확인).
- **가장 큰 운영 문제는 Redis.** 계획자 확인: health 10회 중 6회가 cron 기록을 읽어 오는데 마지막 기록이 **2026-10-05 16:49Z** — 쓰기는 10-05 부터 실패, 읽기는 간헐 성공. 그 사이 Redis 공유 캐시가 사라져 콜드 인스턴스마다 무거운 계산(신고가 기록 RPC 평균 4.7s)을 다시 한다.

## 2. 항목별
| 영역 | 상태 | 근거 |
|---|---|---|
| 의존성 | 미사용 0, audit(운영) 0, backend dev 의 drizzle-kit 하위 esbuild moderate 4(개발 서버 전용) | npm outdated/audit |
| 런타임 | engines 24.x, CI node 24, actions checkout@v7·setup-node@v7·gitleaks SHA(v3.0.0) 최신 | GitHub releases |
| CDN | Sentry 10.76.2·Leaflet 1.9.4·Pretendard SRI 있음 / supabase-js 2.117.2(1판 차이) / Google Fonts·네이버 지도·Toss 는 SRI 불가 구조 | index.html |
| Dependabot | 그룹 PR 이 Sentry 를 올리면 CDN 버전 가드에 막힌다(#78 재현) — 사람이 CDN 을 같이 올려야 한다 | components-guard.test.js |
| DB 잔존 | _old/_bak 테이블 0, 코드 미참조 테이블 0, storage 0, 로그 테이블 미미(cron 0.07MB) | pg_stat·grep |
| DB 인덱스 | idx_scan=0 일반 인덱스 10개 합 약 0.6MB(미미) · `idx_molit_apt_seq`(5.7MB)는 큰 인덱스와 앞부분 겹치나 178만 회 사용 → 유지 | pg_stat_user_indexes |
| 원본 갱신량 | 누적 수정 797만 건(하루 약 4.9만 행 재기록) — **계획자 확인: 93% 가 HOT(인덱스 미변경), dead 0** → 영향 작음, 보류 | pg_stat_user_tables |
| 데이터 정합 | 원본 dedup 중복 0 · 기준선≡이력 집계 불일치 0 · MV 최신일 = 원본 최신일 · 이상치(0원·미래일·면적0) 0 · 최근 7일 적재 오류 0 | SELECT |
| 이력 완전중복 | 5,343그룹(0.6%) — 이력은 거래를 가르는 필드를 저장하지 않아 같은 값의 별개 거래가 겹쳐 보이는 구조(2026-10-02 화성 조사와 같은 성질) | 107c 기록 |
| 건축물대장 | 하위 에이전트의 "단지와 0건 연결"은 키 형식 오해 — **계획자 확인: 최근 거래 단지 13,285곳 중 8,663곳(65%) 보유** | SELECT |
| 좌표 | 원본 단지 이름 키 기준 80.7% 보유, 이름 바뀐 옛 키 2,998개 | SELECT |
| 보존 정책 | 적재 기록·감사·방문·검색·챗 정리 cron 있음. 캐시 테이블(편의·학교·좌표·건축물대장)은 삭제형 TTL 없이 갱신형 — 지우면 외부 API 재호출이라 유지가 맞다 | retention.js |
| 마이그레이션 기록 | 저장소 55개 vs DB 51건(번호 체계 차이, 다수는 execute_sql 적용분) — 기록 불일치, 용량 무관 | list_migrations |
| 보안 권고 | MV 공개(129 2단계로 해소 예정) · 유출 비밀번호 보호 꺼짐(Supabase 대시보드 설정 — 운영자) | get_advisors |
| 코드 | 진입점에서 도달 못 하는 운영 파일 0 · 일회성 스크립트 1(`scripts/generate-sgg-upsert.js`) → 140 | require 그래프 |
| cron | 24개 중 이력 backfill 10슬롯은 완료 후 빈 실행 → 140 에서 2슬롯 | health 기록 |
| 프런트 | 1MB HTML 이지만 br 압축 321KB·재방문은 ETag 304. 주석 약 200KB 포함 | curl |
| 느린 API | 콜드 인스턴스에서만 느림(analysis 2.5~5.4s, records 첫 7.3s), 이후 0.1~0.3s · analysis 는 엣지 캐시 없음 · /region 은 독립 조회 4단 직렬 → 140 | curl 3회 |

## 3. 진행
| 계획 | 내용 | 상태 |
|---|---|---|
| 139 | Redis 명령 절감 — health·cron 공용 제한 분리, health 관측값 5분 메모리 캐시, 챗 관측 expire 1회 | 후보 작성 중 |
| 140 | 이력 backfill 슬롯 10→2 · 지역 페이지 병렬화 · 일회성 스크립트 삭제 | 후보 작성 중 |
| 141 | express 5.3.0 · dotenv 18.0.7 · satori 0.44.3 · supabase-js CDN 2.117.3 | 후보 작성 중 |
| 보류 | Redis 회로차단기(비용 보호 경로와 얽혀 설계 필요) · analysis 콜드 경로 단축(중~대) · 경신 스냅샷 DB 저장(DDL) · 프런트 JS 분리(대) · 원본 무변경 갱신 생략(효과 작음) | 다음 |

## 4. 확인 못 한 것
- Upstash 콘솔 사용량(명령 종류별·일별) — 무엇이 한도를 썼는지는 콘솔에서만 보인다.
- 인덱스·테이블 bloat 실측(pgstattuple 미설치).
- 2020-09~2025-04 지역별 적재 연속성(적재 기록이 2025-05 이후만 보존됨).
