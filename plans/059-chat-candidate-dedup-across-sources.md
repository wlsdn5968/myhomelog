# Plan 059: 같은 단지를 두 번 세지 않는다 — `"대치 은마"` 가 `은마(강남구) · 은마(강남구)` 를 준다

> **실행자 안내**: 끝까지 읽고 각 단계의 검증 명령을 실제로 돌려라. "STOP 조건" 이면 멈추고 보고하라.
>
> **드리프트 점검(먼저)**:
> `git diff --stat 197ec1c..HEAD -- backend/services/chatDataRouter.js backend/utils/aptNameMatch.js`

## Status

- **Priority**: **P0** · **Effort**: S · **Risk**: LOW · **Depends on**: **057 (머지 완료 `4b76a28`)**
- **Category**: bug (사용자 노출) · **Planned at**: commit `197ec1c`, 2026-09-06
- **출처**: 057 배포 후 **프로덕션 라이브 실측**에서 계획자가 직접 발견

## 왜 중요한가 — 라이브 실측

배포 `4b76a28` 프로덕션 `POST /api/chat`:

```
질의: "대치 은마 시세"
응답: "대치 은마" 로 여러 단지가 걸려요: 은마(강남구) · 은마(강남구)
      혹시 이 중에 있나요? 아래에서 눌러 고르시거나 지역명을 함께 적어주세요.
```

**같은 단지가 두 번 나열되고, 답을 줄 수 있는데 되묻는다.**
운영자 요구는 *"여러개가 뜨면 선택하라고 하던지"* 였다 — **하나뿐일 땐 그냥 답해야 한다.**

### DB 실측 — 후보는 실제로 **하나**다

| 출처 | 행 |
|---|---|
| `molit_apt_index` | `은마` / 강남구 / 대치동 / 1979 / 51건 — **1행** |
| `apt_master` | `은마` / 강남구 / 대치동 / `A13583507` — **1행** |

두 테이블에 각각 1행씩 있는 **같은 단지**인데, 코드가 이걸 2곳으로 센다.

## 현재 상태 — `backend/services/chatDataRouter.js:245-267`

```js
  if (!ranked.length && !amCandidates.length) {
    const retry = await _regionSplitRetry();
    if (retry) {
      const rRanked = _buildRanked(retry.molitRows, retry.name);
      const rAm = _buildAmCandidates(retry.amRows, retry.name);
      // Step 3(운영자 요구 "여러개가 뜨면 선택하라고 하던지"): 지역으로 좁혔는데도 후보가
      //   2곳 이상이면 051 이 이미 쓰는 되묻기 형식(아래 amCandidates>=2 분기와 동일 문구
      //   틀)을 그대로 재사용한다 — 새 문구 체계를 만들지 않는다.
      if (rRanked.length + rAm.length >= 2) {
        const opts = [
          ...rRanked.map(c => `${c.aptName}${c.sigungu ? `(${c.sigungu})` : ''}`),
          ...rAm.map(a => `${a.apt_name}${a.sigungu ? `(${a.sigungu})` : ''}`),
        ].slice(0, 3);
        const sugNames = [...rRanked.map(c => c.aptName), ...rAm.map(a => a.apt_name)].slice(0, 3);
        return {
          text: `"${q}" 로 여러 단지가 걸려요: ${opts.join(' · ')}\n혹시 이 중에 있나요? 아래에서 눌러 고르시거나 지역명을 함께 적어주세요.`,
          suggestions: sugNames.map(n => `${n} 시세`),
        };
      }
      ranked = rRanked;
      amCandidates = rAm;
    }
  }
```

**`rRanked.length + rAm.length`** 가 결함이다. `rRanked` 는 MOLIT 원본명 기준, `rAm` 은 KAPT
정식명 기준이라 **같은 단지가 양쪽에 하나씩** 있으면 합이 2가 된다.

⚠ **실제 파일을 읽어 현재 형태를 확인하라.** 위는 계획 시점(`197ec1c`)의 코드다.

## 결함 ② — 3토큰 질의는 아직 작동하지 않는다 (057 실행자가 스스로 보고한 불확실성)

`backend/utils/aptNameMatch.js` 의 `splitRegionName` 은 **접두 전체**를 region 으로 만든다:

```js
  for (let i = 1; i < tokens.length; i++) {
    const region = tokens.slice(0, i).join(' ');
    const name = tokens.slice(i).join(' ');
```

