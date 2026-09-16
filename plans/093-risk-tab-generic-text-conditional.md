# 093 — 리스크 탭: 세대수를 알면서도 "세대수 적을 경우…" 일반론이 대단지에 찍히는 분기 수정

**작성 기준 커밋**: `dc5a30f` (2026-09-16) · 우선순위 P2 · 작업량 XS · 의존: 없음

## 전제 확인 (계획자가 라이브·코드로 확인한 것)
- 라이브(매교역푸르지오SKVIEW, KAPT 3,603세대) 리스크 탭에 "낮음 · 환금성 리스크 · **세대수 적을 경우** 매도 시 거래 부재. 💡 RR(로열동·로열호) 여부 임장 확인" 이 표시된다 — 세대수를 알고 있는 대단지에 조건부 일반론을 그대로 노출(사용자가 "AI 가 대충 쓴 문장" 으로 느끼는 유형).
- 코드 `frontend/index.html:11340~11344`:
  ```js
  if (hh != null && hh < 300) {
    risks.push({level:'낮음',title:'환금성 리스크',probability:'',scenario:`세대수 ${hh.toLocaleString()}세대(소단지) — 매도 시 거래 부재 가능성.`,countermeasure:'같은 …'});
  } else {
    risks.push({level:'낮음',title:'환금성 리스크',probability:'',scenario:'세대수 적을 경우 매도 시 거래 부재.',countermeasure:'RR(로열동·로열호) 여부 임장 확인'});
  }
  ```
  `else` 가 "세대수 모름" 과 "세대수 300 이상" 을 구분하지 않는다. 같은 함수의 다른 항목(`:11337` 노후 단지 `age >= 30`)은 값이 있을 때만 넣는 올바른 패턴.

## 범위
- 수정: `frontend/index.html` 의 위 `else` 분기 1곳. 신규 테스트: `backend/test/frontend-contracts.test.js` 에 소스 계약 1개(또는 기존 리스크 관련 테스트 파일이 있으면 그곳).

## Step 1 — 분기 수정
```js
  if (hh != null && hh < 300) {
    /* 기존 그대로 */
  } else if (hh == null) {
    // RISK-HH-2026-09-16 (Plan 093): 세대수를 모를 때만 조건부 일반론. 대단지(≥300)엔 환금성 항목을 넣지 않는다 — 데이터로 아는 사실에 반하는 문장 금지.
    risks.push({level:'낮음',title:'환금성 리스크',probability:'',scenario:'세대수 정보가 없어 확인이 필요해요 — 소단지(300세대 미만)는 매도 시 거래가 드물 수 있어요.',countermeasure:'KAPT·건축물대장에서 세대수 확인 후 판단'});
  }
```
(≥300 은 항목 생략. `hh` 산출 위치를 확인해 세대수가 **facility 로드 뒤에** 갱신될 때 리스크 탭이 다시 그려지는지 `grep -n "renderRisk("` 로 확인 — 첫 렌더가 facility 이전이면 세대수 로드 후 `renderRisk` 재호출이 있는지 보고에 적는다(없으면 STOP 아님, 보고만).)

## Step 2 — 소스 계약 테스트
`frontend/index.html` 소스에 문자열 `세대수 적을 경우 매도 시 거래 부재.` 가 **없고** `RISK-HH-2026-09-16` 이 1회 있음을 단언(기존 frontend-contracts 의 소스 grep 패턴 재사용).

## 검증·완료 기준
- `npm run verify` `fail 0`(+1). 회귀 주입: 옛 `else` 복원 → 계약 테스트 fail.
- 커밋: `fix(리스크): 세대수 아는 대단지에 "세대수 적을 경우" 일반론 표시 안 함 (Plan 093)`.
