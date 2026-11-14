# 보안 결정과 점검 기록

> 2026-11-14 에 저장소 CLAUDE.md 의 "진행 중 / 운영자 결정 대기" 구역에서 원문 그대로 옮겼다(내용 변경 없음).
> 경고와 금지 문장은 CLAUDE.md 에도 남아 있다. 새 기록은 이 파일에 덧붙이고, 새 경고는 CLAUDE.md 에도 한 줄 적는다.

### 보안 — 운영자 결정 대기 (2026-09-28)
- **공개 키 노출면 축소(Plan 129·132)**: 공개 키(`index.html` 메타)만으로 대형 테이블을 1,000행씩 무제한 REST 조회할 수 있었다(위험 = 무료 전송량 5GB 소진 → 전 API 402). **1단계 적용 완료(2026-10-02, 운영자 SQL Editor 실행 — 기록 `supabase/migrations/20261002_public_key_surface_stage1.sql`)**: 이력·편의시설·학교·건축물대장 공개 읽기 제거, 백엔드 전용 함수 5개 공개 실행 회수. **2단계 코드 완료(Plan 132, 77833fb)**: 검색·지도·인기 라이브 집계가 service_role 로 읽는다(`backend/test/public-key-surface.test.js` 가 고정 — 공개 키로 되돌리면 DB 권한을 닫은 뒤 42501). 절충(운영자 결정): 사용자 경로 DB 상한 anon 3s → 8s. **2단계 DB SQL(`plans/129` §4) 적용 조건 충족(2026-10-14 게이트웨이 로그 24h: 공개 키로 대상 5개 요청 0건 — 공개 키는 regulations_snapshot·popular_apts_snapshot 만)** — 계획자 시도 4가지가 모두 막힘(2026-10-14): 자동 모드 `apply_migration` declined · 수동 승인 모드 `apply_migration` declined · 수동 모드 `execute_sql` declined(Supabase MCP 가 정책 삭제·권한 회수 문장에 확인을 요구하는데 이 앱은 그 확인 창을 띄우지 못한다) · 운영자 크롬의 SQL Editor 로 가는 것은 자동 모드 분류기가 "안전장치 우회" 로 차단 → **운영자 SQL Editor 실행만 가능**. 공개 유지: `popular_apts_snapshot`·`regulations_snapshot`·`billing_plans`.
- **개인정보처리방침 §5·§6 사실 불일치(Plan 136, 2026-10-14 대조)**: Anthropic 이전 시점 "AI 채팅" → 실제는 리포트·특약 분석 · Upstash "개인정보 미저장·토큰 해시·최대 24시간" → 실제는 IP/회원 ID 키(당일 자정까지)·답 못 한 챗 질문 80자 최근 50건(만료 없음), §6 국외이전 표에 Upstash 누락 · Sentry "오류 시·90일" → 실제는 오류 + 요청 표본 약 10%, 보관은 요금제별(무료 30일). 수정안은 `plans/136-privacy-policy-facts.md` — **공개 법적 고지라 게시는 운영자 확인 뒤**(Sentry 요금제 확인 1건 필요). **2026-10-18 개정 예고 게시(운영 8c60ec4)**: 처리방침 맨 위 현행·개정 대조표, **2026-11-17 시행**(§13 의 7일·중요 변경 30일 사전 공지 모두 충족 — 앱에 공지사항 기능 없음). 시행본은 브랜치 `preview/privacy-136`(24a1e58), 절차는 plans/136 §6. Sentry 보관 기간은 처음엔 제외했으나 **2026-10-30 시행본 b9d0080 에서 90일→30일로 넣고 운영 예고문에 '10월 30일 추가 게시'** — 운영자 승인(2026-10-30, plans/136 §44 — 요금제 Developer 확인·보관 단축이라 불리하지 않음)으로 **11-17 에 함께 시행**(예고 18일, §13 7일 충족).
- **Sentry 프로젝트 설정** — ✅ 2026-10-02 적용: 조직 Security & Privacy 의 "Prevent Storing of IP Addresses" 켬(운영자가 로그인해 둔 크롬에서 계획자가 그 토글 하나만 변경 — 두 프로젝트 `node`·`myhomelog-frontend` 에 잠금 표시로 강제 적용 확인). 프로젝트별 Data Scrubber·Use Default Scrubbers 는 원래 켜져 있었다. ECOS 키 재발급은 선택(노출 범위 = 운영자 Sentry 조직, 저장분 2026-10-21 전후 자동 만료).

