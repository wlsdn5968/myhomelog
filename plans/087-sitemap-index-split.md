# 087 — `/sitemap.xml` 을 유형별 사이트맵 인덱스로 분할 (Search Console 에서 apt/region/briefing 색인률을 따로 본다)

**작성 기준 커밋**: `cc46dc2` (2026-09-16) · 우선순위 P2 · 작업량 S~M · 의존: 없음 (084·086 과 파일 겹침 없음)

## 전제 확인 (계획자가 라이브·코드로 확인한 것)
- 라이브 `/sitemap.xml` = **단일 urlset 16,625 URL**(정적 5 + `/region` 허브·시군구 119 + 브리핑 ≤1000 + 단지 ~15,500), `<sitemapindex>` 미사용. 오가닉 유입 2건 — 어떤 유형이 색인되는지 알 길이 없다(Search Console 은 사이트맵 파일 단위로 커버리지를 보여준다).
- 구현: `backend/routes/sitemap.js`(140줄) 한 라우트 `GET /` 안에 정적·지역·브리핑·단지 4블록이 순서대로 `entries` 에 쌓이고, 블록별 실패는 `degraded=true` + `logger.warn`, 응답은 `degraded ? 'no-store' : 'public, max-age=0, s-maxage=21600, stale-while-revalidate=86400'`(`:137`). 헬퍼 `urlTag`(`:31~38`), `STATIC_URLS`(`:22~28`), `ORIGIN`(`:19`), `kstDayString`(`briefingService`), `getSupabaseAdmin`(`db/client`), `LAWD_CODES`(`transactionService`).
- 마운트: `backend/server.js:328` `app.use('/sitemap.xml', require('./routes/sitemap'));`
- `frontend/robots.txt:35` `Sitemap: https://myhomelog.vercel.app/sitemap.xml` — 그대로 두면 인덱스로 이어진다(재등록 불필요).
- 테스트: `backend/test/cache-degraded.test.js:84~160` — `_sitemapAdminStub`(briefing `limit()`·apt `range()` 페이지 스텁), `_withSitemapStub`(db/client·transactionService·briefingService 스텁 후 `routes/sitemap` 재로드, `_routeHandler(router,'/')`), 테스트 3개: ① 전부 성공 → 6시간 캐시 + `<urlset` + `/region/11680` loc ② briefing 실패 → `no-store` + fail-open(지역 loc 유지) ③ apt 실패 → `no-store`.

## 목표 동작
- `GET /sitemap.xml` → `<sitemapindex>` 에 4개 `<sitemap><loc>https://myhomelog.vercel.app/sitemaps/{static,region,briefing,apt}.xml</loc><lastmod>오늘</lastmod></sitemap>`. **DB 조회 없음** → 항상 `public, max-age=0, s-maxage=21600, stale-while-revalidate=86400`.
- `GET /sitemaps/static.xml`·`region.xml`·`briefing.xml`·`apt.xml` → 각 유형의 `<urlset>`. 기존 블록 로직·필터·상한·로그 문구를 **그대로** 옮기고, 그 유형의 조회가 실패하면 `no-store`(fail-open: 실패한 유형은 빈 urlset, 나머지 유형 파일은 영향 없음).

## 범위
- 수정: `backend/routes/sitemap.js`(빌더 함수로 분리 + 인덱스 라우트), 신규 `backend/routes/sitemaps.js`(유형별 라우트), `backend/server.js`(마운트 1줄), `backend/test/cache-degraded.test.js`(사이트맵 테스트 3개를 새 구조로 이전 + 인덱스 테스트 1개 추가). `frontend/robots.txt` 는 **변경하지 않는다**.

## Step 1 — `sitemap.js` 리팩터
- `STATIC_URLS`·`urlTag`·`ORIGIN` 유지. 블록 4개를 함수로: `buildStaticEntries(today)`, `buildRegionEntries(today)` → `{ entries, degraded }`, `async buildBriefingEntries(admin)` → `{ entries, degraded }`, `async buildAptEntries(admin, today)` → `{ entries, degraded }` (본문·조건·로그 문구는 현행 그대로 이동).
- `wrapUrlset(entries)`(현행 `:131~134` 의 XML 조립)와 `wrapIndex(items)`(`<?xml …?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` + `  <sitemap>\n    <loc>…</loc>\n    <lastmod>…</lastmod>\n  </sitemap>` … + `</sitemapindex>\n`) 추가.
- `router.get('/')` 는 인덱스만 만든다(위 목표 동작). `module.exports = router; module.exports._builders = { buildStaticEntries, buildRegionEntries, buildBriefingEntries, buildAptEntries, wrapUrlset, CACHE_OK: 'public, max-age=0, s-maxage=21600, stale-while-revalidate=86400' };`

