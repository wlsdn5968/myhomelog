# Plan 211: 좌표 조회 캐시 키 `geo:` 를 자유 입력 키로 다뤄 다른 기능의 캐시가 밀려나지 않게 한다

> **실행자에게**: 이 계획을 순서대로 따른다. 단계마다 확인 명령을 돌려 기대 결과가 나온 뒤에 다음 단계로 간다.
> "멈춤 조건"에 해당하면 스스로 고치려 하지 말고 멈추고 보고한다. 끝나면 `plans/README.md` 의 211 줄 상태를 고친다.
>
> **먼저 할 일(변경 확인)**: `git diff --stat 55c56b4..HEAD -- backend/cache.js backend/routes/geocode.js`
> 바뀐 것이 있으면 아래 "지금 상태"의 발췌와 실제 코드를 견준다. 다르면 멈춤 조건이다.

## 상태

- **우선순위**: P2
- **작업량**: S
- **위험**: LOW
- **선행 계획**: 없음
- **범주**: security
- **기준**: 커밋 `55c56b4`, 2026-11-18

## 왜 필요한가

서버의 메모리 캐시는 키를 2,000개까지만 둔다. 가득 차면 일부를 지운다. 2026-11-14 보안 점검에서, 익명 사용자가 보낸 글자(검색어, 단지 이름)로 만든 키가 계속 들어오면 다른 기능의 값진 항목(월별 거래 목록, 단지 정보)이 밀려나는 문제를 고쳤다. 고친 방법은 "자유 입력으로 만든 키"의 접두어 목록을 두고, 가득 차면 그 키부터 지우는 것이다. 목록 옆 주석에는 "새 자유 입력 키 접두어를 만들면 여기에 더할 것"이라고 적혀 있다.

그런데 좌표 조회 경로(`POST /api/geocode`, `POST /api/geocode/batch`)가 쓰는 `geo:` 접두어가 이 목록에 없다. 이 키는 요청 본문의 단지 이름, 시군구, 동, 면적 글자로 만들고 하루 동안 둔다. 단지 이름에는 길이 제한이 없다. 같은 단지에 면적 글자만 바꿔 보내면 같은 결과가 서로 다른 키로 쌓인다. 이 키들이 캐시를 채우면 목록에 없는 키라서 값진 항목이 먼저 지워진다. 값진 항목이 지워지면 DB 조회와 함수 CPU 가 늘어난다(이 서비스는 Vercel 의 CPU 한도와 Supabase 무료 한도를 아껴야 한다). 이 계획이 끝나면 `geo:` 키도 먼저 지워지는 쪽에 들어가고, 키에 들어가는 글자 길이에 상한이 생긴다.

## 지금 상태

- `backend/cache.js` : 공유 메모리 캐시와 지우는 순서.
- `backend/routes/geocode.js` : 좌표 조회 경로. 단건(`POST /`)과 묶음(`POST /batch`).

`backend/cache.js:12-30`

```js
const cache = new NodeCache({
  stdTTL: parseInt(process.env.CACHE_TTL_SECONDS || '3600'),
  checkperiod: 600,
  maxKeys: parseInt(process.env.CACHE_MAX_KEYS || '2000'),
});

// AUDIT6-1114 (보안 점검 run-6, search.shared-cache.free-text-key-eviction): 가득 차면 가장 오래된 키 10% 를 지웠는데,
//   익명 입력 문자열(검색어, 단지 이름, 직장 이름)로 만든 키가 계속 들어오면 다른 기능의 값진 항목(월별 거래, 길찾기, KAPT)이 밀려났다.
//   이제 자유 입력으로 만든 키부터 지운다(먼저 만들어진 순 — node-cache 의 keys() 는 생성 순서다). 모자랄 때만 나머지에서 먼저 만들어진 순으로 지운다.
//   새 자유 입력 키 접두어를 만들면 여기에 더할 것. kkkw:cnt: 는 좌표 격자 키라 자유 입력이 아니다.
//   geo-db: 는 단지 이름이 들어가는 좌표 조회 키다(DB 에도 있어 다시 읽으면 된다). 일일 계수 키(dl:)는 넣지 않는다(지우면 한도가 풀린다).
const FREE_TEXT_PREFIXES = ['searchapt:', 'txapt:', 'analysis:', 'kkkw:', 'geo-db:'];
const _isFreeTextKey = (k) => typeof k === 'string' && !k.startsWith('kkkw:cnt:') && FREE_TEXT_PREFIXES.some((p) => k.startsWith(p));
function _pickEvictions(keys) {
  const need = Math.max(1, Math.floor(keys.length / 10));
  const free = keys.filter(_isFreeTextKey).slice(0, need);
  if (free.length >= need) return free;
  return free.concat(keys.filter((k) => !_isFreeTextKey(k)).slice(0, need - free.length));
}
```

