# Plan 045 (설계·스파이크): 공개 페이지 → 앱 전환에서 맥락이 버려진다 — 열린 질문 2개를 먼저 답한다

> **실행자 안내**: 이것은 **설계·스파이크 계획**이다. 최종 산출물은 "구현된 기능" 이 아니라
> **① 열린 질문 2개에 대한 실측 기반 답 + ② 그 답에 따른 최소 구현(가능하다면) + ③ 남은 위험 기록**이다.
> 질문에 답하기 전에 CTA 를 바꾸지 마라 — 잘못 바꾸면 랜딩 퍼널이 꺼지거나 엉뚱한 단지가 열린다.
> "STOP 조건" 에 해당하면 멈추고 보고하라. 완료하면 `plans/README.md` 의 이 계획 행 Status 를 갱신하라.
>
> **드리프트 점검(가장 먼저)**:
> `git diff --stat e7dc1c6..HEAD -- backend/routes/aptPage.js backend/routes/regionPage.js backend/routes/briefing.js frontend/index.html`
> 비어 있지 않으면 아래 "현재 상태" 발췌와 실제 코드를 대조하라.

## Status

- **Priority**: P3
- **Effort**: S (거친 추정 — 스파이크라 답에 따라 달라진다)
- **Risk**: MED
- **Depends on**: **plans/043** 먼저(측정 장치). **plans/044** 와 함께 보는 것이 좋다.
- **Category**: direction
- **Planned at**: commit `e7dc1c6`, 2026-09-06

## 왜 중요한가

공개 SSR 페이지가 앱으로 넘기는 CTA 가 **3개**인데, 그중 **1개만 맥락을 넘긴다**.

맥락을 넘기는 쪽 — `backend/routes/briefing.js:123`·`:182`:

```js
       <a class="cta" href="/?briefing=${esc(day)}">앱에서 열기 →</a>`));
```

버리는 쪽 — `backend/routes/aptPage.js:212`:

```js
    <a class="cta" href="${ORIGIN}/">${esc(aptName)} 대출 한도·비용 계산 →</a>`;
```

버리는 쪽 — `backend/routes/regionPage.js:138`·`:304`:

```js
    <a class="cta" href="${ORIGIN}/">지도·계산기와 함께 보기 →</a>`;
    <a class="cta" href="${ORIGIN}/">${esc(label)} 단지 검색·대출 계산 →</a>`;
```

두 페이지는 `aptName`·`lawdCd`·지역 라벨을 **알고 있으면서도** 맨 홈으로 보낸다.
검색으로 `/apt/43114-58` 에 도착한 사람이 "○○ 대출 한도·비용 계산 →" 을 누르면
**빈 홈**에 떨어져 방금 보던 단지를 손으로 다시 검색해야 한다.

그리고 **SPA 는 이미 받을 준비가 되어 있다**:
- `frontend/index.html:8748-8757` — `handleShareUrl()` 이 `?apt=`·`?area=` 를 읽어 상세를 자동으로 연다.
- `frontend/index.html:10396-10400` — `?region=` 이 위저드 지역 칩을 프리필한다
  (`budget`·`cash`·`wp`·`house`·`first`·`school`·`py` 와 함께).
- `/apt` 페이지 자신이 그 딥링크 형식을 알고 있다 — `aptPage.js:6` 이 "`/?apt=반포자이` 는
  홈과 동일한 메타를 반환" 이라고 적었다.

즉 **새로운 코드 개념이 0**이다. 브리핑 경로가 이미 구현해 둔 패턴을 옮기기만 하면 된다.

**그런데 그냥 옮기면 안 된다.** 두 가지가 걸린다 — 그래서 이 계획은 스파이크다.

## 열린 질문 2개 (이 계획의 본체)

### Q1. `?apt=` 는 **단지명 매칭**이다 — 동명 단지가 잘못 열리지 않는가?

`frontend/index.html:8756`:

```js
  const found=props.find(p=>p.aptName===apt);
```

`backend/routes/aptPage.js:15` 가 정확히 이 위험을 경고해 뒀다
('현대'·'벽산' 같은 흔한 이름). `/apt/:seq` 는 **단지코드**로 특정하는데, 앱으로 넘길 때
이름으로 바뀌면 정보가 손실된다.

**답해야 할 것**:
- 전국에 **동명 단지가 몇 개**인가? (DB 조회 — `molit_apt_index` 의 `apt_name` 중복 수)
- `?apt=` 가 잘못된 단지를 여는 케이스를 라이브에서 재현할 수 있는가?
- `?aptSeq=` 같은 **코드 기반 파라미터**를 SPA 가 받게 하는 것이 가능한가?
  (`handleShareUrl` 의 fallback 경로가 이미 stub 단지를 만들어 조회한다 — `:8758` 이후를 읽어라)

