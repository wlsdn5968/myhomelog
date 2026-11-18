# Plan 209: 정책 보도자료 감지 기록이 소스당 5건에서 잘리지 않게 한다

> **실행자에게**: 이 계획을 순서대로 따른다. 단계마다 확인 명령을 돌려 기대 결과가 나온 뒤에 다음 단계로 간다.
> "멈춤 조건"에 해당하면 스스로 고치려 하지 말고 멈추고 보고한다. 끝나면 `plans/README.md` 의 209 줄 상태를 고친다.
>
> **먼저 할 일(변경 확인)**: `git diff --stat 55c56b4..HEAD -- backend/jobs/regulationsAutoFetch.js backend/jobs/regulationsAiCheck.js`
> 바뀐 것이 있으면 아래 "지금 상태"의 발췌와 실제 코드를 견준다. 다르면 멈춤 조건이다.

## 상태

- **우선순위**: P1
- **작업량**: S
- **위험**: LOW
- **선행 계획**: 없음
- **범주**: bug
- **기준**: 커밋 `55c56b4`, 2026-11-18

## 왜 필요한가

이 서비스는 대출과 세금 기준을 화면에 보여 준다. 정부가 새 대책을 내면 그 기준을 사람이 원문과 대조해 고쳐야 한다. 2026-08-13 대책이 석 달 동안 반영되지 않은 일이 있었고(2026-11-16 확인), 그 뒤로 예약 작업이 날마다 정부 보도자료 목록에서 관련 글을 찾아 저장해 두고, "마지막 검증일 뒤에 나온 관련 글 수"(`pendingReview`)를 health 에 남기게 했다. 작업을 시작할 때마다 이 숫자를 보고 0 이 아니면 원문을 대조한다.

그런데 감지 결과가 소스(금융위원회, 국토교통부 등)마다 앞의 5건으로 잘린 뒤에 저장과 계수로 넘어간다. 자르는 줄의 주석은 "최대 5건만 응답"이다. 응답 크기를 줄이려던 것이 저장과 계수까지 줄였다. 한 소스에서 한 번에 6건 넘게 걸리면 6번째부터는 저장되지 않고 `pendingReview` 에도 세어지지 않는다. 국토교통부의 낱말에는 "주택", "부동산" 같은 넓은 말이 있고 살피는 기간이 7일이라 5건을 넘기 쉽다(실제로 하루에 몇 건이 걸리는지는 운영 기록으로 확인하지 못했다). 이 계획이 끝나면 저장과 계수는 걸린 글 전부를 쓰고, 응답은 종전대로 5건만 싣는다.

## 지금 상태

- `backend/jobs/regulationsAutoFetch.js` : 정부 RSS 를 받아 낱말에 걸린 글을 고른다. `run()` 이 요약을 돌려준다.
- `backend/jobs/regulationsAiCheck.js` : `runFullCheck()` 가 위 `run()` 을 부르고, 결과를 현재 기준과 견주고(`analyzeRegulations`), 감지한 글을 저장하고 대기 수를 센다(`persistDetected`). 유료 AI 호출은 없다(이름만 남았다).
- `backend/routes/cron.js:640-653` : 예약 작업 처리기. `runFullCheck()` 의 결과를 응답으로 내고 `pendingReview` 를 실행 기록에 남긴다.

`backend/jobs/regulationsAutoFetch.js:193-208` (`run()` 의 반환)

```js
  return {
    sources: results.map(r => ({
      name: r.name,
      total: r.total,
      matched_count: r.matched.length,
      matched: r.matched.slice(0, 5).map(m => ({ // 최대 5건만 응답
        title: m.title.slice(0, 200),
        link: m.link,
        pubDate: m.pubDate ? m.pubDate.toISOString() : null,
        hits: m.hits,
      })),
      error: r.error,
    })),
    totalMatched,
    topAlert,
  };
```

`backend/jobs/regulationsAutoFetch.js:124-136` (한 소스에서 걸린 글을 모으는 곳. `r.matched` 는 여기서 만든 전체 목록이다)

```js
    const cutoff = Date.now() - LOOK_BACK_DAYS * 86400000;
    const matched = [];
    for (const it of items) {
      // 최근 7일 안 항목만
      if (it.pubDate && it.pubDate.getTime() < cutoff) continue;
      // 키워드 매칭
      const _hay = it.title + ' ' + (it.desc || '');
      const hits = src.keywords.filter(k => _hay.includes(k));
      if (hits.length) {
        matched.push({ title: it.title, link: it.link, pubDate: it.pubDate, hits });
      }
    }
    return { name: src.name, total: items.length, matched, error: null };
```

