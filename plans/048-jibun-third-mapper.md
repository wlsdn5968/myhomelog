# Plan 048: `molit_transactions` 매퍼 3벌 중 세 번째에도 `jibun` 을 넣는다 (직전 실사고와 같은 함정)

> **실행자 안내**: 끝까지 읽고 각 단계의 검증 명령을 실제로 돌려라. "STOP 조건" 이면 멈추고 보고하라.
>
> **드리프트 점검(먼저)**: `git diff --stat 3d30ee2..HEAD -- backend/services/transactionService.js`

## Status

- **Priority**: P2 · **Effort**: S · **Risk**: LOW · **Depends on**: 없음
- **Category**: bug (latent) · **Planned at**: commit `3d30ee2`, 2026-09-06

## 왜 중요한가

`backend/services/transactionService.js` 에 `molit_transactions` 를 읽어 매핑하는 곳이 **3벌** 있다.
그중 **세 번째만 `jibun` 이 빠져 있다.**

- `:67` select + `:94` 매핑 — `jibun` **있음**
- `:132` select + `:169` 매핑 — `jibun` **있음** (2026-09-05 에 추가. 커밋 주석:
  *"jibun 이 빠져 있었다 — analyzeTransactions 가 단지 지번(최빈값)을 여기서 만들고…"*)
- `:790` select + 그 아래 매핑(`getTransactionsByAptSeq`) — **없음**

`analyzeTransactions` 는 `:725-727` 에서 `t.jibun` 의 최빈값으로 단지 대표 지번을 만든다:

```js
      jibun: (() => {
        // …
        for (const t of sorted) { const j = String(t.jibun || '').trim(); if (j) c[j] = (c[j] || 0) + 1; }
```

`jibun` 이 없으면 이 값은 **항상 빈 문자열**이 된다.

**오늘은 화면에 안 드러난다**(`/apt/:seq` SSR 이 지번을 표시하지 않는다). 그러나 직전 스프린트가
**정확히 이 누락 하나로** 실사고를 냈다 — 추천 경로의 지번 매칭이 한 번도 성립한 적이 없어
세대수 확인이 258곳 → 45곳으로 떨어졌다. 세 번째 사본이 같은 함정을 그대로 들고 있고,
`/apt` 경로에 KAPT 보강(세대수·주차)을 붙이는 순간 조용히 재현된다.

## 현재 상태 — `backend/services/transactionService.js:788-796`

```js
    const { data, error } = await admin
      .from('molit_transactions')
      .select('apt_name, sigungu, umd_nm, exclu_use_ar, build_year, floor, deal_year, deal_month, deal_day, deal_amount, lawd_cd, apt_seq')
      .eq('apt_seq', seq)
      .gte('deal_date', since.toISOString().slice(0, 10))
      .order('deal_date', { ascending: false })
      .order('id', { ascending: false })
      .limit(LIM);
```

그 아래 `rows.map(r => ({ aptName: r.apt_name, sigungu: …, umdNm: …, … }))` 에 `jibun` 이 없다.

### 캐시 키 — ⚠ 반드시 확인하라

이 함수는 결과를 캐시한다(`cache.set(ck, …)`). **캐시 키에 버전이 있으면 올려라.**
안 올리면 옛 매핑(지번 없음)이 캐시 수명만큼 계속 서빙된다. 이 저장소의 확립된 함정이다.
키 형태를 **직접 읽고** 판단하라 — 추측하지 마라.

### 이 저장소의 관례

- 주석 한글, 마커 `<주제>-<YYYY-MM-DD>`. 이 변경의 마커: `JIBUN-COL-2026-09-06`.
- 두 번째 사본(`:129`)이 같은 수정을 하며 남긴 주석이 좋은 본보기다. 형식을 맞춰라.

## 필요한 명령

| 목적 | 명령 | 기대 |
|---|---|---|
| 테스트 | `cd backend && npm test` | `fail 0` (기준 **241 pass**) |
| 린트 | `npm run lint` | exit 0 |
| 문법 | `node --check backend/services/transactionService.js` | exit 0 |

## 범위

**In scope**: `backend/services/transactionService.js`(세 번째 select + 매핑, 캐시 키) ·
`backend/test/characterization.test.js`

