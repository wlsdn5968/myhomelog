# 115 — 공개 페이지 → 앱 맥락 유지 딥링크(P1) + 사실과 다른 문구 4곳 정정(P4)

**작성 기준 커밋**: `6ff6d2e` (2026-09-26) · 부모: `plans/114-direction-review-2026-09-26.md` P1·P4 · **운영자 승인 2026-09-26**("권고대로 진행해줘. 승인할게")
**성격**: 코드 전용 · DB 변경은 P4-③ 한 행(리뷰어가 별도 적용) · UI 구조 변경 없음(문구·href 만)

## 전제 확인 (계획자가 코드·라이브로 직접 확인 — 2026-09-26)
1. **CTA 가 루트로 간다**: `backend/routes/aptPage.js:479` `<a class="cta" href="${ORIGIN}/">${esc(aptName)} 대출 한도·비용 계산 →</a>`. 라이브 `/apt/43114-58` 의 버튼이 `/` 로 이동함을 실측.
2. **SPA 딥링크는 이미 있다**: `frontend/index.html:8907-8920` `handleShareUrl()` 이 `?apt=<단지명>&area=<지역문자열>` 을 읽어 상세 모달을 연다. `area` 는 `resolveLawdCdFromArea()`(`:8996-9012`)가 **구 이름 부분일치**로 lawdCd 를 찾으므로 `"청주시 청원구"` 처럼 구 이름이 들어 있으면 된다. 같은 형식을 `backend/routes/share.js:97` 이 이미 만든다(`/share?apt=…&area=…`).
3. `aptPage.js:159` 의 `loadAptFacts()` 반환값에 `aptName`·`region`("청주시 청원구" 형태, `regionLabel()` 산출)·`sigungu`(원본 짧은 형태)가 있다. **`area` 에는 `region` 을 쓴다**(구 이름 포함이 보장됨).
4. SPA 가 받는 파라미터는 `apt`·`area`·`cmp`·utm 류뿐이다(`grep "sp.get('"` 전수). **지역 딥링크 파라미터는 없다** → `/region/:lawdCd` 의 CTA 는 이번 범위 밖.
5. 문구 4곳(라이브 실측):
   - ① **"AI 특약 초안"**: 무료 사용자는 규칙 엔진 템플릿을 받는다 — 프론트는 `/api/clause` 를 부르지 않고(`index.html:11452` 주석 "AI 맞춤 초안은 프로 개통 시 재배선"), 백엔드 `clause.js:38-52` 는 pro/admin 외 **403 fail-closed**. 그런데 화면은 `index.html:2708` `✍ AI 특약 초안 (보조 도구)` · `:2710` `→ AI 특약 초안` · `:8073` `AI 특약 초안 생성 중...` · `:11541` `내집로그 AI 특약 초안 · 날짜` 라고 쓴다. **약관의 AI 면책(`:3136-3138`)은 보고서가 실제 LLM 을 쓰므로 건드리지 않는다.**
   - ② **"2025.05 이후"** 하드코딩: `index.html:2987` `단지 선택 시 2025.05 이후 실거래 표·가격 위치·월별 거래량 (국토부 신고 기준)`. 장기 추세(Plan 102)는 2020-09 부터 보여주므로 이미 사실과 다르고, 창을 자르면(107c) 더 틀려진다.
   - ③ `billing_plans.free.features` 의 `"맞춤 보고서 월 1회"` vs 코드(dailyLimit)·랜딩 `"무료 가입 후 하루 1회"`. **DB 1행 — 리뷰어가 적용(§Step 5)**.
   - ④ `backend/routes/region.js:135` `return { status: '확인 필요', basis: null }; // 단정하지 않음` → 규제지역 목록에 없는 **모든** 지역(125곳 대부분)의 공개 페이지에 "대출 규제 — 현재 상태 **확인 필요**" 로 렌더(`regionPage.js:282`). 의도(단정 안 함)는 옳으나 방문자에게 결손으로 읽힌다.