`backend/routes/geocode.js:276-284` (단건)

```js
  const { aptName, area, sigungu, umdNm } = req.body || {};
  if (!aptName) return res.status(400).json({ error: 'aptName 필수' });
  // STAB-AUDIT-2026-05-06: 캐시 키에 sigungu·umdNm 포함 — 동명 단지 충돌 차단
  const sgg = String(sigungu || '').trim();
  const umd = String(umdNm || '').trim();
  // SEC-1030-GEOCACHE: area 는 DB 캐시 조회에 안 쓰이므로 길이 60 으로 잘라 키 폭주를 막는다
  const ck = `geo:${aptName}|${sgg}|${umd}|${String(area||'').slice(0, 60)}`.trim();
  const hit = cache.get(ck);
  if (hit) return res.json({ ...hit, fromCache: true });
```

`backend/routes/geocode.js:328-333` (묶음, 항목마다)

```js
    const sgg = String(item.sigungu || '').trim();
    const umd = String(item.umdNm || '').trim();
    const id = item.id || `${item.aptName}|${sgg}|${umd}`;
    const ck = `geo:${item.aptName}|${sgg}|${umd}|${String(item.area||'').slice(0, 60)}`.trim();
    const hit = cache.get(ck);
    if (hit) return { id, ...hit };
```

`geo:` 키를 만들거나 읽는 곳은 `backend/routes/geocode.js:282, 331` 두 곳뿐이다(2026-11-18, `grep -rn "geo:" backend/services backend/routes backend/jobs` 에서 `geo-db:` 를 빼면 두 줄). `geo-db:` 는 `geo:` 로 시작하지 않는다(`'geo-db:x'.startsWith('geo:')` 는 거짓이다).

이 키에 저장하는 값은 좌표, 주소, 장소 이름이다(`geocode.js:294-295, 307, 339-340, 348`). 지워져도 다음 요청이 DB 의 좌표 표를 다시 읽으면 된다(`resolveCoordFromCacheOnly`, `geocode.js:290, 336`).

기존 검사: `backend/test/audit6-1114.test.js:160-175` 가 캐시가 가득 찼을 때 자유 입력 키부터 지우는지 본다. 그 검사는 `process.env.CACHE_MAX_KEYS = '20'` 으로 두고 `../cache` 를 다시 읽은 뒤 `c._pickEvictions([...])` 의 결과를 단언한다.

```js
    assert.deepEqual(c._pickEvictions(['geo-db:name:x|a|b', 'kapt:1', 'tx:1', 'dl:attr:1', 'a', 'b', 'c', 'd', 'e', 'f']), ['geo-db:name:x|a|b'], '좌표 조회 키도 자유 입력 키다');
```

저장소 규칙(`CLAUDE.md` 의 금지 사항에 있는 문장): "공개 입력을 저장하거나 캐시 키로 쓸 때는 `isSafeRegionText`, `createKakaoGate`, `FREE_TEXT_PREFIXES` 를 거친다."
- 주석은 한국어, 이름표는 `GEO-KEY-1118`.
- 검사는 `node:test`, `node:assert/strict`.

## 쓸 명령

| 목적 | 명령 | 성공했을 때 |
|---|---|---|
| 검사 하나 | `cd backend` 뒤 `TZ=UTC node --test test/audit6-1114.test.js` (PowerShell 은 `$env:TZ='UTC'; node --test test/audit6-1114.test.js`) | `ℹ fail 0` |
| 전체 검증 | 저장소 루트에서 `npm run verify` | exit 0, 끝에 `ℹ fail 0` |

## 범위

