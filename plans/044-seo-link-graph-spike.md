# Plan 044 (설계·스파이크): 고아 페이지 12,000개를 링크 그래프에 넣는다 — 먼저 측정 장치부터

> **실행자 안내**: 이것은 **설계·스파이크 계획**이다. 최종 산출물은 "구현된 기능" 이 아니라
> **① 최소 변경 1건 + ② 4주 측정 계획 + ③ 확장 판단 근거**다. 계획을 끝까지 읽고
> 각 단계의 검증을 실제로 수행하라. "STOP 조건" 에 해당하면 멈추고 보고하라.
> 완료하면 `plans/README.md` 의 이 계획 행 Status 를 갱신하라.
>
> **드리프트 점검(가장 먼저)**:
> `git diff --stat e7dc1c6..HEAD -- backend/routes/aptPage.js backend/routes/regionPage.js backend/routes/sitemap.js`
> 비어 있지 않으면 아래 "현재 상태" 수치를 다시 실측하라.

## Status

- **Priority**: P3
- **Effort**: M (거친 추정 — 방향성 항목이라 정밀도가 낮다)
- **Risk**: MED
- **Depends on**: **plans/043** 먼저 들어가는 것이 바람직하다(측정 장치)
- **Category**: direction
- **Planned at**: commit `e7dc1c6`, 2026-09-06

## 왜 중요한가

이 저장소는 색인이 왜 안 되는지를 **이미 진단해서 코드 주석에 적어 뒀다** —
`backend/routes/regionPage.js:94-97`:

> 단지 페이지 15,954개가 **사이트맵에만** 있고 어떤 페이지도 `/apt/*` 로 링크하지 않았다
> (전수 grep: 앱 0 · SSR 0). **내부 링크가 없는 URL 은 크롤 우선순위가 낮다 — 구글 색인이
> 1페이지에 머문 구조적 이유다.**

그 처방을 적용했는데 — **지역당 30개까지만**이다(`regionPage.js:286`, `topAptsOfRegion(lawdCd, 30)`).

계산: `LAWD_CODES` distinct **125개** × 30 = **3,750**.
sitemap 은 **16,093 URL**을 제출한다(단지 15,954 + 지역 118 + 허브·정적).
즉 **약 12,200개(76%)가 여전히 내부 링크 0인 고아 페이지**다.

게다가 `/apt` 페이지의 아웃링크는 지역으로 **올라가는 것뿐**이다 —
`backend/routes/aptPage.js:209-212` 를 보면 `/region/{lawdCd}` 와 `/region`, 그리고 앱 CTA.
**형제 단지로 가는 링크가 0개**라 링크 그래프가 지역 페이지에서 끝난다.

새 데이터도, 새 비용도, 새 페이지도 필요 없다. `/apt` 페이지는 이미 `lawdCd` 를 알고 있고
`topAptsOfRegion()` 은 이미 존재한다.

**다만 결과는 구글 쪽 변수다.** 그래서 이 계획은 "구현" 이 아니라 **측정 가능한 스파이크**로
스코프를 잡는다: 최소 변경 하나를 넣고, 4주 관찰한 뒤, 확장 여부를 데이터로 판단한다.

## 현재 상태 (실측 근거 — 다시 확인할 것)

| 사실 | 값 | 근거 |
|---|---|---|
| sitemap 총 URL | 16,093 | 이전 감사 실측 |
| 단지 URL 문턱 | 거래 3건 이상 + 최근 1년 = 15,954 | `backend/routes/sitemap.js:82-84` |
| 지역 페이지 수 | 118 + 허브 1 | `backend/routes/sitemap.js:43` |
| `LAWD_CODES` distinct | 125 | `sitemap.js:48` 이 파생하는 집합 |
| 지역 페이지당 단지 링크 | **30** | `backend/routes/regionPage.js:286` |
| `/apt` 의 형제 단지 링크 | **0** | `backend/routes/aptPage.js:209-212` |
| 구글 색인 (before) | 발견 5 · 색인 **1** · 마지막 읽은 날 2026-05-28 | Search Console 실측 |

### 관련 코드

`backend/routes/regionPage.js:98` — 이미 있는 함수:

```js
async function topAptsOfRegion(lawdCd, limit = 30) {
```