6. 기존 테스트 패턴: `backend/test/apt-page-links.test.js`(공개 페이지 링크 단언) · `apt-page.test.js` · `share-ssr.test.js`.

## 범위
**건드릴 파일**: `backend/routes/aptPage.js`(479 한 줄) · `backend/routes/region.js`(135 한 줄) · `frontend/index.html`(2708·2710·2987·8073·11541 — 문구만) · `backend/test/public-deeplink-copy.test.js`(신규)
**건드리지 말 것**: `index.html:3136-3138` 약관 AI 면책 · `backend/routes/clause.js`(게이트 유지) · `regionPage.js`(렌더는 그대로, 값만 바뀐다) · `share.js` · 다른 CTA·문구 · **DB(리뷰어 몫)**

---

## Step 1 — 단지 페이지 CTA 를 딥링크로 (P1)
`backend/routes/aptPage.js:479`:
```js
    <a class="cta" href="${ORIGIN}/?apt=${encodeURIComponent(aptName)}&area=${encodeURIComponent(region)}">${esc(aptName)} 대출 한도·비용 계산 →</a>`;
```
바로 위에 주석:
```js
  // DEEPLINK-CTX-2026-09-26 (Plan 115): 종전 href="${ORIGIN}/" 는 구글에서 이 단지 페이지로 온 방문자를
  //   단지를 잊은 랜딩에 떨어뜨렸다(라이브 실측). SPA 의 handleShareUrl(?apt=&area=)이 상세 모달을 바로
  //   연다 — /share 가 쓰는 검증된 형식과 동일. area 는 구 이름 부분일치라 region("청주시 청원구")을 쓴다.
```
`aptName`·`region` 은 이 템플릿 스코프에 이미 있는 변수다(`:470` 에서 `region`, `:479` 에서 `aptName` 사용 중). **`encodeURIComponent` 를 쓰고 `esc()` 로 감싸지 마라** — href 속성 안의 URL 인코딩이 목적이다(기존 `share.js:97` 과 동일).

## Step 2 — 문구 ①: "AI 특약 초안" 4곳 → 제공되는 것 그대로
| 위치 | 현재 | 변경 |
|---|---|---|
| `index.html:2708` | `✍ AI 특약 초안 (보조 도구)` | `✍ 표준 특약 초안 (보조 도구)` |
| `:2710` | `… → AI 특약 초안` | `… → 조건 반영 표준 특약 초안` |
| `:8073` | `AI 특약 초안 생성 중...` | `표준 특약 초안 생성 중...` |
| `:11541` | `내집로그 AI 특약 초안 · ${날짜}` | `내집로그 표준 특약 초안 · ${날짜}` |
각 줄 옆(또는 위)에 `COPY-FACT-2026-09-26 (Plan 115): 무료 경로는 규칙 엔진 템플릿(clause.js 는 pro/admin 외 403) — 없는 능력을 주장하지 않는다.` 주석을 **한 곳(2706 근처)** 에만 단다(4곳 전부 달면 소음). **`:3136-3138` 은 손대지 마라.**

## Step 3 — 문구 ②: 하드코딩 날짜 제거
`index.html:2987`: `단지 선택 시 2025.05 이후 실거래 표·가격 위치·월별 거래량 (국토부 신고 기준)` → `단지 선택 시 실거래 표·가격 위치·월별 거래량 (국토부 신고 기준 · 장기 추세는 2020.09 이후)`.
- "2020.09" 는 이력 테이블 동결 하한(`molit_transactions_hist` min = 2020-09-01, Plan 100 동결)으로 **바뀌지 않는 값**이라 하드코딩해도 된다. 다만 바로 위 주석 `DATA-RANGE-2026-09-16` 을 `DATA-RANGE-2026-09-26 (Plan 115): 원본 하한은 창(107c)에 따라 굴러가므로 적지 않는다 · 이력 하한 2020-09 는 동결값(Plan 100)` 로 바꿔라.

## Step 4 — 문구 ④: 지역 페이지 규제 상태
`backend/routes/region.js:135`:
```js
        return { status: '고시된 규제지역 목록에 없음', basis: null }; // 단정하지 않음 — "비규제" 라고 쓰지 않는다
