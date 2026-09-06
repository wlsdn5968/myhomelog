# Plan 054: 열화(stale) 응답이 캐시에 굳는 경로 2종 — 엣지 30시간 · 전월세 8일

> **실행자 안내**: 끝까지 읽고 각 단계의 검증 명령을 실제로 돌려라. "STOP 조건" 이면 멈추고 보고하라.
>
> **드리프트 점검(먼저)**:
> `git diff --stat e737af3..HEAD -- backend/routes/transactions.js backend/services/priceRecordsService.js backend/services/rentService.js`

## Status

- **Priority**: **P1** · **Effort**: S · **Risk**: MED(캐시 헤더·공유 캐시 경로) · **Depends on**: 없음
- **Category**: bug (조용한 데이터 열화) · **Planned at**: commit `e737af3`, 2026-09-06
- **출처**: 2026-09-06 푸시 직전 적대적 감사(79 에이전트) 생존 결함 #3·#4·#5 — 계획자가 코드를 직접 열어 재확인함

## 왜 중요한가

이 저장소에는 **"열화된 응답을 캐시하면 일시적 장애가 캐시 수명만큼 지속된다"** 는 실사고 이력이 있다
(2026-08-29: 콜드 경로가 돌려준 `regions: []` 가 `s-maxage=6h` 로 엣지에 굳어 지역 선택기가 통째로 사라졌다).

**같은 계열이 두 곳에 남아 있다.** 둘 다 이번 세션의 커밋이 만든 것이 아니라 **그 커밋들이 넓힌 것**이다.

---

## 결함 A — 열화 스냅샷이 엣지에 6시간(+24시간 SWR) 굳는다

### A-1. `sliceRegion` 이 `stale` 플래그를 버린다 — `backend/services/priceRecordsService.js:254-272`

```js
function sliceRegion(blob, lawdCd) {
  if (!blob || !blob.regions) return null;
  const r = blob.regions[String(lawdCd)];
  if (!r) return null;
  return {
    scope: 'region',
    lawdCd: String(lawdCd),
    regionName: regionLabel(lawdCd, ''),
    latestDeal: blob.latestDeal || null,
    sinceDate: blob.sinceDate || null,
    windowDays: Number(blob.windowDays) || REGION_DAYS,
    minPrior: Number(blob.minPrior) || DEF_MIN_PRIOR,
    comparedCount: Number(r.comparedCount) || 0,
    highCount: Number(r.highCount) || 0,
    lowCount: Number(r.lowCount) || 0,
    high: (r.high || []).map(shapeRow).filter(Boolean),
    low: (r.low || []).map(shapeRow).filter(Boolean),
  };
}
```

**새 객체를 만들면서 `blob.stale` 을 복사하지 않는다.** 그런데 `blob` 은 열화일 수 있다 —
같은 파일 `:40-42` 가 그 표식을 만든다:

```js
function _withStale(snap) {
  return { ...snap, stale: true };
}
```

그리고 `:205-211`(SELF-HEAL-2026-09-06, **이번 세션 커밋 321245f 가 추가**)이 실패 후 **10분간**
스냅샷을 그대로 돌려준다:

```js
    if (cache.get(CK_REGION_FAIL) !== undefined) {
      const last = await _lastGood(CK_REGION_LAST);
      if (last) return _withStale(last);
    }
```

### A-2. 라우트가 열화 여부와 무관하게 6시간 캐시를 붙인다 — `backend/routes/transactions.js:76-89`

```js
    // 원자료는 daily cron 으로만 바뀐다 — 엣지 6시간, 그 뒤 하루까지는 낡은 값이라도 준다.
    const CC = 'public, max-age=0, s-maxage=21600, stale-while-revalidate=86400';

    const lawdCd = String(req.query.lawdCd || '').trim();
    if (lawdCd) {
      if (!/^\d{5}$/.test(lawdCd)) return res.status(400).json({ error: 'lawdCd 형식 오류' });
      const blob = await svc.getPriceRecordsByRegion();
      if (!blob) return res.status(503).json({ error: '지역별 경신 집계 조회 실패' });
      const slice = svc.sliceRegion(blob, lawdCd);
      // 없는 지역을 0 으로 지어내지 않는다 — 비교 가능한 거래가 아예 없는 지역이 실제로 있다.
      if (!slice) return res.status(404).json({ error: '이 지역은 비교 가능한 최근 거래가 없습니다.' });
      res.set('Cache-Control', CC);
      return res.json(slice);
    }
```

