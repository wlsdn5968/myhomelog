# Plan 051: 챗 단지 검색이 정식 단지명·지역+단지명을 찾게 한다 (지금은 정식명의 76.6%를 못 찾는다)

> **실행자 안내**: 끝까지 읽고 각 단계의 검증 명령을 실제로 돌려라. "STOP 조건" 이면 멈추고 보고하라.
> 이 계획은 **운영자가 직접 재현한 실패**에서 출발한다. 추측으로 범위를 넓히지 마라.
>
> **드리프트 점검(먼저)**:
> `git diff --stat ed8d658..HEAD -- backend/services/chatDataRouter.js backend/routes/search.js`

## Status

- **Priority**: **P0** · **Effort**: M · **Risk**: MED(사용자 대면 문구·응답 경로) · **Depends on**: 없음
- **Category**: bug (사용자 대면 기능 불능) · **Planned at**: commit `ed8d658`, 2026-09-06

## 왜 중요한가 — 운영자 재현 + 프로덕션 DB 실측

운영자가 도우미 채팅에 **"공릉 풍림아이원 시세"** 를 입력했고 다음을 받았다:

> "공릉 풍림아이원" 이름이 들어간 단지를 국토부 실거래 데이터에서 찾지 못했어요.

**그 단지는 우리 DB에 있다.** `apt_master` 에 `공릉풍림아이원`(노원구 공릉동, kapt_code `A13980513`)이 있고,
국토부 거래도 있다 — 다만 MOLIT 원본명이 **`풍림아파트A`(90건) · `풍림아파트B`(21건)** 로 나뉘어 있다.

### 실측 (프로덕션 DB, 2026-09-06 · 읽기 전용 조회)

| 측정 | 값 |
|---|---|
| `apt_master` 단지 수 | **14,661** |
| 그중 챗이 도달 가능(= `molit_apt_index.apt_name ILIKE '%정식명%'` 이 1건 이상) | **3,427 (23.4%)** |
| **챗이 못 찾는 단지** | **11,234 (76.6%)** |
| 서울만: 3,397 중 전국 부분일치조차 0건 → 화면에 "찾지 못했어요" | **2,482 (73.1%)** |
| 못 찾는 것 중 같은 동에 trigram 유사(≥0.3) MOLIT 이름이 실재 | **4,888** |
| `molit_apt_index` 이름 22,473개 중 **공백을 포함한 이름** | **189 (0.8%)** |
| `apt_master.molit_aliases` 가 **비어 있지 않은** 행 | **14,661 중 1** |

시도별 도달률(실측): 인천 13.6% · 충북 13.0% · 경기 19.9% · 부산 23.8% · **서울 25.1%** ·
대전 28.8% · 세종 29.6% · 울산 36.5% · 대구 37.6%.

### 근본 원인 3가지 (전부 코드로 확인됨)

**① 챗은 `apt_master` 를 아예 보지 않는다.**
`backend/services/chatDataRouter.js:130-136` 이 `molit_apt_index`(국토부 원본명) **한 곳만** 조회한다.
정식 단지명(KAPT 등록명)은 `apt_master.apt_name` 에 있고, 챗은 그 테이블을 참조하지 않는다.
그래서 사용자가 **우리 앱의 단지 상세에 표시된 이름 그대로** 물어봐도 못 찾는다.

**② 공백이 든 질의는 구조적으로 실패한다.**
`chatDataRouter.js:110` 의 `_safeQ = q.replace(/[%_]/g, '')` 는 `%`·`_` 만 제거하고 **공백은 그대로 둔다.**
MOLIT 이름의 99.2%에 공백이 없으므로 `%공릉 풍림아이원%`·`%대치 은마%` 는 원리적으로 0건이다.
운영자 지적: *"지역+아파트 명이면 대충이라도 검색은 되어야지."*

**③ 못 찾으면 그냥 포기한다.**
`chatDataRouter.js:162-165` 가 대안 없이 "찾지 못했어요"로 끝낸다.
운영자 지적: *"여러개가 뜨면 선택하라고 하던지. 그냥 모른다고 검색이 안된다고 하면 어떻게 하냐"*

