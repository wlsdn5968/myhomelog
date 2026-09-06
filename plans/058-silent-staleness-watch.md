# Plan 058: 조용한 낡음을 드러낸다 — 검색 색인 21일 정지가 감시되지 않았다 + 열화 전파 2곳

> **실행자 안내**: 끝까지 읽고 각 단계의 검증 명령을 실제로 돌려라. "STOP 조건" 이면 멈추고 보고하라.
>
> **드리프트 점검(먼저)**:
> `git diff --stat 85efd1c..HEAD -- backend/routes/cron.js backend/routes/regionPage.js backend/routes/ogImage.js`

## Status

- **Priority**: **P1** · **Effort**: S · **Risk**: LOW(관측·캐시 헤더만) · **Depends on**: 없음
- **Category**: bug (관측 부재 + 열화 전파) · **Planned at**: commit `85efd1c`, 2026-09-06
- **⚠ 이 계획은 DB 를 고치지 않는다.** 검색 색인 정지의 **근본 수정은 DB 변경**이고 운영자 승인 대기 중이다.
  여기서는 **같은 일이 다시 21일 동안 조용히 지나가지 않도록** 만드는 것만 한다.

## 왜 중요한가 — 라이브 실측 (2026-09-06)

| | 최신 거래일 | 건수 | 단지 수 |
|---|---|---|---|
| `molit_transactions` (지도·보고서가 읽음) | **2026-09-04** | 460,358 | 22,891 |
| `molit_apt_index` (검색창·챗이 읽음) | **2026-08-14** | 435,613 | 22,473 |

**검색 색인이 21일 뒤처졌고 418개 단지가 검색에 아예 없다.**

원인은 라이브 `GET /api/health` 의 `crons` 에 **이미 기록돼 있었다**:

```
"molit-ingest": { "mvRefreshError": "canceling statement due to statement timeout" }
```

즉 **관측값은 있었는데 아무도 보지 않았다.** 적재 cron 자체는 매일 정상이라(`ok: 126`, `err: 0`)
기존 경보(`summary.err > 0`)에 걸리지 않았다.

`backend/routes/cron.js` 의 현재 코드는 사유를 **health 필드로만** 남긴다:

```js
    let _mvRefreshMs, _mvRefreshError;   // MV-REFRESH-ERROR-2026-09-05 (감사 G-4): 실패 사유를 health 로
    try {
      const sc = require('../db/client').getSupabaseAdmin();
      if (!sc) {
        _mvRefreshError = 'service_role 미설정';
        logger.warn('검색 MV 갱신 skip — service_role 미설정(적재는 정상)');
      } else {
        const _t = Date.now();
        const { error: _mvErr } = await sc.rpc('refresh_molit_apt_index')
          .abortSignal(AbortSignal.timeout(MV_REFRESH_ABORT_MS));
        if (_mvErr) { _mvRefreshError = _mvErr.message; logger.warn({ err: _mvErr.message }, '검색 MV 갱신 실패 — 적재는 정상(다음 cron 재시도)'); }
        else _mvRefreshMs = Date.now() - _t;
      }
    } catch (e) { _mvRefreshError = e.message; logger.warn({ err: e.message }, '검색 MV 갱신 예외 — 적재는 정상'); }
```

⚠ 이 저장소는 **"기록이 비었다 ≠ 실패했다"** 와 **"관측이 거짓말한다"** 로 여러 번 당했다.
여기는 반대로 **기록이 정직했는데 경보가 없어서** 21일이 흘렀다.

## 결함 ② — 열화 전파가 두 곳 더 있다 (Plan 054 가 범위 밖으로 둔 것)

Plan 054 실행자가 **실측으로 확인**해 보고한 것이다. 계획자가 코드로 재확인했다.

**`backend/routes/regionPage.js`** — `loadRegionData()` 가 `sliceRegion(...)` 결과를 `rec` 에 담지만,
캐시 판정은 `cards.length` 만 본다:

```js
  // ⚠ CACHE-POISON-2026-08-29 의 교훈: **열화된 응답에는 긴 캐시를 붙이지 않는다.**
  //   카드가 하나도 없으면 원자료 조회가 통째로 실패한 상태다 — 그걸 하루 굳히면 장애가 하루가 된다.
  res.set('Cache-Control', cards.length
    ? 'public, max-age=0, s-maxage=21600, stale-while-revalidate=86400'
    : 'no-store');
```

`rec.stale === true`(최대 14일 된 스냅샷)라도 **숫자만 있으면 카드가 만들어져** 6시간+SWR 24시간이 붙는다.

**`backend/routes/ogImage.js`** — 같은 `loadRegionData()`·`regionFacts()` 를 재사용하고
`facts.length` 만 본다:

```js
  if (!facts.length) return fallback(res, 'no-facts');   // 통계를 하나도 못 불러온 상태 — 캐시하지 않는다
```

Plan 054 가 `sliceRegion` 이 `stale` 을 **보존하도록 이미 고쳤으므로**(머지 완료 `7b3637a`),
이제 두 라우트가 그 표식을 **읽기만** 하면 된다.

## 필요한 명령

| 목적 | 명령 | 기대 |
|---|---|---|
| 테스트 | `cd backend && npm test` | `fail 0` (기준 **271 pass**) |
| 전체 게이트 | `npm run verify` | exit 0 |
| 문법 | `node --check <수정 파일>` | exit 0 |

## 범위

**In scope**: `backend/routes/cron.js`(MV 경보·지표만) · `backend/routes/regionPage.js`(캐시 판정만) ·
`backend/routes/ogImage.js`(캐시 판정만) · `backend/test/characterization.test.js`(⚠ **파일 끝에만 추가**)

**Out of scope** (최종 `git status --short` 에 있으면 실패):
- **DB·마이그레이션·`ALTER FUNCTION`·`REFRESH MATERIALIZED VIEW`** — 절대 룰 ③. 운영자 승인 대기 중이다.
  **어떤 SQL 도 실행하지 마라.**
- `MV_REFRESH_ABORT_MS` 값 — 서버가 8초에 끊으므로 클라이언트 값을 올려도 소용없다. 건드리지 마라.
- 적재 로직(`molitIngest`)·`summary.err` 경보 — 이미 옳다.
- `priceRecordsService.sliceRegion` — Plan 054 가 이미 고쳤다.
- `regionFacts`·`loadRegionData` 의 **계산 로직** — 캐시 판정만 다룬다.
- `frontend/index.html`

## 단계

### Step 1: MV 갱신 실패를 **경보**로 올린다

`cron.js` 의 기존 `Sentry.captureMessage` 패턴을 **그대로 따르라**(`summary.err > 0` 블록이 본보기다):
고정 문자열 메시지 + 가변값은 `extra` (그룹핑 유지), `try/catch` 로 감싸 텔레메트리 실패가 본 처리를 막지 않게.

- `_mvRefreshError` 가 있으면 → `Sentry.captureMessage(..., { level: 'warning', tags: { route: 'cron.molit-ingest' }, extra: { mvRefreshError } })`
- ⚠ 메시지에 **가변값을 넣지 마라**(이슈가 매일 새로 생긴다). `extra` 로 보내라.

마커: `MV-STALE-WATCH-2026-09-06`

**검증**: `node --check backend/routes/cron.js` → exit 0

### Step 2: **낡음 자체**를 숫자로 기록한다 (실패 사유보다 이게 본질이다)

실패 사유만 보면 "실패했지만 얼마나 낡았는지" 를 모른다. 갱신 시도 **직후**에
MV 와 원본의 최신 거래일을 각각 한 번씩 조회해 `recordCronRun` 에 싣는다:

- `molit_apt_index` 의 `max(recent_deal_date)`
- `molit_transactions` 의 `max(deal_date)`
- 두 값의 차이(일수)

⚠ **조회 방법을 직접 정하되 실제로 동작하는지 확인하라.** PostgREST 로 `max()` 를 얻으려면
`.select('recent_deal_date').order('recent_deal_date', {ascending:false}).limit(1)` 형태가 안전하다
(집계 함수 문법은 버전에 따라 다르다 — **추측하지 말고 로컬에서 형태를 확인**하고, 확인이 불가능하면
그 사실과 네가 고른 형태를 보고하라).

⚠ 조회가 실패해도 **cron 응답은 ok 여야 한다**(기존 규약과 같다). 실패하면 필드를 **생략**하라 —
`0` 이나 `null` 을 "차이 없음"으로 오해하게 만들지 마라(이 저장소가 반복해 당한 결함).

⚠ 차이가 **7일을 넘으면** Step 1 과 같은 방식으로 경보를 올려라. 임계값을 상수로 두고
**왜 7일인지 한 줄 근거**를 적어라(실측: 정상이면 0~1일, 이번 사고는 21일).

**검증**: `node --check backend/routes/cron.js` → exit 0

### Step 3: `regionPage` · `ogImage` 가 `stale` 을 읽게 한다

- `regionPage.js`: 캐시 판정을 `cards.length && !rec.stale` 취지로 바꿔라
  (`rec` 이 없을 수도 있으니 옵셔널 접근을 쓰라).
