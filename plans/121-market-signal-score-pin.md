# 121 — 시장 요약 점수(`summarizeMarketSignal`) 입력→출력 고정 테스트

**작성 기준 커밋**: `d209abc` (2026-09-28) · **출처**: `plans/README.md` 백로그 "summarizeMarketSignal 점수 가산에 가드/테스트 없음"(2026-09-06) · **운영자 승인 2026-09-28**("권고대로" — 후속표 4번)
**성격**: 테스트 전용(프로덕션 코드 변경 0). 신규 파일 1개.

## 1. 사실 (계획자가 `backend/services/analysisService.js:265-380` 을 직접 읽음)
- 시그니처: `summarizeMarketSignal(percentile, volumeSignalObj, jeonseRate, jeonseSample)` — 테스트에서는 `require('../services/analysisService')._internals.calcBuySignal`(같은 함수의 별칭, `:383`·`:789`).
- 가산: ① 가격 위치 `percentile !== null` 일 때만 조건 추가 — `≤30` +2 green · `≤65` +1 yellow · 그 외 0 red(desc `최근 6개월 상위 ${100-percentile}%`). ② 거래량(항상 추가) — up 2 green · neutral 1 yellow · down 0 red, 알 수 없는 값은 neutral. `seasonalBias && up` → 1 yellow(desc `최근 3개월 거래 증가 (성수기 영향 감쇄)`), `seasonalBias` 인데 up 이 아니면 desc 끝에 ` ⚠️ 이사 성수기 영향 가능`. ③ 전세가율 `jeonseRate !== null` 일 때만 — `≥60` +2 green · `≥45` +1 yellow · 그 외 0 red(desc 끝 ` — 역전세 위험 확인 필요`).
- `maxScore = 조건수×2`, `ratio = score/maxScore`(조건 0개면 0.5). `ratio ≥ 0.67` green · `≥ 0.34` yellow · 그 외 red. `metCount` = green 조건 수. `signalDesc = "${totalCount}개 조건 중 ${metCount}개 긍정"`.
- veto: `percentile > 65` 이고 signal 이 green 이면 yellow 로 강등(`vetoApplied = true`). signal 이 red 가 아니면 `signalDesc += ' · ⚠ 시세 상단 — 매수 단가 주의'`.
- `tone`: green→active · yellow→neutral · red→cautious. `summaryDesc = signalDesc.replace('긍정','데이터 부합')`.

## 2. 이 테스트가 드러내는 사실 (주석으로 기록할 것 — 동작은 바꾸지 않는다)
- **veto 강등은 현재 산식으로 도달 불가**: `percentile > 65` 면 가격 조건이 0점이라 3조건 만점이 `4/6 = 0.6667 < 0.67`, 2조건(전세 없음)이면 `2/4 = 0.5` — green 이 나올 수 없다. 그래서 `vetoApplied` 는 항상 false 이고, veto 블록이 실제로 하는 일은 **yellow 에 경고 문구를 붙이는 것뿐**이다. 테스트 이름·주석에 이 사실을 적고 `vetoApplied === false` 를 단언한다(나중에 임계값·가산이 바뀌어 veto 가 살아나면 이 테스트가 알려준다).
- 두 yellow + 한 red(예: 50·down·50) = `2/6 = 0.333 < 0.34` → **전체 red**.

## 3. 테스트 `backend/test/market-signal-score.test.js` (신규) — 각 항목을 별도 `test`
기대값은 §1 규칙으로 **손으로 계산한 값**을 쓰고, 함수를 돌려서 받아 적지 마라(그러면 고정이 아니라 복사다). 계획자 계산:
| # | 입력 (percentile, vol, jeonse) | score/max | signal | metCount | vetoApplied | tone |
|---|---|---|---|---|---|---|
| A | 20, {signal:'up',seasonalBias:false}, 70 | 6/6 | green | 3 | false | active |
| B | 20, {signal:'up',seasonalBias:true}, 70 | 5/6 | green | 2 | false | active |
| C | 80, {signal:'up',seasonalBias:false}, 70 | 4/6 | yellow(+상단 경고 문구) | 2 | **false** | neutral |
| D | 50, 'neutral'(문자열 인자), 50 | 3/6 | yellow | 0 | false | neutral |
| E | 50, {signal:'down'}, 50 | 2/6 | **red** | 0 | false | cautious |
| F | 90, {signal:'down'}, 30 | 0/6 | red(경고 문구 없음) | 0 | false | cautious |
| G | null, {signal:'neutral'}, null | 1/2 | yellow | 0 | false | neutral |
| H | 80, {signal:'up'}, null | 2/4 | yellow(+상단 경고) | 1 | false | neutral |
경계: percentile 30→green·31→yellow·65→yellow·66→red · jeonse 60→green·59.9→yellow·45→yellow·44.9→red(각각 조건 status 만 단언) · `{signal:'weird'}` → neutral 처럼 1점 yellow · C 의 `signalDesc` 가 `'3개 조건 중 2개 긍정 · ⚠ 시세 상단 — 매수 단가 주의'`, `summaryDesc` 가 `'3개 조건 중 2개 데이터 부합 · ⚠ 시세 상단 — 매수 단가 주의'` 와 정확히 같음 · B 의 거래량 조건 desc 가 `'최근 3개월 거래 증가 (성수기 영향 감쇄)'`, status yellow.
실행자는 이 표를 코드와 대조해 **틀린 칸이 있으면 STOP 하고 보고**(계획자 산술 오류 가능성 — 그 경우 코드를 믿는다).

## 4. 하지 말 것
- `analysisService.js` 수정 금지(주석 포함). 기존 테스트 파일 수정 금지. 신규 파일 1개만.
- 기존 테스트(`frontend-contracts.test.js:300~`, `rent-jeonse.test.js:327~`)는 desc 문구를 보고, 이 파일은 **점수·등급**을 본다 — 중복 단언을 만들지 마라.

## 5. 완료 기준
`npm run verify` 전부 통과(526 + 신규). **회귀 주입 1회**: `analysisService.js` 에서 `ratio >= 0.67` 을 `ratio >= 0.66` 으로 잠깐 바꾸면 C 가 green 이 되어 veto 가 살아나고 테스트가 실패하는지 확인 → 원복(결과 보고).