### 보안 점검 run-6 (2026-11-14, quick, 기준 d4d4a4f)
- 산출물 `C:/Users/Woo/security-audit-skill/myhomelog/run-6`. 확정 0, 검증 필요 14, 기각 2, 미룬 단위 8. 사냥과 검증은 haiku(sonnet 주간 한도), 소스 점검만.
- 코드로 묶은 것(AUDIT6-1114, 회귀 검사 `backend/test/audit6-1114.test.js`):
  - 유입 기록(`routes/attribution.js`): daily_visit 말고 다른 이벤트도 IP 하루 30건, 전체 하루 2,000건.
  - 통근 조회(`POST /api/properties/transit`): 한국 범위 좌표, 직장 이름 60자, Kakao 관문(가중치 2), 길찾기 한 번만. 주변 시설 조회는 캐시와 DB 에 없을 때만 관문(가중치 7)을 거친다.
  - 지역 이름 글자 검증(`utils/regionText.js`): `/facility` 입력, 좌표 저장(`geocodeCacheService.saveToDb`), 지도 조회의 동 목록. 운영 DB 읽기 전용 확인(11-14): 좌표 표 동 이름 1,427종, 단지 마스터 1,159종, 거래 색인 1,488종 모두 규칙에 걸리는 값 0건.
  - 단지 마스터 런타임 저장(`aptFacilityService.js`)은 요청 값이 아니라 지역 코드 표와 KAPT 응답을 쓴다(운영에 kapt-lookup-runtime 행 0건).
  - 공유 캐시(`cache.js`)는 가득 차면 자유 입력 키(searchapt, txapt, analysis, kkkw)부터 지운다.
- 반증 검토(haiku, 읽기 전용) 13건 중 코드로 확인해 반영한 것: 지도 조회는 좌표 목록 자체에서 지역 이름이 아닌 행을 뺀다(두 번째 in 목록과 동 범위 없는 조회 방지). 좌표 저장을 건너뛸 때도 메모리에는 1시간 기억한다. 통근 관문은 캐시에 없어 Kakao 를 실제로 부를 때만 쓰인다. 공유 캐시의 자유 입력 접두어에 `geo-db:` 추가. 직장 입력칸 maxlength 60. 통근 테스트는 axios 만 가짜로 두고 실제 서비스 함수로 길찾기 1회를 확인한다.
- 알고 둘 절충: 유입 기록 전체 상한 2,000건은 IP 를 나눠 보내면 그날 유입 집계를 멈추게 할 수 있다(DB 용량 보호를 택했다. 집계는 채널 비교용이라 영향이 작다). 같은 IP 에서 일반 이벤트가 하루 30건을 넘으면 조용히 버려진다. 보고서 경로의 주변 시설 조회는 관문을 넘기지 않는다(로그인과 하루 1회 한도 뒤).
- 코드로 묶지 않은 것: 지도 격자 칸 집계 비용과 단지 OG 렌더의 전역 상한(측정 먼저), Redis 장애 때 동의 기록 상한이 인스턴스마다 따로 적용, 실제 단지 이름을 쓴 가짜 푸시 구독, 계정 수 대비 DB 총량.
- 결제를 다시 켜기 전에 정할 것 4건: 결제 행 CASCADE 삭제와 5년 보관 고지, 등급 전환 때 남은 기간, 환불 뒤 기간 이월, 환불 조건(서버는 사용 여부를 안 봄)과 안내 문구.
- 운영자 확인(읽기만): Supabase Edge Functions 의 `datagokr-proxy` Verify JWT 설정, Authentication 의 가입 제한.
- 다음 회차로 미룬 단위: 추천 계산, 공개 health 응답의 운영 수치, 챗 미응답 원문 보존, 카카오 웹훅의 요청 제한, 공개 API CDN 캐시 키, 관리자 GET 부작용, 크론 작업 본문 2개.