- `ogImage.js`: 같은 원칙. 이 라우트는 `fallback(res, ...)` 규약이 있으니 **그 규약을 깨지 마라** —
  열화면 이미지를 못 만드는 게 아니라 **캐시만 막으면 된다**. 어느 쪽이 맞는지 코드를 읽고 판단하고,
  판단 근거를 보고에 적어라.

⚠ `loadRegionData()` 의 반환 형태(`{ dash, rec, weekly }`)를 **직접 읽어** `rec.stale` 이 실제로
도달하는지 확인하라. 도달하지 않으면 **STOP 하고 실제 형태를 보고**하라(Plan 054 가 고친 것은
`sliceRegion` 이고, 그 결과가 `rec` 에 담기는지는 이 계획이 확인할 몫이다).

마커: `STALE-NOCACHE-2026-09-06` 을 **재사용하지 마라**(마커 원문은 저장소에 1회만).
새 마커: `STALE-PAGE-2026-09-06`

### Step 4: 테스트 (파일 **끝**에만 추가)

1. `_mvRefreshError` 가 있으면 Sentry 경보가 나간다(스텁으로 호출 여부 단언 — 실행 테스트)
2. 메시지에 가변값이 들어가지 않는다(그룹핑 계약)
3. lag 이 임계값을 넘으면 경보가 나간다 / 안 넘으면 안 나간다
4. lag 조회 실패 시 **필드가 생략**된다(`0` 이 아님)
5. `regionPage`·`ogImage` — `rec.stale` 이면 긴 캐시가 붙지 않는다

⚠ 실행이 불가능한 항목은 소스 계약으로 하되 **왜 그렇게 했는지 주석에 남겨라.**
⚠ 소스 문자열 검사 전에 **줄 주석을 제거**하라(자기 주석 오검출 6회 재발 이력).

**검증**: `cd backend && npm test` → `fail 0`, `pass` ≥ 276

### Step 5: 회귀 주입

⚠ 주입 전 `git status --short` 가 비어 있어야 한다.

1. MV 경보 호출을 제거한다 → **fail** 해야 한다
2. `regionPage` 의 `stale` 조건을 뺀다 → **fail** 해야 한다
3. lag 조회 실패 시 `0` 을 넣게 한다 → **fail** 해야 한다

각각 원복 후 `fail 0` 재확인. 안 잡히면 **STOP 조건**.

### Step 6: 전체 게이트

```
npm run verify
```

## 완료 기준

- [ ] `mvRefreshError` 가 있으면 Sentry 경보가 나간다(고정 메시지 + `extra`)
- [ ] MV lag 이 `health.crons` 에 숫자로 보이고, 임계 초과 시 경보가 나간다
- [ ] lag 을 못 구하면 **필드를 생략**한다(0 을 지어내지 않는다)
- [ ] `regionPage`·`ogImage` 가 열화 스냅샷에 긴 캐시를 붙이지 않는다
- [ ] **DB 를 전혀 건드리지 않았다**(SQL 실행 0)
- [ ] `cd backend && npm test` `fail 0`, `pass` ≥ 276 · `npm run verify` exit 0
- [ ] Step 5 의 주입 3건에서 각각 fail

## STOP 조건

- `rec.stale` 이 `loadRegionData` 반환에 도달하지 않는다 → 실제 형태를 보고하고 멈춰라.
- PostgREST 로 `max()` 를 얻는 형태를 확신할 수 없다 → 네가 고른 형태와 그 근거를 보고하라
  (**추측으로 집계 문법을 쓰지 마라**).
- MV 갱신을 지금 성공시키고 싶어진다 → **하지 마라.** DB 변경은 운영자 승인 대기다.
- cron 이 느려져 `maxDuration` 이 걱정된다 → 현재 실측은 `elapsedMs: 17484`(슬롯 0, 42지역)이다.
  조회 2회 추가는 무시할 수준이지만, 측정해서 보고하라.

## 유지보수 메모

- **이 계획은 증상을 드러낼 뿐 원인을 고치지 않는다.** 원인은 `authenticator` 역할의
  `statement_timeout = 8s` 이고, 고치려면 `ALTER FUNCTION public.refresh_molit_apt_index()
  SET statement_timeout` 이 필요하다 — **운영자 승인 사항**이다.
- **일반화할 것**: 긴 `s-maxage` 를 붙이는 라우트 전수 점검(`grep -rn "s-maxage" backend/routes/`).
  성공/열화를 구분하지 않는 곳이 더 있는지. 이 계획 밖이다.
- **리뷰에서 볼 것**: ① Sentry 메시지가 고정 문자열인지 ② lag 미상일 때 0 을 안 넣는지
  ③ DB 를 안 건드렸는지.
