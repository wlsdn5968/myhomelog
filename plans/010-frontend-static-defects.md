# Plan 010: 프론트 정적 결함 2건 정리 — 저장형 XSS 싱크 1곳, 중복 키로 죽은 타임아웃 1곳

> **Executor instructions**: 이 계획을 단계대로 따르라. 각 단계의 검증 명령을 실행해
> 기대 결과를 확인한 뒤 다음 단계로 가라. "STOP conditions" 에 해당하면 멈추고 보고하라.
> 완료하면 `plans/README.md` 의 이 계획 행 Status 를 갱신하라.
>
> **Drift check (가장 먼저 실행)**:
> `git diff --stat 9031f65..HEAD -- frontend/index.html scripts/security-regression-check.js`
> 바뀌었다면 아래 "Current state" 발췌와 실제 코드를 대조하라. 다르면 STOP 조건이다.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `9031f65`, 2026-08-16

## Why this matters

둘 다 **린터가 있었다면 자동으로 잡혔을** 종류인데, 이 저장소에는 린트 설정이 없어 CI 를 통과했다.

1. **저장형 self-XSS**: "계약 타임라인" 의 단지명이 `innerHTML` 에 escape 없이 들어간다.
   이 저장소는 사용자 입력을 렌더링하는 다른 모든 지점에서 예외 없이 `_escHtml()` 을 쓰는데
   **여기 한 곳만 누락**됐다. 서버 CSP 가 `script-src 'unsafe-inline'` 을 허용하고 있어
   (인라인 스크립트 구조상 불가피한 기존 트레이드오프) CSP 백스톱도 작동하지 않는다.
   데이터가 `localStorage` 에만 저장되므로 영향 범위는 입력한 본인 브라우저지만, 붙여넣기
   유도 같은 사회공학과 결합하면 실사용자 세션이 조작될 수 있다.

2. **죽은 타임아웃**: 같은 객체 리터럴에 `signal` 키가 두 번 있어 뒤의 값이 앞을 덮는다.
   "보고서 요청을 90초로 제한한다"는 의도가 실제로는 **180초**로 동작한다. 사용자가 의도의
   2배를 기다린다.

이 계획이 끝나면 두 결함이 사라지고, 1번은 CI 정적 가드가 재유입을 막는다.

## Current state

### 결함 A — escape 누락, `frontend/index.html:8249-8258`

```js
  el.innerHTML=deals.slice(0,3).map(d=>{
    const contractD=d.contract?getDday(d.contract):null;
    const balanceD=d.balance?getDday(d.balance):null;
    const fmtD=(n)=>n===null?'-':n===0?'오늘':n>0?`D-${n}`:`완료`;
    return`<div class="deal-card">
      <div class="deal-apt">${d.apt}</div>
      ${d.contract?`<div class="deal-row"><span class="deal-lbl">계약일</span><span class="deal-day ${contractD!==null&&contractD<=7&&contractD>0?'soon':'ok'}">${fmtD(contractD)}</span></div>`:''}
      ${d.balance?`<div class="deal-row"><span class="deal-lbl">잔금일</span><span class="deal-day ${balanceD!==null&&balanceD<=30&&balanceD>0?'soon':'ok'}">${fmtD(balanceD)}</span></div>`:''}
    </div>`;
  }).join('');
```

`${d.apt}` 만 사용자 입력이다(나머지 보간값은 코드가 만든 값이라 안전). `d.apt` 의 출처는
`frontend/index.html:1722` 의 자유 입력 필드(`id="deal-apt"`, 드롭다운이 아니다)이고,
`localStorage` 에 저장됐다가 이 함수가 다시 그린다.

### 저장소의 확립된 방어 관례

이 저장소는 **표시 시점에 escape** 한다(저장 시점이 아니라). `_escHtml()` 헬퍼가 있고,
북마크·검색이력·임장노트·특약·뉴스 등 다른 사용자입력 렌더링은 전부 이걸 쓴다.
**같은 패턴을 따르라** — 저장 함수(`saveDeal`)는 건드리지 않는다.