### ⚠ 운영자가 반복해서 요구한 것 (이 계획의 수용 기준)

> **"공릉 풍림아파트 a,b 두개로 나눠서 유지하지말라고 몇번을 말했잖아. 같은 아파트라고."**

A/B 는 **하나의 단지로 합산**해서 보여줘야 한다. 이름만 바꾸는 게 아니라 **거래를 합쳐** 건수·평균을 낸다.

## 현재 상태 — 고칠 코드 전문

### `backend/services/chatDataRouter.js:107-136` (후보 선택)

```js
  const admin = getSupabaseAdmin();
  if (!admin) return '지금 실거래 조회가 잠시 어려워요. 상단 검색창에서 단지명을 검색해 보세요.';
  const since = new Date(); since.setMonth(since.getMonth() - 6);
  const _safeQ = q.replace(/[%_]/g, '');
  …
  const _mvSel = 'apt_name, lawd_cd, sigungu, umd_nm, build_year, deal_count';
  const _mv = () => admin.from('molit_apt_index').select(_mvSel);
  const [exactRes, prefixRes, substrRes] = await Promise.all([
    _mv().eq('apt_name', _safeQ).limit(50),
    _mv().ilike('apt_name', `${_safeQ}%`).order('deal_count', { ascending: false }).limit(200),
    _mv().ilike('apt_name', `%${_safeQ}%`).order('deal_count', { ascending: false }).limit(500),
  ]);
```

### `chatDataRouter.js:162-165` (실패 문구)

```js
  if (!ranked.length) {
    return `"${q}" 이름이 들어간 단지를 국토부 실거래 데이터에서 찾지 못했어요.\n` +
      `· 단지명을 조금 다르게(공백·차수 없이) 적어보시거나\n· 상단 검색창 자동완성으로 정확한 이름을 확인해 보세요.`;
  }
```

### `chatDataRouter.js:168-184` (통계 대상 조회 — **여기서 A/B 가 갈린다**)

```js
  const TX_CAP = 400;
  let picked = null, txs = null;
  for (const c of ranked.slice(0, 3)) {
    let tq = admin.from('molit_transactions')
      .select('apt_name, sigungu, umd_nm, deal_amount, deal_date, exclu_use_ar')
      .eq('apt_name', c.aptName)
      .gte('deal_date', since.toISOString().slice(0, 10));
    tq = c.sigungu ? tq.eq('sigungu', c.sigungu) : tq.is('sigungu', null);
    const { data, error } = await tq.order('deal_date', { ascending: false }).limit(TX_CAP);
    if (error) return '지금 실거래 조회가 잠시 어려워요. 상단 검색창에서 단지명을 검색해 보세요.';
    if (data && data.length) { picked = c; txs = data; break; }
  }
```

`.eq('apt_name', c.aptName)` 이 **이름 하나**로 조회하므로 `풍림아파트A` 를 고르면 B 의 21건은 빠진다.

### 관련 테이블 실제 스키마 (실측)

- `apt_master`: `kapt_code, apt_name, lawd_cd, sigungu, umd_nm, facility, facility_fetched_at, source, created_at, updated_at, molit_aliases(jsonb)`
  · **`jibun`·`apt_seq` 컬럼은 없다.** MOLIT 과의 연결 고리는 이름 + (lawd_cd, umd_nm) 뿐이다.
  · `molit_aliases` 는 14,661행 **전부 NOT NULL** 이지만 비어 있지 않은 건 **1행**(위의 공릉풍림아이원)이다.
- `molit_apt_index` (MV, 22,473행): `apt_name, lawd_cd, sigungu, umd_nm, build_year, deal_count, recent_deal_date, apt_seq`
  · 동(`lawd_cd, umd_nm`)당 이름 수: 평균 **14.1** · p95 **50** · 최대 **185**

### 이 저장소의 관례

- 주석 한글. 마커 `<주제>-<YYYY-MM-DD>`. 이 변경의 마커: **`APT-RESOLVE-2026-09-06`**.
- ⚠ **절대 룰 ①** — 매수·매도 추천 X / 미래 가격 예측 X. 새 문구도 지켜야 한다.
- ⚠ **"모름"을 값으로 만들지 마라.** 확신 없는 매칭을 확신처럼 답하지 마라 — 후보로 제시하라.

