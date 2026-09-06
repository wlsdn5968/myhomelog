# Plan 041: 절대 룰 ① 을 결정론 카드에도 적용한다 (AI 채널만 정화돼 있다)

> **실행자 안내**: 이 계획을 처음부터 끝까지 읽고, 각 단계의 검증 명령을 실제로 돌려
> 기대 결과를 확인한 뒤 다음 단계로 가라. "STOP 조건" 에 해당하면 멈추고 보고하라.
> 완료하면 `plans/README.md` 의 이 계획 행 Status 를 갱신하라.
>
> **드리프트 점검(가장 먼저)**:
> `git diff --stat e7dc1c6..HEAD -- backend/services/analysisService.js backend/services/aiService.js backend/test/characterization.test.js`
> 비어 있지 않으면 아래 "현재 상태" 발췌와 실제 코드를 대조하고, 다르면 STOP 조건이다.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: 없음
- **Category**: docs (제품 문구 정합)
- **Planned at**: commit `e7dc1c6`, 2026-09-06
- **운영자 판정**: 2026-09-06 감사에서 "고친다" 로 결정됨

## 왜 중요한가

이 저장소의 **절대 룰 ①** 은 `CLAUDE.md:9` 에 있다:
"매수·매도 추천 X / 미래 가격 예측 X / 정보 정리 도구만."

2026-08-17 에 그 룰을 **AI 프롬프트에서는** 집행했다(`RULE-SELF-CONTRADICT-2026-08-17`,
`backend/services/aiService.js:132-137`): 회전율 등급 라벨과 "전세가율이 일정선을 넘으면
향후 가격 방어력이 좋다" 는 단정을 걷어내고 "무엇을 어떤 수치로 보라" 만 남겼다.

그런데 **같은 도메인의 결정론 카드는 그대로다.** `backend/services/analysisService.js` 가
만드는 `conditions` 배열은 색(`status: green/yellow/red`)과 해석 문구를 함께 싣고,
`frontend/index.html:8918-8922` 가 그것을 신호등 UI 로 렌더한다.

사용자에게는 오히려 결정론 카드가 **더 확정적으로 보인다** — AI 답변에는 "참고" 라는 맥락이
붙지만 색깔 신호등은 시스템의 판정처럼 읽힌다. 한 룰에 대해 두 채널이 다른 기준을 갖고 있고,
느슨한 쪽이 더 강한 인상을 준다.

이 계획은 **문구와 status 매핑만** 고친다. 점수 가산(`score += 2/1`)은 건드리지 않는다
(점수 산식은 이 저장소가 별도로 손대지 않기로 한 영역이다).

## 현재 상태

### 파일

- `backend/services/analysisService.js` — `conditions` 를 만드는 곳(7곳).
- `frontend/index.html:8915-8922` — 렌더. `c.status` 로 pip 색을, `c.desc` 로 문구를 그린다.
- `backend/services/aiService.js:131-142` — **정답 기준이 이미 문장으로 적혀 있다.**
- `backend/test/characterization.test.js:2480` — 이미 있는 금지 문구 계약 테스트
  (`'절대 규칙 — 화면·프롬프트가 추천/예측/대출알선을 하지 않는다'`). **대상 파일을 넓히면 된다.**

### 정답 기준 (같은 저장소 안에 이미 있다)

`backend/services/aiService.js:138-142`:

```
1. **회전율(환금성)**: 연간 거래량 ÷ 총세대수 × 100 — 계산된 값을 그대로 제시한다(등급 라벨 금지).
2. **입지 여건**: 재개발·재건축 진행 단계, 역세권 여부, 업무지구까지의 거리 — 확인된 사실만.
3. **실거주 조건**: 학교 인접, 주차, 경사, 지하주차장 연결 — 확인된 사실만.
4. **세대 컨디션**: 동·층·향은 임장으로 확인할 항목으로 안내한다.
5. **전세가율**: 계산된 비율을 제시하되 그것으로 향후 가격 방향을 말하지 않는다.
```

### 대상 문구 7곳 (있는 그대로)

