# Plan 212: 정책 보도자료 소스를 못 읽으면 실행 기록과 알림으로 드러나게 한다

> **실행자에게**: 이 계획을 순서대로 따른다. 단계마다 확인 명령을 돌려 기대 결과가 나온 뒤에 다음 단계로 간다.
> "멈춤 조건"에 해당하면 스스로 고치려 하지 말고 멈추고 보고한다. 끝나면 `plans/README.md` 의 212 줄 상태를 고친다.
>
> **먼저 할 일(변경 확인)**: `git diff --stat 55c56b4..HEAD -- backend/jobs/regulationsAutoFetch.js backend/jobs/regulationsAiCheck.js backend/routes/cron.js backend/services/cronStats.js`
> `plans/209` 가 먼저 두 작업 파일(`regulationsAutoFetch.js`, `regulationsAiCheck.js`)을 고친다. 그 변경(`matchedAll`, `fullSources`)만 있으면 정상이다. 그 밖의 차이가 있으면 "지금 상태"의 발췌와 견주고, 다르면 멈춤 조건이다. 줄 번호는 209 뒤에 조금 밀려 있으므로 발췌의 글자로 자리를 찾는다.

## 상태

- **우선순위**: P1
- **작업량**: S
- **위험**: LOW
- **선행 계획**: `plans/209-policy-detect-no-truncate.md` (같은 파일을 고친다. 209 가 끝난 뒤에 한다)
- **범주**: bug
- **기준**: 커밋 `55c56b4`, 2026-11-18

## 왜 필요한가

이 서비스는 대출과 세금 기준을 화면에 보여 주고, 정부가 새 대책을 내면 사람이 원문과 대조해 고친다. 새 발표를 놓치지 않으려고 예약 작업이 날마다 정부 보도자료 목록 네 곳을 읽어 관련 글 수(`pendingReview`)를 health 에 남긴다. 작업 규칙은 "작업을 시작할 때 `pendingReview` 를 보고 0 이 아니면 원문을 대조한다"이다.

