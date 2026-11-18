# Plan 205: 전월세 월별 목록을 캐시에서 꺼낼 때 통째로 깊은 복제하지 않게 한다

> **실행자에게**: 이 계획을 순서대로 따른다. 단계마다 확인 명령을 돌려 기대 결과가 나온 뒤에 다음 단계로 간다.
> "멈춤 조건"에 해당하면 스스로 고치려 하지 말고 멈추고 보고한다. 끝나면 `plans/README.md` 의 205 줄 상태를 고친다.
>
> **먼저 할 일(변경 확인)**: `git diff --stat 55c56b4..HEAD -- backend/services/rentService.js backend/cache.js`
> 바뀐 것이 있으면 아래 "지금 상태"의 발췌와 실제 코드를 견준다. 다르면 멈춤 조건이다.

## 상태

- **우선순위**: P1
- **작업량**: S
- **위험**: LOW
- **선행 계획**: 없음. `plans/206` 은 이 계획 다음에 한다(같은 파일을 고친다).
- **범주**: perf
- **기준**: 커밋 `55c56b4`, 2026-11-18

## 왜 필요한가

이 서비스는 Vercel Hobby 의 함수 CPU 한도(30일 합계)에 걸려 2026-11-08 에 실제로 정지된 적이 있다. 그래서 요청마다 쓰는 CPU 를 줄이는 것이 가장 중요한 일이다. 캐시 라이브러리(node-cache)는 값을 넣고 뺄 때마다 깊게 복제한다. 행이 수천 개인 배열에서는 이 비용이 크다. `backend/cache.js` 의 주석에 있는 로컬 실측으로 1,000행을 꺼내는 데 7.2ms, 6,000행은 55.6ms 였고, 복제를 피하는 `setRows/getRows` 로는 1,000행에 0.32ms 였다. 매매 거래 목록은 2026-11-14 에 `setRows/getRows` 로 바꿨는데(13곳) 전월세 목록(`backend/services/rentService.js`)은 그대로 `cache.set/get` 을 쓴다. 단지 상세의 분석(전세가율), 맞춤 보고서, 하루 한 번 도는 전월세 예열 작업이 모두 이 경로로 여섯 달 치 목록을 꺼낸다. 이 계획이 끝나면 전월세 목록도 깊은 복제 없이 읽힌다. 실제로 얼마나 줄어드는지는 이 계획에서 재지 않는다(운영 측정이 필요하다).

## 지금 상태

- `backend/cache.js` : 공유 메모리 캐시. `setRows/getRows` 가 여기 있다.
- `backend/services/rentService.js` : 전월세 월별 조회와 단지별 전세 목록. 캐시 키는 `rent:<지역코드>:<YYYYMM>` 하나뿐이다.

`backend/cache.js:49-68`

```js
// ROWS-NOCLONE-2026-11-14: node-cache 는 기본(useClones)으로 get·set 때마다 값을 깊게 복제한다.
//   거래 목록(행 수천 개)은 꺼낼 때마다 그 비용을 냈다(로컬 실측: 1,000행 get 7.2ms, 6,000행 55.6ms).
//   행이 숫자·문자열뿐인 평평한 객체라면 행마다 얕은 복사({...r})가 깊은 복제와 결과가 같다(1,000행 0.32ms).
//   값을 함수로 감싸 넣으면 라이브러리가 복제하지 않는다(함수는 그대로 돌려준다, 로컬 확인).
//   넣을 때 한 번, 꺼낼 때마다 한 번 얕은 복사를 해 호출자끼리 행 객체를 공유하지 않는다(지금과 같은 격리).
//   ⚠ 원소가 모두 숫자·문자열 필드만 가진 객체 리터럴인 배열에만 쓸 것. 행 안에 객체·배열 값, 원소가 null·원시값, class 인스턴스,
//     배열에 붙인 추가 속성은 얕은 복사로 지켜지지 않는다(2026-11-14 반증 검토 실험). 같은 인스턴스라 del·flushAll·keys 는 그대로 동작하고,
//     getStats().vsize 는 함수 값을 작게 센다(상태 숫자만 영향). mget·take 로 읽으면 함수가 나오니 getRows 로만 읽는다.
const ROWS_BOX = Symbol('rowsBox');
cache.setRows = function setRows(key, rows, ttl) {
  if (!Array.isArray(rows)) return cache.set(key, rows, ttl);
  const stored = rows.map(r => ({ ...r }));
  const box = () => stored.map(r => ({ ...r }));
  box[ROWS_BOX] = true;
  return cache.set(key, box, ttl);
};
cache.getRows = function getRows(key) {
  const v = cache.get(key);
  return (typeof v === 'function' && v[ROWS_BOX]) ? v() : v;
};
```

