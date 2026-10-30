# Plan 180: 최고가 알림이 이력 요약 조회 실패를 "이력 없음"으로 읽지 않게 한다

> **실행자 안내**: 단계마다 검증 명령을 돌려 기대 결과를 확인한 뒤 다음으로 넘어간다. "STOP 조건"에 해당하면 멈추고 보고한다. 끝나면 `plans/README.md` 의 180 행 Status 를 갱신한다.
>
> **Drift check (먼저 실행)**: `git diff --stat 24d2032..HEAD -- backend/jobs/pushNotify.js backend/test/push-record-notify.test.js`
> 바뀐 파일이 있으면 아래 "현재 상태" 발췌와 실제 코드를 비교하고, 다르면 STOP.

## Status
- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `24d2032`, 2026-10-30

## Why this matters
관심 단지 알림(매일 1회 크론 `push-notify`)은 새 거래가 "같은 면적 최고가"인지 판정해 제목과 본문에 "이전 최고 N억"을 적는다. 판정은 원본 거래 표(`molit_transactions`)의 앞선 최고값과 과거 이력 요약 표(`molit_hist_peaks`)의 최고값 중 큰 쪽과 비교한다. 그런데 이력 요약 조회가 실패해도 오류를 읽지 않아, 이력 최고값이 0으로 계산된다. 그러면 원본 16개월 창 밖의 더 높은 과거 거래가 무시되고 **사실이 아닌 최고가 알림**이 사용자 휴대폰으로 나간다. 이 서비스의 절대 규칙("공식 출처만, 환각 차단")에 걸린다. 원본 조회 실패는 이미 건너뛰는데(`if (raw.error) continue;`), 이력 쪽만 빠져 있다.

## Current state
- `backend/jobs/pushNotify.js` — 관심 단지 알림 크론. `markNewHighs(admin, rows, subs, aliasMap)` 가 최고가 판정(127행부터).
- 현재 코드(`backend/jobs/pushNotify.js:136-151`):
```js
  for (const r of cands) {
    try {
      const raw = await admin.from('molit_transactions').select('deal_amount', { count: 'exact' })
        .eq('apt_seq', r.apt_seq).eq('exclu_use_ar', r.exclu_use_ar).lt('deal_date', r.deal_date)
        .order('deal_amount', { ascending: false }).limit(1);
      if (raw.error) continue;
      const hist = await admin.from('molit_hist_peaks').select('mx, n')
        .eq('apt_seq', r.apt_seq).eq('exclu_use_ar', Math.min(Math.round(Number(r.exclu_use_ar) * 100), 32767)).maybeSingle();
      const rawMax = raw.data && raw.data[0] ? Number(raw.data[0].deal_amount) : 0;
      const histMax = hist.data ? Number(hist.data.mx) || 0 : 0;
      const n = (Number(raw.count) || 0) + (hist.data ? Number(hist.data.n) || 0 : 0);
      const prev = Math.max(rawMax, histMax);
      if (n >= 3 && prev > 0 && Number(r.deal_amount) > prev) { r._newHigh = { prevMan: prev }; marked += 1; }
    } catch (_) { /* 판정 실패는 일반 '새 실거래' 알림으로 둔다 */ }
  }
```
- 관행: 판정을 못 하면 `_newHigh` 를 붙이지 않고 일반 "새 실거래" 알림으로 둔다(위 catch 주석). 같은 관행을 따른다.
- `hist.data === null` 이면서 `hist.error` 가 없는 경우는 "그 단지·면적의 이력이 정말 없음"이라 정상이다(이력 없는 신축 등). 이 경우는 지금처럼 판정을 계속해야 한다.
- 테스트: `backend/test/push-record-notify.test.js` 의 `fakeAdmin({ rawMax, rawCount, histMx, histN })` 가 `maybeSingle()` 에서 항상 `error: null` 을 돌려준다(10-24행). 이 패턴을 확장한다.