`backend/jobs/regulationsAiCheck.js:203-212, 226-228` (`runFullCheck()` 안)

```js
  const { run: runRssAutoFetch } = require('./regulationsAutoFetch');
  ...
  const rssSummary = await runRssAutoFetch();
  const currentSnapshot = await loadCurrentSnapshot();
  const aiResults = await analyzeRegulations(rssSummary.sources, currentSnapshot);
  ...
  let pending = { stored: 0, byKey: {}, total: 0 };
  try { pending = await persistDetected(rssSummary.sources, currentSnapshot); } catch (e) { logger.warn({ err: e && e.message }, 'regulationsAiCheck: 감지 기록 저장 실패'); }
```

`backend/jobs/regulationsAiCheck.js:241-251` (`runFullCheck()` 의 반환. `rssResults` 가 그대로 응답에 실린다)

```js
  return {
    rssResults: rssSummary,
    aiResults,
    currentSnapshot: currentSnapshot.map(s => ({ ... })),
    timestamp: new Date().toISOString(),
    pendingReview: pending.total,
```

저장하는 쪽은 소스마다 `src.matched` 를 읽는다. `backend/jobs/regulationsAiCheck.js:75-79`

```js
  for (const src of sources || []) {
    for (const m of (src && src.matched) || []) {
      add({ source: src.name, title: String(m.title || '').slice(0, 200), link: String(m.link || '').slice(0, 300),
        pubDate: m.pubDate ? new Date(m.pubDate).toISOString() : null, hits: (m.hits || []).slice(0, 8), firstSeen: new Date(nowMs).toISOString() });
    }
  }
```

저장 목록은 최근 300건, 400일까지만 둔다(`regulationsAiCheck.js:69-70, 86`). 이 상한은 그대로 둔다.

견주는 쪽도 `src.matched` 를 읽고, 근거 문장은 스스로 5개로 줄인다. `backend/jobs/regulationsAiCheck.js:139-141, 167-168`

```js
  for (const src of rssMatched || []) {
    if (!src.matched || !src.matched.length) continue;
    for (const item of src.matched) {
  ...
      evidence: hits.slice(0, 5).map(_fmt),
      evidenceCount: hits.length,
```

기존 검사: `backend/test/policy-detect-1116.test.js` (검사 5개). 20행, 32행은 낱말 판정, 45행은 `mergeDetected`, 64행은 `pendingCounts`, 79행은 소스 글자를 읽는 배선 검사다.

저장소 규칙
- 주석은 한국어, 이름표는 `POLICY-NOCUT-1118`.
- 검사는 `node:test`, `node:assert/strict`.
- 정책 문구나 낱말 목록은 이 계획에서 바꾸지 않는다.

## 쓸 명령

| 목적 | 명령 | 성공했을 때 |
|---|---|---|
| 검사 하나 | `cd backend` 뒤 `TZ=UTC node --test test/policy-detect-1116.test.js` (PowerShell 은 `$env:TZ='UTC'; node --test test/policy-detect-1116.test.js`) | `ℹ fail 0` |
| 전체 검증 | 저장소 루트에서 `npm run verify` | exit 0, 끝에 `ℹ fail 0` |

## 범위

**고쳐도 되는 파일**
- `backend/jobs/regulationsAutoFetch.js` (`run()` 의 반환)
- `backend/jobs/regulationsAiCheck.js` (`runFullCheck()` 안의 넘기는 값과 반환)
- `backend/test/policy-detect-1116.test.js` (검사 추가. 79행 배선 검사가 고친 줄의 글자를 본다면 그 기대 글자만)
- `plans/README.md` (209 줄의 상태만)

**고치면 안 되는 것**
- 낱말 목록(`RSS_SOURCES` 의 `keywords`, `KEY_TOPIC_KEYWORDS`), 살피는 기간(`LOOK_BACK_DAYS`), 저장 상한(`DETECTED_MAX`, `DETECTED_KEEP_MS`).
- `mergeDetected`, `pendingCounts`, `analyzeRegulations` 의 본문.
- `backend/routes/cron.js`.
- 예약 작업 응답에 실리는 `matched` 는 종전대로 소스당 5건이어야 한다.
- `.env` 로 시작하는 파일은 읽지도 않는다. 정부 RSS 주소를 실제로 부르지 않는다.