## ⚠⚠ 가장 중요한 안전 제약 — 유사도 단독 매칭 금지 (IDENTITY-GATE)

이 저장소는 **이름 유사도만으로 단지를 동일시했다가 전국 956건을 오매칭한 이력**이 있다.
이번 조사에서도 실제 오매칭이 나왔다 — 서울 실측:

| 정식명(apt_master) | 최유사 MOLIT 이름 | trigram |
|---|---|---|
| `강일리버파크11단지` | `강일리버파크1단지` | **0.750** ← **다른 단지다** |
| `벽산블루밍1단지,2단지` | `벽산블루밍1단지` | 0.750 ← 부분만 덮는다 |

따라서 **유사도로 자동 채택하지 마라.** 유사도는 **후보 목록을 만드는 데만** 쓰고,
자동 채택은 아래 셋만 허용한다:

1. **정규화 완전일치** — 공백 제거 후 문자열이 같다
2. **alias 일치** — `apt_master.molit_aliases` 에 그 MOLIT 이름이 명시돼 있다
3. **A/B 형제 규칙**(아래 정의) — 결정적 규칙이고 실측 대상이 12그룹뿐이다

### A/B 형제 규칙 — 전수 실측으로 확정한 좁은 규칙

같은 `(lawd_cd, umd_nm)` 안에서 다음을 **전부** 만족하는 이름 집합만 한 단지로 합친다:

- 각 이름이 `<stem><단일 접미문자>` 형태이고 **stem 이 완전히 동일**하다
  (접미문자 = `[A-Za-z가나다라]` 1글자, stem 길이 ≥ 2)
- 집합 안에 **서로 다른 접미문자가 2개 이상** 존재한다
- 집합의 **`build_year` 가 전부 같다**

전국 실측 결과 후보 12그룹 중 이 규칙을 통과하는 것은 **10~11그룹**이다. 전수 목록:

| 시군구 | 동 | 구성원 | 통과? |
|---|---|---|---|
| 노원구 | 공릉동 | `풍림아파트A`(2001,90건) + `풍림아파트B`(2001,21건) | ✅ ← **운영자 사례** |
| 경기광주시 | 신현동 | `현대모닝사이드1-A`(2002) + `현대모닝사이드1-B`(2002) | ✅ |
| 관악구 | 신림동 | `상목에버빌A`(2004) + `상목에버빌B`(2004) | ✅ |
| 구리시 | 수택동 | `동명A`(1990) + `동명B`(1990) | ✅ |
| 울산 동구 | 방어동 | `오션빌리지9차A`(2011) + `오션빌리지9차B`(2011) | ✅ |
| 울산 동구 | 서호동 | `골든캐슬A`(2011) + `골든캐슬B`(2011) | ✅ |
| 사상구 | 모라동 | `모라A`(1978) + `모라B`(1978) | ✅ |
| 서대문구 | 북아현동 | `우민A`(2001) + `우민B`(2001) | ✅ |
| 수영구 | 광안동 | `광안리치빌A`(2003) + `광안리치빌B`(2003) | ✅ |
| 수원시장안구 | 연무동 | `경성A`(1987) + `경성B`(1987) | ✅ |
| 남양주시 | 진건읍 용정리 | `현대A`(1995) + `현대C`(1996) + `현대D`(1996) | ❌ build_year 불일치 |
| 부평구 | 부평동 | `태강CITY`(2018) + `태강CITY`(2016) | ❌ 접미문자가 같다(이름 동일) |

⚠ 마지막 두 줄이 **규칙의 존재 이유**다. 단순히 "끝 글자를 떼어 같으면 합친다" 로 구현하면
`태강CITY` 두 행(연식 다름)을 합치고, 남양주 `현대A/C/D`(연식 다름)를 합친다. **둘 다 오답이다.**

## 필요한 명령

