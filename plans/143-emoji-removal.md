# 143 — 사용자 화면·응답의 이모지 제거 + 이모지만 있던 버튼을 Lucide 선 아이콘으로

**작성 기준 커밋**: `fcff5a3` (2026-10-14) · **근거**: 전면 검토(`plans/review-2026-10-14.md`) "이모지 552개 — AI 가 만든 느낌", 디자인 규칙 v2(`plans/design-spec-v2-2026-10-14.md` §4 "이모지 0개, 선 아이콘 한 세트") · 운영자 "권고대로 진행" 2026-10-14
**후보 작성**: 사전 분류(sonnet, `scratchpad/emoji-inventory.json`) → 후보(sonnet, 2회 — 1차는 변형 선택자 없는 그림 문자 55곳이 남아 규칙을 넓혀 재작성) → 계획자 검증.

## 1. 규칙
- 사용자에게 보이는 것(정적 HTML·화면에 그리는 JS 문자열·서버 응답)에서 `\p{Extended_Pictographic}` 전부 제거(FE0F·ZWJ 시퀀스 포함).
- **남기는 기능 기호(허용 목록)**: ⚠ ✓ ✔ ✕ ✗ ★ ☆ © ® ™ ↔ ↗ ↘ ↻ ℹ ▲ ▼ ▶ ◀ ● ○ ■ □ ※ — 닫기 버튼·색약 대응 표시·접기 화살표·동기화 배지(✓ 비교 로직 1곳) 등에 쓰인다. 아이콘 교체는 다음 단계.
- 건드리지 않음: 주석 · AI 프롬프트(aiService·report·clause — LLM 지시문) · 운영 로그 · 테스트의 비제품 문자열 · DB 에 이미 저장된 브리핑·챗 기록.
- 이모지만 있던 버튼 8곳 + 챗 아바타 4곳 + 알림 카드·모바일 히어로 아이콘 박스: **lucide-static 1.57.0(ISC)** 원본 경로 그대로(stroke 1.5) — bell·moon/sun·history·message-circle·star·thumbs-up/down·trash-2·bar-chart-3. 빠졌던 aria-label 4개 추가. `<head>` 에 Lucide ISC 고지 주석.
- 검색 결과 🔥 배지(`_hot`) 제거 — 같은 숫자가 "· N건"으로 이미 보인다.
- 이모지가 문장 끝 역할을 하던 3곳에 마침표.

## 2. 계획자 검증 (2026-10-14)
| 항목 | 결과 |
|---|---|
| 남은 그림 문자(허용 목록 밖, 화면 노출) | 계획자 독립 계수: master 542 → 후보 15, 15개는 전부 주석 줄(직접 확인) → **화면 노출 0** |
| Lucide 출처 | `npm pack lucide-static@1.57.0` sha512 = 레지스트리 `dist.integrity` 일치, ISC · 표본 4개(bell·thumbs-up·trash-2·history) 경로 전부 index.html 에 원본 그대로 |
| 테스트 | 신규 `emoji-free-ui.test.js` 3(원래 코드에서 본 검사 실패), `frontend-contracts.test.js:409` 기대값 갱신(의도 유지), verify 641 |
| 캐시 | `news:summary:v5` → `v6` · 서비스워커는 푸시 전용(캐시 없음, `frontend/sw.js`) → 버전 변경 불필요 |

## 3. 배포 뒤 확인
- 데스크톱·모바일 화면 캡처(헤더 버튼·FAB·챗 패널·단지 상세·검색 드롭다운) — 빈 칸·정렬 이상.
- 챗 응답에 이모지 없음, 리포트(유료, 503 중)는 미확인.