### 결함 B — 중복 키, `frontend/index.html:4014-4017`

```js
      // AUDIT-2026-07-05: 유일하게 타임아웃 없던 사용자 대기 fetch — 서버 지연 시 최대 300s(Vercel) 대기하던 것을 90s로 제한(AI 보고서 정상 소요 감안). TimeoutError는 기존 catch else("잠시 후 다시 시도")로 처리됨.
      signal: AbortSignal.timeout(90000),
      signal: AbortSignal.timeout(180000),  // Phase 8: 150s → 180s (KAPT + 카카오 amenities + Claude)
    });
```

JS 객체 리터럴에서 같은 키가 반복되면 **뒤가 이긴다** → 실제 적용값은 180000.
두 주석이 서로 다른 시점의 의도를 담고 있어, 어느 쪽이 최종 의도인지 코드만으로는 알 수 없다.

**판단 근거**: 위 90초 주석이 아래 180초 줄보다 **나중에 추가된 것**이다(`AUDIT-2026-07-05` 라는
날짜 태그가 있고, 아래 줄은 그 이전의 "Phase 8" 작업이다). 즉 최신 의도는 **90초**다.
다만 아래 주석이 말하는 "KAPT + 카카오 amenities" 소요는 실제 부하 근거이므로, 90초로 줄일 때
정상 보고서 생성이 잘리지 않는지 확인이 필요하다 — Step 3 에서 다룬다.

### CI 정적 가드의 구조 — `scripts/security-regression-check.js`

`CHECKS` 배열에 항목을 추가하면 된다. 각 항목 형태:

```js
  {
    name: '<위반 시 출력될 설명>',
    file: 'frontend/index.html',
    re: /<금지 패턴 정규식>/,
  },
```

기본 동작은 "패턴이 코드에 있으면 위반(exit 1)" 이다. `mustExist: true` 를 주면 반대로
"없으면 위반" 이 된다.

⚠ 이 스크립트는 **순수 주석 라인을 건너뛴다**(`isComment`: `//`, `*`, `/*` 로 시작하는 줄).
따라서 설명 주석에 패턴을 인용해도 오탐이 나지 않는다.

## Commands you will need

| 목적 | 명령 | 성공 시 기대 결과 |
|---|---|---|
| 보안 회귀 가드 | `node scripts/security-regression-check.js` | exit 0, "위반 0건" |
| 백엔드 테스트 | `cd backend && npm test` | exit 0, 41 pass |
| 프론트 문법 | Step 4 에 전체 명령 수록 | `문법 오류: 0` |

## Scope

**In scope**:
- `frontend/index.html` — 결함 A 1줄, 결함 B 1줄 제거
- `scripts/security-regression-check.js` — 가드 1개 추가

**Out of scope** (손대지 마라):
- `frontend/index.html:8233-8243` 의 `saveDeal()` — 저장 시점 escape 는 이 저장소 관례가 아니다.
- 다른 `innerHTML` 사용처 — 감사에서 전수 확인했고 전부 이미 escape 되어 있다. 건드리면 회귀 위험만 생긴다.
- CSP 설정(`backend/server.js`) — `unsafe-inline` 은 인라인 스크립트 구조상 기존에 문서화된
  트레이드오프다. 이 계획의 범위가 아니다.
- 린트 도입 — 별개 사안(후속 계획 대상).

## Git workflow

- 현재 브랜치에서 작업한다(이 저장소는 `master` 직접 커밋 관례 — `git log` 확인).
- 커밋 메시지 예: `fix(security,ui): 계약 타임라인 escape 누락 + 중복 signal 키 (Plan 010)`
  본문에 `[근본 원인] [Fix 내용] [회귀 위험]` 을 한글로.
- **push 하지 마라** — 운영자 승인 후에만 한다.

## Steps

