# Plan 181: 검색의 공식 단지 건수 보충이 조회 실패를 "거래 0건"으로 10분 캐시하지 않게 한다

> **실행자 안내**: 단계마다 검증 명령을 돌려 기대 결과를 확인한다. "STOP 조건"이면 멈추고 보고한다. 끝나면 `plans/README.md` 181 행을 갱신한다.
>
> **Drift check (먼저 실행)**: `git diff --stat 24d2032..HEAD -- backend/routes/search.js backend/test/alias-year-178.test.js backend/test/search-chat.test.js`
> 바뀐 파일이 있으면 발췌와 비교하고 다르면 STOP.

## Status
- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `24d2032`, 2026-10-30

## Why this matters
검색 자동완성(`GET /api/search/apt`)에서 공식 단지(apt_master)만 맞은 결과는 별칭(`molit_aliases`)으로 국토부 단지 색인(`molit_apt_index`)을 한 번 더 읽어 준공 연도와 거래 건수를 채운다(2026-10-30 추가, Plan 178). 이 조회가 1초 시간 초과나 오류로 실패해도 오류를 보지 않고 모든 행에 "확인 끝"(`_aliasChecked = true`) 표시를 붙인다. 그래서 준공 연도와 건수가 빈 채로 나가고, 그 응답이 **정상으로 10분 서버 캐시와 CDN 캐시**에 들어간다. 사용자는 "?년" 과 건수 없음을 보고, 다른 사용자도 10분 동안 같은 반쪽 결과를 받는다. 이 라우트에는 이미 "열화 응답은 캐시하지 않고 `degraded: true` 로 알린다"는 규칙이 있는데(789-797행), 이 단계만 그 규칙 밖에 있다.

## Current state
- `backend/routes/search.js` — `router.get('/apt', ...)` 자동완성 라우트.
- 보충 단계(`backend/routes/search.js:671-693`):
```js
    const _masterAliased = out.filter(r => r.source === 'master' && !r.buildYear && r.lawdCd && r.umdNm && r._aliases && r._aliases.length);
    if (_masterAliased.length) {
      const _names = [...new Set(_masterAliased.flatMap(r => r._aliases.map(a => parseAlias(a).name)))];
      const { data: _ix } = await _softQuery(admin.from('molit_apt_index')
        .select('apt_name, lawd_cd, umd_nm, build_year, recent_deal_date, deal_count')
        .in('apt_name', _names).in('lawd_cd', [...new Set(_masterAliased.map(r => r.lawdCd))])
        .limit(1000).abortSignal(AbortSignal.timeout(ENRICH_ABORT_MS)));
      for (const m of _masterAliased) {
        ...
        m._aliasChecked = true; // 별칭 행이 없으면(거래 0건) 조각 맞추기로 지어내지 않는다
        if (top) { m.buildYear = top.build_year; m.recentDealDate = recent; m.dealCount = n; }
      }
    }
    const masterEmpty = out.filter(r => r.source === 'master' && !r.buildYear && r.lawdCd && r.umdNm && !r._aliasChecked);
    for (const r of out) { delete r._aliases; delete r._aliasChecked; }
```
- `_softQuery(p)`(143행)는 예외를 `{ data: null, error: {...} }` 로 바꿔 돌려준다. 즉 실패하면 `error` 가 채워진다.
- 응답과 캐시(`backend/routes/search.js:789-797`):
```js
    const payload = _degraded ? { results: out, query: q, degraded: true } : { results: out, query: q };
    if (_degraded) {
      res.set('Cache-Control', 'no-store');
    } else {
      cache.set(sck, payload, 600);
      res.set('Cache-Control', SEARCH_CDN);
    }
```
  `_degraded` 는 409행의 `const _degraded = _dg.degraded;`. 프런트는 `degraded: true` 를 보고 "일부 데이터를 불러오지 못해 결과가 다 나오지 않았어요" 배너를 띄운다(지우면 안 됨 — 783-788행 주석).
- 실패했을 때 아래의 "이름 조각 맞추기"(`masterEmpty`)로 넘기면 **안 된다**: 그 방식은 같은 동의 다른 단지 거래를 더해 틀린 값(예: 실제 2011년 9건인 단지를 2008년 47건)을 만든 것이 이 단계를 만든 이유다(173-176행 주석).