### Q2. 랜딩을 건너뛰는 것이 옳은가?

`frontend/index.html:3702-3712`:

```js
    const _hasParams = (function(){
      try {
        if (location.hash) return true;
        const p = new URLSearchParams(location.search);
        for (const k of [...p.keys()]) {
          if (/^utm_/i.test(k) || k === 'fbclid' || k === 'gclid' || k === 'igshid') p.delete(k);
        }
        return [...p.keys()].length > 0;
      } catch(_) { return !!(location.search || location.hash); }
    })();
    if(!_seenLanding && !_hasParams && !restored && !sp.get('apt')) {
```

`?apt=` 든 `?region=` 이든 붙이는 순간 `_hasParams` 가 참이 되어 **랜딩이 꺼진다**
(`?apt=` 는 조건에 명시적으로도 들어 있다).

⚠ 이 저장소는 같은 함정을 이미 겪었다 — 주석(`:3697-3701`)이 적어 뒀다:
**"유입 측정을 켜면 퍼널 첫 화면이 꺼지는 정반대 효과"**. UTM 은 그래서 판정에서 제외했다.

**답해야 할 것**:
- 단지 페이지에서 온 사람에게 랜딩을 건너뛰는 것이 옳은가?
  (의도가 명확하므로 옳을 가능성이 높다 — 하지만 **판단**이지 자명한 사실이 아니다)
- 지역 페이지에서 온 사람은 다른가? (지역만 보고 온 사람은 아직 무엇을 할지 모를 수 있다)
- `?apt=`/`?region=` 을 `_hasParams` 판정에서 **제외**해서 랜딩을 살릴 수도 있다.
  그게 나은가, 건너뛰는 게 나은가?

## 현재 상태 (인용 전부 위에 있음)

### 이 저장소의 관례·제약

- 주석 한글, 마커 `<주제>-<YYYY-MM-DD>`. 이 변경의 마커: `CTA-CONTEXT-2026-09-06`.
- 사용자 노출 문구는 절대 룰 ①(매수·매도 추천 금지) 준수.
- 프론트 인라인 JS 는 `npm run lint` 가 검사한다.
- SSR 라우트에서 값은 `esc()` 로 이스케이프한다(같은 파일의 기존 패턴).
  ⚠ URL 쿼리에 넣을 값은 `encodeURIComponent` 가 **먼저**, `esc()` 가 **나중**이다.
- ⚠ 사용자 7명·최근 7일 로그인 0 이라 **전환율을 측정할 수 없다.**
  그래서 "지금 하는 이유" 는 지표가 아니라 **Plan 044 가 성공했을 때 새는 구멍을 미리 막는 것**이다.
  이 사실을 정직하게 문서에 남겨라.

## 필요한 명령

| 목적 | 명령 | 성공 시 기대 |
|---|---|---|
| 린트 | `npm run lint` | exit 0 |
| 테스트 | `cd backend && npm test` | `fail 0` |
| 문법 | `node --check backend/routes/aptPage.js backend/routes/regionPage.js` | exit 0 |

## 범위

**In scope**:
- **조사·측정·문서** (Step 1~2) — 이것이 본체다
- 답이 나온 뒤의 **최소 구현**: `backend/routes/aptPage.js:212` 와
  `backend/routes/regionPage.js:138`·`:304` 의 CTA href 3줄
- 필요 시 `frontend/index.html` 의 `_hasParams` 판정 또는 `handleShareUrl` 의 파라미터 처리
- `backend/test/characterization.test.js`
- `plans/README.md` — **열린 질문의 답과 남은 위험(핵심 산출물)**

**Out of scope**:
- `backend/routes/briefing.js` — **이미 옳다.** 참조만 하라.
- 새 SSR 페이지·새 앱 화면.
- 랜딩 화면 자체의 디자인·문구 변경 — 디자인 기획(claude.ai/design)이 선행한다.
- UTM 파라미터를 CTA 에 붙이는 것 — ⚠ **하지 마라.** 이 저장소는 "UTM 을 붙이면 랜딩이 꺼진다"
  는 충돌을 이미 겪었고 지금 `_hasParams` 가 UTM 을 제외하는 방식으로 해결돼 있다.
  내부 링크에 UTM 을 붙이면 그 해결을 무의미하게 만들고 유입 측정도 오염시킨다.
- Plan 044 의 형제 단지 링크 — 별 계획.

## Git 작업 방식