| 목적 | 명령 | 기대 |
|---|---|---|
| 테스트 | `cd backend && npm test` | `fail 0` (기준 **249 pass**) |
| 게이트 일괄 | `npm run verify` | exit 0 |
| 문법 | `node --check <수정 파일>` | exit 0 |

## 범위

**In scope**:
- `backend/utils/aptNameMatch.js` (**신규** — 순수 함수만, DB 접근 금지)
- `backend/services/chatDataRouter.js` (`_market` 및 그 헬퍼)
- `backend/test/characterization.test.js`

**Out of scope** (최종 `git status --short` 에 있으면 실패):
- `backend/routes/search.js` — 같은 공백 결함이 있지만 **별도 계획(052)** 이다. 성능 주석이 많은 경로라 섞지 마라.
- `frontend/index.html`
- **DB 쓰기 · 마이그레이션 · `molit_aliases` backfill** — 별도 계획(053), 운영자 승인 필요.
  이 계획은 **읽기만** 한다.
- `_regionMarket` / `_resolveRegionRows` 의 **기존 동작** — "공덕 시세" 같은 지역 질의는 지금 정상이다.
  건드리지 마라. (새 경로는 `_regionMarket` 이 `null` 을 돌려준 **뒤**에만 작동한다.)
- `classifyIntent` 의 인텐트 판정 규칙 — 이미 라이브에서 다듬어진 것이다.

## 단계

### Step 0: 현재 동작을 먼저 고정한다 (필수)

⚠ 이걸 먼저 하지 않으면 "회귀가 없다"를 증명할 수 없다.

`backend/test/characterization.test.js` 에 **지금 통과하는** 질의의 응답을 고정하는 테스트를 넣어라.
`route()` 는 DB 를 타므로 Supabase 스텁이 필요하다 — 이 저장소가 이미 쓰는 스텁 방식을 **먼저 찾아
그대로 따르라**(`grep -n "getSupabaseAdmin" backend/test/characterization.test.js`).
스텁이 없다면 순수 함수(`classifyIntent`, 새 `aptNameMatch`)만 실행 테스트하고, `_market` 은
**소스 계약**으로 고정한 뒤 **왜 실행하지 않았는지 주석에 남겨라**.

**산출물**: 최소한 `classifyIntent('공릉 풍림아이원 시세')` 가 `{intent:'market', query:'공릉 풍림아이원'}`
를 주는지 **실제로 찍어** 보고에 적어라. (이게 아니면 이 계획의 전제가 틀린 것이다 → STOP)

### Step 1: `backend/utils/aptNameMatch.js` 신설 — 순수 함수만

DB 를 모르는 순수 모듈로 만든다(테스트가 쉽고, 다른 경로가 재사용할 수 있다).

```js
// APT-RESOLVE-2026-09-06: 단지명 매칭 규칙을 한 곳에.
//   [왜] 챗·검색이 각자 다른 정규화를 쓰다가 "공릉 풍림아이원"이 양쪽 다 0건이 됐다.
//   ⚠ 유사도는 **후보 나열용**이다. 자동 채택 판정에 쓰지 마라(IDENTITY-GATE).
```

내보낼 함수:

- `normalizeName(s)` — `%`·`_` 제거 → **모든 공백 제거** → 소문자화하지 **않는다**(한글이 대부분이고
  기존 `ilike` 가 이미 대소문자 무시). 반환은 문자열.
- `stripAptSuffix(s)` — `chatDataRouter._stripAptSuffix` 와 **같은 규칙**(끝의 `아파트`/`아파트단지` 제거,
  제거 후 2자 미만이면 원본). ⚠ 새로 만들지 말고 **기존 구현을 이리로 옮기고** `chatDataRouter` 가
  이 모듈을 쓰게 하라(사본을 2벌 만들면 이 저장소의 확립된 결함 계열이 된다).
- `siblingKey(name)` — A/B 형제 규칙용. `{ stem, suffix }` 또는 `null`.
  · `name` 이 `[A-Za-z가나다라]` 1글자로 끝나고 stem 길이 ≥ 2 일 때만 값을 준다.