`backend/services/analysisService.js`:

```js
// :258  conditions.push({ label: '가격 위치', status: 'green',  desc: `최근 6개월 하위 ${percentile}% — 시세 하단 구간` });
// :261  conditions.push({ label: '가격 위치', status: 'yellow', desc: `최근 6개월 ${percentile}% 구간 — 시세 수준` });
// :263  conditions.push({ label: '가격 위치', status: 'red',    desc: `최근 6개월 상위 ${100 - percentile}% — 시세 상단 구간` });
```
```js
// :271-275
  const volMap = {
    up:      { score: 2, status: 'green',  desc: '최근 3개월 거래 증가' },
    neutral: { score: 1, status: 'yellow', desc: '거래량 변화 없음 — 관망세' },
    down:    { score: 0, status: 'red',    desc: '거래량 감소' },
  };
```
```js
// :295  conditions.push({ label: '전세가율', status: 'green',  desc: `${jeonseRate}% — 실수요 비중 높음` });
// :298  conditions.push({ label: '전세가율', status: 'yellow', desc: `${jeonseRate}% — 보통 수준` });
// :300  conditions.push({ label: '전세가율', status: 'red',    desc: `${jeonseRate}% — 낮음. 역전세 위험 확인 필요` });
```

### 판정 기준 (무엇이 걸리고 무엇이 아닌가)

- **사실 서술은 유지**: "최근 3개월 거래 증가", "거래량 감소", "최근 6개월 하위 N%",
  `${jeonseRate}%` 같은 **계산된 수치와 관측 사실**은 그대로 둔다.
- **해석·등급 라벨은 제거**: "실수요 비중 높음"(전세가율에서 수요 성격을 단정),
  "보통 수준"(등급 라벨), "관망세"(시장 심리 단정).
- **확인 항목 안내는 유지 가능**: "역전세 위험 확인 필요" 는 예측이 아니라 확인할 항목
  안내로 읽을 여지가 있다. 다만 `status:'red'` 와 결합하면 판정처럼 보이므로 **아래 status
  중립화와 함께** 판단하라.
- **`status` 색은 "좋다/나쁘다" 가 아니라 "어느 구간인가" 로 재정의**하는 것이 목표다.
  구현이 어려우면 문구만 고치고 색은 그대로 두되, 그 판단을 주석에 남겨라.

⚠ 이 문구들은 **사용자에게 그대로 노출된다.** 새 문구도 절대 룰 ①·②를 지켜야 한다
(매수·매도 권유 금지, 미래 가격 단정 금지, 출처 없는 수치 금지).

## 필요한 명령

| 목적 | 명령 | 성공 시 기대 |
|---|---|---|
| 테스트 | `cd backend && npm test` | `pass 224` 이상, `fail 0` |
| 린트 | `npm run lint` | exit 0 |
| 문법 | `node --check backend/services/analysisService.js` | exit 0 |

기준선: **223 pass · 0 fail**.

## 범위

**In scope**:
- `backend/services/analysisService.js` — `conditions` 의 `desc` 문구와(필요 시) `status` 매핑
- `backend/test/characterization.test.js` — `:2480` 의 금지 문구 계약 테스트에
  `analysisService.js` 를 대상 파일로 추가
- `plans/README.md`

**Out of scope**:
- **점수 가산(`score += 2/1`, `volScore`)** — 산식은 건드리지 않는다. 이 계획은 표시 문구만 다룬다.
- `frontend/index.html:8915-8922` 의 렌더 코드 — `status`/`desc` 를 그대로 그리므로 백엔드만 고치면 된다.
  ⚠ 단 CSS 클래스(`sig-pip green/yellow/red`)에 없는 새 `status` 값을 만들면 색이 안 나온다.
  **새 status 값을 도입하려면 프론트 CSS 확인이 선행**되며, 그건 이 계획의 범위 밖이다.
- `backend/services/aiService.js` — **이미 옳다.** 기준 문장으로 참조만 하라.
- 회전율(`turnoverScore`)·점수 밴드 — 별건.

## Git 작업 방식