`splitRegionName('서울 강남 은마')` → `[{region:'서울 강남', name:'은마'}, {region:'서울', name:'강남 은마'}]`

**DB 의 `umd_nm`·`sigungu` 는 공백 없는 단일 토큰이다**(`대치동`, `강남구`). 따라서
- `region='서울 강남'` → `umd_nm ILIKE '서울 강남%'` → **원리적으로 0건**
- `region='서울'` → `sigungu ILIKE '서울%'` → **0건**(`sigungu` 값은 `강남구` 이지 `서울…` 이 아니다)
- 정답인 `{region:'강남', name:'은마'}` 는 **후보에 아예 없다**

즉 3토큰 질의는 재시도 2라운드를 **둘 다 헛돌고** 실패한다.

## 필요한 명령

| 목적 | 명령 | 기대 |
|---|---|---|
| 테스트 | `cd backend && npm test` | `fail 0` (기준 **288 pass**) |
| 전체 게이트 | `npm run verify` | exit 0 |
| 문법 | `node --check backend/services/chatDataRouter.js` | exit 0 |

## 범위

**In scope**: `backend/services/chatDataRouter.js`(재시도 결과 처리 블록만) ·
`backend/utils/aptNameMatch.js`(`splitRegionName` 만) · `backend/test/characterization.test.js`

**Out of scope** (최종 `git status --short` 에 있으면 실패):
- `_regionSplitRetry` 의 **조회 구성**(어떤 컬럼·어떤 상한) — 왕복 상한을 늘리지 마라.
- `_buildRanked` · `_buildAmCandidates` 의 **내부 로직** — 이미 옳다.
- 051 이 만든 **원 질의 경로의 되묻기 분기**(`amCandidates.length >= 2`) — 별개다. 건드리지 마라.
  (같은 결함이 그 경로에도 있는지 **확인해서 보고**만 하라 — 고치지는 마라.)
- `_regionMarket` · `classifyIntent` · `search.js` · `frontend/index.html` · DB

## 단계

### Step 0: 현재 결함을 테스트로 먼저 재현한다

057 이 만든 스텁 패턴을 그대로 쓰라(`grep -n "Plan 057" backend/test/characterization.test.js`).
`"대치 은마 시세"` 상당 시나리오에서 **지금 되묻기가 나오고 목록에 같은 이름이 두 번** 들어가는 것을
재현하라. 재현되지 않으면 **STOP 하고 실제 반환값을 보고**하라.

### Step 1: 두 출처의 후보를 **하나의 목록으로 합치고 중복을 제거**한다

`rRanked`(MOLIT)와 `rAm`(apt_master)를 각각 세지 말고, **단지 단위 키**로 합쳐라.

- 키: `` `${normalizeName(이름)}|${sigungu || ''}` `` — `normalizeName` 은 이미 임포트돼 있다.
- 같은 키면 **하나**다. MOLIT 쪽을 대표로 삼아라(실거래 건수를 알고 바로 조회할 수 있다).
- 합친 목록의 길이가 **2 이상일 때만** 되묻는다.
- **1이면 되묻지 말고** 기존 경로로 내려가 답을 만들어라(`ranked = rRanked; amCandidates = rAm;`).

⚠ 표시 문자열도 합친 목록에서 만들어라 — 지금처럼 두 배열을 이어붙이면 중복이 그대로 남는다.
⚠ `.slice(0, 3)` 상한은 **유지**하라.

⚠ **키에 `umd_nm` 을 넣지 마라.** `apt_master` 와 `molit_apt_index` 의 동명 표기가 미세하게
다를 수 있다(예: `진관동` vs `진관동 …`). 실제로 다른지 **직접 확인해 보고**하고, 다르면
`sigungu` 까지만 쓰는 지금 설계가 옳다는 근거로 적어라.

마커: `CAND-DEDUP-2026-09-06`

**검증**: `node --check backend/services/chatDataRouter.js` → exit 0

### Step 2: `splitRegionName` 이 **단일 토큰 지역** 후보를 낸다

DB 의 `umd_nm`·`sigungu` 가 단일 토큰이므로, region 도 단일 토큰이어야 매칭된다.

- 분할점 `i` 마다 `{ region: tokens[i-1], name: tokens.slice(i).join(' ') }` 를 만든다.
- 2토큰 질의의 결과는 **지금과 완전히 같다**(`대치 은마` → `{region:'대치', name:'은마'}`).
- 3토큰: `서울 강남 은마` → `{region:'서울', name:'강남 은마'}`, `{region:'강남', name:'은마'}`
  · 정렬(name 짧은 순)에 의해 **`{region:'강남', name:'은마'}` 가 1순위**가 된다 ✅