`rent:` 키를 넣고 빼는 곳은 `backend/services/rentService.js` 안의 여섯 곳이 전부다(2026-11-18, `grep -n "cache\.\(get\|set\)(" backend/services/rentService.js`).

```js
 93:  const local = cache.get(key);                       // isRentCached
114:  const hit = cache.get(key);                         // getRentTransactions
126:    if (Array.isArray(shared) && shared.length) { cache.set(key, shared, RENT_MEM_TTL_S); return shared; }
163:  const cached = cache.get(cacheKey);                 // _fetchRentMonth
271:    cache.set(cacheKey, result, 86400);               // _fetchRentMonth 성공
290:    cache.set(cacheKey, _failMark(brief), 300);       // _fetchRentMonth 실패 표식
```

캐시에 들어가는 행의 모양. `backend/services/rentService.js:250-262`

```js
      .map(item => ({
        aptName: _str(item.aptNm),
        umdNm: _str(item.umdNm),
        excluUseAr: parseFloat(item.excluUseAr) || 0,
        floor: parseInt(item.floor) || 0,
        dealYear: parseInt(item.dealYear) || 0,
        dealMonth: parseInt(item.dealMonth) || 0,
        dealDay: parseInt(item.dealDay) || 0,
        deposit: parseAmountManwon(item.deposit),
        monthlyRent: parseAmountManwon(item.monthlyRent),
      }));
```

모든 필드가 숫자나 문자열이라 `setRows` 의 조건에 맞는다. 126행에서 넣는 `shared` 는 Redis 에서 읽은 같은 모양의 배열이다(Upstash 가 JSON 으로 저장했다가 그대로 돌려준다).

실패 표식은 배열이 아닌 객체다. `backend/services/rentService.js:77-79`

```js
const RENT_FAIL = Symbol.for('myhomelog.rent.fail');
const _failMark = (reason) => ({ [RENT_FAIL]: true, reason: reason || null });
const _isFailMark = (v) => !!(v && typeof v === 'object' && !Array.isArray(v) && v[RENT_FAIL]);
```

`setRows` 는 배열이 아닌 값을 `cache.set` 으로 그대로 넣고, `getRows` 는 그대로 돌려준다. 그래서 290행은 고치지 않아도 되고, 읽는 쪽을 `getRows` 로 바꿔도 실패 표식 판정(116행, 165행의 `_isFailMark`)이 그대로 동작한다.

`getJeonseByApt` 가 결과 배열에 붙이는 `monthsTotal`, `monthsFailed` 속성(`rentService.js:357-358`)은 캐시에 넣지 않는 새 배열에 붙이는 것이라 이 변경과 관계없다.

저장소 규칙
- 주석은 한국어로 쓰고 이름표를 붙인다. 이 계획의 이름표는 `RENT-NOCLONE-1118` 이다.
- 검사는 `node:test`, `node:assert/strict`.
- Windows 에서 heredoc 으로 파일을 만들지 않는다.

## 쓸 명령

| 목적 | 명령 | 성공했을 때 |
|---|---|---|
| 검사 하나 | `cd backend` 뒤 `TZ=UTC node --test test/<파일>.test.js` (PowerShell 은 `$env:TZ='UTC'; node --test test/<파일>.test.js`) | `ℹ fail 0` |
| 전체 검증 | 저장소 루트에서 `npm run verify` | exit 0, 끝에 `ℹ fail 0`. 기준 커밋에서 검사 수는 1,274개다 |

전체 검증은 한 번에 하나만 돌린다.

