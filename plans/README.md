# Implementation Plans

improve 스킬이 2026-08-09 생성 (기준 커밋 `b63da64`). 아래 순서로 실행하되 의존성 표기를 우선하라.
각 실행자는 계획 파일을 끝까지 읽고 STOP 조건을 준수하며, 완료 시 자기 행의 Status 를 갱신하라.
⚠ 이 레포의 운영 절대 룰: 공유 production DB 직접 수정 금지(코드 경유만)·push 는 운영자 승인 후.

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 001 | 실거래 DB 조회 1000행 페이징 (고거래 월 최대 47% 누락 실측) | P1 | S | — | DONE (4983974, 2026-08-09) |
| 002 | 공개 geocode 라우트 일일 총량 캡 (Kakao 쿼터 고갈 증폭 차단) | P1 | M | — | DONE (0e0f982, 2026-08-09) |
| 003 | AI 비용 카운터·좌표 저장 await (서버리스 동결 유실 차단) | P1 | S | — | DONE (5e6190a, 2026-08-09) |
| 004 | 결제 이월·규제 판정 계약 테스트 (실사고 이력 경로 고정) | P1 | S~M | — | DONE (d50ed75, 2026-08-09) |
| 005 | README·.env.example·engines 실동작 정합 | P2 | S | — | DONE (b91fda1, 2026-08-09) |

Status values: TODO | IN PROGRESS | DONE | BLOCKED (한 줄 사유) | REJECTED (한 줄 근거)

## Dependency notes

- 상호 의존 없음 — 병렬 실행 가능. 단 004 의 billing 리팩터와 다른 billing 작업이 동시에 돌면 안 됨.
- 검증 공통 게이트: `cd backend && npm test` (기준 시점 12개 전부 pass 가 baseline).

## Findings considered and rejected (재감사 방지)

- **report.js 1,358줄 서비스 분리**: 실이득 대비 이관 리스크(클로저 컨텍스트) 큼 — 순수 함수
  테스트(백로그)부터 선행하는 게 순서. 보류.
- **cache 전역 single-flight**: 40+ 호출부 공유 유틸이라 범위 과대 — 핫스팟 국소 적용만 검토(백로그).
- **청약 피드 ↔ 북마크 지역 연동**: odcloud 지역 필드가 시군구 미제공이라 주소 문자열 매칭 필요 —
  이 레포가 반복 겪은 동명 오배치 함정과 동일 계열, L급. 비권장.
- **Sentry v8→v10**: 유효(moderate 취약 체인 19건 동반 해소)하나 모니터링 공백 리스크 있어
  전용 스프린트로 — 이번 5개에 미포함(백로그 유지).
- **Supabase 클라이언트 SSOT·MOLIT 파싱 통합·Kakao 호출부 통합·페이징 유틸**: 유효한 부채(각각
  실장애 이력 있음)나 M급 리팩터라 운영자 선택 시 후속 계획으로. 이번 라운드 미포함.
- **PERF-01 report in-flight dedup**: 유효하나 현재 트래픽에서 실발생 빈도 낮음(로그인+크레딧
  게이트 뒤) — 트래픽 성장 시 재평가.
- **PERF-03 report jeonse 병렬화**: 유효(S급)나 위 5개 대비 사용자 체감 낮음 — 백로그.
- **관심단지 인앱 피드 / 상세모달 객관정보 노출 (direction)**: 운영자 방향 결정 대기 — 채택 시
  설계 스파이크 계획으로 작성.

## 감사 범위 밖(미감사) 고지

- frontend/index.html 전체 로직(표적 Grep 만 수행 — XSS 싱크·토큰 취급·지도 엔진 확인 수준).
- supabase/ SQL·RLS 정책 전문, .github/ 워크플로 심층, 모바일 실기기 동작.