**Out of scope**:
- 첫 번째·두 번째 매퍼 — 이미 옳다.
- **세 매퍼를 공용 함수로 묶는 리팩터링** — 더 나은 설계지만 이 계획의 범위가 아니다
  (아래 유지보수 메모 참조).
- `/apt` SSR 페이지에 지번을 **표시**하는 것 — 별건.
- DB·마이그레이션.

## 단계

### Step 1: select 와 매핑에 `jibun` 을 넣는다

`:790` 의 select 문자열 끝에 `, jibun` 을 추가하고, 그 아래 `rows.map` 결과 객체에
`jibun: r.jibun || '',` 를 추가한다(다른 두 매퍼와 **같은 형태**).

마커 주석으로 근거를 남겨라 — 왜 세 번째만 빠져 있었고, 무엇이 조용히 깨지는지.

**검증**: `node --check backend/services/transactionService.js` → exit 0
**검증**: `grep -c "jibun" backend/services/transactionService.js` 가 이전보다 **2 이상** 증가

### Step 2: 캐시 키 버전을 올린다 (해당하는 경우)

이 함수의 캐시 키를 읽어 버전 성분이 있으면 올려라. 없으면 **없다고 보고**하고 넘어가라
(임의로 키 형태를 바꾸지 마라 — 다른 소비자가 있을 수 있다).

**검증**: 키를 바꿨다면 그 사실과 이전/이후 값을 보고에 적어라.

### Step 3: 계약 테스트

`backend/test/characterization.test.js` 끝에 테스트 1개를 추가한다.
**세 매퍼가 같은 키 집합을 반환한다**는 것을 고정하라 — 소스에서 세 select 문자열을 뽑아
`jibun` 이 **셋 다** 있는지 확인하고, 가능하면 매핑 결과 객체의 키도 대조하라.

⚠ 이 저장소가 2026-09-02 에 채택한 방식은 "소스 문자열 검사 → 실제 실행" 승격이다.
매퍼를 실행하려면 Supabase 스텁이 필요하다. 실행이 과하다고 판단하면 **소스 대조로 하되
왜 실행하지 않았는지 주석에 남겨라**(이 경우는 "select 컬럼 목록"이라는 배선 계약이라
정규식이 옳은 도구일 수 있다 — 그 판단을 적어라).

**검증**: `cd backend && npm test` → `fail 0`, `pass` ≥ 242

### Step 4: 회귀 주입

⚠ 주입 전 `git status --short` 가 비어 있어야 한다.
세 번째 select 에서 `jibun` 을 다시 빼고 `npm test` 가 **fail** 하는지 확인 → 원복 → `fail 0` 재확인.
안 잡히면 **STOP 조건**.

### Step 5: 전체 게이트 (5종)

## 완료 기준

- [ ] `grep -c "apt_seq, jibun\|jibun')" backend/services/transactionService.js` — 세 select 모두 `jibun` 포함
- [ ] 세 번째 매퍼의 반환 객체에 `jibun` 이 있다
- [ ] `cd backend && npm test` `fail 0`, `pass` ≥ 242 · `npm run lint` exit 0
- [ ] Step 4 의 주입에서 fail 확인
- [ ] `git status --short` 에 In scope 밖 파일이 없다

## STOP 조건

- 드리프트 점검에서 발췌와 실제 코드가 다르다.
- 세 번째 select 가 이미 `jibun` 을 갖고 있다(다른 세션이 먼저 고쳤다) — 그러면 테스트만 추가하고 보고하라.
- 캐시 키를 어떻게 올려야 할지 판단이 안 선다 — 키 형태를 그대로 보고하고 멈춰라.
- Step 4 의 주입이 잡히지 않는다.

## 유지보수 메모

- **근본 해결은 공용 매퍼**다: `mapMolitRow(r, fallbackLawd)` 하나 + select 컬럼 문자열 상수 하나로
  세 곳을 묶으면 이 계열이 끝난다. 이번엔 범위 밖으로 뒀다 — 세 함수의 반환 형태가
  미묘하게 다를 수 있어(폴백·기본값) 별도 확인이 필요하기 때문이다.
  묶을 때의 계약 테스트는 "세 함수의 반환 객체 키 집합이 같다" 를 **실행값으로** 비교하는 것이 옳다.
- **리뷰에서 볼 것**: 캐시 키 버전을 올렸는지. 안 올리면 옛 매핑이 캐시 수명만큼 남는다.