⚠ 이 함수는 **export 되지 않았다** — `regionPage.js:322-324` 는 `router`·`loadRegionData`·
`regionFacts` 만 내보낸다.

`backend/routes/aptPage.js:209-212` — 현재 아웃링크 전부:

```js
    <div class="card"><h2>이 지역 더 보기</h2>
      <div class="links">${lawdCd ? `<a href="/region/${esc(lawdCd)}">${esc(region)} 지역 데이터</a>` : ''}<a href="/region">전국 시군구 전체</a></div>
    </div>
    <a class="cta" href="${ORIGIN}/">${esc(aptName)} 대출 한도·비용 계산 →</a>`;
```

### ⚠ 반대 방향 위험 (이 저장소가 이미 인지하고 있다)

- **얇은 페이지를 대량으로 링크하면 역효과다.** `sitemap.js:83-84`:
  "1~2건짜리는 통계가 아니라 잡음이고, 얇은 페이지를 대량 색인시키면 사이트 전체 평가에 해롭다."
- `/apt` 페이지에는 `thin` 판정에 따른 `noindex` 로직이 있다(`aptPage.js:224` 부근).
  **링크 대상이 `noindex` 페이지면 링크의 의미가 없고 오히려 크롤 예산만 쓴다.**
- 상호 링크가 폭주하면 페이지당 아웃링크 수가 과해져 각 링크의 가치가 희석된다.

### 이 저장소의 관례·제약

- 주석 한글, 마커 `<주제>-<YYYY-MM-DD>`. 이 변경의 마커: `SEO-SIBLING-LINKS-2026-09-06`.
- ⚠ **UTM 을 붙이면 랜딩이 꺼진다** — `frontend/index.html:3702-3711` 의 랜딩 게이트가
  "UTM 이 아닌 파라미터가 하나라도 있으면 랜딩을 건너뛴다" 로 되어 있다.
  이 계획은 앱 CTA 를 건드리지 않으므로 해당 없지만, **Plan 045 와 함께 볼 것.**
- ⚠ **네이버 서치어드바이저는 브라우저 도구로 접근이 차단된다** — 운영자 직접 작업 사항.
- ⚠ PostgREST 는 1000행에서 조용히 잘린다. `topAptsOfRegion` 의 limit 을 크게 올릴 때
  이 함정을 반드시 확인하라(`sitemap.js:85-87` 이 range 페이징 선례를 적어 뒀다).

## 필요한 명령

| 목적 | 명령 | 성공 시 기대 |
|---|---|---|
| 테스트 | `cd backend && npm test` | `fail 0` |
| 린트 | `npm run lint` | exit 0 |
| 문법 | `node --check backend/routes/aptPage.js backend/routes/regionPage.js` | exit 0 |

## 범위

**In scope**:
- `backend/routes/regionPage.js` — `topAptsOfRegion` **export 추가**(동작 불변)
- `backend/routes/aptPage.js` — 형제 단지 링크 카드 1개 추가
- `backend/test/characterization.test.js` — 계약 테스트
- `plans/README.md` — **측정 계획과 판단 기준 기록(이 계획의 핵심 산출물)**

**Out of scope** (이번엔 하지 마라 — 4주 측정 후 판단):
- **지역 페이지의 30개 상한을 올리는 것**과 `/region/:lawd?page=2` 페이지네이션.
  sitemap 에 페이지 URL 을 추가하는 작업이 딸리고, 얇은 페이지 대량 링크의 역효과 위험이
  가장 큰 부분이다. **먼저 형제 링크만 배포하고 4주 색인 추이를 본다.**
- sitemap 문턱(거래 3건 + 최근 1년) 변경.
- 새 SSR 페이지 추가.
- 네이버 서치어드바이저 재제출 — **운영자 직접 작업**(도구 호스트가 차단됨).
- Search Console 재제출 — 운영자 작업(단, Step 4 에서 안내는 한다).

## Git 작업 방식

- 브랜치: `feature/seo-sibling-links`
- 커밋: `feat(SEO): 단지 페이지에 같은 지역 형제 단지 링크 — 고아 페이지 12,000개가 링크 그래프 밖에 있었다`
- ⚠ push·PR 은 운영자 승인 후에만.

## 단계

### Step 0: 현재 수치를 다시 실측한다 (판단의 before 값)

계획서의 수치는 2026-09-06 기준이다. 다음을 직접 재측정해 기록하라:

1. sitemap URL 총수: 라이브 `/sitemap.xml` 을 받아 `<url>` 개수를 센다.
2. 지역 페이지 수 = `LAWD_CODES` distinct.
3. 내부 링크로 도달 가능한 단지 URL 수 = (지역 수 × 30) — 중복 제외.
4. Search Console 의 현재 색인 수 — **운영자만 볼 수 있다.** 운영자에게 값을 물어 기록하라.

**검증**: 네 수치가 `plans/README.md` 에 before 값으로 기록됐다.

### Step 1: `topAptsOfRegion` 을 export 한다 (동작 불변)

`backend/routes/regionPage.js:322-324` 의 export 목록에 추가한다:

```js
module.exports.topAptsOfRegion = topAptsOfRegion;   // SEO-SIBLING-LINKS-2026-09-06: /apt 형제 링크와 공유
```

⚠ **함수 본문은 건드리지 마라.** 지역 페이지의 현재 동작이 바뀌면 안 된다.

**검증**: `node --check backend/routes/regionPage.js` → exit 0
**검증**: `node -e "const m=require('./backend/routes/regionPage');console.log(typeof m.topAptsOfRegion)"` → `function`

### Step 2: `/apt` 에 형제 단지 링크 카드를 추가한다

`backend/routes/aptPage.js` 의 body(`:204-212`) 에서 "이 지역 더 보기" 카드 **아래**에
같은 `lawdCd` 의 다른 단지 링크를 넣는다.

**필수 제약** (전부 지켜라):
- **자기 자신 제외**(현재 `seq`).
- **링크 개수 상한 12~20개** — 더 넣지 마라(링크 가치 희석 + 페이지 무게).
- **sitemap 과 같은 문턱**을 쓴다(거래 3건 이상 + 최근 1년). `topAptsOfRegion` 이 이미 그
  기준을 쓰는지 **함수 본문을 읽고 확인**하라. 다르면 여기서 추가로 필터링한다.
- **`noindex` 로 판정될 얇은 페이지로는 링크하지 마라** — `aptPage.js` 의 `thin` 판정 조건을
  읽고 같은 조건으로 제외하라.
- 링크 텍스트에 **단지명 + 지역**을 넣어라(앵커 텍스트가 신호다).
- **조회 실패 시 카드 자체를 생략**하라. 값을 지어내지 않는 이 저장소의 원칙이고,
  `aptPage.js:207-208` 이 이미 같은 방식으로 쓴다.
- `esc()` 로 이스케이프하라(같은 파일의 기존 패턴).

⚠ **캐시 헤더를 확인하라.** `/apt/:seq` 응답의 `s-maxage` 가 짧으면 이 추가 조회가
매 미스마다 돈다. 현재 값을 읽고, 필요하면 `topAptsOfRegion` 결과를 프로세스 캐시에
`lawdCd` 키로 담아라(같은 지역 단지들이 같은 목록을 공유한다 — 히트율이 높다).

**검증**: `node --check backend/routes/aptPage.js` → exit 0
**검증**: 라이브(또는 로컬)에서 `/apt/<seq>` 를 열어 형제 링크가 12~20개 나오고
자기 자신이 없는지 확인.

### Step 3: 계약 테스트를 추가한다

`backend/test/characterization.test.js` 에 테스트 1개:
- `/apt` 라우트가 만드는 HTML 에 `/apt/` 로 시작하는 링크가 **1개 이상 20개 이하** 존재한다.
- 자기 자신(`seq`)으로 가는 링크가 **없다**.
- 조회가 실패(스텁이 에러)하면 카드가 **생략**되고 나머지 페이지는 정상 렌더된다.

`aptPage` 의 의존성은 `require.cache` 스텁으로 고정한다(이 파일의 기존 패턴).

**검증**: `cd backend && npm test` → `fail 0`

### Step 4: 측정 계획을 문서에 남긴다 — **이 계획의 핵심 산출물**

`plans/README.md` 에 다음을 적는다:

- **before 값**(Step 0 의 네 수치 + 배포 일자)
- **관측 지표**: Search Console 의 ① 색인된 페이지 수 ② 발견됨-색인되지 않음 수
  ③ 마지막 크롤 일자. 주 1회, 4주.
- **판단 기준**(미리 정해 둘 것 — 사후에 정하면 자기합리화가 된다):
  - 4주 후 색인 수가 **의미 있게 늘었다** → 지역 페이지 상한 30 → 페이지네이션으로 확장(별도 계획).
  - **변화 없음** → 링크 그래프가 원인이 아니었다는 뜻. 확장하지 말고 다른 가설
    (콘텐츠 품질·크롤 예산·사이트 권위)로 옮긴다.
  - **색인이 줄었다** → 얇은 페이지 대량 링크의 역효과. 즉시 되돌린다.
- **⚠ 재제출이 필요하다**: 이 저장소는 "페이지를 늘려도 **재제출 안 하면 전달되지 않는다**" 를
  실측했다(사이트맵 제출 2026-05-04인데 마지막 읽은 날이 2026-05-28 이었다).
  배포 후 **운영자가 Search Console 에서 사이트맵을 재제출**해야 한다 — 이것을 문서에 적고
  운영자에게 알려라. 네이버 서치어드바이저도 마찬가지이며 **도구로는 접근할 수 없다.**

**검증**: 위 네 항목이 `plans/README.md` 에 있다.

### Step 5: 전체 게이트

```
npm run lint
node scripts/check-deps-sync.js
node scripts/check-env-example.js
node scripts/security-regression-check.js
cd backend && npm test
```

## 완료 기준

- [ ] `node -e "console.log(typeof require('./backend/routes/regionPage').topAptsOfRegion)"` → `function`
- [ ] `/apt/<seq>` 응답에 `/apt/` 링크가 1~20개, 자기 자신 제외
- [ ] 조회 실패 시 카드가 생략되고 페이지는 정상 렌더(테스트로 확인)
- [ ] `cd backend && npm test` exit 0, `fail 0`
- [ ] `npm run lint` exit 0
- [ ] `plans/README.md` 에 before 값 · 관측 지표 · **판단 기준 3가지** · 재제출 안내가 기록됨
- [ ] 지역 페이지의 `topAptsOfRegion(lawdCd, 30)` 이 **변경되지 않았다**(범위 밖)
- [ ] `plans/README.md` 의 044 행 Status 갱신

## STOP 조건

- `topAptsOfRegion` 의 문턱이 sitemap 의 문턱(거래 3건 + 최근 1년)과 **다르다** —
  어떻게 다른지 보고하라. 문턱을 맞추는 것은 별도 판단이다.
- 형제 링크를 추가했더니 `/apt/:seq` 응답 시간이 눈에 띄게 느려진다 — 캐시를 넣어도
  개선되지 않으면 보고하라(크롤러가 16,000 페이지를 도는 경로다).
- 지역 페이지 상한을 올리고 싶어진다 — **이번 범위가 아니다.** 4주 측정이 먼저다.
- `topAptsOfRegion` 이 1000행 절단에 걸린다(PostgREST 함정).
- Search Console 접근이 필요한데 운영자가 없다 — Step 4 의 문서 작업까지만 하고 보고하라.

## 유지보수 메모

- **이 스파이크의 목적은 기능이 아니라 판단 근거다.** 4주 뒤 판단 기준에 따라
  ① 확장 ② 중단 ③ 롤백 중 하나를 고른다. 그 결정을 `plans/README.md` 에 적어야
  다음 사람이 같은 실험을 반복하지 않는다.
- **얇은 페이지 위험을 계속 주시하라.** Search Console 의 "발견됨 — 현재 색인되지 않음" 이
  크게 늘면 그것이 신호다.
- **Plan 045 와의 관계**: 044 가 성공해서 유입이 늘수록 045(착지 → 앱 전환에서 맥락을 버리는
  문제)의 손실이 곱해진다. 044 를 배포한다면 045 의 스파이크도 함께 진행하는 것이 합리적이다.
- **Plan 043 과의 관계**: 043 의 계측이 없으면 044 의 효과를 Search Console 밖에서는
  전혀 볼 수 없다. **043 을 먼저 넣어라.**