```
- `regionPage.js:282` 는 `rg.status === '규제지역'` 일 때만 강조색이므로 다른 값은 자동으로 보통색 — 렌더 수정 불필요.
- `getRegulatedLawdCodes()` 가 기준일을 돌려주면(`backend/services/regulationsService.js` 확인) `basis` 에 `기준 YYYY-MM-DD` 를 넣어라. **없으면 `basis: null` 그대로 두고 지어내지 마라.** 확인 결과를 보고에 적어라.

## Step 5 — 리뷰어 전용 DB (P4-③, 실행자는 실행 금지)
```sql
update public.billing_plans
   set features = (select jsonb_agg(case when f = '맞춤 보고서 월 1회' then '맞춤 보고서 하루 1회' else f end)
                     from jsonb_array_elements_text(features) f)
 where id = 'free' and features::text like '%맞춤 보고서 월 1회%';
-- 검증: select features from public.billing_plans where id='free';  → "맞춤 보고서 하루 1회"
```
⚠ `pro` 행의 "일일 브리핑 아카이브 전체 (정식 출시 준비 중)" 등은 **손대지 않는다** — 플랜 정책은 운영자 영역.

## Step 6 — 테스트 (신규 `backend/test/public-deeplink-copy.test.js`)
`apt-page-links.test.js` 의 방식(라우터를 스텁으로 렌더하거나 소스 정적 단언)을 따르되 **그 파일은 수정하지 마라**. 고정할 것:
1. `aptPage.js` 소스에 `href="${ORIGIN}/?apt=${encodeURIComponent(aptName)}&area=${encodeURIComponent(region)}"` 가 있고 `href="${ORIGIN}/"` 단독 CTA 는 **없다**. 가능하면 기존 렌더 테스트 방식으로 실제 HTML 에서 `?apt=` 와 `area=` 를 단언하라.
2. `index.html` 에 `AI 특약 초안` 문자열이 **0회** — 단, `:3136-3138` 은 "AI 특약 초안" 이 아니라 "AI가 잘못된 …·AI 환각으로…" 이므로 걸리지 않는다. 걸리면 정규식이 아니라 네 변경이 틀린 것이니 멈춰라.
3. `index.html` 에 `2025.05 이후` 가 **0회**.
4. `region.js` 에 `'확인 필요'` 리터럴이 **0회**, `'고시된 규제지역 목록에 없음'` 이 1회.

## 완료 기준
```
npm run verify                                     → tests 464 이상 / fail 0   (기준선 460 + 신규 4)
grep -c "encodeURIComponent(aptName)" backend/routes/aptPage.js   → 1 이상
grep -c "AI 특약 초안" frontend/index.html         → 0
grep -c "2025.05 이후" frontend/index.html         → 0
grep -c "확인 필요" backend/routes/region.js       → 0
```
배포 후 리뷰어: `/apt/43114-58` HTML 의 CTA href 가 `/?apt=%EC%8B%A0%EB%8F%99%EC%95%84%EC%95%84%ED%8C%8C%ED%8A%B8&area=…` 이고, 그 URL 로 브라우저 진입 시 상세 모달 제목이 "신동아아파트" 인지 · `/region/43114` 의 규제 카드가 "고시된 규제지역 목록에 없음" 인지 · 랜딩에 "2025.05" 가 없는지.

## STOP 조건
1. `aptPage.js` 템플릿 스코프에 `region`/`aptName` 이 없거나 이름이 다르면 추측하지 말고 멈춰라.
2. 기존 테스트(특히 `apt-page-links.test.js`·`share-ssr.test.js`)가 깨지면 고치지 말고 보고하라.
3. `:3136-3138` 을 고치고 싶어지면 멈춰라 — 법적 면책 문구는 계획 범위 밖이다.
4. `basis` 에 넣을 기준일이 코드에 없으면 **null 로 두고** 보고하라. 지어내지 마라.
