/**
 * PUSH-EMPTY-1127 (감사 3차 발견 13 조사에서 찾음): 관심 단지를 모두 지우면 서버의 알림 대상 목록도 비워야 한다.
 *  종전엔 단지가 0개면 아무것도 보내지 않아 서버에 마지막 목록이 남았고, 매일 알림(jobs/pushNotify.js 246, 278행이
 *  저장된 items 로 대상을 고른다)이 지운 단지 소식을 계속 보낼 수 있었다.
 *  브라우저 알림은 서버 구독을 지우고(/api/push/subscribe 는 빈 목록을 400 으로 거절한다), 카카오는 빈 목록을 보낸다.
 * 실행: cd backend && TZ=UTC node --test test/push-empty-1127.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readIndexHtml } = require('../testSupport/readFrontend');

const html = readIndexHtml();
function fnSrc(name) {
  const a = html.indexOf(`function ${name}(`);
  assert.ok(a > 0, `${name} 를 찾지 못했다`);
  let i = html.indexOf('{', html.indexOf(')', a)), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(a, i + 1); }
  }
  throw new Error(`${name} 의 끝을 찾지 못했다`);
}

// _schedulePushItemsSync 를 가짜 환경에서 실제로 돌려 나간 요청을 모은다.
async function run({ items, pushOn, hasSub, kko }) {
  const calls = [];
  let timer = null;
  const env = {
    _pushSyncT: null, _pushOn: pushOn, _kkoLinked: kko,
    CFG: { api: '/api' },
    _pushItems: () => items,
    navigator: { serviceWorker: { getRegistration: async () => ({ pushManager: { getSubscription: async () => (hasSub ? { endpoint: 'https://fcm.googleapis.com/x', toJSON: () => ({ endpoint: 'e' }) } : null) } }) } },
    fetch: (url, opt) => { calls.push({ url, body: JSON.parse(opt.body) }); return Promise.resolve({}); },
    _authHdr: async (h) => h,
    clearTimeout: () => {},
    setTimeout: (f) => { timer = f; return 1; },
  };
  new Function('env', `with(env){ ${fnSrc('_schedulePushItemsSync')}; _schedulePushItemsSync(); }`)(env);
  await timer();
  return calls;
}
const ITEM = { aptName: '상계주공7단지', lawdCd: '11350', sigungu: '노원구', umdNm: '상계동' };

test('관심 단지가 있으면 종전처럼 서버 구독과 카카오 목록을 갱신한다', async () => {
  const c = await run({ items: [ITEM], pushOn: true, hasSub: true, kko: true });
  assert.deepEqual(c.map((x) => x.url), ['/api/push/subscribe', '/api/kakao/items']);
  assert.deepEqual(c[0].body.items, [ITEM]);
});

test('관심 단지를 모두 지우면 서버 구독을 지우고 카카오에는 빈 목록을 보낸다', async () => {
  const c = await run({ items: [], pushOn: true, hasSub: true, kko: true });
  assert.deepEqual(c.map((x) => x.url), ['/api/push/unsubscribe', '/api/kakao/items']);
  assert.equal(c[0].body.endpoint, 'https://fcm.googleapis.com/x');
  assert.deepEqual(c[1].body.items, []);
});

test('알림을 켜지 않았거나 이 기기 구독이 없으면 브라우저 알림 요청을 보내지 않는다(종전과 같음)', async () => {
  assert.deepEqual((await run({ items: [], pushOn: false, hasSub: true, kko: false })).length, 0);
  assert.deepEqual((await run({ items: [], pushOn: true, hasSub: false, kko: false })).length, 0);
  assert.deepEqual((await run({ items: [ITEM], pushOn: false, hasSub: true, kko: false })).length, 0);
});

test('서버: 카카오 목록 경로는 빈 목록을 그대로 저장한다(정리 함수가 빈 배열을 돌려준다)', () => {
  assert.deepEqual(require('../routes/kakao')._allowedItems([]), []);
});