## Git 작업 방식

- 브랜치: `advisor/209-policy-detect-no-truncate`
- 커밋 제목: `fix(policy): 감지 기록과 대기 수가 소스당 5건에서 잘리지 않음 (Sprint 1118-plan209)`. 본문에 `[근본 원인]`, `[Fix 내용]`, `[회귀 위험]`.
- 푸시하지 않는다.

## 단계

### 1단계: `run()` 이 전체 목록도 함께 돌려주게 한다

`backend/jobs/regulationsAutoFetch.js:193-208` 의 반환을 아래 모양으로 바꾼다. 같은 변환을 두 번 쓰지 않게 작은 함수로 뺀다.

```js
  // POLICY-NOCUT-1118 (plans/209): 응답은 종전대로 소스당 5건만 싣는다. 저장과 계수는 걸린 글 전부(matchedAll)를 쓴다.
  //   종전에는 5건으로 자른 목록이 저장(persistDetected)과 대기 수(pendingReview)까지 그대로 갔다.
  //   한 소스에서 한 번에 6건 넘게 걸리면 6번째부터는 저장되지 않았다.
  const _slim = (m) => ({
    title: m.title.slice(0, 200),
    link: m.link,
    pubDate: m.pubDate ? m.pubDate.toISOString() : null,
    hits: m.hits,
  });
  return {
    sources: results.map(r => ({
      name: r.name,
      total: r.total,
      matched_count: r.matched.length,
      matched: r.matched.slice(0, 5).map(_slim), // 최대 5건만 응답
      matchedAll: r.matched.map(_slim),
      error: r.error,
    })),
    totalMatched,
    topAlert,
  };
```

**확인**: `cd backend` 뒤 `node -e "require('./jobs/regulationsAutoFetch')"` → 오류 없음.

### 2단계: `runFullCheck()` 가 전체 목록으로 견주고 저장하게 한다

`backend/jobs/regulationsAiCheck.js` 의 `runFullCheck()` 에서

1. `const rssSummary = await runRssAutoFetch();` 바로 아래에 더한다.

```js
  // POLICY-NOCUT-1118 (plans/209): 견주기와 저장에는 자르지 않은 목록을 쓴다(없으면 종전 목록).
  const fullSources = (rssSummary.sources || []).map((s) => ({ ...s, matched: Array.isArray(s.matchedAll) ? s.matchedAll : s.matched }));
```

2. `analyzeRegulations(rssSummary.sources, currentSnapshot)` 을 `analyzeRegulations(fullSources, currentSnapshot)` 으로 바꾼다.
3. `persistDetected(rssSummary.sources, currentSnapshot)` 을 `persistDetected(fullSources, currentSnapshot)` 으로 바꾼다.
4. 반환의 `rssResults: rssSummary,` 를 아래로 바꾼다. 예약 작업 응답이 커지지 않게 전체 목록은 뺀다.

```js
    rssResults: { ...rssSummary, sources: (rssSummary.sources || []).map(({ matchedAll, ...rest }) => rest) }, // POLICY-NOCUT-1118: 응답에는 소스당 5건만
```

린트가 쓰지 않는 변수(`matchedAll`)를 지적하면 이 저장소의 린트 설정에서 그 규칙이 켜져 있는지 `eslint.config.mjs` 를 읽고, 켜져 있으면 `const rest = { ...s }; delete rest.matchedAll; return rest;` 모양으로 바꾼다.

**확인**: `grep -n "rssSummary.sources, currentSnapshot" backend/jobs/regulationsAiCheck.js` → 결과 없음. `node -e "require('./jobs/regulationsAiCheck')"` → 오류 없음.

### 3단계: 회귀 검사를 더한다

`backend/test/policy-detect-1116.test.js` 끝에 검사 두 개를 더한다. 이 파일은 이미 `mergeDetected`, `pendingCounts` 를 불러 쓰고 있다(15행).

검사 A: `run()` 의 반환에 전체 목록이 있다
- `regulationsAutoFetch.js` 가 쓰는 `axios` 를 `require.cache` 로 가짜로 바꿔 끼우고 모듈을 다시 읽는다. 가짜 `axios.get` 은 주소와 관계없이 `<item>` 이 8개인 RSS 글자열을 돌려준다. 각 항목의 제목에 "주택"을 넣고 `pubDate` 는 지금 시각으로 둔다(`new Date().toUTCString()`). 항목 글자열의 모양은 같은 파일 32행 검사가 `parseRss` 에 넣는 글자열을 본뜬다.
- `run()` 결과에서 국토교통부 소스를 찾아 `matched.length === 5`, `matchedAll.length === 8`, `matched_count === 8` 을 확인한다.
- `finally` 에서 끼운 모듈을 되돌린다.

