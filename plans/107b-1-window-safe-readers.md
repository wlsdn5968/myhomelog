# 107b-1 — 창 자르기 전 소비자 정비 (코드 전용 · DB 변경 0)

**작성 기준 커밋**: `ac3848e` (2026-09-26) · 부모: `plans/107b-107c-window-cut-design.md` §1 의 **B3·B4·B6·B7·B2** · **운영자 승인 2026-09-26**(후속표 5번) · DDL 항목(B1·B5·B8)은 **107b-2** 로 분리(이 계획은 SQL 0)

## 전제 확인 (계획자가 코드·프로덕션으로 직접 확인 — 2026-09-26)
- **B3** `molit_apt_dim` 은 09-20 최초 채움 뒤 **한 번도 갱신되지 않았다**(`max(refreshed_at) = 2026-09-20 13:23Z` 실측). 갱신 함수 `refresh_molit_apt_dim()`(RPC, 바뀐 행만 upsert) 은 존재한다. 원본 적재 cron(`molit-ingest`)은 적재 뒤 `refresh_molit_apt_index()` 를 부르고 `mvRefreshMs` 를 요약에 싣는다(`health.crons['molit-ingest'].mvRefreshMs = 12908` 실측).
- **B4** `backend/server.js:getDataCounts()` 의 `tx` 는 `molit_transactions` `count(*)` 만(476,716). 이력 1,290,112건은 포함되지 않는다. 소비처: 랜딩 "실거래 누적"(`index.html:5546`)·브리핑(`briefingService.js:98`, `routes/briefing.js:35` `txTotal`)·OG 이미지(`ogImage.js:161-182`).
- **B6** 이름으로 지번·준공연도를 찾는 함수 3개(원본에 날짜 하한 없음):
  - `services/aptFacilityService.js:123` `molitIdentity(aptName, sigungu, umdNm)` → 최근 60건의 최빈 `build_year`/지번 본번
  - `services/geocodeCacheService.js:391` `molitJibunAddress({ aptName, sigungu, umdNm })` → `"서울 도봉구 방학동 530"` 형태
  - `services/buildingRegisterService.js:66` `resolveJibun(admin, lawdCd, umdNm, aptName)` → `{ jibun, sigungu, umdNm }`
  - (그 외 `geocacheBackfill.js:244`·`search.js:577`·`:1043` 는 배치·검색 보조 — 부록 A 대로 **저하만**이라 이번 범위 밖)
  `molit_apt_dim` 은 apt_seq 당 1행에 `apt_name·lawd_cd·sigungu·umd_nm·build_year·jibun·last_deal_date` 를 갖는다(22,672행, `apt_name` null 0).
- **B7** `routes/aptPage.js:122` `getTransactionsByAptSeq(seq, 24)` 는 원본 24개월만 읽고 라이브 폴백이 없다. 이력 병합은 `services/aptHistoryService.js:40` `getAptHistoryMonthly(seqs)` 가 이미 한다 — 다만 그 함수는 **월별 집계**(`rows:[{ym, sqm, …}]`)를 돌려주고 개별 거래 행은 안 준다. `/apt` 요약(평형별 중앙값·범위·최근 10건)은 개별 행이 필요하다.
- **B2** 화면 "거래 N건" 라벨: `index.html:5750`(`거래 ${p.dealCount??p.dealCount6m}건`). MV `deal_count` 는 원본 전 기간 건수 → 창 자르면 "최근 16개월 건수" 가 된다.

## 범위
**건드릴 파일**: `backend/routes/cron.js`(molit-ingest 핸들러의 MV 갱신 직후 1곳) · `backend/services/cronStats.js`(NUM) · `backend/server.js`(`getDataCounts` 만) · `backend/services/aptDimService.js`(신규) · `services/aptFacilityService.js`·`geocodeCacheService.js`·`buildingRegisterService.js`(각 폴백 3~5줄) · `backend/services/transactionService.js`(B7 신규 함수 1개) · `backend/routes/aptPage.js`(B7 호출 교체 1줄) · `frontend/index.html`(B2 라벨 1곳) · 테스트 신규 `backend/test/window-safe-readers.test.js`
**건드리지 말 것**: MV 정의·`schema.sql`·`molitIngest.js` 의 적재 로직·`retryFailedGaps`(B8 은 107b-2)·`sitemap.js`·`search.js` 랭킹(`_w`)·`cron.js` 의 `/retention`·`/molit-hist-backfill` 핸들러(다른 계획이 만진다)

