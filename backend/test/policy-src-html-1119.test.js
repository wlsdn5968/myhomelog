/**
 * backend/test/policy-src-html-1119.test.js
 *
 * POLICY-SRC-HTML-1119 (운영자 승인 "권고대로 진행", 2026-11-19): 정책 감지 소스를 RSS 에서 기관 누리집 보도자료 목록으로 바꿨다.
 * 아래 HTML 조각은 2026-11-19 에 네 기관 목록 페이지에서 받은 실제 줄을 줄인 것이다. 정부 주소는 부르지 않는다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LIST_PARSERS, RSS_SOURCES } = require('../jobs/regulationsAutoFetch');

const MOLIT = `<tbody>
<tr>
<td class="bd_num">839</td>
<td class="bd_title">
<a href="dtl.jsp?lcmspage=1&amp;id=95092623" class="new">
[차관동정] 정의경 제2차관, “국민 불편이 없도록 신속한 노사합의와 철저한 대비 필요”
<i><img src="/images/www2019/board/bd_new.gif" alt="새글" /></i>
</a>
</td>
<td class="bd_field">도로철도</td>
<td class="bd_date">2026-11-19</td>
<td class="bd_inquiry">92</td>
</tr>
<tr><td class="bd_num">830</td><td class="bd_title"><a href="dtl.jsp?lcmspage=1&amp;id=95092600">「주택법 시행령」 개정안, 국무회의 의결</a></td><td class="bd_date">2026-11-16</td></tr>`;

const FSC = `<li>
<div class="inner">
<div class="count">15478</div>
<div class="cont">
<div class="subject">
<a href="/no010101/88173?srchCtgry=&curPage=1&srchKey=&srchText=&srchBeginDt=&srchEndDt=" title="깜빡 잊고 지나가버린 지난 3년간 실손보험금, ‘실손24’를 통해  한방에 청구하고 받을 수 있습니다" class="new">깜빡 잊고<span class="newbbs-span">. 금일 등록된 게시글</span></a>
</div>
</div>
<div class="day">2026-11-19</div>
</div>
</li>
<li><a href="/menu">메뉴</a></li>`;

const MOFE = `<ul class="boardType3 explnList">
<li>
<h3><a href="javascript:fn_egov_select('MOSF_000000000080007');">'26.11월 국고채 「모집 방식 비경쟁인수」 발행 미실시</a></h3>
<div class="boardInfo">
<div class="infoLeft">
<span class="date">2026.11.19.</span>
<span class="depart">국채정책과</span>
</div>
</div>
</li>`;

const NTS = `<tbody>
<tr>
<td data-table="number">3317</td>
<td data-table="subject" class="bbs_tit">
<a href="javascript:;" data-id="1356171" title="「세무사 시험 부정행위 대응 TF」 킥오프 회의 및 세무사 시험 부정행위자 시험 무효 절차 개시"  class="nttInfoBtn">
「세무사 시험 부정행위 대응 TF」</a>
</td>
<td data-table="write">소득세과</td>
<td data-table="date">2026.11.17.</td>
</tr>`;

test('POLICY-SRC-HTML-1119: 네 기관 목록에서 제목, 상세 주소, 한국 날짜(그날 0시)를 읽는다', () => {
  const m = LIST_PARSERS.molit(MOLIT);
  assert.equal(m.length, 2);
  assert.equal(m[0].title, '[차관동정] 정의경 제2차관, “국민 불편이 없도록 신속한 노사합의와 철저한 대비 필요”', '새글 표시 그림은 제목에서 뺀다');
  assert.equal(m[0].link, 'https://www.molit.go.kr/USR/NEWS/m_71/dtl.jsp?id=95092623');
  assert.equal(m[0].pubDate.toISOString(), '2026-11-18T15:00:00.000Z');
  assert.equal(m[1].title, '「주택법 시행령」 개정안, 국무회의 의결');

  const f = LIST_PARSERS.fsc(FSC);
  assert.equal(f.length, 1, '메뉴 li 는 건너뛴다');
  assert.equal(f[0].link, 'https://www.fsc.go.kr/no010101/88173');
  assert.match(f[0].title, /^깜빡 잊고 지나가버린 지난 3년간 실손보험금/);
  assert.equal(f[0].pubDate.toISOString(), '2026-11-18T15:00:00.000Z');

  const o = LIST_PARSERS.mofe(MOFE);
  assert.equal(o.length, 1);
  assert.equal(o[0].title, "'26.11월 국고채 「모집 방식 비경쟁인수」 발행 미실시");
  assert.equal(o[0].link, 'https://mofe.go.kr/nw/nes/detailNesDtaView.do?searchBbsId1=MOSFBBS_000000000028&searchNttId1=MOSF_000000000080007&menuNo=4010100');

  const n = LIST_PARSERS.nts(NTS);
  assert.equal(n.length, 1);
  assert.equal(n[0].link, 'https://www.nts.go.kr/nts/na/ntt/selectNttInfo.do?mi=2201&bbsId=1028&nttSn=1356171');
  assert.equal(n[0].pubDate.toISOString(), '2026-11-16T15:00:00.000Z');

  for (const k of Object.keys(LIST_PARSERS)) assert.deepEqual(LIST_PARSERS[k]('<html>점검 중</html>'), [], `${k}: 목록이 아니면 0건`);
});

test('POLICY-SRC-HTML-1119: 소스는 죽은 RSS 를 쓰지 않고 네 기관 목록을 쓴다', () => {
  assert.deepEqual(RSS_SOURCES.map((s) => s.name), ['금융위원회', '국토교통부', '재정경제부', '국세청']);
  for (const s of RSS_SOURCES) {
    assert.ok(LIST_PARSERS[s.parse], `${s.name}: 해석기`);
    assert.ok(!/korea\.kr\/rss|fsc_bbs_rss/.test(s.url), `${s.name}: 2026-07-01 중단된 정책브리핑 RSS 나 503 인 금융위 RSS 를 쓰지 않는다`);
    assert.ok(s.keywords.length >= 5);
  }
  assert.ok(RSS_SOURCES.find((s) => s.name === '국토교통부').cookieRetry);
});

async function runWith(get) {
  const axiosPath = require.resolve('axios');
  const afPath = require.resolve('../jobs/regulationsAutoFetch');
  const saved = { axios: require.cache[axiosPath], af: require.cache[afPath] };
  require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: { get } };
  try {
    delete require.cache[afPath];
    return await require('../jobs/regulationsAutoFetch').run();
  } finally {
    if (saved.axios) require.cache[axiosPath] = saved.axios; else delete require.cache[axiosPath];
    if (saved.af) require.cache[afPath] = saved.af; else delete require.cache[afPath];
  }
}

test('POLICY-SRC-HTML-1119: 국토교통부는 첫 307 의 쿠키를 받아 한 번만 다시 부르고, 쿠키가 없으면 실패로 센다', async () => {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  // TIMEBOMB-1127: "주택" 낱말이 든 둘째 줄(2026-11-16)도 오늘로 바꾼다. 고정 날짜는 감지 창(LOOK_BACK_DAYS 7일)을 지나면 걸리지 않아
  //   2026-11-23 무렵부터 이 검사가 실패했다(2026-11-27 정기 점검에서 발견).
  const molitHtml = MOLIT.replace('2026-11-19', today).replace('2026-11-16', today);
  const calls = [];
  const out = await runWith(async (url, opts) => {
    calls.push({ url, cookie: opts.headers && opts.headers.Cookie, maxRedirects: opts.maxRedirects });
    if (!url.includes('molit.go.kr')) return { status: 200, data: '<html></html>' };
    if (!opts.headers.Cookie) return { status: 307, headers: { 'set-cookie': ['clientid=abc; Path=/', 'TMOSHCooKie=xyz; Path=/'] }, data: '' };
    return { status: 200, data: molitHtml };
  });
  const molit = calls.filter((c) => c.url.includes('molit.go.kr'));
  assert.equal(molit.length, 2);
  assert.equal(molit[0].maxRedirects, 0, '첫 요청은 따라가지 않는다(끝없이 돈다)');
  assert.equal(molit[1].cookie, 'clientid=abc; TMOSHCooKie=xyz');
  const s = out.sources.find((x) => x.name === '국토교통부');
  assert.equal(s.total, 2);
  assert.ok(s.matchedAll.length >= 1, '오늘 날짜 글 가운데 주택 낱말이 있는 글이 걸린다');
  assert.equal(out.sourcesFailed, 3, '나머지 셋은 빈 페이지라 못 읽은 것으로 센다');

  const bad = await runWith(async (url) => (url.includes('molit.go.kr') ? { status: 307, headers: {}, data: '' } : { status: 200, data: '' }));
  assert.match(bad.sources.find((x) => x.name === '국토교통부').error, /without cookie/);
});

test('POLICY-SRC-HTML-1119: 해석은 줄 단위로 잘라 짧은 패턴만 쓴다(큰 페이지에서도 빨리 끝난다)', () => {
  const big = '<tr><td class="bd_title"><a href="dtl.jsp?id=1">' + 'a'.repeat(200000) + '</a></td><td class="bd_date">2026-11-19</td></tr>';
  const t0 = Date.now();
  for (const k of Object.keys(LIST_PARSERS)) LIST_PARSERS[k](big + '<li>' + 'b'.repeat(200000));
  assert.ok(Date.now() - t0 < 1000, `네 해석기 합계 ${Date.now() - t0}ms`);
  const src = fs.readFileSync(path.join(__dirname, '../jobs/regulationsAutoFetch.js'), 'utf8');
  assert.ok(src.includes("split(/<tr[\\s>]/i)") && src.includes("split(/<li[\\s>]/i)"));
});

test('PENDING-KST-1119: 검증일 다음 날(KST) 날짜만 있는 글도 대기 수에 들고, 검증일 당일 글은 빠진다', () => {
  const { pendingCounts } = require('../jobs/regulationsAiCheck');
  const items = [
    { title: '주택 공급 발표(검증일 당일)', link: 'a', pubDate: '2026-11-15T15:00:00.000Z', hits: ['주택'] }, // KST 11-16 0시
    { title: '주택 공급 발표(다음 날)', link: 'b', pubDate: '2026-11-16T15:00:00.000Z', hits: ['주택'] }, // KST 11-17 0시
    { title: '날짜 없는 글', link: 'c', pubDate: null, hits: ['주택'] },
  ];
  assert.equal(pendingCounts(items, [{ key: 'housing_loan_2025', source_effective_date: '2026-11-16' }]).housing_loan_2025, 1);
});