2026-11-18 에 확인한 사실은 이렇다.
- 네 소스 가운데 셋(국토교통부, 국세청, 정책브리핑)은 정책브리핑(korea.kr)의 RSS 주소다. 이 주소들은 지금 404 를 준다. 정책브리핑 공지 "정책브리핑 RSS 서비스 제공 중단 안내"(등록일 2026.07.01, https://www.korea.kr/etc/noticeView.do?newsId=132038885 )에 중단일시 2026. 7. 1., 중단사유 "콘텐츠 저작권 등 권리 보호에 따른 제공방식 변경"이라고 적혀 있다.
- 나머지 하나(금융위원회 RSS)는 같은 날 503 과 "현재 RSS 서비스 점검 중입니다."를 줬다. 언제부터인지는 확인하지 못했다.
- 운영 health 의 `crons['regulations-auto-fetch']` 는 11-16 과 11-17 회차 모두 `{"pendingReview":0,"processed":0,"ok":1}` 이었다. 네 소스를 모두 못 읽었는데 기록은 성공이고 대기 수는 0 이다.

즉 `pendingReview: 0` 은 "새 발표가 없다"가 아니라 "아무것도 읽지 못했다"일 수 있는데 둘이 구별되지 않는다. 소스가 실패하면 경고 로그 한 줄만 남고(함수 로그는 1시간만 보관된다) 실행 기록과 알림에는 아무 흔적이 없다. 이 계획이 끝나면 못 읽은 소스 수가 실행 기록과 health 에 남고, 하나라도 못 읽으면 Sentry 로 알린다. 소스를 무엇으로 바꿀지는 이 계획의 범위가 아니다(아래 "뒤에 맡을 사람에게").

## 지금 상태

- `backend/jobs/regulationsAutoFetch.js` : 정부 RSS 를 받아 낱말에 걸린 글을 고른다.
- `backend/jobs/regulationsAiCheck.js` : `runFullCheck()` 가 위 작업을 부르고 감지 기록과 대기 수를 만든다.
- `backend/routes/cron.js` : 예약 작업 처리기 `handleRegulationsAutoFetch`.
- `backend/services/cronStats.js` : 실행 기록에 남길 숫자 이름 목록(`NUM`)과 걸러 내는 함수 `_pick`.

소스 하나를 읽는 함수는 실패를 예외로 올리지 않고 `error` 에 담는다. `backend/jobs/regulationsAutoFetch.js:115-140`

```js
async function fetchSource(src) {
  try {
    const resp = await axios.get(src.url, { ... });
    const items = parseRss(resp.data);
    ...
    return { name: src.name, total: items.length, matched, error: null };
  } catch (e) {
    return { name: src.name, total: 0, matched: [], error: e.message };
  }
}
```

`run()` 은 실패와 "항목 0개"를 경고 로그로만 남긴다. `backend/jobs/regulationsAutoFetch.js:155-164`

```js
  for (const r of results) {
    totalMatched += r.matched.length;
    if (r.error) {
      logger.warn({ source: r.name, err: r.error }, 'regulations-auto-fetch: 소스 fetch 실패');
    } else if (r.total === 0) {
      // COVERAGE-2026-06-13: fetch 는 성공했으나 <item> 0개 = RSS 가 깨짐(HTML/리다이렉트/오류 응답을 받아 파싱 0).
      ...
      logger.warn({ source: r.name, url: r.url || null }, 'regulations-auto-fetch: 소스가 0개 항목 반환 — RSS URL 점검 필요(HTML/오류 응답 가능성)');
    }
```

`run()` 의 반환(`plans/209` 뒤에는 `sources` 의 각 항목에 `matchedAll` 이 더 있다). `backend/jobs/regulationsAutoFetch.js:193-208`

```js
  return {
    sources: results.map(r => ({ name: r.name, total: r.total, matched_count: r.matched.length, matched: ..., error: r.error })),
    totalMatched,
    topAlert,
  };
```

`runFullCheck()` 의 반환. `backend/jobs/regulationsAiCheck.js:241-251`

```js
  return {
    rssResults: rssSummary,          // plans/209 뒤에는 matchedAll 을 뺀 사본
    aiResults,
    currentSnapshot: currentSnapshot.map(s => ({ ... })),
    timestamp: new Date().toISOString(),
    pendingReview: pending.total,
```

처리기. `backend/routes/cron.js:640-653`

```js
async function handleRegulationsAutoFetch(req, res) {
  try {
    const started = Date.now();
    const result = await runRegulationsAiCheck();
    logger.info({ ... }, 'cron/regulations-auto-fetch OK');
    await require('../services/cronStats').recordCronRun('regulations-auto-fetch', {   // Sprint MMMMMMM-12
      ok: 1, processed: result.rssResults && result.rssResults.totalMatched,
      pendingReview: result.pendingReview, // POLICY-MISS-1116: 검증일 뒤에 쌓인 관련 보도자료 수(0 이 정상)
    }).catch(() => {});
    res.json({ ok: true, ...result });
```

같은 파일의 알림 본보기. `backend/routes/cron.js:107` 부근(파일 위쪽에서 `const Sentry = require('../sentry');` 로 불러 둔 것을 쓴다)

```js
      Sentry.captureMessage('cron 감시: 실거래 적재가 48시간 이상 정체 — molit cron·API 키 확인 필요', {
        level: 'error', tags: { route: 'cron.retention', monitor: 'data-freshness' },
```

숫자 이름 목록의 끝. `backend/services/cronStats.js:103-106`

```js
    // CPU-BUDGET-1115: 어제(UTC) 하루 동안 함수가 쓴 CPU(ms). 30일 합계 한도(팀 4시간)를 날마다 따라가기 위한 값.
    'cpuYesterdayMs',
    // CANCEL-SYNC-2026-10-30 (Plan 172): 적재 뒤 해제돼 원본에서 지운 거래 수(0 이 흔하다 — 필드 부재와 구별).
    'canceledRemoved'];
```

저장소 규칙
- `cronStats` 의 `NUM` 목록에서 마지막 항목은 `canceledRemoved` 여야 한다(`backend/test/molit-cancel-sync.test.js:102` 가 `'canceledRemoved'\]` 를 본다). 새 이름은 그 앞에 넣는다.
- 백엔드 코드는 `@sentry/node` 를 직접 부르지 않고 `../sentry` 를 부른다.
- 알림 문장은 고정 문장으로 쓴다(값이 바뀌어도 Sentry 에서 한 문제로 묶이게). 바뀌는 값은 `extra` 에 넣는다.
- 주석은 한국어, 이름표는 `POLICY-SRC-FAIL-1118`.
- 검사는 `node:test`, `node:assert/strict`. 정부 주소를 실제로 부르지 않는다.

## 쓸 명령

| 목적 | 명령 | 성공했을 때 |
|---|---|---|
| 검사 하나 | `cd backend` 뒤 `TZ=UTC node --test test/policy-detect-1116.test.js` (PowerShell 은 `$env:TZ='UTC'; node --test test/policy-detect-1116.test.js`) | `ℹ fail 0` |
| 전체 검증 | 저장소 루트에서 `npm run verify` | exit 0, 끝에 `ℹ fail 0` |

## 범위

**고쳐도 되는 파일**
- `backend/jobs/regulationsAutoFetch.js` (`run()` 의 반환에 두 칸 추가)
- `backend/jobs/regulationsAiCheck.js` (`runFullCheck()` 의 반환에 두 칸 추가)
- `backend/routes/cron.js` (`handleRegulationsAutoFetch` 안)
- `backend/services/cronStats.js` (`NUM` 에 이름 두 개)
- `backend/test/policy-detect-1116.test.js` (검사 추가)
- `CLAUDE.md` ("정책 기준" 절의 첫 줄에 한 문장 추가)
- `plans/README.md` (212 줄의 상태만)

**고치면 안 되는 것**
- 소스 주소(`RSS_SOURCES` 의 `url`)와 낱말 목록. 소스를 무엇으로 바꿀지는 운영자가 정할 일이다. 이 계획에서 주소를 바꾸거나 새 주소를 넣지 않는다.
- `fetchSource`, `parseRss`, `mergeDetected`, `pendingCounts`, `analyzeRegulations` 의 본문.
- 예약 작업의 응답 코드: 소스를 못 읽어도 처리기는 종전대로 200 을 준다(500 을 주면 Vercel 이 다시 부르거나 다른 감시가 겹쳐 울린다).
- `NUM` 의 마지막 항목(`canceledRemoved`).
- `.env` 로 시작하는 파일은 읽지도 않는다.

## Git 작업 방식

- 브랜치: `advisor/212-policy-sources-failure-visible`
- 커밋 제목: `fix(policy): 보도자료 소스를 못 읽은 수를 실행 기록과 알림으로 드러냄 (Sprint 1118-plan212)`. 본문에 `[근본 원인]`, `[Fix 내용]`, `[회귀 위험]`.
- 푸시하지 않는다.

## 단계

### 1단계: `run()` 이 못 읽은 소스 수를 돌려준다

`backend/jobs/regulationsAutoFetch.js` 의 `run()` 반환 객체에 두 칸을 더한다(`totalMatched,` 줄 위).

```js
    // POLICY-SRC-FAIL-1118 (plans/212): 못 읽은 소스 수. 오류가 났거나 항목이 0개인 소스를 센다.
    //   종전에는 경고 로그만 남아서, 네 곳을 모두 못 읽은 날도 실행 기록은 성공이고 대기 수는 0 이었다.
    sourcesTotal: results.length,
    sourcesFailed: results.filter(r => r.error || r.total === 0).length,
```

**확인**: `cd backend` 뒤 `node -e "require('./jobs/regulationsAutoFetch')"` → 오류 없음.

### 2단계: `runFullCheck()` 가 그 수를 위로 올린다

`backend/jobs/regulationsAiCheck.js` 의 `runFullCheck()` 반환에서 `pendingReview: pending.total,` 줄 아래에 더한다.

```js
    // POLICY-SRC-FAIL-1118 (plans/212): 못 읽은 소스 수(0 이 정상). 0 이 아니면 pendingReview 0 을 "새 발표 없음"으로 읽으면 안 된다.
    sourcesTotal: rssSummary.sourcesTotal,
    sourcesFailed: rssSummary.sourcesFailed,
```

`pendingReview: pending.total,` 줄은 글자 그대로 둔다(기존 검사가 그 글자를 본다).

**확인**: `node -e "require('./jobs/regulationsAiCheck')"` → 오류 없음.

### 3단계: 실행 기록에 남기고 알린다

`backend/routes/cron.js` 의 `handleRegulationsAutoFetch` 에서

1. `recordCronRun('regulations-auto-fetch', { ... })` 의 객체에 한 줄을 더한다. `pendingReview: result.pendingReview,` 줄은 글자 그대로 둔다.

```js
      sourcesFailed: result.sourcesFailed, sourcesTotal: result.sourcesTotal, // POLICY-SRC-FAIL-1118: 못 읽은 소스 수(0 이 정상)
```

2. 그 `recordCronRun` 호출 바로 아래, `res.json(...)` 위에 더한다.

```js
    // POLICY-SRC-FAIL-1118 (plans/212): 소스를 하나라도 못 읽었으면 날마다 알린다. 문장은 고정하고(한 문제로 묶임) 수는 extra 에 넣는다.
    //   이 알림이 오는 동안에는 pendingReview 0 이 "새 발표 없음"을 뜻하지 않는다. 원문을 직접 확인해야 한다.
    if (Number(result.sourcesFailed) > 0) {
      try {
        Sentry.captureMessage('정책 감지: 정부 보도자료 소스를 읽지 못함 — 소스 주소와 대체 경로 확인 필요', {
          level: 'error', tags: { route: 'cron.regulations-auto-fetch', monitor: 'policy-sources' },
          extra: { sourcesFailed: result.sourcesFailed, sourcesTotal: result.sourcesTotal,
            failed: ((result.rssResults && result.rssResults.sources) || []).filter(s => s.error || s.total === 0).map(s => ({ name: s.name, error: s.error ? String(s.error).slice(0, 120) : 'items=0' })) },
        });
      } catch (_) { /* 알림 실패가 본 처리를 막지 않는다 */ }
    }
```

`extra` 에 소스 주소나 응답 본문을 넣지 않는다. 이름과 오류 문장 앞 120자만 넣는다.

**확인**: `node -e "require('./routes/cron')"` 를 `backend` 폴더에서 → 오류 없음. `grep -n "pendingReview: result.pendingReview," backend/routes/cron.js` → 한 줄 그대로 있다.

### 4단계: 숫자 이름 목록에 더한다

`backend/services/cronStats.js` 의 `NUM` 에서 `'cpuYesterdayMs',` 줄 아래, `'canceledRemoved'];` 주석 위에 더한다.

```js
    // POLICY-SRC-FAIL-1118 (plans/212): 정책 보도자료 소스 가운데 못 읽은 수와 전체 수. sourcesFailed 가 0 이 아니면 pendingReview 를 믿으면 안 된다.
    'sourcesFailed', 'sourcesTotal',
```

**확인**: `node -e "const {_pick}=require('./services/cronStats');console.log(JSON.stringify(_pick({ok:1,processed:0,pendingReview:0,sourcesFailed:4,sourcesTotal:4})))"` → 출력에 `"sourcesFailed":4` 와 `"sourcesTotal":4` 가 있다. `grep -n "'canceledRemoved'\];" backend/services/cronStats.js` → 한 줄 있다.

### 5단계: 작업 규칙 문서에 한 문장을 더한다

저장소 루트의 `CLAUDE.md` 에서 "정책 기준" 절의 첫 줄을 찾는다. 그 줄은 이렇게 시작한다: `- 작업을 시작할 때 health 의 \`crons['regulations-auto-fetch'].pendingReview\` 를 본다.` 그 줄의 `→` 표시 앞에 한 문장을 끼운다(다른 글자는 그대로 둔다).

```
같은 기록의 `sourcesFailed` 가 0 이 아니면 소스를 못 읽은 것이라 `pendingReview` 0 을 믿지 않고 정부 누리집에서 직접 확인한다(2026-07-01 정책브리핑 RSS 중단, plans/212).
```

**확인**: `grep -c "sourcesFailed" CLAUDE.md` → 1.

### 6단계: 회귀 검사를 더한다

`backend/test/policy-detect-1116.test.js` 끝에 검사 세 개를 더한다.

검사 A: 모든 소스가 실패하면 `run()` 이 그 수를 돌려준다
- `regulationsAutoFetch.js` 가 쓰는 `axios` 를 `require.cache` 로 가짜로 바꿔 끼우고 모듈을 다시 읽는다. 가짜 `axios.get` 은 항상 `Error('Request failed with status code 404')` 를 던진다.
- `run()` 결과에서 `sourcesTotal` 이 `RSS_SOURCES.length` 와 같고 `sourcesFailed` 가 같은 값이며 `totalMatched` 가 0 이다.
- 가짜를 "항목이 하나도 없는 XML"(`'<rss><channel></channel></rss>'`)을 돌려주게 바꾸면 역시 `sourcesFailed` 가 전체와 같다(항목 0개도 못 읽은 것으로 센다).
- 가짜를 항목 1개짜리 RSS 를 돌려주게 바꾸면 `sourcesFailed` 가 0 이다. 항목 글자열은 같은 파일 32행 검사가 `parseRss` 에 넣는 글자열을 본뜬다.
- `finally` 에서 끼운 모듈을 되돌린다. 끼우고 되돌리는 방식은 `backend/test/rent-jeonse.test.js:249-284` 를 본뜬다.

검사 B: 실행 기록이 그 수를 통과시킨다
- `require('../services/cronStats')._pick({ ok: 1, processed: 0, pendingReview: 0, sourcesFailed: 4, sourcesTotal: 4 })` 의 `sourcesFailed` 가 4, `sourcesTotal` 이 4 다.
- `cronStats.js` 소스에 `'canceledRemoved'];` 가 여전히 있다.

검사 C: 배선
- `cron.js` 소스에 `sourcesFailed: result.sourcesFailed` 와 `monitor: 'policy-sources'` 가 있다.
- `regulationsAiCheck.js` 소스에 `sourcesFailed: rssSummary.sourcesFailed` 가 있다.
- `cron.js` 소스에서 `handleRegulationsAutoFetch` 함수 구간에 `res.status(500)` 이 한 번만 있다(소스 실패로 500 을 주는 분기를 새로 만들지 않았다는 뜻. 기존 catch 의 한 번은 그대로다).

**확인**: `cd backend` 뒤 `TZ=UTC node --test test/policy-detect-1116.test.js` → `ℹ fail 0`, 검사 수가 3개 늘었다.

### 7단계: 전체 검증

저장소 루트에서 `npm run verify`.

**확인**: exit 0, `ℹ fail 0`.

## 검사 계획

- 새 검사 3개: `backend/test/policy-detect-1116.test.js` 끝(A, B, C).
- 고치지 않고 통과해야 하는 검사: `backend/test/molit-cancel-sync.test.js`(목록의 마지막 항목), `backend/test/cron-observability.test.js`.

## 끝났다고 볼 조건

- [ ] `npm run verify` 가 exit 0 이고 `ℹ fail 0`
- [ ] `grep -n "url:" backend/jobs/regulationsAutoFetch.js` 의 소스 주소 네 줄이 그대로다(`git diff` 에 그 줄이 없다)
- [ ] `grep -n "'canceledRemoved'\];" backend/services/cronStats.js` 가 한 줄 있다
- [ ] `grep -c "sourcesFailed" CLAUDE.md` 가 1 이다
- [ ] `git status --short` 에 범위 밖 파일이 없다
- [ ] `plans/README.md` 의 212 줄 상태를 고쳤다

## 멈춤 조건

- `plans/209` 가 끝나 있지 않다(`grep -n "matchedAll" backend/jobs/regulationsAutoFetch.js` 에 결과가 없다).
- "지금 상태"의 발췌와 실제 코드의 글자가 다르다(209 의 변경은 빼고).
- `backend/routes/cron.js` 위쪽에 `const Sentry = require('../sentry');` 가 없다.
- 검사를 통과시키려면 소스 주소나 낱말 목록을 바꿔야 한다는 결론이 난다.
- 검사가 실제 정부 주소를 부르려 한다.

## 뒤에 맡을 사람에게

- 이 계획은 "못 읽고 있다"를 보이게만 한다. 읽을 수 있게 만들지는 않는다. 배포하면 네 소스가 살아나기 전까지 날마다 Sentry 알림이 온다. 그것이 지금의 사실이다.
- 소스를 무엇으로 바꿀지는 운영자가 정한다. 정할 때 볼 것:
  - 정책브리핑은 RSS 를 "콘텐츠 저작권 등 권리 보호에 따른 제공방식 변경"을 사유로 닫았다. 같은 누리집의 목록 화면을 서버가 긁어 오는 방식은 그 사유와 부딪칠 수 있다.
  - 금융위원회 RSS 는 2026-11-18 에 "점검 중"이었다. 다시 열리는지 며칠 본다.
  - 국토교통부와 금융위원회 누리집의 보도자료 목록, 공공데이터포털에 정책브리핑 자료를 주는 공개 API 가 있는지는 이 계획에서 확인하지 않았다.
  - 서버가 읽을 소스를 다시 마련하기 전까지는 사람이 직접 본다. 이 저장소의 규칙은 "마지막 검증일부터 오늘까지 나온 발표 전부를 본문과 첨부로 대조"다. 마지막 전체 대조는 2026-11-16 이다.
- 2026-07-01 부터 넉 달 넘게 세 소스가 닫혀 있었다. 2026-08-13 대책이 석 달 동안 반영되지 않은 일(2026-11-16 확인)의 원인 가운데 하나였을 수 있다. 그때 원인으로 적은 것은 "제목 낱말만 봤다"와 "감지해도 남지 않았다" 두 가지였고, 소스가 닫혀 있었다는 것은 그때 확인하지 않았다.
- `HANDOFF.md` 의 "작업을 시작하면 pendingReview 를 본다"는 문장에도 같은 단서를 달아야 한다(이 계획의 범위에는 `CLAUDE.md` 만 넣었다).