- `groupSiblings(rows)` — `[{apt_name, build_year}]` 를 받아 위 **3조건 전부**를 만족하는 그룹만
  `[{stem, names:[...], buildYear}]` 로 반환. 조건 미달이면 그룹을 만들지 **않는다**.
- `dice(a, b)` — bigram Dice 계수(0~1). 후보 **정렬용**으로만 쓴다.

**검증**: `node --check backend/utils/aptNameMatch.js` → exit 0
**검증**: 아래를 실제로 돌려 값을 보고에 적어라 —
`groupSiblings([{apt_name:'태강CITY',build_year:2018},{apt_name:'태강CITY',build_year:2016}])` → `[]`
`groupSiblings([{apt_name:'현대A',build_year:1995},{apt_name:'현대C',build_year:1996}])` → `[]`
`groupSiblings([{apt_name:'풍림아파트A',build_year:2001},{apt_name:'풍림아파트B',build_year:2001}])` → 그룹 1개

### Step 2: 후보 조회에 **공백 제거 변형**과 **`apt_master`** 를 더한다

`_market` 의 `Promise.all` 블록을 확장한다. 다음을 **한 번의 `Promise.all`** 로 묶어라(왕복 증가 금지):

1. 기존 3개(원문 `_safeQ`) — **그대로 유지**한다. 공백 든 MOLIT 이름 189개가 여기서만 잡힌다.
2. 공백 제거판 `_nq = normalizeName(q)` 로 접두·부분 2개 **추가**
   (`_nq === _safeQ` 면 중복이므로 **추가하지 마라** — 대부분의 질의가 여기 해당한다)
3. `apt_master` 조회 2개: `.ilike('apt_name', '%'+_nq+'%')` 와 (`_nq !== _safeQ` 일 때만)
   `.ilike('apt_name', '%'+_safeQ+'%')` — select 는
   `'apt_name, lawd_cd, sigungu, umd_nm, kapt_code, molit_aliases'`, `.limit(50)`

⚠ **PostgREST 는 컬럼 쪽 공백을 지울 수 없다.** 질의 쪽만 정규화하는 것이고, 그것으로 실측 **+589곳**이
회복된다. 컬럼 정규화가 필요하다는 판단이 들면 그것은 DB 변경이므로 **STOP 하고 보고**하라.

⚠ 기존 등급 판정 `_tier(name)` 은 `_safeQ` 기준이다. 공백 제거판으로 잡힌 행이 등급 1(부분)로
떨어지지 않도록 **정규화 문자열끼리** 비교하도록 고쳐라 — 그러지 않으면 정확일치가 부분일치로
강등돼 순위가 뒤집힌다(이 저장소가 "은마" 사고로 배운 지점이다).

**검증**: `node --check backend/services/chatDataRouter.js` → exit 0

### Step 3: `apt_master` 히트를 MOLIT 이름으로 전개한다

`apt_master` 에서 단지를 찾았는데 그 정식명으로 MOLIT 후보가 안 잡히는 경우(= 이 결함의 76.6%),
그 단지의 `(lawd_cd, umd_nm)` 로 `molit_apt_index` 를 **한 번 더** 조회한다
(`.eq('lawd_cd',…).eq('umd_nm',…).limit(200)` — 동당 최대 실측 185).

전개 규칙, **이 순서로**:

1. `molit_aliases` 가 비어 있지 않으면 → 그 이름들만 채택(**확정**)
2. 정규화 완전일치가 있으면 → 채택(**확정**)
3. 그 외에는 `dice()` 상위 3개를 **후보로만** 담는다(**확정 아님**)

⚠ `apt_master` 히트가 **여러 단지**면 동 조회를 단지마다 하지 마라 — 상위 **2곳까지만** 전개하고,
나머지는 아래 Step 5 의 선택지로 돌려라(왕복 폭증 방지).

**검증**: `node --check …` → exit 0

### Step 4: A/B 를 실제로 **합산**한다

통계 조회(`chatDataRouter.js:168-184`)를 이름 **하나**가 아니라 이름 **집합**으로 바꾼다:

- 확정된 이름 집합(alias 또는 정규화 완전일치 또는 **형제 그룹**)에 대해 `.in('apt_name', names)`
- `sigungu` 필터는 **기존 동작을 유지**하라(`c.sigungu ? .eq(...) : .is(..., null)`)
- 표시 이름: `apt_master` 정식명이 있으면 **정식명**(예: `공릉풍림아이원`), 없으면
  `stem` + `(A·B 합산)` 처럼 합쳤다는 사실을 **밝힌다**
- 합산했으면 응답에 **어떤 원본명을 합쳤는지 한 줄로 밝혀라** — 예:
  `※ 국토부에는 풍림아파트A·풍림아파트B 로 나뉘어 있어 합쳐서 계산했어요.`
  (이 저장소 원칙: 값이 왜 그런지 모르는 게 값이 틀린 것보다 나쁘다)

형제 그룹은 Step 3 의 동 조회 결과에 `groupSiblings()` 를 적용해 얻는다.
**동 조회를 하지 않은 경로(기존 molit 직접 히트)에서도** 형제 병합이 필요하다 —
그 경우 선택된 후보의 `(lawd_cd, umd_nm)` 로 같은 동 조회를 한 번 하고 규칙을 적용하라.

⚠ `TX_CAP = 400` 은 **단지 하나** 기준으로 정해진 값이다. 합산하면 상한에 닿을 수 있다.
상한에 닿으면 기존 코드처럼 **사실대로 밝히는 문구**를 유지하라. 상한 값을 임의로 올리지 마라
(올려야 한다고 판단되면 근거 실측치와 함께 보고하고 STOP).

### Step 5: "못 찾았어요" 를 **선택지**로 바꾼다

`chatDataRouter.js:162-165` 를 다음 원칙으로 교체한다:

- **`apt_master` 에 히트가 있으면** — 절대 "찾지 못했어요"라고 하지 마라.
  단지명·시군구·동을 밝히고, 실거래가 다른 이름으로 등록돼 있을 수 있음을 알린 뒤
  후보를 **최대 3개** 제시한다. `suggestions` 배열에 각 후보의 `"<이름> 시세"` 를 넣어
  사용자가 눌러서 고를 수 있게 하라(`_regionMarket` 의 `ambiguousSidos` 분기가 이미 쓰는 패턴이다 —
  `chatDataRouter.js:429-434` 를 형식의 본보기로 삼아라).
- **확정 후보가 2곳 이상**이면(동명 단지 등) 바로 답하지 말고 같은 방식으로 되묻는다.
- **정말 아무것도 없으면** 기존 문구를 유지하되, 질의에 공백이 있었다면
  공백을 뺀 형태를 함께 제안하라.

⚠ 후보 문구에 **매수·매도 추천이나 가격 예측**이 섞이면 절대 룰 위반이다.
⚠ 확신 없는 후보를 확신처럼 쓰지 마라("~인 것 같아요"가 아니라 "혹시 이 중에 있나요?").

### Step 6: 테스트

`backend/test/characterization.test.js` 끝에 추가한다. **순수 함수는 반드시 실행 테스트**로:

1. `normalizeName('공릉 풍림아이원')` → `'공릉풍림아이원'`
2. `groupSiblings` — Step 1 의 3케이스(통과 1 · 불통과 2)를 그대로 단언
3. `dice('강일리버파크11단지','강일리버파크1단지')` 가 높게 나오더라도 **자동 채택 경로에 쓰이지 않는다**는
   것을 소스 계약으로 고정하라 — `aptNameMatch.dice` 의 호출부가 "후보 정렬" 블록 안에만 있는지
   인덱스 비교로 단언(이 저장소가 2026-09-02 에 채택한 소스 대조 방식)
4. `stripAptSuffix` 가 `chatDataRouter` 에 **사본으로 남아 있지 않다** — 소스에 정의가 1곳뿐임을 단언
5. 실패 응답 문구에 **매수 권유·가격 예측 표현이 없다**

⚠ 이 저장소는 소스 문자열 검사가 **자기 주석을 잡는 사고**를 6회 냈다.
검사 전에 줄 주석을 제거하고, 마커 원문은 저장소에 **정확히 1회**만 두어라.