---

## Step B3 — dim 을 매일 갱신 (`cron.js` molit-ingest 핸들러)
`refresh_molit_apt_index()` 호출·`mvRefreshMs` 계측 **바로 뒤**에:
```js
    // DIM-DAILY-2026-09-26 (Plan 107b-1/B3): molit_apt_dim 은 09-20 최초 채움 뒤 한 번도 안 돌았다(실측).
    //   창을 자르기(107c) 전에 신규 단지가 매일 보존돼야 한다. RPC 는 바뀐 행만 쓰므로 매일 돌려도 싸다.
    try {
      const t0 = Date.now();
      const { data: n, error } = await admin.rpc('refresh_molit_apt_dim');
      if (error) throw error;
      summary.dimRefreshed = Number(n) || 0; summary.dimRefreshMs = Date.now() - t0;
    } catch (e) { logger.warn({ err: e.message }, 'molit_apt_dim 갱신 실패(적재는 계속)'); summary.dimRefreshError = String(e.message).slice(0, 120); }
```
(`summary`·`admin` 변수명은 그 핸들러의 실제 이름을 따르라.) `cronStats.NUM` 에 `'dimRefreshed', 'dimRefreshMs'` 추가. **POST/GET 쌍둥이가 있으면 둘 다.**

## Step B4 — `dataCounts.tx` = 원본 + 이력
`getDataCounts()` 에서 `tx` 를 `txLive + txHist` 로. `txHist` 는 **이력 `count(*)` 를 요청마다 하지 않는다**(129만 행·인덱스 없음): 같은 6h 캐시 안에서 `admin.from('molit_transactions_hist').select('*', { count: 'exact', head: true })` 를 **1회** 부르되(PostgREST count 는 인덱스 없어도 seq scan ≈1~2초 — 6h 에 1번이라 허용), 실패하면 `txHist = 0` 이 아니라 **직전 캐시값 유지**(없으면 `tx` 에 이력을 더하지 않고 `txHistUnknown: true` 를 실어 프론트가 "누적" 대신 "원본" 이라고 쓸 수 있게). 반환 객체: `{ tx, txLive, txHist, lastIngestedAt }`. 소비처 3곳은 `tx` 를 그대로 쓰므로 수정 불필요 — **단 브리핑 `txTotal` 과 OG 이미지가 갑자기 1.76M 대로 뛰는 것이 의도**임을 커밋 본문에 적어라.

## Step B6 — `aptDimService.findByName` 폴백
신규 `backend/services/aptDimService.js`:
```js
/** 이름·동으로 보존 차원 행을 찾는다 — 원본(molit_transactions)에 창 안 거래가 없는 단지의 지번·준공연도 폴백. */
async function findByName({ aptName, umdNm, sigungu, lawdCd }) → { aptSeq, aptName, lawdCd, sigungu, umdNm, buildYear, jibun, lastDealDate } | null
```
- 조회: `molit_apt_dim` 에서 `apt_name = aptName` AND (`umd_nm = umdNm` 있으면) AND (`lawd_cd` 또는 `sigungu` 있으면) → `order('last_deal_date', desc).limit(1)`.
- 메모리 캐시 1h(`cache` 모듈, 키 `dim:name:${lawdCd||sigungu}|${umdNm}|${aptName}`).
- 3곳에 **원본 결과가 비었을 때만** 붙인다(원본 우선 = 현재 동작 불변):
  - `molitIdentity`: `data` 가 비면 `findByName(...)` → `{ buildYear, jibunMain }` 형태로 맞춰 반환.
  - `molitJibunAddress`: 비면 dim 의 `jibun` 으로 같은 형식 문자열 조립(`sigungu umd_nm jibun`; 시도 접두는 기존 코드가 붙이는 방식 그대로).
  - `resolveJibun`: 비면 dim 행으로 `{ jibun, sigungu, umdNm }`; 그래도 없으면 기존 MOLIT 라이브 폴백으로 진행(순서: 원본 → dim → 라이브).

