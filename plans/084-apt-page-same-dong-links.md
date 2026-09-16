# 084 — 공개 단지 페이지에 "같은 동 다른 단지" 내부 링크 카드 (16k 페이지의 상호 링크 밀도 ↑)

**작성 기준 커밋**: `5d6215b` (2026-09-16) · 우선순위 P2 · 작업량 S · 의존: 없음 (086 과 파일 겹침 없음)

## 전제 확인 (계획자가 라이브·코드로 확인한 것)
- 라이브 `/apt/11350-183` 하단 "이 지역 더 보기" 카드는 `/region/11350`·`/region`·지도 딥링크 3개뿐(`backend/routes/aptPage.js:407~410`). 같은 동(umd_nm) 단지 간 링크는 **없다**. 오가닉 유입 2건 — 16,625 페이지가 서로를 가리키지 않아 크롤러가 지역 허브를 거쳐야만 닿는다.
- 같은 동 단지를 만드는 **기존 함수는 없다.** 가장 가까운 패턴은 `backend/routes/regionPage.js:98~116` `topAptsOfRegion(lawdCd, limit)`: `getSupabaseAdmin()` → `molit_apt_index` 에서 `apt_seq, apt_name, umd_nm, build_year, deal_count` 를 `lawd_cd` 로 골라 `deal_count` 내림차순, 실패 시 `[]` + `logger.warn`, `apt_seq` 형식(`^\d{5}-\d+$`) 필터.
- aptPage 의 캐시 정책(`:427~433`): `cacheUnsafe = thin || aptMasterErrored || enrichErrored` → `no-store`, 아니면 `s-maxage=21600`. 조회가 **오류로** 비면 긴 캐시를 붙이지 않는 원칙([[degraded-response-cached-at-edge]]).
- 라우트 안에 `lawdCd`·`umd`·`seq`·`region` 변수가 이미 있다(`:401~410` 의 `body` 조립에서 사용).
- 테스트 하네스: `backend/test/apt-page-enrich.test.js:75~130` 이 `require.cache` 로 `db/client`(`getSupabaseAdmin`)·`transactionService`·`schoolService`·`geocodeCacheService` 를 스텁하고 `routes/aptPage` 를 로드해 핸들러를 직접 호출한다 — 같은 방식으로 새 테스트 파일을 쓴다.

## 범위
- 수정: `backend/routes/aptPage.js`(헬퍼 1개 + 카드 1개 + cacheUnsafe 1항). 신규: `backend/test/apt-page-links.test.js`. 그 외 금지(regionPage·sitemap·briefing 은 다른 계획).

## Step 1 — 헬퍼 (`loadAptMasterMatch` 정의 뒤에 추가)
```js
// APT-PAGE-LINKS-2026-09-16 (Plan 084): 같은 동(umd_nm) 다른 단지 — 공개 페이지끼리의 내부 링크.
//   molit_apt_index 만 읽는다(외부 호출 0). 실패는 { errored:true } 로 알려 긴 캐시를 막는다.
async function sameDongApts(lawdCd, umdNm, excludeSeq, limit = 8) {
  const { getSupabaseAdmin } = require('../db/client');
  const admin = getSupabaseAdmin();
  if (!admin || !lawdCd || !umdNm) return { errored: false, rows: [] };
  try {
    const { data, error } = await admin
      .from('molit_apt_index')
      .select('apt_seq, apt_name, umd_nm, deal_count')
      .eq('lawd_cd', String(lawdCd))
      .eq('umd_nm', String(umdNm))
      .order('deal_count', { ascending: false })
      .limit(limit + 1);
    if (error) throw error;
    const rows = (data || [])
      .filter((r) => r && /^\d{5}-\d+$/.test(String(r.apt_seq || '')) && String(r.apt_seq) !== String(excludeSeq))
      .slice(0, limit);
    return { errored: false, rows };
  } catch (e) {
    logger.warn({ err: e.message, lawdCd, umdNm }, 'APT-PAGE-LINKS-2026-09-16: 같은 동 단지 조회 실패');
    return { errored: true, rows: [] };
  }
}
```
(`logger` 는 이 파일이 이미 쓰는 것을 사용. `getSupabaseAdmin` 을 파일 상단에서 이미 가져오면 그것을 쓴다.)

## Step 2 — 카드 삽입 (`const body = …` 직전)
```js
  // APT-PAGE-LINKS-2026-09-16 (Plan 084)
  const { errored: sameDongErrored, rows: dongRows } = await sameDongApts(lawdCd, umd, seq);
  const sameDongHtml = dongRows.length
    ? `<div class="card"><h2>같은 동 다른 단지 <span class="src">최근 실거래 많은 순 · 매물 광고 아님</span></h2>
      <div class="links">${dongRows.map((r) => `<a href="/apt/${esc(r.apt_seq)}">${esc(r.apt_name || '')}</a>`).join('')}</div>
    </div>`
    : '';
```
`body` 템플릿에서 `${schoolsCardHtml}` 다음, "이 지역 더 보기" 카드 **앞**에 `${sameDongHtml}` 을 넣는다. `cacheUnsafe` 를 `thin || aptMasterErrored || enrichErrored || sameDongErrored` 로.

## Step 3 — 테스트 `backend/test/apt-page-links.test.js` (apt-page-enrich.test.js 의 스텁 하네스를 그대로 재사용·복제)
1. 스텁 admin 이 같은 동 행 10개(자기 seq 1개 + 형식 불량 1개 포함)를 돌려주면 → HTML 에 `같은 동 다른 단지` 카드, `/apt/` 링크 **정확히 8개**, 자기 seq·불량 seq 링크 없음, `Cache-Control` 에 `s-maxage` 포함(거래 있음 fixture 기준).
2. 스텁 admin 의 `molit_apt_index` 조회가 `{ error }` 를 돌려주면 → 카드 없음 + `Cache-Control: no-store`.
3. `umd` 가 비면(인덱스 행에 umd_nm 없음) → 조회 자체를 안 함(스텁 호출 카운트 0) + 카드 없음.
(스텁은 `from('molit_apt_index')` 체인에서 `select/eq/eq/order/limit` 를 받아야 한다 — 기존 하네스의 체인 스텁을 확장.)

## 검증·완료 기준
- `npm run verify` → `fail 0`, 테스트 수 **385**(382 + 3).
- 회귀 주입(수행 후 원복): Step 2 의 `|| sameDongErrored` 를 지우면 테스트 2 가 fail.
- 커밋 1개: `feat(공개페이지): 같은 동 다른 단지 내부 링크 카드 (Plan 084)`.

## STOP 조건
- 라우트 안에 `umd`/`lawdCd`/`seq` 변수명이 위와 다르다 → 실제 이름을 보고하고 그 이름으로 진행(STOP 아님). 하네스가 `molit_apt_index` 체인을 스텁할 수 없는 구조라면 → 멈추고 보고.
