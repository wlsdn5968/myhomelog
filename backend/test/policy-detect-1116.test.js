/**
 * backend/test/policy-detect-1116.test.js
 *
 * POLICY-MISS-1116 (운영자 지적 "2025년 10월 대책 이후에도 계속 대책이 발표되고 있는데 왜 현재까지 대책을 못 따라가는거야").
 * 2026-11-16 에 확인한 원인 두 가지를 고정한다.
 *   1) 정책 감지가 보도자료 제목의 낱말만 봤고, 2026-08-13 금융 종합대책의 제목에는 그 낱말이 하나도 없었다.
 *   2) 감지해도 경고 로그 한 번으로 끝나고 남지 않았다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseRss, RSS_SOURCES } = require('../jobs/regulationsAutoFetch');
const { mergeDetected, pendingCounts, DETECTED_KEY } = require('../jobs/regulationsAiCheck');

const T_0813 = '수도권 23만호+α 추가 공급, 주택 공급 촉진 및 청년 등 실수요자 금융지원 강화'; // fsc.go.kr/no010101/87517 의 실제 제목
const OLD_FSC = ['LTV', 'DSR', '주담대', '대출', '주택담보', '규제지역', '스트레스', '디딤돌', '보금자리', '가계부채', '만기연장'];

test('정책 감지: 2026-08-13 금융 종합대책의 실제 제목이 금융위 낱말에 걸린다(옛 낱말로는 걸리지 않았다)', () => {
  const fsc = RSS_SOURCES.find((s) => s.name === '금융위원회');
  assert.deepEqual(OLD_FSC.filter((k) => T_0813.includes(k)), [], '고치기 전 낱말로는 0건이었다');
  assert.ok(fsc.keywords.filter((k) => T_0813.includes(k)).length >= 1);
  for (const k of OLD_FSC) assert.ok(fsc.keywords.includes(k), `옛 낱말을 빼지 않는다: ${k}`);
  // 2025-10 이후 실제 보도자료 제목들도 걸린다
  for (const t of ['규제지역 추가 지정 관련 「긴급 가계부채 점검회의」 개최', '부동산 시장과 금융의 절연을 위한 - ｢‘26년도 가계부채 관리방안｣ 발표',
    '다주택자 대출 만기연장 관련 全 금융권 「긴급 점검회의」 개최', '규제지역 내 주택담보대출의 대환대출시 해당 주택담보대출 취급 시점의 LTV 규제비율을 적용합니다.']) {
    assert.ok(fsc.keywords.some((k) => t.includes(k)), t);
  }
});

test('정책 감지: 제목에 낱말이 없어도 요약에 있으면 잡는다(요약은 앞 600자, 태그 제거)', () => {
  const xml = '<rss><item><title>제목에는 없음</title><link>https://x/1</link><dc:date>2026-11-16</dc:date>'
    + '<description><![CDATA[<p>DSR 소득산정 기준을 바꿉니다</p>]]></description></item>'
    + '<item><title>요약 없는 글</title><link>https://x/2</link><pubDate>Mon, 16 Nov 2026 00:00:00 GMT</pubDate></item></rss>';
  const items = parseRss(xml);
  assert.equal(items.length, 2);
  assert.match(items[0].desc, /DSR 소득산정 기준을 바꿉니다/); assert.doesNotMatch(items[0].desc, /<p>|CDATA/);
  assert.equal(items[1].desc, '');
  const src = fs.readFileSync(path.join(__dirname, '../jobs/regulationsAutoFetch.js'), 'utf8');
  assert.ok(src.includes("const _hay = it.title + ' ' + (it.desc || '');"));
  assert.ok(parseRss('<item><title>긴 요약</title><description>' + '가'.repeat(5000) + '</description></item>')[0].desc.length <= 600);
});

test('감지 기록: 같은 글은 한 번만 남고 처음 본 시각을 유지하며, 400일이 지난 글과 300건을 넘는 글은 버린다', () => {
  const now = Date.parse('2026-11-16T00:00:00Z');
  const prev = [
    { source: '금융위원회', title: '옛 글', link: 'https://x/old', pubDate: '2026-08-13T00:00:00.000Z', hits: ['주택'], firstSeen: '2026-08-14T00:00:00.000Z' },
    { source: '금융위원회', title: '아주 옛 글', link: 'https://x/ancient', pubDate: '2025-09-01T00:00:00.000Z', hits: ['대출'], firstSeen: '2025-09-02T00:00:00.000Z' },
  ];
  const sources = [{ name: '금융위원회', matched: [
    { title: '옛 글', link: 'https://x/old', pubDate: new Date('2026-08-13T00:00:00Z'), hits: ['주택'] },
    { title: '새 글', link: 'https://x/new', pubDate: new Date('2026-11-15T00:00:00Z'), hits: ['가계부채'] },
  ] }];
  const out = mergeDetected(prev, sources, now);
  assert.deepEqual(out.map((x) => x.link), ['https://x/new', 'https://x/old'], '최신순, 중복 없음, 400일 넘은 글 제외');
  assert.equal(out[1].firstSeen, '2026-08-14T00:00:00.000Z', '처음 본 시각 유지');
  const many = [{ name: 's', matched: Array.from({ length: 400 }, (_, i) => ({ title: 't' + i, link: 'https://x/' + i, pubDate: new Date(now - i * 60000), hits: ['대출'] })) }];
  assert.equal(mergeDetected([], many, now).length, 300);
  assert.deepEqual(mergeDetected(null, null, now), []);
  assert.equal(DETECTED_KEY, 'regulations:detected:v1');
});

test('검증 대기 수: 마지막 검증일 뒤에 나온 관련 글만 세고, 검증일을 고치면 0 으로 돌아간다', () => {
  const items = [
    { title: T_0813, link: 'a', pubDate: '2026-08-13T00:00:00.000Z', hits: ['주택'] },
    { title: '2026년 9월 가계대출 동향(잠정) 및 ｢가계부채 점검회의｣ 개최', link: 'b', pubDate: '2026-10-15T00:00:00.000Z', hits: ['가계부채', '대출'] },
    { title: '종부세 납부 안내', link: 'c', pubDate: '2026-10-20T00:00:00.000Z', hits: ['종부세'] },
    { title: '오래된 대출 글', link: 'd', pubDate: '2026-04-01T00:00:00.000Z', hits: ['대출'] },
  ];
  const before = pendingCounts(items, [{ key: 'housing_loan_2025', source_effective_date: '2026-05-19' }, { key: 'acquisition_tax_2025', source_effective_date: '2026-05-04' }]);
  assert.equal(before.housing_loan_2025, 2, '8.13 대책과 10.15 점검회의');
  assert.equal(before.acquisition_tax_2025, 1, '세금 글은 세금 기준 쪽에만 센다');
  const after = pendingCounts(items, [{ key: 'housing_loan_2025', source_effective_date: '2026-11-16' }]);
  assert.equal(after.housing_loan_2025, 0);
  assert.deepEqual(pendingCounts([], []), {});
});

test('배선: 예약 작업이 감지 기록을 저장하고 대기 수를 실행 기록에 남기며, 대기가 있으면 날마다 경고한다', () => {
  const ai = fs.readFileSync(path.join(__dirname, '../jobs/regulationsAiCheck.js'), 'utf8');
  assert.ok(ai.includes('pending = await persistDetected(fullSources, currentSnapshot);'));
  assert.ok(ai.includes('if (pending.total > 0) {'));
  assert.ok(ai.includes('pendingReview: pending.total,'));
  const cron = fs.readFileSync(path.join(__dirname, '../routes/cron.js'), 'utf8');
  assert.ok(cron.includes('pendingReview: result.pendingReview,'));
  const stats = fs.readFileSync(path.join(__dirname, '../services/cronStats.js'), 'utf8');
  assert.ok(stats.includes("'pendingReview',"));
  // cronStats 가 실제로 이 값을 통과시킨다
  const { _pick } = require('../services/cronStats');
  if (typeof _pick === 'function') assert.equal(_pick({ ok: 1, processed: 3, pendingReview: 2 }).pendingReview, 2);
});

test('POLICY-NOCUT-1118: run() 은 응답용 matched 를 5건으로 자르되 저장과 계수용 matchedAll 에는 걸린 글 전부를 담는다', async () => {
  const axiosPath = require.resolve('axios');
  const afPath = require.resolve('../jobs/regulationsAutoFetch');
  const saved = { axios: require.cache[axiosPath], af: require.cache[afPath] };
  const now = new Date().toUTCString();
  const xml = '<rss>' + Array.from({ length: 8 }, (_, i) => `<item><title>주택 정책 발표 ${i}</title><link>https://x/${i}</link><pubDate>${now}</pubDate></item>`).join('') + '</rss>';
  const axiosStub = { get: async () => ({ status: 200, data: xml }) }; // 가짜: 실제 정부 주소를 부르지 않는다
  require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: axiosStub };
  try {
    delete require.cache[afPath];
    const af = require('../jobs/regulationsAutoFetch');
    const out = await af.run();
    const molit = out.sources.find((s) => s.name === '국토교통부');
    assert.equal(molit.matched.length, 5, '응답은 종전대로 5건');
    assert.equal(molit.matchedAll.length, 8, '저장과 계수용 목록은 전부');
    assert.equal(molit.matched_count, 8);
  } finally {
    if (saved.axios) require.cache[axiosPath] = saved.axios; else delete require.cache[axiosPath];
    if (saved.af) require.cache[afPath] = saved.af; else delete require.cache[afPath];
  }
});

test('POLICY-NOCUT-1118: 한 소스에서 8건이 걸려도 8건이 저장되고 대기 수에도 8건이 세어진다', () => {
  const now = Date.parse('2026-11-18T00:00:00Z');
  const matched = Array.from({ length: 8 }, (_, i) => ({ title: '주택 정책 발표 ' + i, link: 'https://x/n' + i, pubDate: '2026-11-17T00:00:00.000Z', hits: ['주택'] }));
  const items = mergeDetected([], [{ name: '국토교통부', matched }], now);
  assert.equal(items.length, 8);
  const counts = pendingCounts(items, [{ key: 'housing_loan_2025', source_effective_date: '2026-11-10' }]);
  assert.equal(counts.housing_loan_2025, 8);
});

// POLICY-SRC-FAIL-1118 (plans/212): 소스를 못 읽은 수가 run() 반환에 남는다. 가짜 axios 만 쓰고 정부 주소는 부르지 않는다.
async function _runWithFakeAxios(get) {
  const axiosPath = require.resolve('axios');
  const afPath = require.resolve('../jobs/regulationsAutoFetch');
  const saved = { axios: require.cache[axiosPath], af: require.cache[afPath] };
  require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: { get } };
  try {
    delete require.cache[afPath];
    const af = require('../jobs/regulationsAutoFetch');
    return { out: await af.run(), total: af.RSS_SOURCES.length };
  } finally {
    if (saved.axios) require.cache[axiosPath] = saved.axios; else delete require.cache[axiosPath];
    if (saved.af) require.cache[afPath] = saved.af; else delete require.cache[afPath];
  }
}

test('POLICY-SRC-FAIL-1118: 모든 소스가 오류이거나 항목 0개이면 못 읽은 수가 전체와 같고, 항목이 있으면 0 이다', async () => {
  const a = await _runWithFakeAxios(async () => { throw new Error('Request failed with status code 404'); });
  assert.equal(a.out.sourcesTotal, a.total);
  assert.equal(a.out.sourcesFailed, a.total);
  assert.equal(a.out.totalMatched, 0);
  const b = await _runWithFakeAxios(async () => ({ status: 200, data: '<rss><channel></channel></rss>' }));
  assert.equal(b.out.sourcesFailed, b.total, '항목 0개도 못 읽은 것으로 센다');
  const now = new Date().toUTCString();
  const xml = `<rss><item><title>주택 정책 발표</title><link>https://x/1</link><pubDate>${now}</pubDate></item></rss>`;
  const c = await _runWithFakeAxios(async () => ({ status: 200, data: xml }));
  assert.equal(c.out.sourcesTotal, c.total);
  assert.equal(c.out.sourcesFailed, 0);
});

test('POLICY-SRC-FAIL-1118: 실행 기록이 못 읽은 수를 통과시킨다', () => {
  const { _pick } = require('../services/cronStats');
  const p = _pick({ ok: 1, processed: 0, pendingReview: 0, sourcesFailed: 4, sourcesTotal: 4 });
  assert.equal(p.sourcesFailed, 4);
  assert.equal(p.sourcesTotal, 4);
  const stats = fs.readFileSync(path.join(__dirname, '../services/cronStats.js'), 'utf8');
  assert.ok(stats.includes("'canceledRemoved'];"));
});

test('POLICY-SRC-FAIL-1118: 배선. 처리기가 기록하고 알리되 소스 실패로 500 을 주지 않는다', () => {
  const cron = fs.readFileSync(path.join(__dirname, '../routes/cron.js'), 'utf8');
  assert.ok(cron.includes('sourcesFailed: result.sourcesFailed'));
  assert.ok(cron.includes("monitor: 'policy-sources'"));
  const check = fs.readFileSync(path.join(__dirname, '../jobs/regulationsAiCheck.js'), 'utf8');
  assert.ok(check.includes('sourcesFailed: rssSummary.sourcesFailed'));
  const s = cron.indexOf('async function handleRegulationsAutoFetch');
  const e = cron.indexOf("router.post('/regulations-auto-fetch'");
  assert.ok(s >= 0 && e > s);
  assert.equal(cron.slice(s, e).split('res.status(500)').length - 1, 1, '기존 catch 의 한 번만 있어야 한다');
});