## Step B7 — `/apt` 요약이 이력을 포함
`transactionService.js` 에 `getTransactionsByAptSeqMerged(seq, monthsBack)` 추가: 원본 `getTransactionsByAptSeq(seq, monthsBack)` 결과에 **원본에 없는 달**만 `molit_transactions_hist`(`deal_date, exclu_use_ar, deal_amount, floor`)에서 붙인다. 이력 행은 `aptName·sigungu·umdNm·buildYear·jibun` 이 없으므로 `molit_apt_dim` 행(`loadDimRow` 와 같은 조회)으로 채운다. 반환 형태는 기존과 동일(`analyzeTransactions` 가 그대로 먹게). `aptPage.js:122` 호출을 이 함수로 교체. **오늘은 원본이 16.6개월이라 24개월 중 이력이 붙는 달은 2025-05 이전 = 0개** → 동작 변화 0(배선만). 테스트로 "원본 12개월 + 이력 12개월" 스텁을 넣어 병합·정렬·중복 없음(같은 달은 원본만)을 고정.

## Step B2 — 라벨
`index.html:5750` 의 `거래 ${…}건` → `최근 거래 ${…}건`. (창 자르기 전에는 전 기간과 같아 사용자에겐 변화가 없고, 자른 뒤에도 거짓이 되지 않는 문구.) 주석 `LABEL-WINDOW-2026-09-26 (Plan 107b-1/B2)`.

## 테스트 (신규 `backend/test/window-safe-readers.test.js`, 스텁은 `data-counts-sync.test.js` 패턴)
1. B4: hist count 스텁 1,290,112 + live 476,716 → `tx = 1,766,828`, `txLive`·`txHist` 분리, hist count 실패 시 `txHistUnknown: true` 이고 `tx === txLive`.
2. B6: 원본 조회가 빈 배열일 때 세 함수가 dim 스텁 값을 돌려주고, 원본이 있으면 dim 을 **부르지 않는다**(호출 기록).
3. B7: 원본 6개월 + 이력 6개월 스텁 → 병합 12개월·같은 달 중복 0·이력 행에 dim 의 aptName 이 채워짐.
4. B3·B2 정적 단언: `cron.js` 에 `refresh_molit_apt_dim` 호출이 있고(쌍둥이면 2회), `index.html` 에 `거래 ${` 원문이 0회·`최근 거래 ${` 1회.

## 완료 기준
`npm run verify` → 기준선 + 4 / fail 0. 배포 후 리뷰어: 다음 `molit-ingest` 회차(17:45Z) 에 `crons['molit-ingest'].dimRefreshed` 숫자 · DB `max(refreshed_at)` 갱신 · `/api/health` `dataCounts.tx` ≈ 1.77M 이고 브리핑 "실거래 누적" 일치 · `/apt/43114-58` 요약 건수 자르기 전과 동일(59건).

## STOP 조건
- `getTransactionsByAptSeq` 의 반환 행 필드명이 계획과 다르면(`analyzeTransactions` 가 기대하는 키) 추측하지 말고 소스에서 읽어 맞추고, 못 찾으면 멈춰라.
- 원본 조회를 dim 으로 **대체**하고 싶어지면 멈춰라 — 폴백만 한다.
- DDL·SQL 실행 금지. 기존 테스트 파일 수정 금지.

> **⚠ 계획자 오류 기록(2026-09-26, 실행자가 STOP 으로 잡음 — Plan 106↔110 과 같은 유형)**: B7 의 `aptPage.js` 호출 교체는 `transactionService` 를 **통째로 인라인 스텁**하는 기존 테스트 2개(`apt-page-enrich.test.js:101`·`apt-page-links.test.js:112`)와 `testSupport/_helpers.js` 의 스텁을 깨뜨린다(새 함수 키가 없어 `is not a function` → catch 로 삼켜져 거래 0건). 계획서 "범위" 에 이 파일들을 넣지 않았다. 실행자는 규칙대로 커밋하지 않고 1줄짜리 수정안을 제시했고, 리뷰어가 (a) 를 승인했다. **교훈(재확인)**: 어떤 함수의 호출부를 바꾸는 계획은 `grep -rn "<모듈명>" backend/test backend/testSupport` 로 그 모듈을 스텁하는 테스트를 먼저 찾아 범위에 명시한다 — 스텁은 "당시 인터페이스의 사본" 이라 새 키를 보태는 것이 옳다.
> **B4 설계 변경(실행자 절충, 승인)**: 계획서의 "반환 객체 4키" 를 그대로 하면 Plan 113 의 `data-counts-sync.test.js`(from 3회·3키 고정)가 깨진다 → `getDataCounts({ includeHist })` opt-in, 실호출부(`/api/health`)만 true. 브리핑·OG 는 같은 캐시를 읽으므로 전파된다.