## Commands you will need
| Purpose | Command | Expected |
|---|---|---|
| 검색 테스트 | `node --test backend/test/search-chat.test.js backend/test/alias-year-178.test.js` | fail 0 |
| 전체 검증 | `npm run verify` | `ℹ fail 0` |

## Scope
**In scope**: `backend/routes/search.js`(보충 단계와 payload 조건), `backend/test/alias-year-178.test.js`(소스 계약 추가)
**Out of scope**: 이름 조각 맞추기 단계(`masterEmpty` 이하), 지역 분리·정렬 코드, 캐시 키(`searchapt:v4`), 프런트.

## Git workflow
- 커밋: `fix(search): 공식 단지 건수 보충 실패를 열화로 표시하고 캐시하지 않음 (Sprint XX)` + `[근본 원인] [Fix 내용] [회귀 위험]`. push 는 운영자 승인 후.

## Steps
### Step 1: 실패를 기록한다
보충 블록 바로 위에 `let _enrichFailed = false;` 를 선언한다. 조회 결과 구조분해를 `const { data: _ix, error: _ixErr } = await _softQuery(...)` 로 바꾸고, 바로 다음에 `if (_ixErr) _enrichFailed = true;` 를 넣는다. `_aliasChecked = true` 는 그대로 둔다(실패해도 조각 맞추기로 지어내지 않는다).
**Verify**: `grep -n "_enrichFailed" backend/routes/search.js` → 선언 1, 설정 1

### Step 2: payload 와 캐시 조건에 반영한다
789행을 `const _degradedOut = _degraded || _enrichFailed;` 로 만든 뒤, payload 와 `if` 조건에서 `_degraded` 대신 `_degradedOut` 을 쓴다. 다른 곳의 `_degraded` 사용은 바꾸지 않는다.
**Verify**: `grep -n "_degradedOut" backend/routes/search.js` → 3줄(선언·payload·if)

### Step 3: 소스 계약 테스트
`backend/test/alias-year-178.test.js` 의 마지막 "배선" 테스트에 단언 3개를 추가한다:
- `/const \{ data: _ix, error: _ixErr \} = await _softQuery\(/`
- `/if \(_ixErr\) _enrichFailed = true;/`
- `/const _degradedOut = _degraded \|\| _enrichFailed;/`
**Verify**: `node --test backend/test/alias-year-178.test.js` → fail 0

### Step 4: 회귀 주입
Step 2 의 `|| _enrichFailed` 를 잠시 지우고 Step 3 이 실패하는지 본 뒤 되돌린다.
**Verify**: 지운 상태 fail ≥1, 되돌린 뒤 fail 0

## Test plan
- 소스 계약 3개(위). 실행 테스트를 추가하고 싶다면 `backend/test/search-chat.test.js` 의 `_withSearchDbStubChain` 패턴으로 `molit_apt_index` + `apt_name` in 조회를 reject 시키고 `res.body.degraded === true` 와 `Cache-Control: no-store` 를 단언한다(선택).

## Done criteria
- [ ] `grep -c "_enrichFailed" backend/routes/search.js` ≥ 3
- [ ] `node --test backend/test/search-chat.test.js backend/test/alias-year-178.test.js` → fail 0
- [ ] `npm run verify` → fail 0
- [ ] `git status --short` 에 in-scope 파일만
- [ ] README 181 행 갱신

## STOP conditions
- 671-693행 발췌가 다르다(구조가 바뀌었다).
- `_degraded` 가 `const` 가 아니거나 다른 곳에서 재할당된다.
- 실패 시 조각 맞추기로 넘겨야 할 것 같은 근거를 발견했다(넘기지 말 것 — 먼저 보고).

## Maintenance notes
- 이 라우트에 보충 조회를 또 추가하면 같은 방식으로 `_degradedOut` 에 합친다.
- `.limit(1000)` 은 서버 1000행 상한과 같다. 별칭 이름이 많은 광역 검색에서 1000행에 닿으면 일부 단지가 비게 된다 — 행 수가 1000이면 경고 로그를 남기는 것은 별도 후속.
