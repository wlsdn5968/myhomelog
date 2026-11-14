# Plan 197: 지도 집계가 DB 오류를 삼키고 빠진 결과를 캐시하지 않게 한다

> 실행자 지침: 단계마다 확인 명령을 돌려 기대 결과를 본 뒤 다음으로 간다. STOP 조건이 생기면 멈추고 보고한다. 끝나면 `plans/README.md` 의 197 행을 고친다.
>
> 드리프트 확인: `git diff --stat b1cc128..HEAD -- backend/routes/search.js`
> 바뀌었으면 아래 발췌와 대조하고 다르면 STOP.

## 상태

- 우선순위: P1
- 작업량: S
- 위험: LOW
- 선행: 없음
- 분류: bug
- 작성 기준: 커밋 `b1cc128`, 2026-11-14

## 왜 하나

`GET /api/search/in-bounds` (지도 핀 집계)는 최근 180일 거래를 1000행씩 읽어 단지별 평균가와 건수를 낸다. 거래 조회와 공식 단지 별칭 조회가 오류를 받아도 확인하지 않아서, 중간 페이지가 실패하면 루프가 그냥 끝나고 일부만 집계된다. 그 결과가 비어 있지 않으면 서버 메모리 5분, CDN 300초(+재검증 1800초) 동안 모든 사용자에게 같은 틀린 건수와 평균가로 나간다. 이 저장소는 "열화된 응답은 캐시하지 않는다" 가 규칙이고(2026-08-29 실사고), 같은 라우트의 보충 거래 조회는 이미 오류를 확인한다.

## 현재 상태

`backend/routes/search.js` (b1cc128 기준 행 번호)

- `:1052` `router.get('/in-bounds', ...)` 시작.
- `:1149` 거래 페이지 조회, 오류를 받지 않음:
  ```js
        const { data: _page } = await _q
          .gte('deal_date', _cut180)
          .order('deal_date', { ascending: false })
          .order('id', { ascending: false })
          .range(_from, _from + 999);
        if (_page && _page.length) txs.push(..._page);
        if (!_page || _page.length < 1000) break;
  ```
- `:1168` 공식 단지 별칭 조회, 오류를 받지 않음:
  ```js
        const { data: _mp } = await admin
          .from('apt_master')
          ...
          .range(_mf, _mf + 999);
        if (_mp && _mp.length) masters.push(..._mp);
  ```
- `:1231` 공식 단지 본체 좌표 조회, 오류를 받지 않음(핀 위치만 영향, 건수·가격은 아님):
  ```js
      const { data: _kr } = await admin.from('apt_geocache').select('apt_key, lat, lng, source')
        .in('apt_key', _kaptKeys.slice(_ki, _ki + 200));
  ```
- 본보기(같은 라우트 `:1315-1316`, 이미 맞게 함):
  ```js
        const { data: _page, error: _me } = await _q.gte('deal_date', _cut180).order('id', { ascending: false }).range(_from, _from + 999);
        if (_me) throw _me;
  ```
- 캐시 저장(`:1374-1381`): 결과가 있으면 CDN 헤더와 `_ibMemo.set`. 예외는 `catch` 에서 `no-store` + 500(`:1383-1388`).

## 필요한 명령

| 목적 | 명령 | 성공 기준 |
|---|---|---|
| 단일 테스트 | `cd backend && node --test test/inbounds-db-error-197.test.js` | 전부 pass |
| 관련 기존 테스트 | `cd backend && node --test test/umd-rename-1114.test.js test/audit4b-1114.test.js test/cpu-cache-1108.test.js` | 전부 pass |
| 전체 검증 | 루트에서 `npm run verify` | exit 0 |

## 범위

수정: `backend/routes/search.js` 의 in-bounds 핸들러 안 세 곳, `backend/test/inbounds-db-error-197.test.js`(새로 만듦), `backend/test/cpu-cache-1108.test.js`(14행 정규식 한 줄만).

건드리지 말 것: 페이지 크기, 상한(9000/4000), 정렬, 필터(같은 파일 주석에 "한 글자도 바꾸지 않았다" 고 적힌 근거가 있다). 다른 라우트. `_jibunSafeStems(...).catch(() => new Set())` 는 실패 시 합치지 않는 안전한 기본값이라 그대로 둔다.

## 단계

### 1단계: 거래와 별칭 조회 오류를 던진다

