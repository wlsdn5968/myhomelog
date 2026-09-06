/**
 * backend/test/rent-jeonse.test.js
 *
 * characterization.test.js(Plan 066, 10,056줄·327 test 단일 파일)를 도메인별로 분할한 조각.
 * 동작을 하나도 바꾸지 않는 이동이다 — 테스트 이름·개수·본문은 원본과 동일하다.
 * 공용 목/스텁 유틸은 ./_helpers 에서 가져온다. 새 테스트는 이 파일의 주제와 맞으면 여기에,
 * 아니면 backend/test/README.md 규칙대로 새 도메인 파일을 만든다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LAWD, _mkRecordsRes, _plan056RunGap, _plan064RunGapAttach, _plan064RunNoneReliability } = require('../testSupport/_helpers');



// ── 전세 조회 페이서·인플라이트 병합·숫자 단지명 (2026-09-05) ────────────────────────
test('전세 실거래 조회 — 요청 시작 간격을 공용 페이서가 보장하고, 같은 (구,월) 동시 조회는 한 번만 나가며, 숫자 단지명에 죽지 않는다', async () => {
  const dgkPath = require.resolve('../services/dataGoKrClient');
  const rentPath = require.resolve('../services/rentService');
  const saved = { dgk: require.cache[dgkPath], rent: require.cache[rentPath], key: process.env.MOLIT_API_KEY, gap: process.env.RENT_MIN_GAP_MS };
  const starts = [];
  const seen = [];
  const failMonth = new Set();
  const stub = {
    get: async (url, cfg) => {
      const ym = String(cfg.params.DEAL_YMD);
      starts.push(Date.now());
      seen.push(cfg.params.LAWD_CD + ':' + ym);
      if (failMonth.has(ym)) { const e = new Error('boom'); e.response = { status: 500, data: {} }; throw e; }
      return { status: 200, data: { response: { header: { resultCode: '000', resultMsg: 'OK' }, body: { totalCount: 2, items: { item: [
        { aptNm: 101, umdNm: 202, excluUseAr: '84.9', floor: '3', dealYear: ym.slice(0, 4), dealMonth: String(Number(ym.slice(4))), dealDay: '1', deposit: '50,000', monthlyRent: '0' },
        { aptNm: ' 상계주공 ', umdNm: '상계동', excluUseAr: '59.3', floor: '5', dealYear: ym.slice(0, 4), dealMonth: String(Number(ym.slice(4))), dealDay: '2', deposit: '30,000', monthlyRent: '0' },
      ] } } } } };
    },
    _isBlockedPattern: () => false, _buildFullUrl: () => '', ALLOWED_HOSTS: new Set(),
  };
  process.env.MOLIT_API_KEY = 'xxxxxxxx-test-molit-key';
  process.env.RENT_MIN_GAP_MS = '60';
  require.cache[dgkPath] = { id: dgkPath, filename: dgkPath, loaded: true, exports: stub };
  const cache = require('../cache');
  try {
    delete require.cache[rentPath];
    const { getJeonseByApt, getRentTransactions } = require('../services/rentService');
    // ① 6개월 조회 — 시작 간격 ≥ 페이서(60ms 설정 → 50ms 이상으로 관대하게 판정)
    const rows = await getJeonseByApt('99981', '');
    assert.equal(seen.filter(s => s.startsWith('99981:')).length, 6, '월별 6회가 아니다');
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    assert.ok(gaps.every(g => g >= 50), '요청 시작 간격이 페이서 미만이다: ' + JSON.stringify(gaps));
    assert.ok(rows.some(r => r.aptName === '101' && r.umdNm === '202'), '숫자 단지명·동명이 문자열로 파싱되지 않았다(종전 aptNm.trim 타입 오류로 그 달 전체 유실)');
    assert.ok(rows.some(r => r.aptName === '상계주공'), '공백 트림이 깨졌다');
    assert.equal(rows.monthsTotal, 6, '표본 개월 메타가 없다');
    assert.deepEqual(rows.monthsFailed, [], '실패 달이 없는데 메타에 있다');
    // ② 같은 (구,월) 동시 조회 → 업스트림 1회
    starts.length = 0; seen.length = 0;
    const [a, b] = await Promise.all([getRentTransactions('99982', '202601'), getRentTransactions('99982', '202601')]);
    assert.equal(seen.length, 1, '인플라이트 병합이 안 돼 같은 달을 두 번 조회했다: ' + JSON.stringify(seen));
    assert.equal(a.length, 2); assert.equal(b.length, 2);
    // ③ 한 달이 실패하면 그 달만 빠지고 메타에 남는다
    seen.length = 0;
    const months = [];
    { const now = new Date(); for (let i = 0; i < 6; i++) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); months.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`); } }
    failMonth.add(months[2]);
    const rows3 = await getJeonseByApt('99983', '');
    assert.deepEqual(rows3.monthsFailed, [months[2]], '실패한 달이 메타에 남지 않는다');
    assert.equal(rows3.length, 10, '실패 달만 빠져야 한다(5개월 × 2건)');
  } finally {
    for (const k of cache.keys()) if (/^rent:9998[123]:/.test(k)) cache.del(k);
    if (saved.dgk) require.cache[dgkPath] = saved.dgk; else delete require.cache[dgkPath];
    if (saved.rent) require.cache[rentPath] = saved.rent; else delete require.cache[rentPath];
    if (saved.key === undefined) delete process.env.MOLIT_API_KEY; else process.env.MOLIT_API_KEY = saved.key;
    if (saved.gap === undefined) delete process.env.RENT_MIN_GAP_MS; else process.env.RENT_MIN_GAP_MS = saved.gap;
  }
});



test('보고서 전세가율 — 최종 limit 곳에 대해서만 조회하고(컷 전 24곳·14개 구 동시 조회가 429 를 불렀다), 분모는 재집계 뒤 가격, 표본 개월을 적는다', () => {
  const rpt = require('node:fs').readFileSync(require.resolve('../routes/report'), 'utf8');
  const iFinal = rpt.indexOf('const finalOut = out.slice(0, limit);');
  const iJeonse = rpt.indexOf('getJeonseByApt');
  assert.ok(iFinal > 0 && iJeonse > iFinal, '전세가율 조회가 최종 선별 앞에 있다(후보 24곳 전부를 조회한다)');
  assert.match(rpt, /_lawds = \[\.\.\.new Set\(finalOut\.map\(c => c\.lawd_cd\)\.filter\(Boolean\)\)\]/, '전세 조회 대상이 finalOut 이 아니다');
  const iBasis = rpt.indexOf('c.avgPriceFull = stats[0].avg;');
  assert.ok(iBasis > 0 && iJeonse > iBasis, '전세가율 분모가 대표평형 재집계(avgPriceFull) 앞에서 계산된다 — 밴드로 잘린 평균이 분모가 된다');
  assert.ok((rpt.match(/jeonse_months/g) || []).length >= 3, '표본 개월(jeonse_months)이 facts·장점·프롬프트에 실리지 않는다');
  // 사후 기입 대상은 applyObjectiveScore 가 만드는 객체와 **같은 속성명**이어야 한다 — 라이브 실측(2026-09-05): c.facts 로 적어
  //   한 번도 기입되지 않았고 오류도 없었다(빌더는 c.objectiveFacts). 읽는 쪽 둘(데이터판·프롬프트)도 같은 이름을 써야 한다.
  const builderProp = (rpt.match(/\n  c\.(\w+) = \{\s*\n[\s\S]{0,600}?district: district\.tier/) || [])[1];
  assert.ok(builderProp, 'objective fact 객체를 만드는 대입문을 찾지 못했다');
  const writes = rpt.match(/c\.(\w+)\.jeonse_ratio = /g) || [];
  assert.ok(writes.length >= 1, '전세가율 사후 기입이 없다');
  for (const w of writes) assert.equal(w, `c.${builderProp}.jeonse_ratio = `, '사후 기입 속성명이 빌더와 다르다(매달린 참조): ' + w);
  for (const rd of ['const f = c.objectiveFacts || {};', 'const facts = c.objectiveFacts || {};']) assert.ok(rpt.includes(rd.replace('objectiveFacts', builderProp)), '읽는 쪽 속성명이 빌더와 다르다: ' + rd);
});



// ── 전월세 2차 캐시(Redis)·월 창·TTL (2026-09-05) ────────────────────────────────────
test('전세 실거래 조회 — 로컬 미스면 Redis 공유 캐시를 먼저 읽고, 업스트림 성공은 월 나이에 맞는 TTL 로 Redis 에 쓴다', async () => {
  const dgkPath = require.resolve('../services/dataGoKrClient');
  const rcPath = require.resolve('../services/redisCache');
  const rentPath = require.resolve('../services/rentService');
  const saved = { dgk: require.cache[dgkPath], rc: require.cache[rcPath], rent: require.cache[rentPath], key: process.env.MOLIT_API_KEY, gap: process.env.RENT_MIN_GAP_MS };
  const upstream = [];
  const rsets = [];
  const shared = new Map();
  const dgkStub = { get: async (url, cfg) => { upstream.push(cfg.params.LAWD_CD + ':' + cfg.params.DEAL_YMD);
    return { status: 200, data: { response: { header: { resultCode: '000' }, body: { totalCount: 1, items: { item: [{ aptNm: '가나다', umdNm: '동', excluUseAr: '84', floor: '1', dealYear: '2026', dealMonth: '1', dealDay: '1', deposit: '10,000', monthlyRent: '0' }] } } } } }; },
    _isBlockedPattern: () => false, _buildFullUrl: () => '', ALLOWED_HOSTS: new Set() };
  const rcStub = { rget: async (k) => shared.get(k), rset: async (k, v, ttl) => { rsets.push([k, Array.isArray(v) ? v.length : v, ttl]); } };
  process.env.MOLIT_API_KEY = 'xxxxxxxx-test-molit-key';
  process.env.RENT_MIN_GAP_MS = '0';
  require.cache[dgkPath] = { id: dgkPath, filename: dgkPath, loaded: true, exports: dgkStub };
  require.cache[rcPath] = { id: rcPath, filename: rcPath, loaded: true, exports: rcStub };
  const cache = require('../cache');
  try {
    delete require.cache[rentPath];
    const rent = require('../services/rentService');
    // 월 창·TTL 규칙
    const w = rent.monthsWindow(new Date(2026, 8, 5));
    assert.deepEqual(w, ['202609', '202608', '202607', '202606', '202605', '202604'], '최근 6개월 창이 다르다');
    assert.equal(rent.rentTtlSec('202609', new Date(2026, 8, 5)), 30 * 3600, '최근 달 TTL 이 30h 가 아니다');
    assert.equal(rent.rentTtlSec('202606', new Date(2026, 8, 5)), 8 * 86400, '이전 달 TTL 이 8일이 아니다');
    // ① Redis 히트 → 업스트림 0
    shared.set('rent:99971:202601', [{ aptName: '공유', umdNm: 'x', excluUseAr: 59, floor: 2, dealYear: 2026, dealMonth: 1, dealDay: 3, deposit: 5000, monthlyRent: 0 }]);
    const a = await rent.getRentTransactions('99971', '202601');
    assert.equal(upstream.length, 0, 'Redis 에 있는데 업스트림을 불렀다');
    assert.equal(a[0].aptName, '공유');
    assert.ok(cache.get('rent:99971:202601'), '공유 캐시 값이 로컬에 채워지지 않았다');
    assert.equal(await rent.isRentCached('99971', '202601'), true);
    // ② Redis 미스 → 업스트림 1회 → rset(월 나이 TTL)
    const recentYm = rent.monthsWindow()[0];
    const olderYm = rent.monthsWindow()[4];
    await rent.getRentTransactions('99972', recentYm);
    await rent.getRentTransactions('99972', olderYm);
    assert.deepEqual(upstream, ['99972:' + recentYm, '99972:' + olderYm], '업스트림 호출이 예상과 다르다: ' + JSON.stringify(upstream));
    await new Promise(r => setTimeout(r, 10));
    const byKey = Object.fromEntries(rsets.map(([k, n, ttl]) => [k, [n, ttl]]));
    assert.deepEqual(byKey['rent:99972:' + recentYm], [1, 30 * 3600], '최근 달 Redis 저장(TTL 30h)이 없다');
    assert.deepEqual(byKey['rent:99972:' + olderYm], [1, 8 * 86400], '이전 달 Redis 저장(TTL 8일)이 없다');
    assert.equal(await rent.isRentCached('99973', '202601'), false, '없는 키가 캐시됨으로 나온다');
  } finally {
    for (const k of cache.keys()) if (/^rent:9997[123]:/.test(k)) cache.del(k);
    if (saved.dgk) require.cache[dgkPath] = saved.dgk; else delete require.cache[dgkPath];
    if (saved.rc) require.cache[rcPath] = saved.rc; else delete require.cache[rcPath];
    if (saved.rent) require.cache[rentPath] = saved.rent; else delete require.cache[rentPath];
    if (saved.key === undefined) delete process.env.MOLIT_API_KEY; else process.env.MOLIT_API_KEY = saved.key;
    if (saved.gap === undefined) delete process.env.RENT_MIN_GAP_MS; else process.env.RENT_MIN_GAP_MS = saved.gap;
  }
});



// ── 전월세 예열 크론 (2026-09-05) ────────────────────────────────────────────────────
test('전월세 예열 cron — 최근 2개월은 전 지역, 이전 4개월은 7조 중 오늘 조만, 캐시된 달은 건너뛰고, 일 한도(code=22)를 만나면 멈춘다', async () => {
  const rentPath = require.resolve('../services/rentService');
  const jobPath = require.resolve('../jobs/rentWarm');
  const saved = { rent: require.cache[rentPath], job: require.cache[jobPath] };
  const calls = [];
  const cached = new Set(['10001:202609']);
  let quotaAt = null;
  const stub = {
    monthsWindow: () => ['202609', '202608', '202607', '202606', '202605', '202604'],
    isRentCached: async (c, ym) => cached.has(c + ':' + ym),
    getRentTransactions: async (c, ym) => { calls.push(c + ':' + ym); if (quotaAt && c + ':' + ym === quotaAt) { const e = new Error('국토부 전월세 API 호출 실패: Request failed with status code 429'); e.reason = 'HTTP 429 LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR code=22'; throw e; } return []; },
  };
  require.cache[rentPath] = { id: rentPath, filename: rentPath, loaded: true, exports: stub };
  try {
    delete require.cache[jobPath];
    const { run } = require('../jobs/rentWarm');
    const codes = Array.from({ length: 14 }, (_, i) => String(10001 + i));
    // ① 계획: 14×2 + (i%7===3 인 2개 지역)×4 = 36 · 캐시 1건 건너뜀
    const out = await run({ codes, dayIdx: 3, concurrency: 2 });
    assert.equal(out.planned, 36, '계획 건수가 다르다: ' + out.planned);
    assert.equal(out.skipped, 1, '캐시된 달을 건너뛰지 않았다');
    assert.equal(out.fetched, 35, '조회 건수가 다르다: ' + out.fetched);
    assert.equal(out.stopped, null);
    const older = calls.filter(s => /:20260[4-7]$/.test(s)).map(s => s.split(':')[0]);
    assert.deepEqual([...new Set(older)].sort(), ['10004', '10011'], '이전 달을 오늘 조(3, 10) 외 지역에도 조회했다: ' + JSON.stringify([...new Set(older)]));
    assert.ok(!calls.includes('10001:202609'), '캐시된 달을 조회했다');
    // ② 일 한도 → 즉시 중단·사유 기록
    calls.length = 0; quotaAt = '10002:202609';
    const out2 = await run({ codes, dayIdx: 3, concurrency: 1 });
    assert.equal(out2.stopped, 'quota', '일 한도에서 멈추지 않았다');
    assert.ok(out2.remaining > 0, '중단 뒤 남은 건수가 기록되지 않았다');
    assert.ok(calls.length <= 3, '한도 이후에도 계속 조회했다: ' + calls.length);
    // ③ 시간 예산 0 → 아무것도 조회하지 않고 budget 으로 멈춘다
    calls.length = 0; quotaAt = null;
    const out3 = await run({ codes, dayIdx: 3, budgetMs: 0 });
    assert.equal(out3.stopped, 'budget'); assert.equal(calls.length, 0);
  } finally {
    if (saved.rent) require.cache[rentPath] = saved.rent; else delete require.cache[rentPath];
    if (saved.job) require.cache[jobPath] = saved.job; else delete require.cache[jobPath];
  }
  const cron = require('node:fs').readFileSync(require.resolve('../routes/cron'), 'utf8');
  assert.match(cron, /router\.get\('\/warm-rent', handleWarmRent\);/, 'cron 라우트가 없다');
  assert.match(cron, /recordCronRun\('warm-rent', summary\)/, '성공 기록이 없다');
  assert.match(cron, /recordCronRun\('warm-rent', \{ ok: false, error: e\.message \}\)/, '실패 기록이 없다(health.crons 에 흔적이 안 남는다)');
  const vercel = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '../../vercel.json'), 'utf8'));
  const wr = (vercel.crons || []).find(c => c.path === '/api/cron/warm-rent');
  assert.ok(wr, 'vercel.json 에 warm-rent cron 이 없다');
  assert.equal(wr.schedule, '30 20 * * *', '스케줄이 하루 1회(20:30 UTC = 05:30 KST)가 아니다');
  const rentSrc = require('node:fs').readFileSync(require.resolve('../services/rentService'), 'utf8');
  assert.match(rentSrc, /apiErr\.reason = brief;/, '일 한도 판별용 reason 이 오류에 실리지 않는다(예열이 한도를 인식 못 한다)');
});



// ── 전월세 열화 응답(200+비정상 resultCode) 공유 캐시 오염 차단 (2026-09-06, RENT-DEGRADED) ──────
test('전세 실거래 조회 — 200+비정상 resultCode 는 예외로 승격되어 reject 하고, 공유 Redis 에 쓰이지 않으며, 캐시됨으로도 보이지 않는다', async () => {
  const dgkPath = require.resolve('../services/dataGoKrClient');
  const rcPath = require.resolve('../services/redisCache');
  const rentPath = require.resolve('../services/rentService');
  const saved = { dgk: require.cache[dgkPath], rc: require.cache[rcPath], rent: require.cache[rentPath], key: process.env.MOLIT_API_KEY, gap: process.env.RENT_MIN_GAP_MS };
  const rsets = [];
  const dgkStub = {
    get: async () => ({ status: 200, data: { response: { header: { resultCode: '22', resultMsg: '일 트래픽 제한 초과' }, body: {} } } }),
    _isBlockedPattern: () => false, _buildFullUrl: () => '', ALLOWED_HOSTS: new Set(),
  };
  const rcStub = { rget: async () => undefined, rset: async (k, v, ttl) => { rsets.push([k, Array.isArray(v) ? v.length : v, ttl]); } };
  process.env.MOLIT_API_KEY = 'xxxxxxxx-test-molit-key';
  process.env.RENT_MIN_GAP_MS = '0';
  require.cache[dgkPath] = { id: dgkPath, filename: dgkPath, loaded: true, exports: dgkStub };
  require.cache[rcPath] = { id: rcPath, filename: rcPath, loaded: true, exports: rcStub };
  const cache = require('../cache');
  try {
    delete require.cache[rentPath];
    const rent = require('../services/rentService');
    const lawd = '99991';
    const ym = rent.monthsWindow()[0];
    // ① 비정상 resultCode → reject (Step 1: break 를 throw 로 승격 — 매매 경로와 동일)
    await assert.rejects(rent.getRentTransactions(lawd, ym), /MOLIT/, '비정상 resultCode 가 reject 로 승격되지 않았다');
    // ② 실패는 공유 Redis 에 쓰이지 않는다(애초에 rows 를 만들지 못했으니 rset 호출 자체가 없어야 한다, Step 2)
    assert.equal(rsets.length, 0, '실패했는데 rset 이 호출됐다 — 열화가 공유 캐시에 심긴다');
    // ③ 실패가 "캐시됨" 으로 보이지 않는다(Step 3) — 예열 cron 이 이 (구,월)을 계속 건너뛰면 안 된다
    assert.equal(await rent.isRentCached(lawd, ym), false, '실패가 캐시됨으로 보인다');
  } finally {
    for (const k of cache.keys()) if (k.startsWith('rent:99991:')) cache.del(k);
    if (saved.dgk) require.cache[dgkPath] = saved.dgk; else delete require.cache[dgkPath];
    if (saved.rc) require.cache[rcPath] = saved.rc; else delete require.cache[rcPath];
    if (saved.rent) require.cache[rentPath] = saved.rent; else delete require.cache[rentPath];
    if (saved.key === undefined) delete process.env.MOLIT_API_KEY; else process.env.MOLIT_API_KEY = saved.key;
    if (saved.gap === undefined) delete process.env.RENT_MIN_GAP_MS; else process.env.RENT_MIN_GAP_MS = saved.gap;
  }
});



test('전세 실거래 조회 — 5분 안의 재조회(캐시된 실패 히트 경로)에서도 실패가 실패로 남아 getJeonseByApt 의 표본 집계가 정직하다', async () => {
  const dgkPath = require.resolve('../services/dataGoKrClient');
  const rcPath = require.resolve('../services/redisCache');
  const rentPath = require.resolve('../services/rentService');
  const saved = { dgk: require.cache[dgkPath], rc: require.cache[rcPath], rent: require.cache[rentPath], key: process.env.MOLIT_API_KEY, gap: process.env.RENT_MIN_GAP_MS };
  const dgkStub = {
    get: async () => ({ status: 200, data: { response: { header: { resultCode: '22', resultMsg: '일 트래픽 제한 초과' }, body: {} } } }),
    _isBlockedPattern: () => false, _buildFullUrl: () => '', ALLOWED_HOSTS: new Set(),
  };
  const rcStub = { rget: async () => undefined, rset: async () => {} };
  process.env.MOLIT_API_KEY = 'xxxxxxxx-test-molit-key';
  process.env.RENT_MIN_GAP_MS = '0';
  require.cache[dgkPath] = { id: dgkPath, filename: dgkPath, loaded: true, exports: dgkStub };
  require.cache[rcPath] = { id: rcPath, filename: rcPath, loaded: true, exports: rcStub };
  const cache = require('../cache');
  try {
    delete require.cache[rentPath];
    const rent = require('../services/rentService');
    const lawd = '99993';
    const ym = rent.monthsWindow()[0]; // getJeonseByApt 가 도는 6개월 중 첫 달과 같아야 5분 캐시 히트 경로(Step 4)를 탄다
    // 사전 준비: 한 번 실패시켜 5분 실패 표식을 심는다(위 테스트와 같은 결과, 여기선 준비 단계일 뿐)
    await assert.rejects(rent.getRentTransactions(lawd, ym), /MOLIT/);
    // Step 4 핵심: 캐시된 실패 히트 경로에서도 실패가 실패로 남는다 —
    //   getJeonseByApt 의 표본 집계(monthsFailed)로 확인한다. ym 이 6개월 창의 첫 달이므로 이 경로를 반드시 탄다.
    //   (Step 4 없이 빈 배열만 캐시했다면 이 달은 예외 없이 [] 를 받아 "실패" 로 잡히지 않는다 — 5/6 로 위장된다.)
    const rows = await rent.getJeonseByApt(lawd, '아무단지');
    assert.equal(rows.monthsFailed.length, 6, `표본 6개월 중 일부가 실패로 잡히지 않았다(화면엔 그만큼 n/6 이 부풀려 보인다): ${JSON.stringify(rows.monthsFailed)}`);
  } finally {
    for (const k of cache.keys()) if (k.startsWith('rent:99993:')) cache.del(k);
    if (saved.dgk) require.cache[dgkPath] = saved.dgk; else delete require.cache[dgkPath];
    if (saved.rc) require.cache[rcPath] = saved.rc; else delete require.cache[rcPath];
    if (saved.rent) require.cache[rentPath] = saved.rent; else delete require.cache[rentPath];
    if (saved.key === undefined) delete process.env.MOLIT_API_KEY; else process.env.MOLIT_API_KEY = saved.key;
    if (saved.gap === undefined) delete process.env.RENT_MIN_GAP_MS; else process.env.RENT_MIN_GAP_MS = saved.gap;
  }
});



test('전세 실거래 조회 — 실제 0건(정상 resultCode) 은 공유 Redis 에 쓰지 않고 캐시됨으로도 보지 않는다(예열 cron 이 매일 재확인한다)', async () => {
  const dgkPath = require.resolve('../services/dataGoKrClient');
  const rcPath = require.resolve('../services/redisCache');
  const rentPath = require.resolve('../services/rentService');
  const saved = { dgk: require.cache[dgkPath], rc: require.cache[rcPath], rent: require.cache[rentPath], key: process.env.MOLIT_API_KEY, gap: process.env.RENT_MIN_GAP_MS };
  const rsets = [];
  const dgkStub = {
    get: async () => ({ status: 200, data: { response: { header: { resultCode: '000', resultMsg: 'OK' }, body: { totalCount: 0, items: '' } } } }),
    _isBlockedPattern: () => false, _buildFullUrl: () => '', ALLOWED_HOSTS: new Set(),
  };
  const rcStub = { rget: async () => undefined, rset: async (k, v, ttl) => { rsets.push([k, Array.isArray(v) ? v.length : v, ttl]); } };
  process.env.MOLIT_API_KEY = 'xxxxxxxx-test-molit-key';
  process.env.RENT_MIN_GAP_MS = '0';
  require.cache[dgkPath] = { id: dgkPath, filename: dgkPath, loaded: true, exports: dgkStub };
  require.cache[rcPath] = { id: rcPath, filename: rcPath, loaded: true, exports: rcStub };
  const cache = require('../cache');
  try {
    delete require.cache[rentPath];
    const rent = require('../services/rentService');
    const lawd = '99992';
    const ym = rent.monthsWindow()[0];
    const rows = await rent.getRentTransactions(lawd, ym);
    assert.deepEqual(rows, [], '정상 0건 응답이 빈 배열이 아니다');
    assert.equal(rsets.length, 0, '빈 결과인데 rset 이 호출됐다 — 공유 캐시에 최대 8일 굳는 문제 재발(Step 2)');
    assert.equal(await rent.isRentCached(lawd, ym), false, '빈 결과가 캐시됨으로 보인다 — 예열 cron 이 계속 건너뛴다(Step 3)');
  } finally {
    for (const k of cache.keys()) if (k.startsWith('rent:99992:')) cache.del(k);
    if (saved.dgk) require.cache[dgkPath] = saved.dgk; else delete require.cache[dgkPath];
    if (saved.rc) require.cache[rcPath] = saved.rc; else delete require.cache[rcPath];
    if (saved.rent) require.cache[rentPath] = saved.rent; else delete require.cache[rentPath];
    if (saved.key === undefined) delete process.env.MOLIT_API_KEY; else process.env.MOLIT_API_KEY = saved.key;
    if (saved.gap === undefined) delete process.env.RENT_MIN_GAP_MS; else process.env.RENT_MIN_GAP_MS = saved.gap;
  }
});


test('전세가율 표본 완전성 — 결측 달이 있으면 실제 개월 수를 밝히고, 없으면 기존 문구를 유지한다 (Plan 046)', () => {
  // Plan 041 이 "최근 6개월 전세 실거래 기준" 이라는 사실 주장을 추가했다. 그런데 국토부 조회가
  // 일부 달에 실패하면 표본은 6개월보다 얇다(rentService.js 의 monthsFailed) — 그때 "6개월" 은
  // 거짓말이 된다. summarizeMarketSignal 의 네 번째 인자(jeonseSample)로 표본 완전성을 받아
  // 결측이 있을 때만 실제 개월 수를 밝힌다.
  const { _internals } = require('../services/analysisService');
  const { calcBuySignal } = _internals;

  // ① 3인자 호출(기존 호출 형태, characterization.test.js:2539/2548 과 동일 패턴) → 문구 불변.
  //   ★ 하위호환 고정 — 네 번째 인자는 선택적이어야 한다.
  const r1 = calcBuySignal(50, { signal: 'neutral' }, 49);
  const jeonse1 = r1.conditions.find(c => c.label === '전세가율');
  assert.match(jeonse1.desc, /49% \(최근 6개월 전세 실거래 기준\)/,
    '3인자 호출은 기존 문구 그대로여야 한다(하위호환)');

  // ② 표본이 완전(failed: 0) → 기존 문구와 동일.
  const r2 = calcBuySignal(50, { signal: 'neutral' }, 49, { total: 6, failed: 0 });
  const jeonse2 = r2.conditions.find(c => c.label === '전세가율');
  assert.match(jeonse2.desc, /49% \(최근 6개월 전세 실거래 기준\)/,
    '결측 0건이면 기존 문구를 유지해야 한다');

  // ③ 표본이 불완전(failed: 2/6) → "6개월" 이라 단정하지 않고 실제 4/6 을 밝힌다.
  const r3 = calcBuySignal(50, { signal: 'neutral' }, 49, { total: 6, failed: 2 });
  const jeonse3 = r3.conditions.find(c => c.label === '전세가율');
  assert.match(jeonse3.desc, /49% \(전세 실거래 4\/6개월 표본\)/,
    '결측이 있으면 실제 개월 수(4/6)를 밝혀야 한다');
  assert.equal(/최근 6개월 전세 실거래 기준/.test(jeonse3.desc), false,
    '표본이 얇은데 "최근 6개월" 이라 단정하면 안 된다');

  // ④ 메타를 모른다(total/failed 가 null) → 모름을 0으로 만들지 않고 기존 문구로 처리.
  const r4 = calcBuySignal(50, { signal: 'neutral' }, 49, { total: null, failed: null });
  const jeonse4 = r4.conditions.find(c => c.label === '전세가율');
  assert.match(jeonse4.desc, /49% \(최근 6개월 전세 실거래 기준\)/,
    '표본 메타를 모르면(null) 기존 문구로 처리해야 한다 — "0/0" 등으로 표현하면 안 된다');

  // ⑤ 절대 룰 ① — 어떤 경우에도 desc 에 매수 권유·가격 예측 표현이 없어야 한다.
  for (const c of [...r1.conditions, ...r2.conditions, ...r3.conditions, ...r4.conditions]) {
    assert.equal(/매수|매도|사세요|파세요|오를|내릴|상승할|하락할/.test(c.desc), false,
      `조건 카드 desc 에 매수·매도 권유 또는 가격 예측 표현이 있다: ${c.desc}`);
  }

  // ⑥ red 분기의 "역전세 위험 확인 필요" 는 041 이 의도적으로 남긴 문구 — 표본 표기가 바뀌어도 유지.
  const rRed = calcBuySignal(50, { signal: 'neutral' }, 30, { total: 6, failed: 2 });
  const jeonseRed = rRed.conditions.find(c => c.label === '전세가율');
  assert.match(jeonseRed.desc, /30% \(전세 실거래 4\/6개월 표본\) — 역전세 위험 확인 필요/,
    'red 분기의 역전세 위험 확인 필요 문구가 표본 표기와 함께 유지돼야 한다');
});



test('전세가율 표본 메타 추출은 filter 보다 앞에 있어야 한다 (Plan 046 — 계약 고정)', () => {
  // getJeonseByApt 는 monthsTotal·monthsFailed 를 배열의 "커스텀 속성"으로 싣는다.
  // Array.prototype.filter 는 새 배열을 반환하므로, filter 뒤에서 메타를 꺼내면 항상 undefined 가
  // 되어 조용히 "모름" 으로 빠진다(겉으로는 에러 없이 그냥 항상 기존 문구만 나온다 — 이 계획이
  // 고치려는 결함 자체가 재발한다). 소스 순서를 인덱스 비교로 고정한다.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../services/analysisService.js'), 'utf8');

  const metaIdx = src.indexOf('const _jTotal = Number.isFinite(jeonseT.monthsTotal)');
  const filterIdx = src.indexOf('jeonseT = jeonseT.filter(_scope)');

  assert.ok(metaIdx !== -1, '메타 추출 코드를 찾을 수 없다 — 계획서 발췌와 소스가 어긋났다');
  assert.ok(filterIdx !== -1, 'jeonseT filter 코드를 찾을 수 없다 — 계획서 발췌와 소스가 어긋났다');
  assert.ok(metaIdx < filterIdx,
    '표본 메타 추출이 filter 보다 뒤에 있다 — monthsTotal/monthsFailed 가 조용히 사라진다');
});



function _stubRecordsRoute(mode) {
  const svcPath = require.resolve('../services/priceRecordsService');
  const routePath = require.resolve('../routes/transactions');
  const saved = { svc: require.cache[svcPath], route: require.cache[routePath] };
  const svcStub = {
    getPriceRecordsByRegion: async () => ({ regions: { '11350': {} } }), // sliceRegion 자체를 스텁하므로 형태만 있으면 된다
    sliceRegion: () => (mode === 'stale'
      ? { scope: 'region', lawdCd: '11350', stale: true, computedAt: '2026-08-20T00:00:00.000Z' }
      : { scope: 'region', lawdCd: '11350' }),
    getPriceRecords: async () => ({ highCount: 0, lowCount: 0 }),
    regionMenu: () => [],
  };
  require.cache[svcPath] = { id: svcPath, filename: svcPath, loaded: true, exports: svcStub };
  delete require.cache[routePath];
  const router = require('../routes/transactions');
  const restore = () => {
    if (saved.svc) require.cache[svcPath] = saved.svc; else delete require.cache[svcPath];
    delete require.cache[routePath]; // 다음 요청자가 실제 파일을 다시 읽게
  };
  const layer = router.stack.find(l => l.route && l.route.path === '/records');
  if (!layer) { restore(); throw new Error('/records 라우트를 못 찾았다(경로가 바뀌었나)'); }
  return { handle: layer.route.stack[0].handle, restore };
}



test('Plan 054 Step 2 — GET /transactions/records?lawdCd= 가 지역 슬라이스 열화 시 no-store', async () => {
  // 전엔 항상 CC 가 붙어 6시간+SWR24시간 엣지에 굳었다(2026-08-29 실사고와 같은 계열).
  const { handle, restore } = _stubRecordsRoute('stale');
  try {
    const res = _mkRecordsRes();
    await handle({ query: { lawdCd: '11350' } }, res, () => {});
    assert.equal(res.headers['Cache-Control'], 'no-store', '열화 지역 슬라이스에 긴 캐시가 붙었다');
  } finally { restore(); }
});



test('Plan 054 Step 2 — GET /transactions/records?lawdCd= 가 지역 슬라이스 정상 시 기존 캐시 헤더를 유지한다(회귀 아님)', async () => {
  const { handle, restore } = _stubRecordsRoute('fresh');
  try {
    const res = _mkRecordsRes();
    await handle({ query: { lawdCd: '11350' } }, res, () => {});
    assert.match(res.headers['Cache-Control'], /s-maxage=21600/, '정상 지역 슬라이스의 캐시 헤더가 사라졌다(회귀)');
  } finally { restore(); }
});



test('Plan 054 Step 3 — getRentTransactions: 배포 이전에 이미 공유 Redis 에 굳은 빈 배열은 히트로 치지 않고 업스트림을 다시 부른다', async () => {
  const dgkPath = require.resolve('../services/dataGoKrClient');
  const rcPath = require.resolve('../services/redisCache');
  const rentPath = require.resolve('../services/rentService');
  const saved = { dgk: require.cache[dgkPath], rc: require.cache[rcPath], rent: require.cache[rentPath], key: process.env.MOLIT_API_KEY, gap: process.env.RENT_MIN_GAP_MS };
  let dgkCalls = 0;
  const dgkStub = {
    get: async () => {
      dgkCalls++;
      return { status: 200, data: { response: { header: { resultCode: '000', resultMsg: 'OK' }, body: { totalCount: 1, items: { item: [
        { aptNm: '테스트아파트', umdNm: '역삼동', excluUseAr: '84.9', floor: '5', dealYear: '2026', dealMonth: '9', dealDay: '1', deposit: '10,000', monthlyRent: '0' },
      ] } } } } };
    },
    _isBlockedPattern: () => false, _buildFullUrl: () => '', ALLOWED_HOSTS: new Set(),
  };
  // 037 은 "쓰기 측"만 막았다 — 배포 이전에 이미 Redis 에 심긴 오염된 빈 배열을 흉내낸다.
  const rcStub = { rget: async () => [], rset: async () => {} };
  process.env.MOLIT_API_KEY = 'xxxxxxxx-test-molit-key';
  process.env.RENT_MIN_GAP_MS = '0';
  require.cache[dgkPath] = { id: dgkPath, filename: dgkPath, loaded: true, exports: dgkStub };
  require.cache[rcPath] = { id: rcPath, filename: rcPath, loaded: true, exports: rcStub };
  const cache = require('../cache');
  try {
    delete require.cache[rentPath];
    const rent = require('../services/rentService');
    const lawd = '99994';
    const ym = rent.monthsWindow()[0];
    const rows = await rent.getRentTransactions(lawd, ym);
    assert.equal(dgkCalls, 1, '공유 Redis 의 굳은 빈 배열을 히트로 쳐서 업스트림을 다시 부르지 않았다');
    assert.equal(rows.length, 1, '업스트림 재조회 결과가 반영되지 않았다');
  } finally {
    for (const k of cache.keys()) if (k.startsWith('rent:99994:')) cache.del(k);
    if (saved.dgk) require.cache[dgkPath] = saved.dgk; else delete require.cache[dgkPath];
    if (saved.rc) require.cache[rcPath] = saved.rc; else delete require.cache[rcPath];
    if (saved.rent) require.cache[rentPath] = saved.rent; else delete require.cache[rentPath];
    if (saved.key === undefined) delete process.env.MOLIT_API_KEY; else process.env.MOLIT_API_KEY = saved.key;
    if (saved.gap === undefined) delete process.env.RENT_MIN_GAP_MS; else process.env.RENT_MIN_GAP_MS = saved.gap;
  }
});



test('Plan 064 ①: 결측이 있으면 gapData.jeonseBasis 에 실제 개월 수(4/6)가 실린다', () => {
  const g = _plan064RunGapAttach(6, 2);
  assert.equal(g.jeonseBasis, '전세 실거래 4/6개월 표본',
    '결측 2/6인데 gapData.jeonseBasis 가 실제 개월 수를 밝히지 않는다');
});



test('Plan 064 ②: 결측이 없으면(0/6) 조건 카드와 같은 문구를 쓰고 "6/6" 단정을 만들지 않는다', () => {
  const g = _plan064RunGapAttach(6, 0);
  assert.equal(g.jeonseBasis, '최근 6개월 전세 실거래 기준',
    '결측 0건인데 조건 카드와 다른 문구를 만들었다');
  assert.equal(/\d+\/\d+/.test(g.jeonseBasis), false,
    '결측이 없는데 "n/6" 형태의 단정 문구가 생겼다 — 얻지 못한 정밀도를 만들어낸 것');
});



test('Plan 064 ③: 표본 자체를 모르면(_jTotal===null) gapData.jeonseBasis 키가 아예 없다', () => {
  const g = _plan064RunGapAttach(null, null);
  assert.equal(Object.prototype.hasOwnProperty.call(g, 'jeonseBasis'), false,
    '표본을 모르는데 jeonseBasis 키가 생겼다 — "모름" 을 "완전한 6개월" 로 오독시킬 위험');
});



test('Plan 064 ④: summarizeMarketSignal 기존 3인자 호출 동작은 변하지 않는다 (하위호환)', () => {
  const { _internals } = require('../services/analysisService');
  const { calcBuySignal } = _internals;
  const r = calcBuySignal(50, { signal: 'neutral' }, 49);
  const jeonse = r.conditions.find(c => c.label === '전세가율');
  assert.match(jeonse.desc, /49% \(최근 6개월 전세 실거래 기준\)/,
    '3인자 호출(jeonseSample 생략)의 조건 카드 문구가 바뀌었다 — 하위호환 파손');
});



test('Plan 064 ⑤: 갭 카드가 백엔드 jeonseBasis 문구를 그대로 그린다(결측 있음)', () => {
  const html = _plan056RunGap(70, { jeonseBasis: '전세 실거래 4/6개월 표본' });
  assert.ok(html.indexOf('전세 실거래 4/6개월 표본') >= 0,
    '갭 카드가 백엔드가 준 표본 문구를 그리지 않는다');
});



test('Plan 064 ⑥: gapData.jeonseBasis 가 없으면(모름) 갭 카드에 표본 문구가 없다', () => {
  const html = _plan056RunGap(70, {});
  assert.equal(/개월 표본|전세 실거래 기준/.test(html), false,
    '표본을 모르는데 갭 카드에 표본 관련 문구가 나왔다');
});



test('Plan 064 ⑦: red 분기 — "역전세 위험 확인 필요" 와 표본 문구가 함께 나온다(레이아웃 확인)', () => {
  const html = _plan056RunGap(40, { jeonseBasis: '전세 실거래 4/6개월 표본' });
  assert.ok(html.indexOf('역전세 위험 확인 필요') >= 0, 'red 분기 위험 고지가 사라졌다');
  assert.ok(html.indexOf('전세 실거래 4/6개월 표본') >= 0, 'red 분기에서 표본 문구가 사라졌다');
});



test('Plan 064 ⑧: red 분기인데 jeonseBasis 가 없으면(모름) 위험 고지만 나오고 표본 문구는 없다', () => {
  const html = _plan056RunGap(40, {});
  assert.ok(html.indexOf('역전세 위험 확인 필요') >= 0, 'red 분기 위험 고지가 사라졌다(기존 동작 회귀)');
  assert.equal(/개월 표본|전세 실거래 기준/.test(html), false,
    '표본을 모르는데 red 분기에서 표본 문구가 나왔다');
});



test('Plan 064 ⑨: 프론트는 임계값(60/45)·total-failed 산술을 다시 만들지 않는다 (소스 계약)', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const fe = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');
  const s = fe.indexOf("let gapHtml=''");
  const e = fe.indexOf('// ─ 실투자금 계산기', s);
  const block = fe.slice(s, e);
  // 줄 주석을 먼저 제거한 뒤 검사한다(자기 주석 오검출 6회 재발 이력 — test-marker-self-collision).
  const noComments = block.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.equal(/jeonseSample|monthsTotal|monthsFailed|\.total\s*-\s*\.?failed/.test(noComments), false,
    '프론트 gapHtml 이 표본 산술(total-failed)을 다시 계산하는 코드를 만들었다 — 백엔드 문자열을 그대로 써야 한다');
  assert.ok(/g\.jeonseBasis/.test(noComments), '프론트가 gapData.jeonseBasis 를 읽지 않는다');
});



test('Plan 064 ⑩: reliability===NONE 이라 marketSummary 가 null 이어도 gapData.jeonseBasis 는 옳게 채워진다', () => {
  const { gapData, marketSummary } = _plan064RunNoneReliability({ reliability: 'NONE', jTotal: 6, jFailed: 2 });
  assert.equal(marketSummary, null, 'reliability=NONE 인데 marketSummary 가 null 이 아니다(테스트 전제 확인)');
  assert.equal(gapData.jeonseBasis, '전세 실거래 4/6개월 표본',
    'reliability=NONE 경로에서 gapData.jeonseBasis 가 옳게 채워지지 않는다');
});



// ── WIRE-JEONSE-SAMPLE-2026-09-06 (Plan 060 ④): analyzeApt 의 배선을 실행으로 확인한다 ──────
//   [왜] analysisService.js:596 은 `_jTotal !== null ? { total: _jTotal, failed: _jFailed } : null`
//   로 전세 표본 결측 메타를 summarizeMarketSignal 의 4번째 인자에 넘긴다. 기존 테스트 2개는
//   (a) calcBuySignal 을 직접 호출해 4번째 인자를 손으로 채우고, (b) 메타 추출 코드가 filter
//   보다 앞에 있는지 소스 인덱스만 비교한다 — **그 사이의 배선**(analyzeApt 가 그 인자를 실제로
//   채워 넘기는가)은 아무도 안 본다. 감사자 실측: :596 을 `null,` 로 바꿔(무조건 "모름") 넣어도
//   pass 249 / fail 0, eslint 도 통과했다(`_` 접두라 미사용 경고도 안 뜬다).
//   [방식] REC-BEHAVIORAL 테스트의 require.cache 기법과 동일 — analyzeApt 자신은 실제 소스
//   그대로 실행하고, 외부 I/O(transactionService·rentService)만 고정 픽스처로 바꾼다.
//   ⚠ 프로덕션 코드는 건드리지 않는다 — 지금 값(:596)은 옳다, 이 테스트는 그걸 지킨다.
test('WIRE-JEONSE-SAMPLE-2026-09-06: analyzeApt 가 전세 표본 결측(_jTotal/_jFailed)을 marketSummary 까지 실제로 넘긴다', async () => {
  const txPath = require.resolve('../services/transactionService');
  const rentPath = require.resolve('../services/rentService');
  const asPath = require.resolve('../services/analysisService');
  const realTx = require(txPath);
  const cache = require('../cache');

  const LAWD = '11350'; // 노원구 — transactionService.LAWD_CODES 실값
  const buildYear = 2015;
  const now = new Date();
  const saleTx = Array.from({ length: 10 }, (_, i) => ({
    aptName: '배선단지', sigungu: '노원구', umdNm: '상계동',
    excluUseAr: 84.9, buildYear, floor: 5 + i,
    dealYear: now.getFullYear(), dealMonth: now.getMonth() + 1, dealDay: (i % 28) + 1,
    dealAmount: 60000, lawdCd: LAWD, aptSeq: `${LAWD}-0`, jibun: '',
  }));
  // getJeonseByApt 가 돌려주는 배열 자체에 monthsTotal/monthsFailed 를 싣는다
  // (rentService 실제 계약과 같은 모양 — 배열의 "커스텀 속성").
  const jeonseArr = [
    { deposit: 42000, monthlyRent: 0 },
    { deposit: 41000, monthlyRent: 0 },
  ];
  jeonseArr.monthsTotal = 6;
  // ⚠ rentService.js:342 의 실제 계약은 monthsFailed 가 "실패한 달 문자열의 배열"이다(길이가
  //   실패 개월 수) — analysisService.js:548 이 `Array.isArray(...) ? .length : null` 로 읽는다.
  //   숫자를 직접 넣으면(Array.isArray 가 false) _jFailed 가 null 이 되어 이 테스트 자체가
  //   무의미해진다(최초 작성 때 실제로 이 실수로 오탐 없이 조용히 "완전 표본" 분기로 샜다).
  jeonseArr.monthsFailed = ['202608', '202607']; // 2개월 결측 → "전세 실거래 4/6개월 표본" 문구가 나와야 한다

  const stubs = {
    [txPath]: { ...realTx, getTransactionsByAptInclAliases: async () => saleTx },
    [rentPath]: { getJeonseByApt: async () => jeonseArr },
  };
  const saved = new Map();
  for (const [p, exp] of Object.entries(stubs)) {
    saved.set(p, require.cache[p]);
    require.cache[p] = { id: p, filename: p, loaded: true, exports: exp };
  }
  saved.set(asPath, require.cache[asPath]);
  delete require.cache[asPath]; // analysisService 자신은 다시 읽어 위 스텁을 보게 한다

  cache.del('analysis:11350:배선단지::'); // 이전 실행의 캐시가 남아있으면 픽스처가 무시된다

  try {
    const { analyzeApt } = require(asPath);
    const result = await analyzeApt(LAWD, '배선단지', 6.0);
    assert.ok(result.marketSummary, 'marketSummary 가 계산되지 않았다 — 픽스처의 saleTx 표본(8건 이상)이 부족한지 확인');
    const jeonseCond = result.marketSummary.conditions.find(c => c.label === '전세가율');
    assert.ok(jeonseCond, '전세가율 조건 카드가 없다 — 픽스처의 jeonse 표본으로 jeonseRate 가 계산되지 않았다');
    assert.match(jeonseCond.desc, /전세 실거래 4\/6개월 표본/,
      'analyzeApt 가 _jTotal/_jFailed 를 marketSummary 까지 넘기지 않는다 — '
      + ':596 이 무조건 null 을 넘기면(배선 삭제) 결측이 있어도 "최근 6개월 전세 실거래 기준"으로 나온다');
    assert.doesNotMatch(jeonseCond.desc, /최근 6개월 전세 실거래 기준/,
      '결측이 있는데 "최근 6개월" 로 단정한다 — 표본 메타가 analyzeApt 에서 끊겼다');
  } finally {
    for (const [p, prev] of saved) { if (prev) require.cache[p] = prev; else delete require.cache[p]; }
    for (const [p, prev] of saved) assert.equal(require.cache[p], prev, `require.cache 복원 실패: ${p}`);
  }
});