- 브랜치: `feature/cta-context-deeplink`
- 커밋(구현까지 간 경우): `feat(공개페이지): CTA 가 단지·지역 맥락을 앱으로 넘긴다 — 3곳 중 2곳이 맨 홈으로 보냈다`
- ⚠ push·PR 은 운영자 승인 후에만.

## 단계

### Step 1: Q1 에 답한다 — 동명 단지 위험을 실측한다

1. `molit_apt_index`(또는 동등한 소스)에서 **`apt_name` 이 중복되는 단지 수**를 센다.
   전국 기준과 서울 기준을 따로 낸다.
   ⚠ PostgREST 는 1000행에서 조용히 잘린다 — 집계는 **SQL 로** 하고 행을 세지 마라.
2. 가장 흔한 이름 상위 10개를 뽑는다.
3. 라이브에서 `/?apt=<가장 흔한 이름>` 을 열어 **어느 단지가 열리는지** 확인한다.
   `props` 에 없으면 어떤 경로를 타는지도 확인하라(`frontend/index.html:8758` 이후).
4. `handleShareUrl` 이 `aptSeq` 같은 코드 파라미터를 받게 하는 것이 **얼마나 큰 변경인지**
   판단한다(그 함수와 `showDetail` 의 입력 형태를 읽고 판단).

**산출물**: 중복 단지 수 · 상위 10개 이름 · 라이브 재현 결과 · `aptSeq` 도입 난이도(S/M/L).
이것을 `plans/README.md` 에 적는다.

**검증**: 위 네 값이 문서에 기록됐다.

### Step 2: Q2 에 답한다 — 랜딩 게이트의 실제 동작을 확인한다

Browser 패널로 **세 경우**를 각각 열어 랜딩이 뜨는지 확인한다
(⚠ `_seenLanding` 은 저장된 상태이므로 **매번 새 프라이빗 세션 또는 저장소 초기화** 후 테스트하라):

1. `https://<host>/` — 랜딩이 뜬다(기준)
2. `https://<host>/?apt=반포자이` — 랜딩이 꺼진다(예상)
3. `https://<host>/?region=서울 강남구` — 랜딩이 꺼진다(예상)

그리고 **판단을 적는다**: 단지 페이지 유입자에게 랜딩을 건너뛰는 것이 옳은가?
지역 페이지 유입자는 다른가? 근거와 함께 한 문단으로.

⚠ 이 저장소의 교훈: 라이브 측정은 **누가 무엇으로 재느냐가 결과를 바꾼다.**
Vercel MCP 페치는 인증을 실어 엣지 캐시를 항상 MISS 로 보이게 하고, 내 익명 세션의 한도 표시를
신규 방문자 값으로 읽어 없는 결함을 보고한 이력이 있다. **브라우저에서 직접 열어라.**

**산출물**: 세 경우의 실제 동작 + 판단 한 문단. `plans/README.md` 에 기록.

### Step 3: 답에 따라 최소 구현 — 또는 하지 않는다

Step 1·2 의 답에 따라 셋 중 하나를 고른다:

- **(A) 안전하다고 판단** → CTA 3줄을 고친다:
  - `aptPage.js:212` → 단지를 특정할 수 있는 파라미터를 붙인다.
    Q1 의 답이 "동명 위험이 크다" 면 **이름 대신 코드**를 쓰거나, 코드 지원이 L 급이면
    `/apt` CTA 는 **손대지 말고** 지역 CTA 만 고친다.
  - `regionPage.js:138`·`:304` → `?region=<지역 라벨>` 을 붙인다.
    ⚠ 값은 `encodeURIComponent` 후 `esc()`. 라벨 형식이 앱의 `ch-r`/`ch-rs` 칩과
    맞는지 `frontend/index.html:10396-10400` 을 읽고 확인하라 — 안 맞으면 프리필이 조용히 실패한다.
- **(B) 랜딩을 살려야 한다고 판단** → `_hasParams` 판정에서 `apt`/`region` 을 제외하는 변경을
  함께 넣는다(UTM 을 제외한 것과 같은 방식). ⚠ `:3712` 의 `!sp.get('apt')` 조건도 함께 봐야 한다.
- **(C) 위험이 크다고 판단** → **구현하지 않는다.** Q1·Q2 의 답과 "왜 하지 않는가" 를
  문서에 남기는 것으로 이 계획을 완료한다. **이것도 정상적인 결과다.**

어느 쪽이든 **고른 이유를 `plans/README.md` 에 적어라.**

**검증**: (A)·(B) 라면 `node --check` + `npm run lint` exit 0. (C) 라면 코드 변경 0.