- 브랜치: `fix/absolute-rule-deterministic-cards`
- 커밋: `fix(문구): 결정론 조건 카드에서 등급 라벨·해석 표현 제거 — AI 채널만 정화돼 있었다`
- ⚠ push·PR 은 운영자 승인 후에만.

## 단계

### Step 1: 7개 문구를 "수치·사실만" 으로 다시 쓴다

`backend/services/analysisService.js` 의 위 7곳을 고친다. 각 문구는
**계산된 값 + 그 값이 무엇을 센 것인지**만 담아야 한다.

방향 예시(그대로 베끼지 말고 이 기준으로 다시 쓰라):
- 전세가율 → `${jeonseRate}% (최근 6개월 전세 실거래 기준)` — 등급 라벨 없이 수치와 근거만.
- 거래량 → `최근 3개월 거래 ${n}건 (직전 3개월 ${m}건)` 처럼 **비교 가능한 수치**.
  숫자를 만들 수 없다면 "최근 3개월 거래 증가" 처럼 관측 사실만 남기고 "관망세" 같은
  심리 단정을 뺀다.
- 가격 위치 → 백분위 수치와 창(6개월)은 유지, "시세 수준" 같은 등급 표현은 제거.

블록 위에 마커 주석을 남긴다:

```js
// RULE-DETERMINISTIC-2026-09-06:
// [왜] 절대 룰 ①(매수·매도 추천 X / 미래 가격 예측 X)을 2026-08-17 에 AI 프롬프트에서는 집행했는데
//   (aiService.js 의 RULE-SELF-CONTRADICT-2026-08-17) 같은 도메인의 **결정론 카드는 그대로였다**.
//   사용자에게는 색 신호등이 AI 답변보다 더 확정적으로 보인다 — 느슨한 쪽이 더 강한 인상을 준다.
// [기준] aiService.js 의 "단지 정보 정리 기준" 절과 같다: 계산된 값을 제시하되 등급 라벨과
//   향후 방향 단정을 붙이지 않는다. 해석은 사용자 몫이다.
// [범위] 문구와 status 매핑만. 점수 가산은 건드리지 않는다.
```

**검증**: `node --check backend/services/analysisService.js` → exit 0
**검증**: 아래가 모두 `0` — 제거 대상 표현이 남아 있지 않다.
```
grep -c "실수요 비중 높음" backend/services/analysisService.js
grep -c "관망세" backend/services/analysisService.js
grep -c "보통 수준" backend/services/analysisService.js
```

### Step 2: `status` 색의 의미를 점검한다

`status` 가 여전히 "좋다/나쁘다" 로 읽히는지 판단하라. 세 가지 선택지:

- **(a)** `status` 를 그대로 두고 문구만 중립화한다 — 가장 안전. 프론트 CSS 변경 없음.
- **(b)** 전세가율·가격 위치처럼 **좋고 나쁨이 성립하지 않는 지표**는 전부 `yellow`(중립)로 통일.
- **(c)** 새 status 값 도입 — **하지 마라.** 프론트 CSS 에 클래스가 없어 색이 사라진다(범위 밖).

(a) 또는 (b) 중 하나를 고르고, **고른 이유를 주석에 남겨라**. (b) 를 고르면
`frontend/index.html:8920` 의 pip 이 전부 같은 색이 되어 화면 인상이 바뀌므로,
그 사실을 커밋 메시지에 명시하라.

**검증**: `node --check backend/services/analysisService.js` → exit 0

### Step 3: 금지 문구 계약 테스트의 대상을 넓힌다

`backend/test/characterization.test.js:2480` 의
`test('절대 규칙 — 화면·프롬프트가 추천/예측/대출알선을 하지 않는다 …')` 를 열어,
검사 대상 파일 목록에 `backend/services/analysisService.js` 를 추가한다.

