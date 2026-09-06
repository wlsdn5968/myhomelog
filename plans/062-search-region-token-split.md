# Plan 062: 검색창도 "지역 + 단지명" 을 지역으로 좁혀 찾게 한다 (챗은 057/059 로 됐다)

> **실행자 안내**: 끝까지 읽고 각 단계의 검증 명령을 실제로 돌려라. "STOP 조건" 이면 멈추고 보고하라.
>
> **드리프트 점검(먼저)**: `git diff --stat 18ff341..HEAD -- backend/routes/search.js backend/utils/aptNameMatch.js`

## Status

- **Priority**: P1 · **Effort**: S · **Risk**: MED(성능 민감 경로 + 엣지 캐시) · **Depends on**: **057·059(머지 완료)**
- **Category**: bug · **Planned at**: commit `18ff341`, 2026-09-06
- **출처**: Plan 057 유지보수 메모 — 챗만 고쳤고 검색창은 남겨 뒀다

## 왜 중요한가

운영자 요구는 챗에만 국한된 게 아니었다:

> **"지역+아파트 명이면 대충이라도 검색은 되어야지."**

**챗은 됐다**(라이브 확인: `대치 은마 시세` → `📊 은마 (강남구 대치동) … 거래 23건`).
**검색창은 아직이다.**

Plan 052 가 **공백 제거 변형**을 추가했지만, 그건 `대치 은마` 를 `대치은마` 라는 **한 단어로 붙일 뿐**이다.
DB 실측(2026-09-06): `molit_apt_index`·`apt_master` 어디에도 `대치은마` 라는 이름은 없다.
`은마` 는 `대치동` 에 있고, **지역 토큰을 분리해야** 찾을 수 있다.

### 이미 있는 재료 — 새로 만들지 마라

`backend/utils/aptNameMatch.js` 에 **`splitRegionName` 이 이미 있다**(057 신설, 059 개선):

```js
function splitRegionName(q) {
  const tokens = String(q == null ? '' : q).trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return [];
  const out = [];
  for (let i = 1; i < tokens.length; i++) {
    const region = tokens[i - 1];              // 단일 토큰만 — DB umd_nm/sigungu 와 형태를 맞춘다.
    const name = tokens.slice(i).join(' ');
    if (region.length < 2 || name.length < 2) continue;
    out.push({ region, name });
  }
  out.sort((a, b) => a.name.length - b.name.length);
  return out.slice(0, 3);
}
```

⚠ **실제 파일을 읽어 확인하라** — 위는 계획 시점(`18ff341`)의 코드다.

- `splitRegionName('대치 은마')` → `[{region:'대치', name:'은마'}]`
- `splitRegionName('서울 강남 은마')` → `[{region:'강남', name:'은마'}, {region:'서울', name:'강남 은마'}]`
- `splitRegionName('은마')` → `[]`

**단일 토큰 region 인 이유**: DB 의 `umd_nm`·`sigungu` 는 공백 없는 단일 토큰이다(`대치동`·`강남구`).

### 현재 검색창 코드 — `backend/routes/search.js`

Plan 052 가 만든 구조(요지):
- `qApt` = 끝의 "아파트" 접미사만 제거한 원문
- `_qNo` = `normalizeName(qApt)`(공백 제거), `_needsNoSpace` 일 때만 조회 **추가**
- `Promise.all` 로 최대 5개 조회(molit 1 + apt_master 2 + 공백제거 2)
- 실패는 `_softQuery` 로 soft-fail, 캐시 키는 `searchapt:v2:…`

⚠ **성능 주석을 반드시 읽어라** — `search.js` 는 "새 인덱스 제안 금지"(실측 근거 포함)와
MV 전환 근거가 주석으로 박혀 있다. 그 판단을 뒤집지 마라.

## 필요한 명령

| 목적 | 명령 | 기대 |
|---|---|---|
| 테스트 | `cd backend && npm test` | `fail 0` (기준 **292 pass**) |
| 전체 게이트 | `npm run verify` | exit 0 |
| 문법 | `node --check backend/routes/search.js` | exit 0 |

## 범위

**In scope**: `backend/routes/search.js` · `backend/test/characterization.test.js`(⚠ **파일 끝에만 추가**)

**Out of scope** (최종 `git status --short` 에 있으면 실패):
- `backend/utils/aptNameMatch.js` — **읽기(임포트)만** 하라. 구현을 바꾸지 마라.
- `backend/services/chatDataRouter.js` — 챗은 057/059 로 끝났다.
- 그룹핑·정렬·`_w` 가중치 — **건드리지 마라**(MV 전환 때 정렬이 뒤틀린 이력).
- 인덱스 추가 · DB · 마이그레이션 · `frontend/index.html`

## 단계

### Step 0: 현재 실패를 테스트로 먼저 고정한다

`GET /api/search/apt?q=대치 은마` 상당 시나리오에서 **지금 결과가 비어 있음**을 재현하라.
이 파일의 기존 Supabase 스텁 방식을 따르라(`grep -n "Plan 052" backend/test/characterization.test.js`).
재현되지 않으면 **STOP 하고 실제 반환값을 보고**하라.

### Step 1: 실패 경로에서만 지역 분리 재시도