**고쳐도 되는 파일**
- `backend/cache.js` (`FREE_TEXT_PREFIXES` 와 그 위 주석)
- `backend/routes/geocode.js` (282행, 331행의 키 만드는 줄과 그 앞 몇 줄)
- `backend/test/audit6-1114.test.js` (검사 추가)
- `plans/README.md` (211 줄의 상태만)

**고치면 안 되는 것**
- 지우는 순서의 규칙(`_pickEvictions`), 키 상한(`maxKeys`).
- 좌표를 찾는 로직(`kakaoGeocode`, `resolveCoordFromCacheOnly` 호출), 카카오 호출 예산(`createIpBudget`, `GEOCODE_IP_DAILY_KAKAO_CAP`), 묶음 항목 상한(`MAX_BATCH_ITEMS`).
- 카카오 검색에 넘기는 값: `kakaoGeocode(key, aptName, area, sgg, umd, st)` 에는 종전 값을 그대로 넘긴다. 줄이는 것은 캐시 키에 쓰는 글자뿐이다.
- 응답의 모양.
- `.env` 로 시작하는 파일은 읽지도 않는다.

## Git 작업 방식

- 브랜치: `advisor/211-geo-cache-key-free-text`
- 커밋 제목: `fix(cache): 좌표 조회 키 geo: 를 자유 입력 키로 다루고 길이를 묶음 (Sprint 1118-plan211)`. 본문에 `[근본 원인]`, `[Fix 내용]`, `[회귀 위험]`.
- 푸시하지 않는다.

## 단계

### 1단계: 접두어 목록에 `geo:` 를 더한다

`backend/cache.js:23` 을 바꾸고, 그 위 주석 끝에 한 줄을 더한다.

```js
//   GEO-KEY-1118 (plans/211): geo: 는 좌표 조회 경로(routes/geocode.js)가 요청 본문의 단지 이름, 시군구, 동, 면적 글자로 만드는 키다.
//     목록에 빠져 있어 이 키가 캐시를 채우면 다른 기능의 항목이 먼저 지워졌다. 값은 DB 좌표 표에서 다시 읽을 수 있다.
const FREE_TEXT_PREFIXES = ['searchapt:', 'txapt:', 'analysis:', 'kkkw:', 'geo-db:', 'geo:'];
```

**확인**: `cd backend` 뒤 `node -e "const c=require('./cache');console.log(JSON.stringify(c._pickEvictions(['geo:a|b|c|d','kapt:1','tx:1','a','b','c','d','e','f','g'])))"` → `["geo:a|b|c|d"]`.

### 2단계: 키에 들어가는 글자 길이를 묶는다

`backend/routes/geocode.js` 의 단건 경로에서 키를 만드는 줄(282행)을 아래로 바꾼다.

```js
  // GEO-KEY-1118 (plans/211): 키에 쓰는 글자는 길이를 묶는다(단지 이름 100자, 시군구와 동 40자, 면적 60자). 긴 글자로 큰 키를 만들지 못하게 한다.
  //   카카오 검색과 DB 조회에는 종전 값을 그대로 넘긴다.
  const ck = `geo:${String(aptName).slice(0, 100)}|${sgg.slice(0, 40)}|${umd.slice(0, 40)}|${String(area||'').slice(0, 60)}`.trim();
```

묶음 경로(331행)도 같은 방식으로 바꾼다.

```js
    const ck = `geo:${String(item.aptName).slice(0, 100)}|${sgg.slice(0, 40)}|${umd.slice(0, 40)}|${String(item.area||'').slice(0, 60)}`.trim(); // GEO-KEY-1118
```

100자라는 값은 이 저장소가 단지 이름에 이미 쓰는 상한이다(`backend/routes/analysis.js:20` 이 100자를 넘는 이름을 거절한다).

**확인**: `grep -n "geo:\${" backend/routes/geocode.js` → 두 줄 모두 `.slice(0, 100)` 을 포함한다. `node -e "require('./routes/geocode')"` 를 `backend` 폴더에서 → 오류 없음.

### 3단계: 회귀 검사를 더한다