## Step 2 — `backend/routes/sitemaps.js` (신규)
```js
'use strict';
const express = require('express');
const { getSupabaseAdmin } = require('../db/client');
const { kstDayString } = require('../services/briefingService');
const { _builders: B } = require('./sitemap');
const router = express.Router();
function send(res, { entries, degraded }) {
  res.set('Cache-Control', degraded ? 'no-store' : B.CACHE_OK);
  res.type('application/xml').send(B.wrapUrlset(entries));
}
router.get('/static.xml', (req, res) => send(res, { entries: B.buildStaticEntries(kstDayString()), degraded: false }));
router.get('/region.xml', (req, res) => send(res, B.buildRegionEntries(kstDayString())));
router.get('/briefing.xml', async (req, res) => send(res, await B.buildBriefingEntries(getSupabaseAdmin())));
router.get('/apt.xml', async (req, res) => send(res, await B.buildAptEntries(getSupabaseAdmin(), kstDayString())));
module.exports = router;
```
(`admin` 이 null 이면 빌더가 `{ entries: [], degraded: false }` 를 돌려주도록 — 현행 `if (admin)` 분기와 동일한 의미. 브리핑·단지 빌더의 `getSupabaseAdmin()` 호출은 라우트에서 넘긴 `admin` 인자를 쓰게 바꾼다.)

## Step 3 — `server.js:328` 뒤에 `app.use('/sitemaps', require('./routes/sitemaps'));`

## Step 4 — 테스트 이전 (`cache-degraded.test.js`)
- `_withSitemapStub` 이 `routes/sitemaps` 도 재로드하고(캐시 삭제·복구 대상에 추가) `fn({ index, typed })` 로 두 라우터의 핸들러를 넘기게 한다(`_routeHandler(indexRouter,'/')`, `_routeHandler(typedRouter,'/briefing.xml')` 등).
- 기존 3개를 새 의미로 바꾼다: ① `index GET /` → 6시간 캐시 + `<sitemapindex` + 4개 `/sitemaps/…xml` loc(스텁이 실패를 주입해도 인덱스는 항상 6시간 캐시 — DB 를 안 읽으므로) ② `typed GET /briefing.xml` briefing 실패 → `no-store`, 그리고 같은 스텁 상태에서 `typed GET /region.xml` 은 6시간 캐시 + `/region/11680` loc(fail-open 의 새 형태: 유형 간 격리) ③ `typed GET /apt.xml` apt 실패 → `no-store`. 추가 ④ `typed GET /apt.xml` 성공(aptPages 에 seq 1개) → 6시간 캐시 + `/apt/<seq>` loc.

## 검증·완료 기준
- `npm run verify` → `fail 0`, 테스트 수 **382 + 1**(4번 추가; 이전분은 개수 유지).
- 회귀 주입(수행 후 원복): `sitemaps.js` 의 `send()` 에서 `degraded ? 'no-store' :` 분기를 지우면 ②·③ fail.
- 정적: `grep -c "sitemapindex" backend/routes/sitemap.js` ≥ 1 · `grep -n "app.use('/sitemaps'" backend/server.js` 1건.
- 리뷰어 라이브 검증(배포 후): `/sitemap.xml` 이 `<sitemapindex>` 4건, `/sitemaps/apt.xml` 이 `<urlset>` 15k+ URL, `/sitemaps/region.xml` 120 URL, robots 의 `Sitemap:` 줄 불변.
- 커밋 1개: `feat(SEO): sitemap 을 유형별 인덱스로 분할 — apt/region/briefing/static (Plan 087)`.

## STOP 조건
- Express 5 에서 `/sitemaps/apt.xml` 같은 경로가 마운트/매칭되지 않는다(테스트 하네스의 `_routeHandler` 가 경로를 못 찾음) → 실제 라우트 스택을 보고하고 멈춘다.