⚠ **이 저장소의 6회 재발 함정**: 소스를 문자열로 훑는 검사는 **자기 주석까지 잡는다.**
Step 1 의 주석에 제거 대상 표현의 원문을 쓰지 마라(이 계획서가 그 원문을 담고 있으므로,
주석에는 "등급 라벨" 같은 상위 표현만 쓴다). 기존 테스트가 줄 주석을 제거한 뒤 검사하는지
**먼저 읽고** 확인한 뒤 추가하라.

**검증**: `cd backend && npm test` → `pass` ≥ 223, `fail 0`

### Step 4: 회귀 주입

⚠ **주입 전 `git status --short` 가 비어 있어야 한다**(Step 1~3 을 커밋했는지).

제거한 표현 중 하나를 `analysisService.js` 에 되돌려 넣고
`cd backend && npm test` 가 **fail** 하는지 확인한 뒤 원복한다.

**검증**: 주입 시 fail ≥ 1 → 원복 후 fail 0. 안 잡히면 **STOP 조건**.

### Step 5: 라이브 확인

Browser 패널로 단지 상세를 열어 조건 카드 3개가 **정상적으로 렌더되는지** 확인한다
(문구가 비거나 `undefined` 가 뜨지 않는지). 스크린샷 대신 DOM 텍스트로 판정하라.

**검증**: 조건 카드 3개가 모두 문구를 갖고 있고 콘솔 신규 에러 0.

### Step 6: 전체 게이트

```
npm run lint
node scripts/check-deps-sync.js
node scripts/check-env-example.js
node scripts/security-regression-check.js
cd backend && npm test
```

## 테스트 계획

- **기존 테스트 확장 1건**(`:2480` 의 대상 파일 목록).
- 새 문구가 수치를 담게 됐다면, 그 수치가 실제로 계산돼 들어가는지 **실행 테스트 1개**를 추가하라
  (`analysisService` 의 해당 함수를 직접 호출). 소스 문자열 검사로 끝내지 마라.
- **검증**: `cd backend && npm test` → 전부 통과.

## 완료 기준

- [ ] `grep -c "실수요 비중 높음\|관망세\|보통 수준" backend/services/analysisService.js` → `0`
- [ ] `node --check backend/services/analysisService.js` exit 0
- [ ] `backend/test/characterization.test.js` 의 절대규칙 테스트가 `analysisService.js` 를 대상에 포함
- [ ] `cd backend && npm test` exit 0, `fail 0`
- [ ] `npm run lint` exit 0
- [ ] Step 4 의 회귀 주입에서 fail 확인
- [ ] Step 5 의 라이브 확인에서 조건 카드 3개가 정상 렌더
- [ ] `git status --short` 에 `frontend/index.html` 이 **없다**(백엔드만 고쳤다)
- [ ] `plans/README.md` 의 041 행 Status 갱신

## STOP 조건

- 드리프트 점검에서 `analysisService.js` 의 7곳이 발췌와 다르다.
- 새 문구를 쓰다가 매수 권유·가격 예측처럼 읽히는 표현밖에 떠오르지 않는다 — 보고하라.
- Step 3 에서 계약 테스트에 파일을 추가했더니 **기존 문구 수십 건이 걸린다** —
  범위가 커진 것이므로 어떤 문구가 걸리는지 목록으로 보고하고 멈춰라.
- Step 4 의 주입이 잡히지 않는다.
- 프론트 CSS 를 고쳐야 할 것 같다(= 새 status 값을 만들려 하고 있다 — 범위 밖).

## 유지보수 메모

- **앞으로 사용자 노출 문구를 추가할 때**: `aiService.js:131-142` 의 기준을 그대로 적용하라.
  계산된 값 + 근거만, 등급 라벨과 향후 방향 단정 없이.
- **리뷰에서 볼 것**: 점수 가산이 안 바뀌었는지(`score += `). 바뀌었다면 범위를 넘은 것이다.
- **의도적으로 미뤄둔 것**: `status` 색 자체의 의미론. (b) 를 고르지 않았다면 색은 여전히
  "좋다/나쁘다" 로 읽힐 수 있다. 신호등 UI 를 "구간 표시" 로 바꾸는 것은 디자인 변경이라
  기획(claude.ai/design)이 선행해야 한다.