**합쳐진 결과**: RPC 가 한 번 타임아웃하면(이 저장소는 PostgREST authenticator `statement_timeout` **8초**를
실측했다) 그 후 **10분 동안 요청된 모든 시군구**가 최대 14일 묵은 스냅샷을 받고, 그것이
`lawd_cd` 마다 **별도 캐시 키**로 엣지에 6시간 + SWR 24시간 = **최대 30시간** 굳는다.
`sliceRegion` 이 `stale` 을 버렸으므로 프론트도 운영자도 낡은 값임을 **알 수 없다**.

⚠ 이 저장소의 확립된 규칙: **성공 응답에만 긴 `s-maxage`, 열화면 `no-store`.**

---

## 결함 B — 전월세 Redis 의 **빈 배열**이 캐시 히트로 반환된다 (037 이 쓰기 측만 고쳤다)

### 읽기 측 — `backend/services/rentService.js:113-131`

```js
async function getRentTransactions(lawdCd, dealYm) {
  const key = `rent:${lawdCd}:${dealYm}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    if (_isFailMark(hit)) _throwFailMark(hit); // RENT-DEGRADED-2026-09-06: 캐시된 실패도 실패로 던진다
    return hit || [];
  }
  if (_inflight.has(key)) return _inflight.get(key);
  const p = (async () => {
    const shared = await rget(key); // 로컬 미스 → Redis(예열분) → 업스트림
    if (Array.isArray(shared)) { cache.set(key, shared, RENT_MEM_TTL_S); return shared; }
    const rows = await _fetchRentMonth(lawdCd, dealYm);
    // RENT-DEGRADED-2026-09-06: 빈 결과는 공유 캐시에 쓰지 않는다. …
    if (rows.length) rset(key, rows, rentTtlSec(dealYm)).catch(() => { … });
    return rows;
  })().finally(() => _inflight.delete(key));
```

`if (Array.isArray(shared))` 는 **빈 배열 `[]` 도 참이다.** 037 은 **쓰기**를 막았지만
**배포 이전에 이미 Redis 에 굳은 빈 배열**은 읽기 측에서 그대로 히트가 된다.

### 그래서 예열 cron 이 스스로 못 고친다 — `backend/services/rentService.js:87-97`

```js
async function isRentCached(lawdCd, dealYm) {
  const key = `rent:${lawdCd}:${dealYm}`;
  // RENT-DEGRADED-2026-09-06: 빈 배열을 "캐시됨" 으로 보면 예열 cron 이 그 (구,월)을 TTL 내내
  //   건너뛰어 오염이 스스로 복구되지 않는다(rentWarm.js 의 skipped 경로). …
  const local = cache.get(key);
  if (Array.isArray(local) && local.length) return true;
  const shared = await rget(key);
  return Array.isArray(shared) && shared.length > 0;
}
```

`isRentCached` 는 **옳게 고쳐졌다**(빈 배열 = 캐시 아님). 그런데 `backend/jobs/rentWarm.js:46-49`:

```js
        if (await rent.isRentCached(code, ym)) { out.skipped++; continue; }
        await rent.getRentTransactions(code, ym);
        out.fetched++;