`:1149` 를 `const { data: _page, error: _pe } = await _q` 로 바꾸고 `.range(...)` 바로 다음 줄에 `if (_pe) throw _pe;` 를 넣는다. `:1168` 도 `error: _mpe` 를 받고 `if (_mpe) throw _mpe;`. 두 함수는 `Promise.all` 안에서 돌므로 던지면 바깥 `catch` 로 가서 `no-store` 500 이 된다(지금 보충 조회와 같은 처리).

확인: `grep -n "if (_pe) throw _pe;\|if (_mpe) throw _mpe;" backend/routes/search.js` → 2줄.

### 2단계: 본체 좌표 조회 실패 때는 응답은 주되 캐시하지 않는다

핀 위치만 영향이므로 500 대신 표식을 둔다. `let _ibNoCache = false;` 는 반드시 `const kaptCoord = {}; // kaptCode → {lat,lng} (본체 좌표)` 줄 바로 앞에 둔다. 핸들러 머리에 두면 `audit4b-1114.test.js:14-18` 이 핸들러 시작 1400자 안에서 찾는 `const _ibHit = _ibMemo.get(_ibKey);` 가 밀려 실패할 수 있다. 그리고 `:1231` 을 `const { data: _kr, error: _krErr } = ...` 로 받은 뒤 `if (_krErr) { _ibNoCache = true; logger.warn({ err: _krErr.message }, 'in-bounds: 본체 좌표 조회 실패(이번 응답은 캐시 안 함)'); }`. 캐시 저장 두 곳의 조건을 `out.length && !_ibNoCache` 로 바꾼다(헤더와 `_ibMemo.set` 모두). `logger` 가 이 파일에 이미 import 돼 있는지 확인(`grep -n "logger" backend/routes/search.js | head -3`).

헤더 두 줄은 모양을 유지하고 조건만 바꾼다:
```js
    if (out.length && !_ibNoCache) res.set('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=1800');
    else res.set('Cache-Control', 'no-store');
```
`backend/test/cpu-cache-1108.test.js:14` 가 옛 모양을 정규식으로 고정한다. 그 정규식의 `if \(out\.length\)` 부분만 `if \(out\.length && !_ibNoCache\)` 로 고친다(나머지 글자는 그대로).

확인: `grep -n "_ibNoCache" backend/routes/search.js` → 4줄 이상(선언, 표시, 헤더 조건, 메모 조건). `cd backend && node --test test/cpu-cache-1108.test.js test/audit4b-1114.test.js` → 전부 pass.

### 3단계: 테스트

`backend/test/inbounds-db-error-197.test.js` 를 만든다. 이 핸들러는 DB 가짜를 만들기 어려우므로 소스 계약으로 고정하고, 회귀 주입으로 테스트가 실제로 잡는지 확인한다. 형식은 `backend/test/audit4b-1114.test.js` 첫 테스트(핸들러 구간을 `indexOf` 로 잘라 정규식 단언)를 따른다.
1. in-bounds 구간 안에 `.from('molit_transactions')` 로 시작하는 조회가 모두 `error` 를 구조분해한다: 구간에서 `const { data: _page } = await` 패턴이 0건.
2. `if (_pe) throw _pe;`, `if (_mpe) throw _mpe;` 가 있다.
3. 캐시 헤더 조건과 `_ibMemo.set` 조건에 `!_ibNoCache` 가 있다.

회귀 주입: 1단계 한 줄을 임시로 되돌리고 테스트가 fail 하는지 본 뒤 원래대로 돌린다.

확인: 새 테스트 3 pass, 주입 시 fail.

## 완료 기준

- [ ] `npm run verify` exit 0
- [ ] 새 테스트 3 pass, 회귀 주입 때 fail 확인
- [ ] `git status --short` 에 범위 밖 파일 없음
- [ ] README 197 행 갱신

## STOP 조건

- `:1149`, `:1168`, `:1231` 근처 코드가 발췌와 다르다.
- `umd-rename-1114.test.js` 의 "좌표 중복 제거" 테스트가 소스 구간을 잘라 실행하는데(`const _seen = new Map();` 부터), 이번 변경이 그 구간 안 코드를 바꿔 실패한다. 그 구간은 건드리지 않아야 한다.

## 유지보수 메모

- 이 라우트에 새 DB 조회를 더하면 같은 규칙을 따른다: 건수·가격에 영향이면 던지고, 표시 위치에만 영향이면 `_ibNoCache`.
- 500 이 늘면 화면에서 지도 핀이 잠시 안 보인다. 운영 로그 `영역 검색 실패` 와 Sentry `search/in-bounds` 를 배포 뒤 하루 본다.