## 범위

**고쳐도 되는 파일**
- `backend/services/rentService.js` (위 여섯 곳 가운데 다섯 곳과 주석)
- `backend/test/cache-rows-1114.test.js` (검사 하나를 더한다)
- `plans/README.md` (205 줄의 상태만)

**고치면 안 되는 것**
- `backend/cache.js` : `setRows/getRows` 는 그대로 쓴다.
- `rentService.js` 의 Redis 쪽(`rget`, `rset`, `rentTtlSec`), 예열 건너뛰기 규칙(`isRentCached` 의 판정 내용): `plans/206` 이 고친다. 이 계획에서는 `isRentCached` 의 `cache.get` 을 `cache.getRows` 로 바꾸는 한 줄만 건드린다.
- `getJeonseByApt` 의 걸러 내기와 정렬(336-359행): 동작을 바꾸지 않는다.
- `.env` 로 시작하는 파일은 읽지도 않는다.

## Git 작업 방식

- 브랜치: `advisor/205-rent-cache-noclone`
- 커밋 제목: `perf(rent): 전월세 월별 목록 캐시를 깊은 복제 없이 넣고 꺼냄 (Sprint 1118-plan205)`. 본문에 `[근본 원인]`, `[Fix 내용]`, `[회귀 위험]`.
- 푸시하지 않는다.

## 단계

### 1단계: 읽는 세 곳을 `getRows` 로 바꾼다

`backend/services/rentService.js`
- 93행 `const local = cache.get(key);` → `const local = cache.getRows(key);`
- 114행 `const hit = cache.get(key);` → `const hit = cache.getRows(key);`
- 163행 `const cached = cache.get(cacheKey);` → `const cached = cache.getRows(cacheKey);`

**확인**: `grep -n "cache\.get(" backend/services/rentService.js` → 결과 없음.

### 2단계: 넣는 두 곳을 `setRows` 로 바꾼다

- 126행의 `cache.set(key, shared, RENT_MEM_TTL_S)` → `cache.setRows(key, shared, RENT_MEM_TTL_S)`
- 271행 `cache.set(cacheKey, result, 86400);` → `cache.setRows(cacheKey, result, 86400);`
- 290행(실패 표식)은 그대로 둔다. 그 줄 위에 한 줄 주석을 더한다: `// RENT-NOCLONE-1118: 실패 표식은 배열이 아니라서 setRows 로 넣지 않는다(getRows 는 이 값을 그대로 돌려준다).`
- 51행 `const RENT_MEM_TTL_S = 86400;` 위에 주석을 더한다.

```js
// RENT-NOCLONE-1118 (plans/205): 월별 목록은 cache.setRows/getRows 로 넣고 꺼낸다(깊은 복제 대신 행마다 얕은 복사, backend/cache.js 의 ROWS-NOCLONE-2026-11-14).
//   행은 숫자와 문자열 필드만 가진 객체라 조건에 맞는다. 행에 객체나 배열 값을 더하면 이 방식을 쓸 수 없다.
```

**확인**: `grep -n "cache\.set(" backend/services/rentService.js` → 290행 한 줄만 나온다. `grep -c "cache\.setRows(\|cache\.getRows(" backend/services/rentService.js` → 5.

### 3단계: 126행이 돌려주는 값이 캐시와 객체를 나눠 쓰지 않는지 확인한다

126행은 `cache.setRows(key, shared, ...)` 뒤에 `return shared;` 를 한다. `setRows` 는 넣을 때 행을 얕게 복사해 따로 보관하므로(`cache.js:60`), 호출자가 `shared` 를 고쳐도 캐시는 오염되지 않는다. 코드를 바꿀 필요는 없다. 눈으로 확인만 한다.

**확인**: `backend/cache.js:60` 에 `const stored = rows.map(r => ({ ...r }));` 가 있다.

### 4단계: 회귀 검사를 더한다

`backend/test/cache-rows-1114.test.js` 의 맨 끝에 검사 하나를 더한다. 같은 파일의 마지막 검사("거래 서비스의 거래 목록 캐시는 모두 getRows/setRows 를 쓴다")가 `transactionService.js` 소스를 읽어 확인하는 방식을 본뜬다.