### Step 4: 계약 테스트 (구현한 경우에만)

- SSR 페이지 3종의 CTA href 가 **맥락 파라미터를 담고 있다**(브리핑 포함 — 셋이 같은 규칙).
  ★ 이 단언이 "한 곳만 고침" 재발을 막는다.
- 값이 `encodeURIComponent` 로 인코딩됐다(공백·한글이 그대로 들어가지 않는다).
- (B) 를 골랐다면: `_hasParams` 가 `apt`/`region` 을 제외한다는 것을 프론트 함수를 추출해
  **실행**으로 단언하라(`characterization.test.js:885` 패턴).

**검증**: `cd backend && npm test` → `fail 0`

### Step 5: 라이브 확인 (구현한 경우에만)

1. `/apt/<seq>` 를 열고 CTA 를 **실제로 클릭**해 앱이 그 단지를 여는지 확인.
2. `/region/<lawd>` 의 CTA 를 클릭해 지역 칩이 프리필되는지 확인.
3. 콘솔 신규 에러 0.
4. Q2 의 판단대로 랜딩이 뜨거나 안 뜨는지 확인.

**검증**: 네 가지 모두 의도대로.

### Step 6: 전체 게이트

```
npm run lint
node scripts/check-deps-sync.js
node scripts/check-env-example.js
node scripts/security-regression-check.js
cd backend && npm test
```

## 완료 기준

- [ ] `plans/README.md` 에 **Q1 의 답**(동명 단지 수·상위 10개·라이브 재현 결과·`aptSeq` 난이도)이 있다
- [ ] `plans/README.md` 에 **Q2 의 답**(세 경우의 실제 동작 + 판단 한 문단)이 있다
- [ ] `plans/README.md` 에 (A)/(B)/(C) 중 무엇을 골랐고 왜인지 적혀 있다
- [ ] (A)·(B) 인 경우: `npm run lint` exit 0, `cd backend && npm test` `fail 0`,
      CTA 계약 테스트 존재, Step 5 의 라이브 확인 4가지 통과
- [ ] (C) 인 경우: `git status --short` 에 코드 변경이 **없다**(문서만)
- [ ] `backend/routes/briefing.js` 가 **변경되지 않았다**(이미 옳다)
- [ ] CTA 어디에도 **UTM 파라미터가 없다**: `grep -c "utm_" backend/routes/aptPage.js backend/routes/regionPage.js` 합계 `0`
- [ ] `plans/README.md` 의 045 행 Status 갱신

## STOP 조건

- Q1 조사에 프로덕션 DB **쓰기**가 필요해진다 — 읽기 전용 조회만 하라(절대 룰 ③).
- 라이브에서 `/?apt=<흔한 이름>` 이 **다른 단지를 연다** — 그 사실만 기록하고
  `/apt` CTA 구현은 보류하라(그게 (C) 다). 지역 CTA 는 별개로 판단할 수 있다.
- `?region=` 프리필이 지역 라벨 형식 불일치로 조용히 실패한다 — 라벨 형식을 맞추는 것이
  다른 곳(칩 정의·`pickRegions`)에 번지면 보고하라.
- `_hasParams` 를 고쳤더니 기존 공유 링크(`?apt=`)의 동작이 바뀐다.
- CTA 에 UTM 을 붙이고 싶어진다 — **금지.** 위 "범위" 참조.

## 유지보수 메모

- **왜 지금 전환율로 정당화하지 않는가**: 사용자 7명·유입 17건이라 **전환율 측정이 원리적으로
  불가능**하다. 이 작업의 근거는 지표가 아니라 구조다 — 브리핑 경로가 이미 옳은 형태를
  구현해 뒀고 나머지 둘이 그것을 안 따를 이유가 없다. **Plan 044 가 성공해 유입이 늘수록
  이 구멍의 손실이 곱해진다.** 그 정직한 근거를 문서에 그대로 남겨라.
- **Plan 043 과의 관계**: 043 의 `search`·`report` 이벤트가 있어야 "착지 → 앱 → 검색" 이
  실제로 이어지는지 볼 수 있다. 043 을 먼저 넣어라.
- **리뷰에서 볼 것**: 세 CTA(브리핑 포함)가 **같은 규칙**을 따르는지. 이 저장소는
  "한 곳만 고침" 으로 취득세·규제 판정에서 반복 사고를 냈다.
- **의도적으로 미뤄둔 것**: `?apt=` 를 코드 기반(`aptSeq`)으로 바꾸는 것. Q1 의 답이 L 급이면
  별도 계획이 필요하다 — 그 판단 근거를 문서에 남겨라.