```

`isRentCached` = false → `getRentTransactions` 호출 → **Redis 의 `[]` 를 그대로 되받음**
→ 업스트림 재조회가 **일어나지 않는데** `out.fetched++` 로 세어진다.
**cron 로그가 "받았다"고 거짓 보고한다.** 오염은 TTL(최대 8일) 동안 살아남는다.

⚠ 이 저장소의 원칙: *"값이 틀렸다"보다 "값이 왜 그런지 모른다"가 더 나쁘다.*
지금은 **관측 자체가 거짓말한다** — 그게 이 결함의 핵심이다.

## 필요한 명령

| 목적 | 명령 | 기대 |
|---|---|---|
| 테스트 | `cd backend && npm test` | `fail 0` (기준 **249 pass**) |
| 전체 게이트 | `npm run verify` | exit 0 |
| 문법 | `node --check <수정 파일>` | exit 0 |

## 범위

**In scope**:
- `backend/services/priceRecordsService.js` (`sliceRegion` 만)
- `backend/routes/transactions.js` (캐시 헤더 분기만)
- `backend/services/rentService.js` (`getRentTransactions` 의 **읽기 측**만)
- `backend/test/characterization.test.js` — ⚠ **파일 끝에만 추가하라.** 기존 테스트를 옮기거나
  고치지 마라(다른 실행자가 동시에 같은 파일 끝에 추가하고 있다).

**Out of scope** (최종 `git status --short` 에 있으면 실패):
- `backend/jobs/rentWarm.js` — 카운터가 거짓말하는 건 원인이 아니라 **증상**이다. 읽기 측을 고치면
  자동으로 정직해진다. 굳이 고치고 싶으면 **보고에만 적어라.**
- `isRentCached` · `_withStale` · `_lastGood` · `_rpcWithRetry` — **이미 옳다. 건드리지 마라.**
- `getPriceRecords`(전국판)의 백오프·TTL 상수 — 별건.
- `backend/routes/regionPage.js` · `backend/routes/ogImage.js` — 같은 서비스를 쓰지만 이 계획 밖이다.
  다만 **`stale` 을 어떻게 다루는지 읽어서 보고에 적어라**(같은 결함이 있으면 다음 계획의 근거가 된다).
- Redis 키 삭제·운영 개입 — DB/인프라 변경은 하지 마라.
- 프론트(`frontend/index.html`) — stale 배지 UI 는 별건이다.

## 단계

### Step 1: `sliceRegion` 이 `stale` 과 `computedAt` 을 보존한다

`sliceRegion` 반환 객체에 `blob` 의 열화 표식을 **그대로 실어라**.
⚠ 다른 필드처럼 `|| 기본값` 으로 채우지 마라 — **모름은 모름으로 둔다**(없으면 키 자체를 넣지 않거나
`undefined` 로 둬라. `stale: false` 를 지어내면 이 저장소가 반복해 당한 결함이 된다).

`blob` 에 어떤 열화 관련 필드가 있는지 **직접 확인하라**(`_withStale` 은 `stale` 만 붙인다.
`computedAt` 이 실제로 있는지 `getPriceRecordsByRegion` 의 성공 경로를 읽어 확인하고,
**없으면 없다고 보고**하고 `stale` 만 보존하라 — 없는 필드를 만들지 마라).

마커: `STALE-PROPAGATE-2026-09-06`

**검증**: `node --check backend/services/priceRecordsService.js` → exit 0

### Step 2: 라우트가 열화면 캐시하지 않는다

`backend/routes/transactions.js` 의 **두 응답 경로 모두**(지역 슬라이스 경로와 전국 경로) 를 보라.

- 응답이 열화(`stale`)면 → `Cache-Control: no-store` (또는 이 저장소가 이미 쓰는 열화용 헤더가
  있으면 **그것과 같은 값**을 써라 — `grep -rn "no-store" backend/` 로 먼저 확인하라)
- 정상이면 → **기존 `CC` 그대로**

⚠ 전국 경로(`getPriceRecords()`)에도 같은 판정을 적용하라. 그 경로의 `degraded` 변수와
혼동하지 마라 — `degraded` 는 `withRegions` 조회 실패용이고, 스냅샷 열화와는 **다른 개념**이다.
둘 다 캐시를 막아야 하는지 **직접 코드를 읽고 판단해 근거와 함께 보고**하라.

마커: `STALE-NOCACHE-2026-09-06`

**검증**: `node --check backend/routes/transactions.js` → exit 0

### Step 3: 전월세 읽기 측이 빈 배열을 히트로 치지 않는다

`getRentTransactions` 의 `if (Array.isArray(shared))` 를 **비어 있지 않은 배열**일 때만 히트로
바꿔라. 빈 배열이면 업스트림 재조회로 내려가야 한다.

⚠ **로컬 캐시 히트 경로(`const hit = cache.get(key)`)는 건드리지 마라** — 그건 이 프로세스가
방금 조회해 넣은 값이라 성격이 다르고, `_isFailMark` 처리가 얽혀 있다. 바꾸면 인플라이트 병합과
실패 마커 의미가 흔들린다. **공유 캐시(Redis) 읽기만** 고친다.

⚠ 그 결과 "그 달에 실제로 거래가 0건"인 (구,월)은 매번 업스트림을 다시 부른다.
`isRentCached` 의 주석(`:89-92`)이 **이미 그 비용을 감수하기로 판단**했다 — 같은 판단을 따르고,
읽기 측도 같은 이유임을 마커 주석에 적어라.

마커: `RENT-EMPTY-READ-2026-09-06`

**검증**: `node --check backend/services/rentService.js` → exit 0

### Step 4: 테스트 (파일 **끝**에만 추가)

**실행 테스트**를 우선하라:

1. `sliceRegion({...blob, stale:true, regions:{...}}, '11350')` 결과에 `stale === true`
2. `sliceRegion(정상 blob, '11350')` 결과가 `stale: false` 를 **지어내지 않는다**
   (`'stale' in result === false` 또는 `undefined` — 네가 고른 표현을 단언하라)
3. `getRentTransactions` — Redis 스텁이 `[]` 를 주면 **업스트림 조회가 일어난다**
   · 스텁 방법은 이 저장소가 이미 쓰는 방식을 먼저 찾아 따르라
     (`grep -n "rget\|redis" backend/test/characterization.test.js | head`)
   · 실행이 불가능하다고 판단하면 **소스 계약**으로 하되 **왜 실행하지 않았는지 주석에 남겨라**
4. 라우트 — 열화 응답에 `s-maxage` 가 붙지 않는다(소스 계약이라도 좋으나, 가능하면 실행)

⚠ 소스 문자열 검사 전에 **줄 주석을 제거**하라. 이 저장소는 검사가 자기 주석을 잡는 사고를 6회 냈다.
⚠ 마커 원문은 저장소에 **정확히 1회**만 두어라.

**검증**: `cd backend && npm test` → `fail 0`, `pass` ≥ 253

### Step 5: 회귀 주입 (반드시 수행)

⚠ 주입 전 `git status --short` 가 **비어 있어야 한다**(= Step 1~4 를 커밋했는지).

1. `sliceRegion` 에서 `stale` 보존을 뺀다 → **fail** 해야 한다
2. 라우트의 열화 분기를 없애 항상 `CC` 를 붙인다 → **fail** 해야 한다
3. `getRentTransactions` 의 빈 배열 가드를 되돌린다 → **fail** 해야 한다

각각 원복 후 `fail 0` 재확인. 하나라도 안 잡히면 **STOP 조건**.

### Step 6: 전체 게이트

```
npm run verify
```

## 완료 기준

- [ ] `sliceRegion` 이 `stale` 을 보존하고, 정상일 때 `false` 를 **지어내지 않는다**
- [ ] 열화 응답에 `s-maxage`/`stale-while-revalidate` 가 **붙지 않는다**(두 응답 경로 모두 검토했음을 보고)
- [ ] Redis 의 빈 배열이 **히트가 아니다**(업스트림 재조회로 내려간다)
- [ ] 로컬 캐시(`cache.get`) 경로와 `isRentCached` 는 **변하지 않았다**
- [ ] `cd backend && npm test` `fail 0`, `pass` ≥ 253 · `npm run verify` exit 0
- [ ] Step 5 의 주입 3건에서 각각 fail
- [ ] `git status --short` 에 Out of scope 파일이 없다(특히 `rentWarm.js`·`frontend/index.html`)

## STOP 조건

- 드리프트 점검에서 발췌와 실제 코드가 다르다.
- `blob` 에 `stale` 외에 보존할 필드가 있는지 판단이 안 선다 → 실제 객체 형태를 찍어 보고하라.
- 전국 경로의 `degraded` 와 스냅샷 `stale` 중 어느 쪽까지 캐시를 막아야 할지 확신이 없다
  → **더 보수적인 쪽(둘 다 막음)으로 하되 그 판단과 근거를 보고**하라.
- 빈 배열 가드를 넣었더니 기존 테스트가 깨진다 → 그 테스트가 **결함을 정답으로 고정**하고 있는지
  먼저 읽어라. 이 저장소는 그런 사례가 실제로 있었다(Plan 036). 판단을 보고하고 멈춰라.
- Step 5 의 주입이 잡히지 않는다.

## 유지보수 메모

- **같은 계열을 앞으로도 볼 곳**: 긴 `s-maxage` 를 붙이는 모든 라우트. 성공/열화를 구분하지 않으면
  같은 사고가 난다. `grep -rn "s-maxage" backend/routes/` 로 전수 점검할 가치가 있다(이 계획 밖).
- **리뷰에서 볼 것**: ① `stale: false` 를 지어내지 않았는지 ② 로컬 캐시 경로를 안 건드렸는지
  ③ 테스트가 실행인지 소스 계약인지, 소스 계약이면 그 사유가 적혀 있는지.