⚠ **성공 경로의 조회 수를 늘리지 마라.** 챗(057)과 같은 원칙이다:
**기존 조회 결과가 비었을 때만** 추가 조회한다.

- `splitRegionName(qApt)` 후보를 **최대 2개**까지 순차 시도하고, 결과가 있으면 **즉시 중단**한다.
- 후보당 조회: `molit_apt_index` 를 `umd_nm ILIKE '<region>%'` + `apt_name ILIKE '%<name>%'` 로,
  그리고 `apt_master` 도 같은 형태로. `sigungu` 경로도 넣을지는 **네가 판단**하되
  (챗은 `umd_nm`·`sigungu` 둘 다 조회한다) **왕복 수를 보고에 명시**하라.
- ⚠ `region`·`name` 에서 `%`·`_` 를 제거하라. `normalizeName` 은 공백까지 지우므로 **여기엔 쓸 수 없다**.
- 새 조회도 **`_softQuery` 로 감싸라** — 실패가 500 이 되면 안 된다.
- 결과는 **기존 병합·그룹핑 경로에 합류**시켜라. 새 그룹핑 코드를 만들지 마라.

마커: `SEARCH-REGION-SPLIT-2026-09-06`

### Step 2: 캐시 키 버전을 올린다 ⚠

`searchapt:v2:` → `v3:`. 안 올리면 이미 캐시된 **빈 결과**가 서버 캐시 + 엣지
(`s-maxage=600`)만큼 계속 나간다. 이 저장소는 열화 응답이 엣지에 굳은 실사고가 있다.

⚠ 엣지 캐시는 URL 기준이라 서버 키 변경으로 비워지지 않는다 — **배포 후 최대 10분**은
이미 캐시된 URL 에 옛 응답이 나갈 수 있다. 그 사실을 보고에 적어라.

### Step 3: 테스트 (파일 **끝**에만 추가)

**실행 테스트**로:
1. `q='대치 은마'` → `은마` 가 결과에 나온다
2. 성공 경로(`q='은마'`)에서 **추가 조회가 일어나지 않는다**(스텁 호출 카운터로 단언)
   ⚠ 057 은 "이중 `.ilike` 체인" 시그니처로 셌다 — 같은 기법을 쓸 수 있는지 보고 판단하라.
3. 다중 토큰이지만 기존 경로로 이미 찾아지는 질의(예: 공백 든 실제 이름)에서도 **추가 조회 0**
4. 새 조회가 실패해도 응답이 나간다(`_softQuery`)
5. 캐시 키에 `v3` 이 있다

**검증**: `cd backend && npm test` → `fail 0`, `pass` ≥ 297

### Step 4: 회귀 주입

⚠ 주입 전 `git status --short` 가 비어 있어야 한다.

1. 지역 분리 재시도를 제거한다 → **fail** 해야 한다
2. 재시도 게이트를 무조건 실행으로 바꾼다 → **fail** 해야 한다(왕복 계약)
3. 캐시 키 버전을 되돌린다 → **fail** 해야 한다

⚠ 주입이 안 잡히면 **테스트 시나리오의 판별력 부족**일 수 있다(057 에서 실제로 그랬다).
시나리오를 보강해 재확인하고 **무엇을 왜 보강했는지 보고**하라. 코드를 완화하지 마라.

### Step 5: 전체 게이트

```
npm run verify
```

## 완료 기준

- [ ] `q='대치 은마'` 가 `은마` 를 준다(실행 테스트)
- [ ] 성공 경로 조회 수가 **늘지 않았다**(테스트로 고정)
- [ ] 캐시 키가 `v3` 이다
- [ ] 새 조회가 `_softQuery` 로 감싸여 있다
- [ ] `aptNameMatch.js` 가 **변하지 않았다**
- [ ] `cd backend && npm test` `fail 0`, `pass` ≥ 297 · `npm run verify` exit 0
- [ ] Step 4 의 주입 3건에서 각각 fail
- [ ] `git status --short` 에 `chatDataRouter.js`·`frontend/index.html` 이 **없다**

## STOP 조건

- Step 0 에서 `q='대치 은마'` 가 **이미 결과를 준다** → 다른 세션이 먼저 고쳤다. 보고하고 멈춰라.
- 성공 경로 왕복이 는다 → 설계를 다시 보라.
- 인덱스를 추가해야 할 것 같다 → **하지 마라.** `search.js` 주석이 실측 근거로 금지한다.
- `aptNameMatch.js` 를 고쳐야 할 것 같다 → 보고하고 멈춰라(챗이 같은 함수를 쓴다).
- Step 4 의 주입이 (보강 후에도) 잡히지 않는다.

## 유지보수 메모

- **챗과 검색창이 이제 같은 순수 함수(`splitRegionName`)를 쓴다** — 규칙을 바꾸면 **양쪽이 함께** 바뀐다.
  그게 의도다(사본 금지). 바꿀 때 두 경로의 테스트를 모두 확인하라.
- **근본은 데이터다** — `molit_aliases` 가 채워졌으므로(2026-09-06 적용, 10,505행) 정식명 검색은
  대부분 직접 해결된다. 지역 분리는 **이름이 아예 다르거나 사용자가 지역을 덧붙인** 경우의 보완책이다.
- **리뷰에서 볼 것**: 성공 경로 왕복 불변, 캐시 키 버전, `_softQuery` 래핑.