`backend/test/audit6-1114.test.js` 의 "공유 캐시: 가득 차면 자유 입력 키부터 지우고 다른 기능의 키는 남긴다" 검사(160행 부근) 바로 아래에 검사 두 개를 더한다. 캐시를 작은 상한으로 다시 읽고 끝나면 되돌리는 방식은 그 검사를 그대로 본뜬다(`CACHE_MAX_KEYS`, `require.cache`, `finally`).

검사 A: `geo:` 키가 가득 차도 거래 키는 남는다
- `CACHE_MAX_KEYS = '20'` 으로 캐시를 다시 읽는다.
- 거래 키 8개(`tx:11350:2026MM`)를 먼저 넣는다.
- `geo:단지${i}|노원구|상계동|` 모양의 키를 60개 넣는다. 넣는 호출이 `false` 를 돌려주지 않는다.
- 거래 키 8개가 모두 남아 있다. 전체 키 수가 20 이하다.
- `c._pickEvictions(['geo:x|a|b|', 'kapt:1', 'tx:1', 'a', 'b', 'c', 'd', 'e', 'f', 'g'])` 가 `['geo:x|a|b|']` 다.

검사 B: 경로 코드가 키 글자 길이를 묶는다
- `backend/routes/geocode.js` 소스를 읽어 `` `geo:${ `` 로 시작하는 키를 만드는 줄이 정확히 두 개이고, 두 줄 모두 `.slice(0, 100)` 과 `.slice(0, 40)` 을 포함하는지 본다. 줄바꿈은 `/\r?\n/` 으로 나눈다.

**확인**: `cd backend` 뒤 `TZ=UTC node --test test/audit6-1114.test.js` → `ℹ fail 0`, 검사 수가 2개 늘었다.

### 4단계: 전체 검증

저장소 루트에서 `npm run verify`.

**확인**: exit 0, `ℹ fail 0`, 검사 수 1,276개(1,274 + 2).

## 검사 계획

- 새 검사 2개: `backend/test/audit6-1114.test.js` (A, B).
- 본보기: 같은 파일 160-175행.

## 끝났다고 볼 조건

- [ ] `npm run verify` 가 exit 0 이고 `ℹ fail 0`
- [ ] `grep -n "FREE_TEXT_PREFIXES = " backend/cache.js` 의 줄에 `'geo:'` 가 있다
- [ ] `backend/routes/geocode.js` 에서 `kakaoGeocode(` 를 부르는 줄(304행, 346행 부근)이 그대로다
- [ ] `git status --short` 에 범위 밖 파일이 없다
- [ ] `plans/README.md` 의 211 줄 상태를 고쳤다

## 멈춤 조건

- "지금 상태"의 발췌와 실제 코드가 다르다.
- `geo:` 로 시작하는 키를 `geocode.js` 밖에서 만들거나 읽는 코드가 있다(그 키가 지워지면 안 되는 값일 수 있다).
- 기존 검사 가운데 `geo:` 키가 끝까지 남아 있어야 통과하는 것이 있다.
- 키 글자를 줄였더니 같은 이름의 다른 단지가 한 키로 합쳐지는 기존 검사 실패가 난다(그 경우 상한 값을 임의로 올리지 말고 보고한다).

## 뒤에 맡을 사람에게

- 이 변경 뒤에는 캐시가 가득 찰 때 좌표 조회 결과가 먼저 지워진다. 좌표는 DB 표에서 다시 읽으므로 카카오 호출이 늘지는 않는다(DB 에 없는 단지는 카카오를 다시 부르지만, 그 호출은 IP 예산과 전역 계수로 묶여 있다).
- 같은 단지에 면적 글자만 바꿔 키를 늘리는 것 자체는 남아 있다(면적은 `kakaoGeocode` 에 넘어가는 값이라 이 계획에서는 키에서 빼지 않았다). 이 계획은 그 키들이 다른 기능을 밀어내지 못하게 한 것이다. 면적을 키에서 뺄 수 있는지는 `kakaoGeocode` 가 면적을 어떻게 쓰는지 읽고 따로 정한다.
- 새 캐시 키 접두어를 만들 때는 그 키가 익명 입력 글자로 만들어지는지 먼저 보고, 그렇다면 `FREE_TEXT_PREFIXES` 에 더한다. `backend/cache.js` 의 주석과 `CLAUDE.md` 의 금지 사항에 같은 규칙이 있다.
