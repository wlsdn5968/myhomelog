/**
 * backend/test/cron-observability.test.js
 *
 * characterization.test.js(Plan 066, 10,056줄·327 test 단일 파일)를 도메인별로 분할한 조각.
 * 동작을 하나도 바꾸지 않는 이동이다 — 테스트 이름·개수·본문은 원본과 동일하다.
 * 공용 목/스텁 유틸은 ./_helpers 에서 가져온다. 새 테스트는 이 파일의 주제와 맞으면 여기에,
 * 아니면 backend/test/README.md 규칙대로 새 도메인 파일을 만든다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _authorizeCron, _mkCronRes, _mockCronAdmin, _mockRes, _requireCronMolitHandler } = require('../testSupport/_helpers');



// ── Sprint XXXXXX: cron 관측 기록이 /api/health 로 새면 안 되는 값을 거르는지 ──────────
//   cronStats 는 job summary 를 Redis 에 담고 그 최근 1회가 **공개 health 응답**에 실린다.
//   job 이 나중에 새 필드(키·경로·사용자 식별자 등)를 요약에 추가해도 자동으로 노출되지 않도록
//   숫자 화이트리스트만 통과시키는데, 그 성질을 여기서 고정한다.
test('cronStats._pick — 숫자 화이트리스트만 통과, 그 외 필드는 유출되지 않는다', () => {
  const { _pick } = require('../services/cronStats');
  const out = _pick({
    inserted: 142, processed: 400, failed: 258, elapsedMs: 251000, poolSize: 3800,
    // 아래는 전부 빠져야 한다
    apiKey: 'secret-value', token: 'abc', userEmail: 'a@b.c', rows: [{ aptName: '홍길동아파트' }],
    kakao: { key: 'k' }, nested: { deep: { x: 1 } },
  });
  assert.deepEqual(out, { processed: 400, inserted: 142, failed: 258, poolSize: 3800, elapsedMs: 251000 });
  for (const k of ['apiKey','token','userEmail','rows','kakao','nested']) {
    assert.equal(k in out, false, `${k} 가 화이트리스트를 통과했다 — health 로 유출된다`);
  }
  // 실패 표기는 남긴다(진단 목적) — 단 문자열은 길이 제한
  const err = _pick({ ok: false, error: 'x'.repeat(500) });
  assert.equal(err.ok, false);
  assert.equal(err.error.length, 120);
  // 숫자가 아닌 값이 숫자 필드에 와도 통과시키지 않는다
  assert.deepEqual(_pick({ inserted: 'NaN아님', processed: null }), {});
  // MV-REFRESH-ERROR-2026-09-05 (감사 G-4): 실패 사유는 통과하되 길이 제한 · 빈 문자열은 키 자체를 만들지 않는다
  assert.equal(_pick({ mvRefreshError: 'x'.repeat(300) }).mvRefreshError.length, 120);
  assert.equal('mvRefreshError' in _pick({ mvRefreshError: '  ' }), false);
  const cronSrc = require('node:fs').readFileSync(require('node:path').join(__dirname, '../routes/cron.js'), 'utf8');
  assert.match(cronSrc, /mvRefreshError: _mvRefreshError,/, 'cron 이 MV 갱신 실패 사유를 기록에 넘기지 않는다');
  assert.match(cronSrc, /if \(_mvErr\) \{ _mvRefreshError = _mvErr\.message;/, 'RPC 오류가 사유로 남지 않는다');
  assert.deepEqual(_pick(null), {});
  // Sprint AAAAAAA: molit-ingest 카운터(ok·err·skipped)는 숫자일 때 통과, boolean 실패 표기와 공존
  assert.deepEqual(_pick({ ok: 0, err: 9, skipped: 108 }), { ok: 0, err: 9, skipped: 108 });
});



// ZERO-FETCH-WATCH (2026-08-10): 광주 5개 구가 44일간 rows_fetched=0 인데 status='ok' 라
//   기존 지표(ok/err)로 전혀 안 보였다. 관측 필드를 열되 화이트리스트의 보안 성질은 유지해야 한다.
test('cronStats._pick — 지역 정체 감시 필드는 통과, 임의 필드는 여전히 차단', () => {
  const { _pick } = require('../services/cronStats');
  const out = _pick({
    zeroFetchRegions: 5, zeroFetchLawds: '29110,29140,29155', slot: 2, regionsCount: 39,
    verifyFixed: 12, rehealHealed: 3,
    serviceKey: 'SECRET', apiKey: 'SECRET', results: [{ lawdCd: '29110' }],
  });
  assert.equal(out.zeroFetchRegions, 5);
  assert.equal(out.zeroFetchLawds, '29110,29140,29155'); // 법정동 코드 = 공개 정보
  assert.equal(out.slot, 2);
  assert.equal(out.verifyFixed, 12);
  assert.equal(out.rehealHealed, 3);
  // 화이트리스트 밖은 무조건 배제 (민감값 유출 방지 — 이 성질이 깨지면 안 된다)
  assert.equal(out.serviceKey, undefined);
  assert.equal(out.apiKey, undefined);
  assert.equal(out.results, undefined);
  // 빈 문자열은 "보고되지 않음"이므로 키 자체가 없어야 한다
  assert.equal(_pick({ zeroFetchLawds: '' }).zeroFetchLawds, undefined);
});



test('규제 감시 — 룰베이스 대조는 SQL·confidence 를 만들지 않는다 (REG-ZERO-COST, Sentry NODE-7)', async () => {
  const { analyzeRegulations } = require('../jobs/regulationsAiCheck');
  // 스냅샷 key 리터럴을 `key:` 자리에 직접 두지 않는다 — gitleaks generic-api-key 가
  //   "key: '<고엔트로피 문자열>'" 을 자격증명으로 오탐해 CI 가 실제로 막혔다(run 31917863984).
  //   (.gitleaks.toml allowlist 로도 막아뒀다. 여기 상수명에도 key/token/secret 을 쓰지 말 것.)
  const TAX_SNAP = 'acquisition_tax_2025';
  const LOAN_SNAP = 'housing_loan_2025';
  const snap = [
    { key: TAX_SNAP, note: '취득세 스냅샷' },
    { key: LOAN_SNAP, note: '주담대 스냅샷' },
  ];
  const src = (name, matched) => ({ name, matched });

  // ① 매칭 항목 0건 → 확인 필요 0, topAlert 없음
  const none = await analyzeRegulations([src('국세청', [])], snap);
  assert.equal(none.reviewNeededCount, 0);
  assert.equal(none.topAlert, null);

  // ② 취득세 보도자료는 취득세 key 에만 붙는다 (주제 키워드 분리 — 전 key 무차별 매칭 회귀 차단)
  const tax = await analyzeRegulations([src('국세청', [
    { title: '2026년 취득세 중과 개편 방안', link: 'https://korea.kr/x', pubDate: new Date('2026-08-14'), hits: ['취득세', '중과'] },
  ])], snap);
  const byKey = Object.fromEntries(tax.analysis.map(a => [a.key, a]));
  assert.equal(byKey[TAX_SNAP].evidenceCount, 1);
  assert.equal(byKey[LOAN_SNAP].evidenceCount, 0, '취득세 기사가 주담대 스냅샷에도 붙음');
  assert.equal(byKey[TAX_SNAP].reviewNeeded, true);

  // ③ 환각 차단 계약: 어떤 경우에도 proposedSQL·confidence 를 지어내지 않고, '변경'을 단정하지 않는다.
  //    (종전 AI 판정은 confidence≥90 이면 UPDATE 문까지 생성했다 — 되살리면 이 테스트가 깨진다.)
  for (const a of tax.analysis) {
    assert.equal(a.proposedSQL, null, `proposedSQL 자동 생성 부활: ${a.key}`);
    assert.equal(a.confidence, null, `confidence 점수 조작 부활: ${a.key}`);
    assert.equal(a.changeDetected, false, `룰베이스가 변경을 단정: ${a.key}`);
  }
  assert.ok(/변경 확정 아님/.test(tax.topAlert), 'topAlert 가 변경을 단정하는 문구로 회귀');
});



test('규제 감시 — 주제 키워드 미정의 key 는 누락이 아니라 과보고로 실패한다 (REG-ZERO-COST)', async () => {
  const { analyzeRegulations } = require('../jobs/regulationsAiCheck');
  const FUTURE_SNAP = 'future_policy_2027'; // 상수명에 key/token/secret 금지 (gitleaks 오탐)
  const r = await analyzeRegulations([{ name: '금융위원회', matched: [
    { title: '주택담보대출 LTV 규제 조정', link: 'https://fsc.go.kr/y', pubDate: new Date('2026-08-15'), hits: ['LTV'] },
  ] }], [{ key: FUTURE_SNAP, note: '미정의 키' }]);
  assert.equal(r.analysis[0].evidenceCount, 1, '미정의 key 가 조용히 0건으로 떨어짐');
  assert.ok(/미정의 key/.test(r.analysis[0].reasoning));
});



// SNAPROLE-2026-08-16 (Sprint MMMMMMM) — NODE-9 순환의 마지막 고리를 고정한다.
//   실측: pg_db_role_setting 의 anon.statement_timeout = 3s, service_role 은 항목 없음.
//   집계 RPC 를 2회 연속 EXPLAIN ANALYZE 한 결과 **콜드 5,672ms → 웜 198ms**(정렬이 work_mem 을
//   넘겨 temp 481/483 디스크로 흐름). cron 은 하루 1회라 항상 콜드에 가까워 3s 를 확실히 초과 →
//   08-14·08-15 cron 연속 실패, 스냅샷 54h 노화(신선도 36h 미달) → 사용자가 라이브 집계 직격.
//   service_role 로 바꾸면 최소한 3s 컷은 벗어난다(정확한 실효 상한은 미검증 — popularService
//   주석의 [미검증] 항목 참조. 8s 라면 여유 2.3s 뿐이라 거래량 증가 시 재점검 필요).
//   이 테스트가 깨지면 "cron 이 다시 공개키로 집계한다"는 뜻 — 스냅샷 생산이 또 멈춘다.
test('popularService — cron 스냅샷 집계는 service_role 로 조회한다 (anon 3s 컷 회피)', async () => {
  const clientPath = require.resolve('../db/client');
  const geoPath = require.resolve('../services/geocodeCacheService');
  const svcPath = require.resolve('../services/popularService');
  const saved = { c: require.cache[clientPath], g: require.cache[geoPath], s: require.cache[svcPath] };

  const today = new Date().toISOString().slice(0, 10);
  const rows = Array.from({ length: 12 }, (_, i) => ({
    aptName: `단지${i}`, sigungu: `시군구${i}`, umdNm: `동${i}`, lawdCd: `1111${i}`,
    buildYear: 2000, recentDealDate: today, dealCount60d: 50 - i, avgDealAmount: 100000,
  }));
  const used = [];   // 어떤 키로 무엇을 호출했는지 기록 — 주입이 실제로 먹었는지의 유일한 증거
  const makeClient = (tag) => ({
    rpc(name) {
      used.push(`${tag}:rpc:${name}`);
      return { abortSignal: () => Promise.resolve({ data: rows, error: null }) };
    },
    from(table) {
      used.push(`${tag}:from:${table}`);
      if (table === 'apt_geocache') {
        const coords = rows.map(r => ({ apt_name: r.aptName, sigungu: r.sigungu, umd_nm: r.umdNm, lat: 37.5, lng: 127.0 }));
        return { select: () => ({ in: () => Promise.resolve({ data: coords, error: null }) }) };
      }
      return { upsert: () => Promise.resolve({ error: null }) };
    },
  });
  require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: {
    getSupabaseReadonly: () => makeClient('anon'), getSupabaseAdmin: () => makeClient('service_role') } };
  require.cache[geoPath] = { id: geoPath, filename: geoPath, loaded: true, exports: {
    resolveCoordBatch: async () => { used.push('resolveCoordBatch'); return []; } } };
  delete require.cache[svcPath];
  try {
    const r = await require('../services/popularService').computeAndStoreSnapshot();
    assert.equal(r.stored, true, `스냅샷 저장 실패: ${JSON.stringify(r)}`);
    assert.equal(r.usedFallback, false, 'RPC 성공인데 fallback 으로 빠짐');
    assert.ok(used.includes('service_role:rpc:search_popular_apts'), `집계 RPC 가 service_role 로 가지 않았다: ${used.join(' ')}`);
    assert.ok(!used.some(u => u.startsWith('anon:')), `cron 경로가 공개키(anon)를 썼다 — 3s 컷 재유입: ${used.join(' ')}`);
  } finally {
    if (saved.c) require.cache[clientPath] = saved.c; else delete require.cache[clientPath];
    if (saved.g) require.cache[geoPath] = saved.g; else delete require.cache[geoPath];
    if (saved.s) require.cache[svcPath] = saved.s; else delete require.cache[svcPath];
  }
});



// ── Sprint NNNNNNN (2026-08-16, 코드리뷰 HIGH 지적) — 검색 강등 판정 ──────────
//   왜 추가하나: apt_master 조회는 **이름·동명 2개** 쿼리인데, 종전 판정은 *둘 다* 실패할 때만
//   error 를 세웠다. 한쪽만 실패하면 masterRes 가 `{data}` 라 `.error` 가 undefined → degraded=false
//   → **결과 일부가 빠진 응답이 '정상'으로 서버 10분 + CDN s-maxage 600(+SWR 1h) 에 굳었다.**
//   경고 로그도 관측 카운터도 없어 사후 추적조차 불가했다. 게다가 umd_nm 쿼리는 접미 정규화 전
//   원본 q 로 더 넓게 스캔해 timeout 확률이 apt_name 쪽보다 높다 — 실제로 걸리는 쪽이다.
//   이 테스트는 "반쪽 응답은 캐시하지 않는다"는 계약을 판정 함수 수준에서 고정한다.
test('computeDegrade — apt_master "한쪽만" 실패도 강등으로 잡는다 (반쪽 응답 캐시 금지 계약)', () => {
  const { computeDegrade } = require('../routes/search');
  const E = { code: '57014', message: 'canceling statement due to statement timeout' };

  // 전부 정상 → 캐시해도 되는 완전한 응답
  assert.deepEqual(computeDegrade(null, null, null),
    { masterAllFailed: false, masterPartial: false, degraded: false, fatal: false });

  // ★ 핵심 회귀: 이름 쿼리만 실패 / 동명 쿼리만 실패 — 둘 다 부분실패이자 강등이어야 한다
  for (const [nameErr, umdErr, label] of [[E, null, 'apt_name 만 실패'], [null, E, 'umd_nm 만 실패']]) {
    const r = computeDegrade(null, nameErr, umdErr);
    assert.equal(r.masterPartial, true, `${label}: 부분실패로 인식 못함`);
    assert.equal(r.degraded, true, `${label}: degraded=false → 반쪽 응답이 캐시/CDN 에 굳는다`);
    assert.equal(r.fatal, false, `${label}: 한쪽은 살아있는데 500 을 낸다`);
  }

  // apt_master 양쪽 실패 + molit 정상 → molit-only 로 살아남음(500 아님)
  assert.deepEqual(computeDegrade(null, E, E),
    { masterAllFailed: true, masterPartial: false, degraded: true, fatal: false });

  // 두 출처가 **동시에** 전멸할 때만 500 — 빈 배열로 위장 금지
  assert.equal(computeDegrade(E, E, E).fatal, true, '전멸인데 빈 결과를 정상으로 반환');

  // molit 이 죽어도 apt_master 한쪽이 살아있으면 강등 서비스(500 아님)
  const mixed = computeDegrade(E, null, E);
  assert.equal(mixed.fatal, false, 'master 한쪽 생존인데 500');
  assert.equal(mixed.degraded, true, '강등 응답인데 캐시 대상으로 분류');
});



test('_isAbortErr — 우리가 끊은 요청만 abort 로 보고, 진짜 오류는 Sentry 로 보낸다', () => {
  const { _isAbortErr } = require('../routes/search');

  // postgrest-js 가 실제로 만드는 형태: message = `${name}: ${msg}`, code = '' (dist/index.cjs 확인)
  assert.equal(_isAbortErr({ message: 'TimeoutError: The operation was aborted due to timeout', code: '', hint: '' }),
    true, 'TimeoutError 형태를 못 잡으면 Sentry 이슈가 매번 생긴다');
  assert.equal(_isAbortErr({ message: 'AbortError: This operation was aborted', code: '',
    hint: 'Request was aborted (timeout or manual cancellation)' }), true);
  assert.equal(_isAbortErr({ aborted: true }), true, 'reject 경로(_softQuery)가 붙인 표식');

  // ★ DB 측 statement timeout 은 abort 가 아니다 — 둘을 구분해야 대응이 갈린다
  //   (abort 증가 = 상한이 동작 / timeout 증가 = 2.5s 안에도 못 끝냄)
  assert.equal(_isAbortErr({ code: '57014', message: 'canceling statement due to statement timeout' }),
    false, 'DB timeout 을 abort 로 오분류하면 상한 효과를 측정할 수 없다');

  // ★ 진짜 오류는 반드시 false — 조용히 삼켜지면 권한·스키마 드리프트를 못 본다
  assert.equal(_isAbortErr({ code: '42501', message: 'permission denied for table molit_transactions' }), false);
  assert.equal(_isAbortErr({ code: 'PGRST204', message: 'column does not exist' }), false);
  assert.equal(_isAbortErr(null), false);
});



// ── Plan 023-2: cron 인증 **배선** 계약 (감사 워크플로 지적 — 함수만 보고 router.use 는 안 봤다) ──
//   `authorizeCron` 함수 자체는 아래 테스트가 12개 조합으로 고정하지만, 그 함수가 **라우터에
//   실제로 물려 있는지**는 아무도 안 봤다. `router.use(authorizeCron)` 한 줄이 사라지면
//   실거래 재적재·apt_master 동기화·retention hard delete(복구 불가)가 인증 없이 열리는데
//   테스트는 초록이다. 위 중개보수 배선 누락과 **같은 클래스**라 함께 막는다.
test('cron 라우터 배선 — authorizeCron 이 모든 엔드포인트 앞에 물려 있다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/cron.js'), 'utf8');
  const lines = src.split('\n');

  const useIdx = lines.findIndex((l) => /^\s*router\.use\(\s*authorizeCron\s*\)/.test(l));
  assert.ok(useIdx >= 0, 'cron.js 에 `router.use(authorizeCron)` 이 없다 — 모든 cron 엔드포인트가 무인증으로 열린다');

  // ★ 라우트 정의보다 **먼저** 와야 한다. 뒤에 오면 앞선 라우트는 게이트를 통과하지 않는다.
  const firstRouteIdx = lines.findIndex((l) => /^\s*router\.(get|post|put|patch|delete)\s*\(/.test(l));
  assert.ok(firstRouteIdx >= 0, 'cron.js 에서 라우트 정의를 찾지 못했다');
  assert.ok(useIdx < firstRouteIdx,
    `router.use(authorizeCron) 이 첫 라우트(${firstRouteIdx + 1}행)보다 뒤(${useIdx + 1}행)에 있다 — 앞선 라우트가 무인증이다`);

  // 이 파일이 실제로 여러 cron 엔드포인트를 들고 있는지도 확인(빈 파일이면 위 단언이 무의미해진다)
  const routeCount = lines.filter((l) => /^\s*router\.(get|post|put|patch|delete)\s*\(/.test(l)).length;
  assert.ok(routeCount >= 5, `cron 라우트가 ${routeCount}개뿐 — 파일 구조가 바뀌었는지 확인할 것`);
});



// ── 감사 #45 (2026-08-16): 응답 직전 관측이 **await 되는지** 소스 계약 ────────────────
//   [왜] 이건 단위 테스트로 잡을 수 없는 종류다 — 유실은 "서버리스가 응답 후 함수를 동결할 때"
//   일어나고, 로컬에서는 Redis 도 동결도 재현되지 않는다(실제로 await 를 지우는 회귀 주입을 해도
//   테스트 71개가 전부 초록이었다). 그래서 **동작이 아니라 소스의 형태**를 고정한다.
//   cron·billing 배선 계약과 같은 부류: 지워지면 조용히 관측만 사라지고 아무도 모른다.
test('강등 관측 배선 — popular-stale 은 응답 전에 await 된다 (서버리스 동결 유실 차단)', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/search.js'), 'utf8');

  // 1) 함수가 Promise 를 돌려줘야 호출부가 기다릴 수 있다 (return 이 없으면 await 가 무의미)
  //    DEGRADE-SHARED-2026-08-17: 구현이 services/degradeStats 로 옮겨졌으므로 **소스 정규식이 아니라
  //    실제로 실행해서** Promise 인지 확인한다(형태 검사보다 강하다 — 위임이 끊기면 여기서 잡힌다).
  const fnStart = src.indexOf('function _observeDegrade(');
  assert.ok(fnStart >= 0, 'search.js 에서 _observeDegrade 를 찾지 못했다');
  const fnBody = src.slice(fnStart, src.indexOf('\n}', fnStart));
  assert.match(fnBody, /return\s+/,
    '_observeDegrade 가 아무것도 반환하지 않는다 — 호출부가 await 해도 즉시 통과한다');
  const { observeDegrade } = require('../services/degradeStats');
  const ret = observeDegrade('test-kind');
  assert.ok(ret && typeof ret.then === 'function',
    'degradeStats.observeDegrade 가 Promise 를 반환하지 않는다 — await 가 무의미해진다');

  // 2) 응답 직전 경로(popular-stale)는 반드시 await
  assert.match(src, /await\s+_observeDegrade\('popular-stale'\)/,
    "popular-stale 강등이 await 되지 않는다 — res.json 직후 동결되면 관측이 유실된다");

  // 3) await 가 res.json 보다 **앞**이어야 의미가 있다
  const awaitIdx = src.indexOf("await _observeDegrade('popular-stale')");
  // POPULAR-WINDOW-2026-09-05: 응답 객체에 window 가 추가돼 완전 일치가 깨졌다 — 이 단언의 의도는
  //   "await 가 응답보다 앞"이므로 응답 **지점**만 찾으면 된다(이 접두는 파일에서 유일).
  const jsonIdx = src.indexOf('res.json({ results: stale,');
  assert.ok(awaitIdx >= 0 && jsonIdx >= 0 && awaitIdx < jsonIdx,
    `await 가 응답(res.json)보다 뒤에 있다 — await ${awaitIdx} vs json ${jsonIdx}`);

  // 4) Redis 미설정(로컬)에서도 절대 reject 하지 않는다 — 관측이 응답을 막으면 안 된다.
  await ret;

  // 5) 두 소비처가 **같은 Redis 키**를 쓴다(검색·보고서). 갈리면 health 에서 한쪽이 사라진다.
  const { KEY_PREFIX } = require('../services/degradeStats');
  assert.equal(KEY_PREFIX, 'searchdeg:',
    '강등 키 접두어가 바뀌었다 — /api/health 의 searchDegrade 배선과 함께 확인할 것');
  assert.match(src, /require\('\.\.\/services\/degradeStats'\)/,
    'search.js 가 공유 모듈을 쓰지 않는다 — 사본이 다시 갈린다');
});



test('authorizeCron — cron 게이트: 시크릿 미설정 차단 + 헤더 조합별 판정', () => {
  const authorizeCron = _authorizeCron();
  // ⚠ 픽스처 값은 반드시 `xxx…` 형태로 둘 것 — `.gitleaks.toml` 의 allowlist(`xxx+`)에 걸리도록.
  //   실사례: 처음엔 변수명 SECRET 에 하이픈+숫자 섞인 문자열을 넣었다가 gitleaks 의
  //   generic-api-key 가 엔트로피 4.09 로 잡아 **CI 가 빨갛게 됐다**(run 31933274554). 같은 레포에서
  //   `key: 'acquisition_tax_2025'` 픽스처로 한 번 겪은 것과 같은 함정이다.
  //   설정을 완화하는 대신(=.gitleaks.toml 주석의 "전면 완화 금지") 픽스처를 더미답게 만든다.
  const TOKEN = 'xxxxxxxx-cron-fixture-xxxxxxxx';
  const call = (authHeader, secret) => {
    const saved = process.env.CRON_SECRET;
    if (secret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = secret;
    const res = _mockRes();
    let nexted = false;
    try {
      authorizeCron({ headers: authHeader === undefined ? {} : { authorization: authHeader } },
        res, () => { nexted = true; });
    } finally {
      if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved;
    }
    return { status: nexted ? null : res.statusCode, nexted };
  };

  // ★ CRON_SECRET 미설정 → 403 으로 완전 차단. 여기서 열리면 배포 사고 시 아무나
  //   retention(복구 불가 hard delete)을 강제 실행할 수 있다.
  assert.deepEqual(call(`Bearer ${TOKEN}`, undefined), { status: 403, nexted: false });
  assert.deepEqual(call(undefined, undefined), { status: 403, nexted: false });

  // 정상 토큰만 통과
  assert.deepEqual(call(`Bearer ${TOKEN}`, TOKEN), { status: null, nexted: true });

  // 헤더 없음 / Bearer 접두 없음 / 다른 스킴 → 전부 401
  assert.deepEqual(call(undefined, TOKEN), { status: 401, nexted: false });
  assert.deepEqual(call('', TOKEN), { status: 401, nexted: false });
  assert.deepEqual(call(TOKEN, TOKEN), { status: 401, nexted: false });          // 접두 없이 값만
  assert.deepEqual(call(`Basic ${TOKEN}`, TOKEN), { status: 401, nexted: false });
  // 접두 대소문자는 구분한다(현재 동작 고정)
  assert.deepEqual(call(`bearer ${TOKEN}`, TOKEN), { status: 401, nexted: false });

  // ★ 길이가 다른 토큰 — timingSafeEqual 예외 없이 401 이어야 한다(사전 길이 체크 계약)
  assert.deepEqual(call('Bearer x', TOKEN), { status: 401, nexted: false });
  assert.deepEqual(call(`Bearer ${TOKEN}x`, TOKEN), { status: 401, nexted: false });
  assert.deepEqual(call('Bearer ', TOKEN), { status: 401, nexted: false });

  // 같은 길이·다른 값 → 401 (비교 자체가 동작하는지)
  const sameLenWrong = 'X'.repeat(TOKEN.length);
  assert.equal(sameLenWrong.length, TOKEN.length);
  assert.deepEqual(call(`Bearer ${sameLenWrong}`, TOKEN), { status: 401, nexted: false });

  // 토큰 앞뒤 공백은 trim 후 비교(현재 동작 고정 — 스케줄러가 개행을 붙이는 사고 대비)
  assert.deepEqual(call(`Bearer ${TOKEN}  `, TOKEN), { status: null, nexted: true });
});



// ── CRON-STALE-2026-08-17 (Sprint MMMMMMM-12) ─────────────────────────────────
// [실측 배경] 2026-08-16 에 geocache-backfill(04:00) · building-register-backfill(06:00) ·
//   retention(18:00) 의 실행 기록이 통째로 비었는데 **Sentry 의 cron 오류도 0건**이었다.
//   즉 실패한 게 아니라 안 돈 것인데, 그걸 알아차릴 수단이 하나도 없었다.
//   원인 두 갈래를 모두 코드에서 확인했고 여기서 형태로 고정한다.
test('cron 실행 기록이 성공·실패 양쪽에 남는다 + await 로 유실을 막는다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/cron.js'), 'utf8');
  const { CRON_PATH_TO_JOBS, CRON_MAX_AGE_H } = require('../services/cronStats');

  // ① 모든 cron 잡이 **실패 경로에서도** 기록을 남긴다.
  //   종전엔 실패 기록이 단 한 곳도 없었다(popular-snapshot 만 try 안에서 ok:false 를 남겼다).
  //   그래서 기록이 빈 cron 을 두고 "미실행 vs 실패" 를 구별할 수 없었다.
  const jobsWithOwnThrowPath = Object.values(CRON_PATH_TO_JOBS).flat()
    .filter(j => j !== 'popular-snapshot'); // popular-snapshot 은 자기 라우트가 없다(retention 안에서 계산)
  for (const job of jobsWithOwnThrowPath) {
    assert.ok(src.includes(`recordCronRun('${job}', { ok: false`),
      `'${job}' 의 catch 에 실패 기록이 없다 — 실패하면 health.crons 에 흔적이 사라진다`);
  }

  // ② 모든 recordCronRun 이 await 된다.
  //   ⚠ 이 저장소는 같은 실수를 이미 겪었다 — `_observeDegrade` 를 await 안 하면 서버리스가
  //     응답 후 함수를 동결하면서 Redis 쓰기가 잘린다(커밋 ba1db07). cron 기록도 같은 경로다.
  //     await 없이 두면 cron 은 정상인데 기록만 사라지는, 가장 헷갈리는 상태가 만들어진다.
  const total = (src.match(/\.recordCronRun\(/g) || []).length;
  const awaited = (src.match(/await require\('\.\.\/services\/cronStats'\)\.recordCronRun\(/g) || []).length;
  assert.ok(total > 0, 'recordCronRun 호출을 하나도 못 찾았다 — 이 테스트의 전제가 깨졌다');
  assert.equal(awaited, total,
    `recordCronRun ${total}개 중 ${awaited}개만 await 된다 — 안 된 것은 서버리스 동결로 유실된다`);

  // ③ 미실행 감시가 retention **쌍둥이 양쪽**에 걸려 있다.
  //   이 저장소는 쌍둥이 한쪽만 고쳐 사고가 난 이력이 여러 번 있다(GET-PARITY·SENTRY-GAP 주석).
  const iPost = src.indexOf("router.post('/retention'");
  const iGet = src.indexOf("router.get('/retention'");
  const iMolit = src.indexOf('async function handleMolitIngest');
  assert.ok(iPost >= 0 && iGet > iPost && iMolit > iGet, 'retention 쌍둥이 구조를 못 찾았다');
  for (const [name, part] of [['POST', src.slice(iPost, iGet)], ['GET', src.slice(iGet, iMolit)]]) {
    assert.match(part, /await checkCronStaleness\(\)/, `retention ${name} 에 cron 미실행 감시가 없다`);
    assert.ok(part.includes("recordCronRun('retention'"), `retention ${name} 이 자기 실행을 기록하지 않는다`);
    // Sprint MMMMMMM-22: 지역 단위 적재 중단 감시도 쌍둥이 양쪽에 있어야 한다.
    //   실제로 Vercel cron 이 호출하는 쪽이 GET 이었던 전례가 있다(GET-PARITY 주석) — 한쪽만 넣으면 감시가 안 돈다.
    assert.match(part, /await checkRegionIngestFreshness\(\)/, `retention ${name} 에 지역 적재 중단 감시가 없다`);
  }

  // ④ 감시 대상 목록이 vercel.json 과 1:1 이다 — 새 cron 이 감시에서 조용히 빠지는 것을 막는다.
  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '../../vercel.json'), 'utf8'));
  const declared = [...new Set(vercel.crons.map(c => c.path.split('?')[0]))].sort();
  assert.deepEqual(declared, Object.keys(CRON_PATH_TO_JOBS).sort(),
    'vercel.json 의 cron 경로와 CRON_PATH_TO_JOBS 가 어긋났다 — 새 cron 을 감시 대상에 넣을 것');
  assert.deepEqual(
    [...new Set(Object.values(CRON_PATH_TO_JOBS).flat())].sort(),
    Object.keys(CRON_MAX_AGE_H).sort(),
    'CRON_MAX_AGE_H 에 기대 주기가 없는 잡이 있다(또는 없는 잡이 남아 있다)');

  // ⑤ push-notify 주석의 시각이 실제 스케줄과 맞는다 (2026-08-17 까지 '18:20 UTC' 로 어긋나 있었다)
  const pn = vercel.crons.find(c => c.path === '/api/cron/push-notify');
  assert.equal(pn.schedule, '30 22 * * *', 'push-notify 스케줄이 바뀌었다 — 주석도 함께 고칠 것');
  assert.equal(src.includes('18:20 UTC'), false, 'push-notify 주석이 실제 스케줄(22:30 UTC)과 다르다');
});



test('findStaleCrons — 기대 주기 초과만 경보, 기록 없음은 침묵', () => {
  const { findStaleCrons } = require('../services/cronStats');
  const now = Date.parse('2026-08-17T00:00:00Z');
  const { stale, never } = findStaleCrons({
    'geocache-backfill': { at: '2026-08-16T04:00:00Z' },  // 20h — 정상
    'facility-backfill': { at: '2026-08-14T05:00:00Z' },  // 67h — 일간 기준(50h) 초과
    'apt-master-sync': { at: '2026-08-11T20:00:00Z' },    // 124h — 주간 기준(240h) 안이라 정상
    'audit-prune': { at: null },                          // 값이 깨진 기록 → 판단 불가
  }, now);

  assert.deepEqual(stale.map(s => s.job), ['facility-backfill'],
    '주기 초과 판정이 바뀌었다 — 일간 50h / 주간 240h 전제를 확인할 것');
  assert.equal(stale[0].ageH, 67);
  // ⚠ "기록 없음" 은 경보로 올리지 않는다 — 이 기능 배포 직후엔 아직 한 번도 안 돈 잡이 정상적으로
  //   여기 들어오기 때문이다(오탐). 진단용으로만 함께 싣는다.
  assert.ok(never.includes('audit-prune'), 'at 이 깨진 기록은 never 로 분류돼야 한다');
  assert.ok(never.includes('push-notify'), '기록이 아예 없는 잡은 never 로 분류돼야 한다');
  assert.equal(stale.some(s => s.job === 'audit-prune'), false, '판단 불가를 경보로 올리면 안 된다');

  // Redis 미설정(null) 이어도 던지지 않는다 — 감시가 cron 본체를 막아선 안 된다.
  assert.deepEqual(findStaleCrons(null, now).stale, []);
});



// ── REGION-FRESHNESS-2026-08-17 (Sprint MMMMMMM-22) ───────────────────────────
// 이 저장소는 **지역 단위** 적재 중단으로 두 번 사고를 냈다(광주 44일 · 인천 45일).
// 둘 다 HTTP 200 · 0건이라 status='ok' 였고, 전역 신선도 감시(MAX(ingested_at) 하나)로는
// 원리적으로 보이지 않는다. 판정을 실행해서 고정한다 — 형태 검사로는 경계값(> vs >=)을 못 잡는다.
test('pickStaleRegions — 30일 초과만 경보 · 폐지 코드 제외 · 이력 없음은 침묵', () => {
  const { pickStaleRegions, REGION_STALE_DAYS } = require('../services/cronStats');
  const now = Date.parse('2026-08-17T05:00:00Z');
  const retired = new Set(['28110', '28140', '28260']);

  const { stale, never } = pickStaleRegions({
    '11680': '2026-08-14',   // 3일 — 정상
    '41290': '2026-07-28',   // 20일 — 실측상 가장 오래된 **정상** 지역(과천). 경보가 나면 안 된다
    '29110': '2026-07-04',   // 44일 — 광주 사고 재현. 반드시 잡혀야 한다
    '28260': '2026-06-24',   // 54일이지만 **폐지 코드** → 제외
    '28720': null,           // 거래 이력 자체가 없음(옹진군) → never, 경보 아님
  }, retired, now);

  const codes = stale.map(s => s.lawdCd);
  assert.deepEqual(codes, ['29110'], `경보 대상이 정확히 광주 1곳이어야 한다: ${JSON.stringify(stale)}`);
  assert.equal(stale[0].days, 44, '경과일 계산이 어긋난다');
  assert.equal(stale[0].lastDealDate, '2026-07-04');
  assert.deepEqual(never, ['28720'], '이력 없는 지역은 never 로만 분류돼야 한다');

  // 경계값 — 임계와 정확히 같은 날은 경보가 아니고, 하루 더 지나면 경보다(> 인지 >= 인지 고정).
  const at = (days) => new Date(now - days * 86400000).toISOString().slice(0, 10);
  assert.equal(pickStaleRegions({ '11680': at(REGION_STALE_DAYS) }, retired, now).stale.length, 0,
    `${REGION_STALE_DAYS}일 정확히는 경보 대상이 아니어야 한다`);
  assert.equal(pickStaleRegions({ '11680': at(REGION_STALE_DAYS + 1) }, retired, now).stale.length, 1,
    `${REGION_STALE_DAYS + 1}일은 경보 대상이어야 한다`);

  // 서버 런타임 TZ 는 UTC 다 — 로컬(한국)에서만 통과하는 계산이 되면 안 된다(TZ 사고 이력).
  assert.equal(pickStaleRegions({ '11680': '2026-07-04' }, retired, now).stale[0].days, 44);

  // 빈 입력·retired 미전달에도 던지지 않는다 — 감시가 cron 본체를 막아선 안 된다.
  assert.deepEqual(pickStaleRegions(null, null, now).stale, []);
  assert.deepEqual(pickStaleRegions({}, undefined, now).never, []);
});



test('RETIRED_LAWD_CODES — 감시에서만 빼고 LAWD_CODES 에는 남아 있어야 한다', () => {
  const { LAWD_CODES, LAWD_CODE_TO_NAME, RETIRED_LAWD_CODES } = require('../services/transactionService');
  const all = new Set(Object.values(LAWD_CODES));
  for (const code of RETIRED_LAWD_CODES) {
    // ⚠ 지우면 적재된 인천 옛 구 거래의 지역명 매핑과 지역 대시보드가 깨진다(transactionService 주석).
    assert.ok(all.has(code), `폐지 코드 ${code} 를 LAWD_CODES 에서 지우면 안 된다 — 감시 제외만 하는 것이다`);
    assert.ok(LAWD_CODE_TO_NAME[code], `폐지 코드 ${code} 의 지역명 매핑이 사라졌다`);
  }
  // 폐지 목록이 전체를 삼키면 감시가 통째로 꺼진다 — 그런 실수를 막는다.
  assert.ok(RETIRED_LAWD_CODES.size > 0 && RETIRED_LAWD_CODES.size < all.size / 4,
    `폐지 목록이 비정상적으로 크다: ${RETIRED_LAWD_CODES.size}/${all.size}`);
});



// ── CRON-MISS-2026-08-17 (Sprint MMMMMMM-24) ──────────────────────────────────
// Vercel 공식 문서로 확정한 사실: cron 전달은 best effort 라 회차가 통째로 누락될 수 있고,
// 그때 런타임 로그조차 안 남으며, 실패해도 재시도하지 않는다. 따라서 알림 job 은
// "한 회차 걸러도 다음 회차가 따라잡는" 창을 가져야 한다. 그 창을 여기서 고정한다.
// ── PUSH-WINDOW-BEHAVIORAL-2026-09-02 (감사 후속: 테스트 행위화) ─────────────
//   [왜] 알림 조회 창이 좁아지면 사용자는 관심단지 거래를 놓치고, **놓쳤다는 사실조차 모른다**.
//     종전 테스트는 소스에서 `NOTIFY_FLOOR_MS = 72 * 3600 * 1000` 이라는 **글자**를 봤다.
//     상수가 그대로여도 뒤에서 floorTs 를 덮어쓰면 통과하고, 상수를 다른 식으로 쓰면(예: 3일)
//     동작이 같은데도 실패한다 — 둘 다 틀린 신호다.
//   [무엇이 바뀌었나] run() 을 실제로 실행하고, 조회에 넘어간 `gte(ingested_at, ...)` 값을
//     관측해 **계산된 창**을 확인한다. 외부 의존은 require.cache 스텁으로 끊는다.
//     (web-push 는 VAPID env 가 있을 때만 지연 로드되므로 스텁이 필요 없다 — 발송은 일어나지 않는다)
test('pushNotify — 조회 창을 실제로 계산시켜 확인한다 (72h 바닥 · 워터마크 · 정렬)', async () => {
  const jobPath = require.resolve('../jobs/pushNotify');
  const clientPath = require.resolve('../db/client');
  const txPath = require.resolve('../services/transactionService');
  const kakaoPath = require.resolve('../services/kakaoMemoService');

  const makeAdmin = (pushRows) => {
    const seen = { gte: [], order: [], tables: [] };
    const mk = (table) => {
      const s = {
        select: () => s,
        limit: async () => ({ data: table === 'push_subscriptions' ? pushRows : [], error: null }),
        in: () => s,
        gte: (col, val) => { seen.gte.push([col, val]); return s; },
        order: (col, opt) => { seen.order.push([col, opt && opt.ascending]); return s; },
        range: async () => ({ data: [], error: null }),   // 거래 0건 → 발송 경로는 타지 않는다
        update: () => ({ eq: async () => ({ error: null }), in: async () => ({ error: null }) }),
        delete: () => ({ eq: async () => ({ error: null }) }),
      };
      return s;
    };
    return { client: { from: (tb) => { seen.tables.push(tb); return mk(tb); } }, seen };
  };

  const runJob = async (pushRows) => {
    const paths = [jobPath, clientPath, txPath, kakaoPath];
    const saved = {};
    for (const q of paths) saved[q] = require.cache[q];
    const { client, seen } = makeAdmin(pushRows);
    const stub = (q, exp) => { require.cache[q] = { id: q, filename: q, loaded: true, exports: exp }; };
    stub(clientPath, { getSupabaseAdmin: () => client });
    stub(txPath, { getAliasCanonicalMap: async () => new Map() });
    stub(kakaoPath, { isKakaoConfigured: () => false, sendKakaoMemo: async () => ({}), refreshKakaoToken: async () => null });
    delete require.cache[jobPath];
    try {
      const { run } = require(jobPath);
      const res = await run();
      return { res, seen };
    } finally {
      for (const q of paths) { if (saved[q]) require.cache[q] = saved[q]; else delete require.cache[q]; }
    }
  };

  const H = 3600 * 1000;
  const now = Date.now();
  const sub = (id, agoMs) => ({
    id, endpoint: 'https://example.invalid/' + id, p256dh: 'k', auth: 'a', fail_count: 0,
    items: [{ lawdCd: '11680', name: '테스트단지' }],
    last_notified_at: agoMs == null ? null : new Date(now - agoMs).toISOString(),
  });
  const windowH = (seen) => {
    const g = seen.gte.find(([c]) => c === 'ingested_at');
    assert.ok(g, '거래 조회에 ingested_at 하한이 없다 — 창 자체가 사라졌다');
    return (now - new Date(g[1]).getTime()) / H;
  };

  // ① 워터마크가 없으면 바닥까지 훑는다. 72h = cron 2회 연속 누락 내성
  //    (Vercel cron 은 best effort 라 회차가 통째로 빠질 수 있고 재시도도 없다).
  const a = await runJob([sub(1, null)]);
  assert.ok(Math.abs(windowH(a.seen) - 72) < 0.2,
    `조회 창이 72h 가 아니다(${windowH(a.seen).toFixed(1)}h) — cron 이 이틀 연속 누락되면 그 사이 거래가 영구히 안 나간다`);

  // ② 모두 최근에 받았으면 가장 오래된 워터마크까지만 — 매번 72h 를 재훑지 않는다
  const b = await runJob([sub(1, 10 * H), sub(2, 20 * H)]);
  assert.ok(Math.abs(windowH(b.seen) - 20) < 0.2,
    `가장 오래된 워터마크(20h)를 따르지 않는다(${windowH(b.seen).toFixed(1)}h)`);

  // ③ 아주 오래 못 받은 구독이 있어도 바닥에서 멈춘다 — 전수 재훑기로 번지지 않는다
  const c = await runJob([sub(1, 200 * H), sub(2, 5 * H)]);
  assert.ok(Math.abs(windowH(c.seen) - 72) < 0.2,
    `오래된 워터마크가 바닥을 넘어 확장됐다(${windowH(c.seen).toFixed(1)}h)`);

  // ④ 정렬은 **내림차순**이어야 한다. 안전캡(5,000행)에 걸릴 때 오름차순이면 최신이 잘린다 —
  //    "새 실거래 알림" 에서 최신을 버리는 것은 정확히 반대 동작이다. 2차 키(id)도 같은 방향.
  assert.deepEqual(a.seen.order, [['ingested_at', false], ['id', false]],
    '거래 조회 정렬이 바뀌었다 — 오름차순이면 캡에 걸릴 때 최신 거래가 잘린다');

  // ⑤ 발송 게이트가 꺼진 상태에서도 죽지 않고 이유를 밝힌다(관측 가능해야 한다)
  assert.equal(a.res.webGate, 'off(VAPID/pkg)', '웹푸시 게이트 상태를 보고하지 않는다');
  assert.equal(a.res.kakaoGate, 'off(env)', '카카오 게이트 상태를 보고하지 않는다');

  // ⑥ 캡·상한에 닿으면 침묵하지 않는다 — 조용히 잘리면 건수가 틀린 채로 발송된다.
  //    (경고 자체는 로그 경로라 소스로 확인한다)
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../jobs/pushNotify.js'), 'utf8');
  assert.match(src, /rows\.length >= ROW_CAP/, '거래 조회 캡 도달 경고가 없다');
  assert.match(src, /상한\(500\)에 닿음/, '구독자 조회 상한 경고가 없다');
});



// ── SENTRY-IGNORE-2026-09-02 (감사 P0-4) ─────────────────────────────────────
//   [왜] Anthropic 크레딧 부족 에러가 error 로 36건 쌓여 운영자의 위험 신호
//     ("Sentry 신규 오류 0건")를 상시 오염시켰다. 실측 태그 `mechanism: auto.ai.anthropic`,
//     `handled: no` — Sentry 의 자동 계측이 우리 try/catch 보다 먼저 잡은 것이다.
//     보고서는 그 상황에서도 데이터판으로 정상 열화하므로 **결함이 아니라 설계된 경로**다.
//   [무엇을 고정하나] ① 그 문구가 실제로 걸러지는가 ② 필터가 **과도하게 넓어져** 진짜 장애를
//     삼키지 않는가. ②가 이 테스트의 진짜 목적이다 — 무시 목록은 조용히 넓어지기 쉽다.
test('Sentry 무시 목록: 예상된 AI 열화만 걸러내고 진짜 장애는 통과시킨다', () => {
  const { IGNORED_ERROR_PATTERNS } = require('../sentry');
  assert.ok(Array.isArray(IGNORED_ERROR_PATTERNS), "sentry.js 가 IGNORED_ERROR_PATTERNS 를 export 하지 않는다");

  // Sentry 의 ignoreErrors 는 문자열이면 부분일치, 정규식이면 test 로 매칭한다.
  const ignored = (msg) => IGNORED_ERROR_PATTERNS.some((pat) =>
    (typeof pat === 'string' ? msg.includes(pat) : pat.test(msg)));

  // ① 예상된 열화는 걸러진다
  const credit = 'Error: 400 {"type":"error","error":{"type":"invalid_request_error",'
    + '"message":"Your credit balance is too low to access the Anthropic API."}}';
  assert.ok(ignored(credit), '크레딧 부족 에러가 여전히 Sentry 로 올라간다 — 신규 오류 감시가 오염된다');

  // ② 진짜 장애는 반드시 통과해야 한다 (필터가 넓어지면 여기서 걸린다)
  const mustReport = [
    'Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
    'Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
    'Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    'Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens is too large"}}',
    'TypeError: Cannot read properties of undefined (reading \'score\')',
    'AbortError: The operation was aborted due to timeout',
    'PostgrestError: permission denied for table molit_transactions',
  ];
  const swallowed = mustReport.filter(ignored);
  assert.deepEqual(swallowed, [],
    `Sentry 무시 목록이 너무 넓다 — 진짜 장애를 삼킨다:\n  ${swallowed.join('\n  ')}`);
});



test('보고서 AI 열화는 Sentry 대신 degrade 카운터로 관측된다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const src = fs2.readFileSync(path2.join(__dirname, '../routes/report.js'), 'utf8');
  // Sentry 에서 걸러내는 대신 관측 경로를 남겨야 한다 — 둘 다 없으면 크레딧 소진이 무성지대가 된다.
  assert.ok(/observeDegrade\(`report-ai-/.test(src),
    'AI 열화 지점에 observeDegrade 기록이 없다 — Sentry 에서 걸러내면 관측 수단이 사라진다');
});



// ── RECORDS-LAST-2026-09-05 ────────────────────────────────────────────────────────
test('경신 카드 — 재계산 실패 시 503 대신 마지막 성공 스냅샷(stale)을 주고, 성공 시 스냅샷을 남기며, 워밍은 1회 재시도한다', async () => {
  const dbPath = require.resolve('../db/client');
  const redisPath = require.resolve('../services/redisCache');
  const svcPath = require.resolve('../services/priceRecordsService');
  const saved = { db: require.cache[dbPath], redis: require.cache[redisPath], svc: require.cache[svcPath] };
  const store = new Map();
  let rpcMode = 'fail'; let rpcCalls = 0;
  require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: {
    rget: async (k) => (store.has(k) ? store.get(k) : null), rset: async (k, v) => { store.set(k, v); },
  } };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
    getSupabaseAdmin: () => ({ rpc: async () => {
      rpcCalls++;
      if (rpcMode === 'fail') return { data: null, error: { message: 'canceling statement due to statement timeout' } };
      if (rpcMode === 'failOnce') { rpcMode = 'ok'; return { data: null, error: { message: 'timeout' } }; }
      return { data: { latestDeal: '2026-09-03', sinceDate: '2026-08-27', comparedCount: 2148, highCount: 369, lowCount: 123, high: [], low: [] }, error: null };
    } }),
  } };
  const cache = require('../cache');
  try {
    delete require.cache[svcPath];
    const svc = require('../services/priceRecordsService');
    for (const k of ['records:price:v1', 'records:price:computeFailedAt']) cache.del(k);
    // ① 스냅샷도 없고 RPC 도 실패 → null(503) — 실패를 0 으로 꾸미지 않는다
    assert.equal(await svc.getPriceRecords(), null);
    // ② 성공 → 신선 캐시 + 마지막 성공 스냅샷 저장
    cache.del('records:price:v1'); cache.del('records:price:computeFailedAt');
    rpcMode = 'ok';
    const fresh = await svc.getPriceRecords();
    assert.equal(fresh.highCount, 369); assert.ok(!fresh.stale);
    assert.ok(store.has('records:price:last'), '마지막 성공 스냅샷이 저장되지 않았다');
    // ③ 신선 캐시가 비고 RPC 가 다시 실패 → stale 스냅샷(computedAt 포함)
    cache.del('records:price:v1'); store.delete('records:price:v1');
    rpcMode = 'fail';
    const stale = await svc.getPriceRecords();
    assert.ok(stale && stale.stale === true && stale.highCount === 369 && stale.computedAt, '재계산 실패에 마지막 성공 스냅샷을 주지 않는다');
    // ④ 백오프 중에는 RPC 를 다시 부르지 않는다
    const before = rpcCalls;
    const again = await svc.getPriceRecords();
    assert.equal(rpcCalls, before, '실패 직후 요청이 다시 8초짜리 RPC 를 태운다');
    assert.ok(again.stale);
    // ⑤ 워밍(force)은 1회 재시도로 살아난다
    cache.del('records:price:computeFailedAt');
    rpcMode = 'failOnce'; const c0 = rpcCalls;
    const warmed = await svc.getPriceRecords({ force: true });
    assert.equal(rpcCalls - c0, 2, '워밍이 실패 후 재시도하지 않는다');
    assert.ok(warmed && !warmed.stale && warmed.highCount === 369);
  } finally {
    for (const k of ['records:price:v1', 'records:price:computeFailedAt']) cache.del(k);
    if (saved.db) require.cache[dbPath] = saved.db; else delete require.cache[dbPath];
    if (saved.redis) require.cache[redisPath] = saved.redis; else delete require.cache[redisPath];
    if (saved.svc) require.cache[svcPath] = saved.svc; else delete require.cache[svcPath];
  }
  const route = require('node:fs').readFileSync(require.resolve('../routes/transactions'), 'utf8');
  assert.match(route, /res\.set\('Cache-Control', \(degraded \|\| data\.stale\) \? 'no-store' : CC\);/, 'stale 응답이 엣지 6시간에 굳는다');
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../frontend/index.html'), 'utf8');
  assert.match(html, /async function _loadPriceRecordsCard\(\)\{/, '랜딩 경신 카드 로더가 함수가 아니다(재시도 불가)');
  assert.match(html, /_meta\.textContent = \(d\.stale && _at && !isNaN\(_at\)\) \? `[^`]*기준` : '실시간';/, 'stale 스냅샷을 실시간이라 부른다');
  assert.match(html, /_meta\.textContent='불러오지 못함 · 다시 시도'; _meta\.style\.cursor='pointer'; _meta\.title='클릭하면 다시 불러와요'; _meta\.onclick=\(\)=>_loadPriceRecordsCard\(\);/, '실패 시 재시도 동작이 없다');
});



// ── INTEREST-WARM-2026-09-05 ──────────────────────────────────────────────────────
test('관심도 워밍 cron — 거래 많은 단지부터 좌표 있는 것만 네이버 데이터랩 캐시를 채운다', async () => {
  const dbPath = require.resolve('../db/client');
  const dlPath = require.resolve('../services/naverDatalabService');
  const jobPath = require.resolve('../jobs/interestWarm');
  const saved = { db: require.cache[dbPath], dl: require.cache[dlPath], job: require.cache[jobPath] };
  const q = (table) => {
    const s = { _t: table, _in: null,
      select() { return s; }, order() { return s; }, not() { return s; },
      in(col, vals) { s._in = vals; return s; },
      range(a, b) {
        if (table === 'molit_apt_index') {
          const rows = Array.from({ length: 1200 }, (_, i) => ({ apt_name: 'A' + i, sigungu: '노원구', umd_nm: '상계동', deal_count: 5000 - i }));
          return Promise.resolve({ data: rows.slice(a, b + 1), error: null });
        }
        return Promise.resolve({ data: [], error: null });
      },
      then(resolve) { // apt_geocache 는 range 없이 await 된다
        const rows = (s._in || []).filter(n => Number(n.slice(1)) % 3 !== 0).map(n => ({ apt_name: n, sigungu: '노원구', umd_nm: '상계동', lat: 37.6, lng: 127.0 }));
        resolve({ data: rows, error: null });
      },
    };
    return s;
  };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getSupabaseAdmin: () => ({ from: (t) => q(t) }) } };
  let got = null;
  require.cache[dlPath] = { id: dlPath, filename: dlPath, loaded: true, exports: {
    hasKeys: () => true, warmInterest: async (items, calls) => { got = { items, calls }; return { calls: 2, filled: 8, pending: 0 }; },
  } };
  try {
    delete require.cache[jobPath];
    const { run } = require('../jobs/interestWarm');
    // SELF-HEAL-2026-09-06: dayIdx:0 을 고정한다 — 회전(rotated) 도입 이후 dayIdx 를 생략하면
    //   오늘 날짜에 따라 오프셋이 달라져 아래 "거래 많은 순서" 단언이 요일마다 깨진다(실측: 실패).
    //   off=0 이면 rotated === items(항등) 이므로 이 테스트의 기존 기대값은 그대로 유효하다.
    const out = await run({ calls: 33, top: 1200, dayIdx: 0 });
    assert.ok(got, 'warmInterest 가 호출되지 않았다');
    assert.equal(got.calls, 33, '호출 상한이 전달되지 않았다');
    assert.equal(got.items.length, 800, `좌표 없는 단지가 걸러지지 않았다(${got.items.length})`);
    assert.equal(got.items[0].aptName, 'A1', '거래 많은 순서가 아니다');
    assert.match(require('node:fs').readFileSync(jobPath, 'utf8'), /\.order\('deal_count', \{ ascending: false \}\)/, '거래 많은 순 정렬이 소스에서 사라졌다(스텁은 order 를 무시해 행위로는 못 잡는다)');
    assert.ok(got.items.every(it => it.lat === 37.6 && it.umd === '상계동'), '좌표·동이 실리지 않았다');
    assert.equal(out.top, 1200); assert.equal(out.withCoord, 800); assert.equal(out.filled, 8);
  } finally {
    if (saved.db) require.cache[dbPath] = saved.db; else delete require.cache[dbPath];
    if (saved.dl) require.cache[dlPath] = saved.dl; else delete require.cache[dlPath];
    if (saved.job) require.cache[jobPath] = saved.job; else delete require.cache[jobPath];
  }
  const cron = require('node:fs').readFileSync(require.resolve('../routes/cron'), 'utf8');
  assert.match(cron, /router\.get\('\/warm-interest', handleWarmInterest\);/, 'cron 라우트가 없다');
  assert.match(cron, /recordCronRun\('warm-interest', summary\)/, '실행 기록이 남지 않는다(health.crons 에서 안 보인다)');
  const vercel = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '../../vercel.json'), 'utf8'));
  const wi = (vercel.crons || []).find(c => c.path === '/api/cron/warm-interest');
  assert.ok(wi, 'vercel.json 에 warm-interest cron 이 없다');
  assert.equal(wi.schedule, '0 19 * * *', '스케줄이 하루 1회(19:00 UTC = 04:00 KST)가 아니다');
  const cs = require('node:fs').readFileSync(require.resolve('../services/cronStats'), 'utf8');
  assert.match(cs, /'warm-interest': 50,/, 'cronStats 기대 소요에 등록되지 않았다');
  assert.match(cs, /'\/api\/cron\/warm-interest': \['warm-interest'\],/, 'cronStats 경로 매핑에 등록되지 않았다');
});


// ── SELF-HEAL-2026-09-06 (A) ────────────────────────────────────────────────────────
//   [행위 테스트] 지역 경신 블롭(getPriceRecordsByRegion)에도 쌍둥이(getPriceRecords)와 같은
//   실패 백오프가 걸리는지 확인한다 — 패턴은 위 RECORDS-LAST-2026-09-05 테스트와 같다.
test('지역 경신 블롭 — 재계산이 반복 실패해도 마지막 성공 스냅샷으로 백오프한다(요청마다 30일 창 RPC 를 다시 태우지 않는다)', async () => {
  const dbPath = require.resolve('../db/client');
  const redisPath = require.resolve('../services/redisCache');
  const svcPath = require.resolve('../services/priceRecordsService');
  const saved = { db: require.cache[dbPath], redis: require.cache[redisPath], svc: require.cache[svcPath] };
  const store = new Map();
  store.set('records:priceByRegion:last', { regions: { '11680': { highCount: 3, lowCount: 1 } }, computedAt: '2026-09-01T00:00:00Z' });
  let rpcCalls = 0;
  require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: {
    rget: async (k) => (store.has(k) ? store.get(k) : null), rset: async (k, v) => { store.set(k, v); },
  } };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
    getSupabaseAdmin: () => ({ rpc: async () => { rpcCalls++; return { data: null, error: { message: 'canceling statement due to statement timeout' } }; } }),
  } };
  const cache = require('../cache');
  try {
    delete require.cache[svcPath];
    const svc = require('../services/priceRecordsService');
    for (const k of ['records:priceByRegion:v1', 'records:priceByRegion:computeFailedAt']) cache.del(k);
    const first = await svc.getPriceRecordsByRegion();
    assert.equal(rpcCalls, 1, '캐시가 비어 있으니 첫 호출은 RPC 를 불러야 한다');
    assert.ok(first && first.stale === true, '실패 시 마지막 성공 스냅샷을 stale 로 줘야 한다');
    const before = rpcCalls;
    const second = await svc.getPriceRecordsByRegion();
    assert.equal(rpcCalls, before, '백오프 중인데 두 번째 호출이 다시 30일 창 RPC 를 태운다(쌍둥이 getPriceRecords 에는 있던 보호가 없다)');
    assert.ok(second && second.stale === true, '백오프 중에도 마지막 성공 스냅샷을 줘야 한다');
  } finally {
    for (const k of ['records:priceByRegion:v1', 'records:priceByRegion:computeFailedAt']) cache.del(k);
    if (saved.db) require.cache[dbPath] = saved.db; else delete require.cache[dbPath];
    if (saved.redis) require.cache[redisPath] = saved.redis; else delete require.cache[redisPath];
    if (saved.svc) require.cache[svcPath] = saved.svc; else delete require.cache[svcPath];
  }
});



// ── Plan 054 (2026-09-06): 열화(stale) 응답이 캐시에 굳는 경로 2종 ───────────────────────────
//   [실사고 이력] 2026-08-29 콜드 경로가 돌려준 regions:[] 가 s-maxage=6h 로 엣지에 굳어 브리핑
//   지역 선택기가 통째로 사라졌다. 이번 라운드는 같은 계열이 지역별 슬라이스와 전월세 읽기 측에
//   남아 있던 것을 고친다(Step 1~3).

test('Plan 054 Step 1 — sliceRegion 이 열화 blob 의 stale·computedAt 을 슬라이스에도 싣는다(정상일 땐 지어내지 않는다)', () => {
  const { sliceRegion } = require('../services/priceRecordsService');
  const baseRegions = { '11350': { comparedCount: 5, highCount: 2, lowCount: 1, high: [], low: [] } };

  // ① 열화 blob(_withStale 이 만드는 형태 그대로) — stale·computedAt 이 슬라이스에도 실려야 한다
  const staleBlob = {
    stale: true, computedAt: '2026-08-20T00:00:00.000Z',
    latestDeal: '2026-08-19', sinceDate: '2026-08-01', windowDays: 30, minPrior: 3,
    regions: baseRegions,
  };
  const staleSlice = sliceRegion(staleBlob, '11350');
  assert.equal(staleSlice.stale, true, '열화 blob 인데 슬라이스가 stale 을 안 실었다 — 라우트가 캐시 여부를 판정 못 한다');
  assert.equal(staleSlice.computedAt, '2026-08-20T00:00:00.000Z', 'computedAt 이 슬라이스로 전달되지 않았다');

  // ② 정상 blob — stale 을 지어내지 않는다(false 로 채우면 이 저장소가 반복해 당한 결함이 된다)
  const freshBlob = {
    latestDeal: '2026-09-03', sinceDate: '2026-08-04', windowDays: 30, minPrior: 3,
    regions: baseRegions,
  };
  const freshSlice = sliceRegion(freshBlob, '11350');
  assert.equal('stale' in freshSlice, false, '정상 응답인데 stale 키가 생겼다(지어낸 값일 위험)');
  assert.equal('computedAt' in freshSlice, false, '정상 응답인데 없는 computedAt 을 지어냈다');
});



test('MV 갱신 실패 시 Sentry 경보가 고정 메시지 + extra 로 나간다 (Plan 058 Step 1)', async () => {
  // service_role 미설정 경로(admin=null) — 기존 mvRefreshError 분기를 그대로 탄다.
  const { handle, sentryCalls, restore } = _requireCronMolitHandler(null);
  try {
    const res = _mkCronRes();
    await handle({ query: {} }, res);
    assert.equal(sentryCalls.length, 1, 'mvRefreshError(service_role 미설정)인데 Sentry 경보가 안 나갔다');
    const call = sentryCalls[0];
    assert.equal(typeof call.msg, 'string', 'Sentry 메시지가 문자열이 아니다');
    assert.equal(/\$\{|`/.test(call.msg), false,
      'Sentry 메시지에 template literal 흔적이 있다 — 이슈가 매일 새로 생겨 그룹핑이 깨진다');
    assert.equal(call.opts.level, 'warning');
    assert.equal(call.opts.tags.route, 'cron.molit-ingest');
    assert.equal(call.opts.extra.mvRefreshError, 'service_role 미설정');
    assert.equal(res.body && res.body.ok, true, 'MV 경보가 나가도 cron 응답 자체는 ok 여야 한다(기존 규약)');
  } finally { restore(); }
});



test('검색 색인 lag — 임계값(7일) 초과 시 경보가 나가고, 정상 범위면 조용하다 (Plan 058 Step 2)', async () => {
  // ① 21일 지연 — 이번 실사고의 실측값 그대로. 경보가 나가야 한다.
  {
    const admin = _mockCronAdmin({ mvDate: '2026-08-14', txDate: '2026-09-04' });
    const { handle, sentryCalls, restore } = _requireCronMolitHandler(admin);
    try {
      const res = _mkCronRes();
      await handle({ query: {} }, res);
      assert.equal(sentryCalls.length, 1, '21일 지연인데 경보가 정확히 1건(lag) 나가지 않았다');
      assert.equal(sentryCalls[0].opts.extra.searchIndexLagDays, 21, 'lag 계산값이 실측(21일)과 다르다');
      assert.equal(/\$\{|`/.test(sentryCalls[0].msg), false, 'lag 경보 메시지에 template literal 흔적 — 그룹핑 계약 위반');
      assert.equal(sentryCalls[0].opts.tags.route, 'cron.molit-ingest');
    } finally { restore(); }
  }
  // ② 1일 지연 — 정상 범위(실측 기준 0~1일). 경보가 없어야 한다.
  {
    const admin = _mockCronAdmin({ mvDate: '2026-09-03', txDate: '2026-09-04' });
    const { handle, sentryCalls, restore } = _requireCronMolitHandler(admin);
    try {
      const res = _mkCronRes();
      await handle({ query: {} }, res);
      assert.equal(sentryCalls.length, 0, '1일 지연(정상)인데 경보가 나갔다 — 오탐');
    } finally { restore(); }
  }
});



test('검색 색인 lag 조회 실패 시 필드가 생략된다 — 0 을 지어내지 않는다 (Plan 058 Step 2)', async () => {
  // molit_apt_index 조회 자체가 에러를 반환하는 상황(예: 순간적 통신 장애) — lag 을 알 수 없다.
  const admin = _mockCronAdmin({ mvErr: new Error('조회 실패') });
  const { handle, sentryCalls, statsCalls, restore } = _requireCronMolitHandler(admin);
  try {
    const res = _mkCronRes();
    await handle({ query: {} }, res);
    const rec = statsCalls.find(c => c.name === 'molit-ingest');
    assert.ok(rec, 'molit-ingest 실행 기록이 recordCronRun 으로 안 남았다');
    assert.equal(rec.summary.searchIndexLagDays, undefined,
      'lag 조회가 실패했는데 값이 채워졌다 — 0 을 지어내면 "지연 없음"으로 오독된다');
    assert.equal(sentryCalls.length, 0, '조회 실패는 lag 미상일 뿐 경보 사유가 아니다(오탐 방지)');
    assert.equal(res.body && res.body.ok, true, 'lag 조회 실패해도 cron 응답은 ok 여야 한다');
  } finally { restore(); }
});



test('cronStats._pick — searchIndexLagDays 화이트리스트를 통과하고, 미상은 0 으로 둔갑하지 않는다 (Plan 058 Step 2)', () => {
  const { _pick } = require('../services/cronStats');
  assert.equal(_pick({ searchIndexLagDays: 21 }).searchIndexLagDays, 21);
  assert.equal(_pick({ searchIndexLagDays: 0 }).searchIndexLagDays, 0, '0(지연 없음)도 유효한 값이라 통과해야 한다');
  assert.equal('searchIndexLagDays' in _pick({ searchIndexLagDays: undefined }), false,
    '미상(undefined)이 화이트리스트를 통과해 0 으로 오독될 값을 남기면 안 된다');
  assert.equal('searchIndexLagDays' in _pick({}), false);
});



// ── STALE-PAGE-2026-09-06 (Plan 058 Step 3) ───────────────────────────────────────────────────
// [배경] priceRecordsService.sliceRegion 은 Plan 054 에서 blob.stale(최대 14일 된 마지막 성공
//   스냅샷)을 rec.stale 로 보존하도록 고쳤다. 이 계획이 확인할 몫은 그 표식이 loadRegionData()
//   반환까지 실제로 도달하는지, 그리고 두 라우트가 그것을 **읽어서 캐시를 막는지**다.
//   [도달 확인] regionPage.js 의 loadRegionData 는 `rec = svc.sliceRegion(await svc.getPriceRecordsByRegion(), region.lawdCd);`
//   로 sliceRegion 의 반환을 그대로 rec 에 담아 `{ dash, rec, weekly }` 로 돌려준다 — 가공·재포장 없음.
//   따라서 `rec.stale` 은 별도 배선 없이 그대로 도달한다(코드 인용, STOP 조건 아님).
test('지역 페이지 — rec.stale 이면 긴 캐시가 붙지 않는다 (Plan 058 Step 3)', async () => {
  const express = require('express');
  const app = express();
  app.use('/region', require('../routes/regionPage'));
  const svc = require('../services/priceRecordsService');
  const regionMod = require('../routes/region');
  const saved = { getByRegion: svc.getPriceRecordsByRegion, buildDashboard: regionMod.buildDashboard };
  try {
    // buildDashboard 는 실제 R-ONE·KOSIS 호출을 타므로 테스트에선 null 로 막는다 — 이 테스트의
    // 관심사는 경신(rec) 카드 하나로 cards.length>0 을 만들고 stale 판정만 보는 것이다.
    regionMod.buildDashboard = async () => null;

    // ① stale 스냅샷 — 카드는 있지만(highCount>0) 캐시는 no-store 여야 한다.
    svc.getPriceRecordsByRegion = async () => ({
      stale: true, sinceDate: '2026-08-01', windowDays: 30, minPrior: 3,
      regions: { 11680: { comparedCount: 10, highCount: 3, lowCount: 1, high: [], low: [] } },
    });
    const srv1 = app.listen(0);
    try {
      const port = srv1.address().port;
      const res = await fetch(`http://127.0.0.1:${port}/region/11680`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store',
        'rec.stale 인데 긴 캐시(s-maxage=21600 + SWR 86400)가 붙었다 — 낡은 스냅샷이 하루 넘게 굳는다');
    } finally { srv1.close(); }

    // ② 대조군: stale 이 아니면(정상) 기존대로 긴 캐시가 붙어야 한다 — 이번 변경이 정상 경로까지
    //    no-store 로 만들지 않았는지 확인한다(과잉 적용 방지).
    svc.getPriceRecordsByRegion = async () => ({
      stale: false, sinceDate: '2026-08-01', windowDays: 30, minPrior: 3,
      regions: { 11680: { comparedCount: 10, highCount: 3, lowCount: 1, high: [], low: [] } },
    });
    const srv2 = app.listen(0);
    try {
      const port = srv2.address().port;
      const res = await fetch(`http://127.0.0.1:${port}/region/11680`);
      assert.match(res.headers.get('cache-control') || '', /s-maxage=21600/,
        '정상(비 stale) 응답인데도 긴 캐시가 사라졌다 — 이번 변경이 과잉 적용됐다');
    } finally { srv2.close(); }
  } finally {
    svc.getPriceRecordsByRegion = saved.getByRegion;
    regionMod.buildDashboard = saved.buildDashboard;
  }
});