### Step 1: 결함 A — 단지명 렌더링에 escape 를 적용한다

`frontend/index.html:8254` 를 다음 형태로 바꾼다:

```js
      <div class="deal-apt">${_escHtml(d.apt||'')}</div>
```

같은 블록의 다른 보간값(`fmtD(...)`, 클래스명 삼항)은 **바꾸지 마라** — 코드가 만든 값이다.

`_escHtml` 이 이 스코프에서 호출 가능한지 확인하라(파일 내 전역 함수다).

**Verify**:
- `grep -n 'class="deal-apt">${_escHtml' frontend/index.html` → 1건
- `grep -n 'class="deal-apt">${d.apt}' frontend/index.html` → **0건**

### Step 2: 결함 A 재유입을 CI 가드로 막는다

`scripts/security-regression-check.js` 의 `CHECKS` 배열에 항목 1개를 추가한다.
기존 항목들과 같은 형식·같은 위치(배열 안)에 두고, 위에 한글 주석으로 **왜 넣는지**를 남긴다.

- `name`: 위반 시 사람이 읽고 바로 이해할 문장(예: `계약 타임라인 단지명 raw 삽입 — _escHtml() 로 감싸야 함`)
- `file`: `frontend/index.html`
- `re`: `deal-apt` 클래스 div 안에 `${d.apt}` 가 raw 로 들어간 형태만 잡는 정규식.
  넓게 잡지 마라 — `_escHtml(d.apt||'')` 형태는 **통과해야 한다**.

**Verify**: `node scripts/security-regression-check.js` → exit 0, 패턴 수가 **13 → 14** 로 늘어난다.

### Step 3: 결함 B — 중복 `signal` 키를 제거한다

`frontend/index.html:4015-4016` 두 줄 중 **하나만 남긴다.**

남길 값: **90000** (위 "Current state" 의 판단 근거 참조 — 90초 주석이 나중 것이다).
`180000` 줄을 지우되, 그 줄의 주석이 담고 있는 정보(KAPT·카카오 amenities·AI 가 걸리는 구간이라
길게 잡았던 이력)는 **남은 줄의 주석에 합쳐라.** 왜 90초인지, 과거에 180초였는지가 보여야 한다.

⚠ 90초로 줄이면 느린 보고서 생성이 잘릴 수 있다. 코드상 이 fetch 의 실패는
`frontend/index.html` 의 기존 catch 분기가 "잠시 후 다시 시도" 로 처리하므로 앱이 깨지지는 않는다.
**다만 사용자가 결과를 못 받는 것은 실질 회귀다** — 아래 STOP 조건을 확인하라.

**Verify**:
- `grep -c "signal: AbortSignal.timeout" frontend/index.html` → 이 fetch 블록에서 **1건**
  (파일 전체에는 다른 fetch 의 `AbortSignal.timeout` 이 있을 수 있으니, 4000~4020 행 범위에서 세라:
  `sed -n '4000,4020p' frontend/index.html | grep -c "signal: AbortSignal.timeout"` → `1`)

### Step 4: 프론트 문법이 깨지지 않았는지 확인한다

저장소 루트에서:

```
node -e "const fs=require('fs');const html=fs.readFileSync('frontend/index.html','utf8');const blocks=[...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)];let bad=0;blocks.forEach((m,i)=>{if(/ld\+json/.test(m[1])){try{JSON.parse(m[2])}catch(e){bad++;console.log('LD '+i+': '+e.message)}}else{try{new Function(m[2])}catch(e){bad++;console.log('JS '+i+': '+e.message)}}});console.log('문법 오류: '+bad)"
```

**Verify**: `문법 오류: 0`

### Step 5: 가드가 실제로 잡는지 회귀 주입으로 확인한다

Step 2 의 가드가 형식만 통과하는 게 아닌지 확인한다.
`frontend/index.html:8254` 를 **일시적으로** `${d.apt}` 로 되돌리고 실행:

`node scripts/security-regression-check.js`

**Verify**: **exit 1** 이고, 출력에 Step 2 에서 넣은 `name` 문구와 해당 줄 번호가 찍힌다.
확인 후 반드시 `_escHtml(d.apt||'')` 로 되돌리고 다시 실행해 exit 0 을 확인하라.

> 이 단계를 건너뛰지 마라. 이 저장소는 가드 도입 시 회귀 주입으로 실효성을 확인하는 관례가 있다.

## Test plan

- **새 단위 테스트는 추가하지 않는다.** 결함 A 의 회귀 방지는 **CI 정적 가드**(Step 2)가 맡는다 —
  이 저장소가 XSS 계열 회귀에 쓰는 확립된 수단이다(`scripts/security-regression-check.js` 의
  기존 항목 1~4번이 전부 같은 성격이다).
- 결함 B 는 "중복 키가 없다"는 것이 검증이라 grep(Step 3)으로 충분하다.
- 기존 41개 테스트는 그대로 통과해야 한다: `cd backend && npm test`.

## Done criteria

전부 만족해야 한다:

- [ ] `grep -n 'class="deal-apt">${d.apt}' frontend/index.html` → 0건
- [ ] `grep -n 'class="deal-apt">${_escHtml' frontend/index.html` → 1건
- [ ] `sed -n '4000,4020p' frontend/index.html | grep -c "signal: AbortSignal.timeout"` → `1`
- [ ] `node scripts/security-regression-check.js` exit 0, **14 패턴** 검사
- [ ] Step 5 회귀 주입 시 exit 1 로 잡히고, 원복 후 exit 0
- [ ] Step 4 프론트 문법 검사 → `문법 오류: 0`
- [ ] `cd backend && npm test` exit 0, 41 pass
- [ ] `git status` 에 `frontend/index.html`, `scripts/security-regression-check.js` 외 변경 없음
- [ ] `plans/README.md` 의 010 행 Status 갱신

## STOP conditions

멈추고 보고하라:

- `frontend/index.html:8249-8258` 또는 `:4014-4017` 이 위 발췌와 다르다(드리프트).
- `_escHtml` 함수가 파일에 없거나 이름이 다르다.
- Step 5 에서 회귀를 주입했는데도 가드가 exit 0 이다(정규식이 실제 패턴을 못 잡는 것).
- Step 2 의 정규식이 **수정된 안전한 형태**(`_escHtml(d.apt||'')`)까지 잡아 exit 1 이 된다
  → 정규식이 너무 넓다. 좁히되, 두 번 시도해도 안 되면 STOP.
- 결함 B 에서 어느 값을 남길지 판단이 서지 않는다(예: 90초 주석이 실제로는 더 오래된 것으로 보인다)
  → 임의로 정하지 말고 STOP 후 보고.

## Maintenance notes

- 이 저장소의 XSS 방어 원칙은 **"표시 시점 escape"** 다. 새 렌더링 코드를 추가할 때
  사용자 입력이 `innerHTML` 로 가면 반드시 `_escHtml()` 을 거쳐야 한다.
  CSP 가 `unsafe-inline` 을 허용하므로 **CSP 는 백스톱이 되지 못한다** — 코드 레벨 escape 가 유일한 방어다.
- 결함 B 같은 중복 키는 린터(`no-dupe-keys`)로 자동 검출되는 종류다. 린트 도입은 이 계획 범위 밖이지만
  (별도 후속 항목), 도입 전까지는 같은 실수가 다시 통과할 수 있다는 점을 리뷰에서 유의할 것.
- 보고서 fetch 타임아웃을 다시 조정할 일이 생기면, **값이 두 곳에 생기지 않도록** 상수로 빼는 것을 검토하라.
- 리뷰어가 볼 곳: escape 가 표시 지점에만 들어갔는지(저장 지점은 그대로인지), 가드 정규식이
  안전 형태를 오탐하지 않는지.