## Commands you will need
| Purpose | Command | Expected on success |
|---|---|---|
| 이 파일 테스트 | `node --test backend/test/push-record-notify.test.js` | 모두 pass |
| 전체 검증 | `npm run verify` | 마지막에 `ℹ fail 0` |

## Scope
**In scope**: `backend/jobs/pushNotify.js`(markNewHighs 안 한 줄), `backend/test/push-record-notify.test.js`(테스트 추가)
**Out of scope**: 알림 문구(`_buildTitle`·`_buildBody`), 원본 조회 쿼리, `molit_hist_peaks` 스키마, 프런트.

## Git workflow
- 커밋 메시지 형식(저장소 관례): `fix(push): 이력 요약 조회 실패면 최고가 판정을 건너뜀 (Sprint XX)` + 본문 `[근본 원인] [Fix 내용] [회귀 위험]`, 끝에 공동 작성자 줄은 운영자 지침을 따른다.
- push 는 운영자 승인 후.

## Steps
### Step 1: 이력 조회 오류면 이 행 판정을 건너뛴다
`const hist = ...maybeSingle();` 바로 다음 줄에 `if (hist.error) continue;` 를 넣는다. 같은 줄에 짧은 주석: `// 이력 요약을 못 읽으면 과거 최고를 모른다 — 최고가로 단정하지 않고 일반 알림으로(Plan 180)`.
**Verify**: `grep -n "if (hist.error) continue;" backend/jobs/pushNotify.js` → 1줄

### Step 2: 테스트 추가
`fakeAdmin` 에 선택 인자 `histError` 를 추가해, 값이 있으면 `maybeSingle()` 이 `{ data: null, error: histError }` 를 돌려주게 한다(기존 호출은 그대로 동작해야 함). 새 테스트 2개:
1. 원본 최고 115,450(만원)·원본 건수 7, 이력 조회 오류 → 새 거래 116,000 이어도 `r._newHigh === undefined`, 반환 `marked === 0`.
2. 원본 최고 115,450·건수 7, 이력 **없음**(`histMx: null`, 오류 없음) → 새 거래 116,000 이면 `_newHigh` 가 붙는다(`{ prevMan: 115450 }`). 정상 "이력 없음" 경로가 막히지 않았음을 고정한다.
**Verify**: `node --test backend/test/push-record-notify.test.js` → 기존 5개 + 새 2개 pass

### Step 3: 회귀 주입 확인
Step 1 의 줄을 잠시 지우고 Step 2 테스트 1이 실패하는지 확인한 뒤 되돌린다.
**Verify**: 지운 상태에서 `node --test backend/test/push-record-notify.test.js` → fail 1, 되돌린 뒤 → fail 0

## Test plan
- 위 2개. 패턴은 같은 파일의 "원본·이력 최고보다 높고 이전 3건 이상이면 최고가" 테스트.

## Done criteria
- [ ] `grep -c "if (hist.error) continue;" backend/jobs/pushNotify.js` → 1
- [ ] `node --test backend/test/push-record-notify.test.js` → fail 0, 테스트 수 = 기존 + 2
- [ ] `npm run verify` → fail 0
- [ ] `git status --short` 에 in-scope 두 파일만
- [ ] `plans/README.md` 180 행 갱신

## STOP conditions
- 136-151행 발췌가 실제와 다르다.
- `maybeSingle()` 대신 다른 호출로 바뀌어 있다.
- 기존 테스트가 `fakeAdmin` 변경으로 깨지고, 인자 기본값으로 해결되지 않는다.

## Maintenance notes
- 이 판정의 정의는 DB 함수 `get_price_records`(2026-10-27 수정)와 같아야 한다. 판정 규칙을 바꾸면 두 곳을 함께 본다.
- 같은 종류(오류를 "없음"으로 읽기)는 이 저장소에서 여러 번 나왔다(Plan 158). 새 조회를 추가할 때 `error` 를 읽는지 리뷰에서 본다.