검사 B: 6번째 글도 저장되고 세어진다
- 소스 하나에 글 8개가 든 목록(각각 링크가 다르고 제목에 "주택", `pubDate` 는 2026-11-17)을 만들어 `mergeDetected([], [{ name: '국토교통부', matched: 여덟 개 }], 지금)` 을 부르면 8건이 남는다.
- 그 결과로 `pendingCounts(items, [{ key: 'housing_loan_2025', source_effective_date: '2026-11-10' }])` 을 부르면 `housing_loan_2025` 가 8 이다.
- 이 검사는 `mergeDetected` 와 `pendingCounts` 가 넘겨받은 만큼 다 쓴다는 것을 고정한다(자르는 곳이 다시 생기면 깨진다).

79행의 배선 검사가 `persistDetected(rssSummary.sources` 같은 옛 글자를 요구하면 새 글자(`persistDetected(fullSources`)로 고친다. 그 밖의 단언은 건드리지 않는다.

**확인**: `cd backend` 뒤 `TZ=UTC node --test test/policy-detect-1116.test.js` → `ℹ fail 0`, 검사 7개.

### 4단계: 전체 검증

저장소 루트에서 `npm run verify`.

**확인**: exit 0, `ℹ fail 0`, 검사 수 1,276개(1,274 + 2).

## 검사 계획

- 새 검사 2개: `backend/test/policy-detect-1116.test.js` 끝(A, B).
- 본보기: 같은 파일의 32행(RSS 글자열), 45행(`mergeDetected`), 64행(`pendingCounts`). 모듈 끼우기는 `backend/test/rent-jeonse.test.js:249-284`.

## 끝났다고 볼 조건

- [ ] `npm run verify` 가 exit 0 이고 `ℹ fail 0`
- [ ] `grep -n "rssSummary.sources, currentSnapshot" backend/jobs/regulationsAiCheck.js` 결과 없음
- [ ] `grep -n "matched: r.matched.slice(0, 5)" backend/jobs/regulationsAutoFetch.js` 결과가 한 줄 있다(응답은 여전히 5건)
- [ ] `runFullCheck()` 반환의 `rssResults.sources` 에 `matchedAll` 이 없다(검사나 `node -e` 로 확인하지 말고 코드로 확인한다. 실행하면 정부 RSS 를 부른다)
- [ ] `git status --short` 에 범위 밖 파일이 없다
- [ ] `plans/README.md` 의 209 줄 상태를 고쳤다

## 멈춤 조건

- "지금 상태"의 발췌와 실제 코드가 다르다.
- `run()` 의 반환을 `regulationsAiCheck.js` 와 `routes/cron.js` 밖에서 쓰는 코드가 있다(`grep -rn "regulationsAutoFetch" backend --include=*.js` 로 확인. `backend/test` 는 뺀다).
- 검사를 통과시키려면 낱말 목록이나 저장 상한을 바꿔야 한다는 결론이 난다.
- 검사가 실제 정부 주소를 부르려 한다(가짜 `axios` 가 끼워지지 않았다).

## 뒤에 맡을 사람에게

- 이 변경 뒤 첫 실행에서 `pendingReview` 가 0 이 아닌 값으로 뛸 수 있다. 지금까지 잘려서 안 세어지던 글이 들어오기 때문이다. 그때는 저장소 규칙대로 그 보도자료들의 원문(본문과 첨부)을 열어 저장된 기준과 대조한다. 제목만 보고 넘기지 않는다.
- 낱말이 넓어서("주택", "부동산") 관련 없는 글이 많이 걸릴 수 있다. 그것이 불편해지면 낱말을 줄이기 전에, 놓치면 안 되는 실제 제목(`policy-detect-1116.test.js:20-30` 에 모아 둔 것)이 계속 걸리는지부터 본다.
- 대기 수가 0 이 아니어도 알림은 가지 않는다(health 에 숫자만 남는다). 하루 한 번 알림을 보내는 것은 별도 제안이다.
- 살피는 기준 시각이 UTC 자정이라 검증 다음 날 한국 시간 0~9시에 나온 글이 빠질 수 있다는 지적이 있었다(`regulationsAiCheck.js:96`). 이 계획에서는 확인하지 않았다.