```js
test('전월세 서비스의 월별 목록 캐시도 getRows/setRows 를 쓴다(실패 표식만 cache.set)', () => {
  const s = fs.readFileSync(path.join(__dirname, '../services/rentService.js'), 'utf8');
  assert.equal((s.match(/cache\.get\(/g) || []).length, 0, 'cache.get 으로 읽으면 깊은 복제가 다시 생긴다');
  assert.equal((s.match(/cache\.getRows\(/g) || []).length, 3);
  assert.equal((s.match(/cache\.setRows\(/g) || []).length, 2);
  const sets = s.split(/\r?\n/).filter((l) => /cache\.set\(/.test(l));
  assert.equal(sets.length, 1);
  assert.ok(sets[0].includes('_failMark('), '남은 cache.set 은 실패 표식뿐이어야 한다');
});
```

**확인**: `cd backend` 뒤 `TZ=UTC node --test test/cache-rows-1114.test.js` → `ℹ fail 0`.

### 5단계: 전월세 검사와 전체 검증

`cd backend` 뒤 `TZ=UTC node --test test/rent-jeonse.test.js` → `ℹ fail 0`. 이 파일에는 실패 표식, 빈 결과, Redis 읽기 경로를 실제로 실행하는 검사가 있다. 여기서 실패하면 멈춤 조건이다.

그다음 저장소 루트에서 `npm run verify`.

**확인**: exit 0, `ℹ fail 0`, 검사 수 1,275개(1,274 + 1).

## 검사 계획

- 새 검사 1개: `backend/test/cache-rows-1114.test.js` 끝(위 4단계).
- 기존 검사로 동작 확인: `backend/test/rent-jeonse.test.js` 전체.
- 확인: `npm run verify` → 모두 통과.

## 끝났다고 볼 조건

- [ ] `npm run verify` 가 exit 0 이고 `ℹ fail 0`
- [ ] `grep -n "cache\.get(" backend/services/rentService.js` 결과 없음
- [ ] `grep -n "cache\.set(" backend/services/rentService.js` 결과가 실패 표식 한 줄뿐
- [ ] `backend/test/rent-jeonse.test.js` 를 고치지 않았다(`git diff --stat` 에 없다)
- [ ] `git status --short` 에 범위 밖 파일이 없다
- [ ] `plans/README.md` 의 205 줄 상태를 고쳤다

## 멈춤 조건

- "지금 상태"의 발췌와 실제 코드가 다르다(특히 `rent:` 키를 넣고 빼는 곳이 여섯 곳이 아니다).
- 캐시에 들어가는 행(250-262행)에 객체나 배열 값을 가진 필드가 있다.
- `rent:` 키를 `rentService.js` 밖에서 `cache.get`, `cache.mget`, `cache.take` 로 읽는 코드가 있다(`grep -rn "rent:" backend --include=*.js` 로 확인. `backend/test` 는 뺀다).
- `backend/test/rent-jeonse.test.js` 가 실패한다.

## 뒤에 맡을 사람에게

- 전월세 행에 중첩 값(객체, 배열)을 더하려면 먼저 이 캐시 방식을 다시 본다. `backend/cache.js` 의 주석에 조건이 있다.
- health 의 `cache.stats.vsize` 는 함수로 감싼 값을 작게 센다. 이 변경 뒤 그 숫자가 줄어도 실제 메모리가 준 것은 아니다.
- 줄어든 CPU 는 재지 않았다. 배포 뒤 health 의 `crons['warm-rent'].cpuMs`(2026-11-16 회차 5,889ms, 가져옴 234건)를 같은 가져옴 건수인 날과 견주면 볼 수 있다.
- 다음 단계 후보(이 계획 범위 밖): `getJeonseByApt` 가 여섯 달 치를 모두 펼친 뒤 행마다 `aptName.replace(/\s/g,'')` 를 하고 `{...t}` 로 또 복사한다(`rentService.js:336-348`). 보고서는 지역 전체 목록을 이 함수로 받는다(`backend/routes/report.js:1786`).