**검증**: `cd backend && npm test` → `fail 0`, `pass` ≥ 253

### Step 7: 회귀 주입 (반드시 수행)

⚠ 주입 전 `git status --short` 가 **비어 있어야 한다**(= Step 1~6 을 커밋했는지).
이 저장소는 미커밋 상태에서 주입했다가 수정 6곳을 통째로 날린 이력이 있다.

1. `normalizeName` 의 공백 제거를 되돌린다 → `npm test` **fail** 해야 한다
2. `groupSiblings` 의 `build_year` 동일 조건을 뺀다 → **fail** 해야 한다 (태강CITY·현대A/C/D 케이스)
3. `.in('apt_name', names)` 를 `.eq('apt_name', names[0])` 로 되돌린다 → **fail** 해야 한다

각각 원복 후 `fail 0` 재확인. 하나라도 안 잡히면 **STOP 조건**이다.

### Step 8: 전체 게이트

```
npm run verify
```

## 완료 기준

- [ ] `classifyIntent`→`_market` 경로에서 `"공릉 풍림아이원"` 이 **공릉풍림아이원 단지로 해석**된다
      (스텁 테스트 또는 실행 증거로 보여라)
- [ ] 답변의 거래 건수가 **A+B 합산**이다(풍림아파트A 90건 + B 21건이 한 단지로)
- [ ] 합쳤다는 사실이 응답에 **밝혀져** 있다
- [ ] `apt_master` 히트가 있는데 "찾지 못했어요"를 반환하는 경로가 **없다**
- [ ] `stripAptSuffix` 구현이 저장소에 **1곳**뿐이다
- [ ] `cd backend && npm test` `fail 0`, `pass` ≥ 253 · `npm run verify` exit 0
- [ ] Step 7 의 주입 3건에서 각각 fail 확인
- [ ] `git status --short` 에 Out of scope 파일이 **없다**(특히 `search.js`·`frontend/index.html`)

## STOP 조건

- 드리프트 점검에서 발췌와 실제 코드가 다르다.
- `classifyIntent('공릉 풍림아이원 시세')` 가 `market` 인텐트를 주지 않는다 — 그러면 결함이 인텐트
  분류에 있는 것이고 이 계획의 전제가 틀렸다. **실제 반환값을 찍어 보고하라.**
- 테스트에서 Supabase 를 스텁할 방법이 이 저장소에 없다 — 있는 것만 실행 테스트하고
  **무엇을 왜 소스 계약으로 대체했는지 보고**하라(임의로 새 테스트 하네스를 도입하지 마라).
- DB 스키마 변경·`molit_aliases` 쓰기가 필요하다고 판단된다 → **하지 마라.** 계획 053 의 몫이다.
- 유사도 임계값을 자동 채택에 쓰고 싶어진다 → **하지 마라.** 위 IDENTITY-GATE 표를 다시 읽어라.
- Step 7 의 주입이 잡히지 않는다.

## 유지보수 메모

- **이 결함의 근본은 데이터에 있다** — `molit_aliases` 가 14,661행 중 1행만 채워져 있다.
  이 계획은 **조회 시점 해석**으로 증상을 덮는다. 영구 해결은 alias backfill(계획 053)이고,
  그때 이 코드의 "동 조회 + 유사도 후보" 경로는 대부분 alias 히트로 대체돼 왕복이 줄어든다.
- **`CLAUDE.md:122` 가 거짓이다** — "~~apt_master.molit_aliases 자동 backfill~~ (완료)" 로 적혀 있는데
  실제로는 1행뿐이다. 이 줄이 다음 세션에게 "이미 해결됨"이라는 거짓 안심을 준다.
  계획 053 에서 문서도 함께 정정해야 한다. **이 계획에서는 문서를 건드리지 마라**(범위 밖).
- **리뷰에서 볼 것**: ① 유사도가 자동 채택에 새어 들어가지 않았는지 ② A/B 합산이 `build_year`
  동일 조건을 지키는지 ③ `Promise.all` 왕복 수가 늘지 않았는지(기존 3 → 최대 7, 조건부 동 조회 1회).