- 기존 가드(`region`·`name` 2자 이상, 최대 3개)는 **그대로 유지**하라.
- 중복 후보가 생기면 제거하라.

⚠ **057 의 테스트가 깨진다** — `splitRegionName('서울 강남 은마')` 의 기대값을 고정한 테스트가 있다.
그 테스트를 **새 기대값으로 갱신**하고, 주석에 **왜 바뀌었는지(DB 의 umd_nm·sigungu 가 단일 토큰이라
공백 든 region 은 원리적으로 0건)** 를 적어라. 테스트를 지우지 마라.

마커: `REGION-TOKEN-SINGLE-2026-09-06`

**검증**: 아래 값을 실제로 찍어 보고에 적어라 —
`splitRegionName('은마')` · `splitRegionName('대치 은마')` · `splitRegionName('서울 강남 은마')`

### Step 3: 테스트 (파일 **끝**에만 추가)

**실행 테스트**로:

1. 같은 단지가 두 출처에 하나씩 있으면 → **되묻지 않고 실거래를 답한다**(핵심)
2. 진짜로 서로 다른 두 단지면 → **되묻고**, 목록에 **중복이 없다**
3. `splitRegionName` 3케이스(Step 2 값 그대로)
4. 2토큰 질의의 `splitRegionName` 결과가 **변하지 않았다**(하위호환)
5. 057 의 기존 테스트가 그대로 통과한다(`"대치 은마"` 가 여전히 은마를 찾는다)

⚠ 소스 문자열 검사를 쓸 거면 **먼저 줄 주석을 제거**하라(자기 주석 오검출 6회 재발 이력).

**검증**: `cd backend && npm test` → `fail 0`, `pass` ≥ 292

### Step 4: 회귀 주입 (반드시 수행)

⚠ 주입 전 `git status --short` 가 비어 있어야 한다.

1. 중복 제거를 빼고 `rRanked.length + rAm.length >= 2` 로 되돌린다 → **fail** 해야 한다
2. `splitRegionName` 을 접두 전체 region 으로 되돌린다 → **fail** 해야 한다

⚠ 주입이 안 잡히면 **테스트 시나리오의 판별력이 부족한 것**이다(057 에서 실제로 그랬다).
시나리오를 보강해 다시 확인하고, **무엇을 왜 보강했는지 보고**하라. 코드를 완화하지 마라.

### Step 5: 전체 게이트

```
npm run verify
```

## 완료 기준

- [ ] 같은 단지가 두 출처에 있으면 **되묻지 않고 답한다**(실행 테스트)
- [ ] 되묻을 때 목록에 **중복이 없다**
- [ ] `splitRegionName('서울 강남 은마')` 의 1순위가 `{region:'강남', name:'은마'}` 다
- [ ] 2토큰 질의 동작이 **변하지 않았다**
- [ ] 왕복 상한이 **늘지 않았다**
- [ ] `cd backend && npm test` `fail 0`, `pass` ≥ 292 · `npm run verify` exit 0
- [ ] Step 4 의 주입 2건에서 각각 fail
- [ ] `git status --short` 에 Out of scope 파일이 없다

## STOP 조건

- Step 0 에서 중복이 재현되지 않는다 → 다른 세션이 먼저 고쳤다. 보고하고 멈춰라.
- 원 질의 경로(`amCandidates.length >= 2`)도 함께 고쳐야 할 것 같다 → **하지 마라.**
  같은 결함이 있는지 **확인해 보고**만 하라(별도 계획 근거가 된다).
- 왕복을 늘려야 할 것 같다 → 설계를 다시 보라.
- Step 4 의 주입이 (시나리오 보강 후에도) 잡히지 않는다.

## 유지보수 메모

- **이 결함 계열의 근원**: 한 단지를 두 출처(MOLIT 원본명 / KAPT 정식명)로 들고 있는데 **동일성
  판정 키가 없다.** `molit_aliases`(계획 053)가 채워지면 apt_master 행이 자기 MOLIT 이름을 알게 되어
  이런 중복 판정이 구조적으로 사라진다. 이 계획은 그전까지의 보완이다.
- **리뷰에서 볼 것**: ① 합친 목록이 1개일 때 되묻지 않는지 ② 2토큰 동작이 안 바뀌었는지
  ③ 왕복이 안 늘었는지.
