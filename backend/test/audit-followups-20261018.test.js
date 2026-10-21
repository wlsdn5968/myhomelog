/**
 * backend/test/audit-followups-20261018.test.js
 *
 * 2026-10-18 전수 점검 후속(운영자 "권고대로" 승인). 보안 감사 #2~#4 · 뉴스 관련성 · 데이터 상태 창 · 문구 사실 정정.
 * 동작으로 검사할 수 있는 것은 실제 함수를 부르고, 나머지는 이 저장소 관례대로 소스를 정적으로 본다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const html = read('../../frontend/index.html');

// ── 보안 #3: 지역 코드·거래년월 ─────────────────────────────────────────
test('isKnownLawdCd — 코드 표·폐지 코드는 통과, 임의 5자리는 거부', () => {
  const { isKnownLawdCd, LAWD_CODES } = require('../services/transactionService');
  assert.equal(isKnownLawdCd('11680'), true);
  assert.equal(isKnownLawdCd('28110'), true, '폐지 코드도 지역 대시보드가 쓴다');
  for (const c of Object.values(LAWD_CODES)) assert.equal(isKnownLawdCd(c), true, c);
  for (const c of ['99999', '00000', '1168', '116800', '', null, undefined]) assert.equal(isKnownLawdCd(c), false, String(c));
});

function runValidate(query) {
  const { validateTransactionQuery } = require('../middleware/validation');
  let status = null, nexted = false;
  const res = { status(s) { status = s; return this; }, json() { return this; } };
  validateTransactionQuery({ query }, res, () => { nexted = true; });
  return { status, nexted };
}
test('validateTransactionQuery — 모르는 지역·말이 안 되는 거래년월은 400', () => {
  assert.deepEqual(runValidate({ lawdCd: '11680', dealYm: '202609' }), { status: null, nexted: true });
  assert.equal(runValidate({ lawdCd: '99999', dealYm: '202609' }).status, 400);
  assert.equal(runValidate({ lawdCd: '11680', dealYm: '202613' }).status, 400);
  assert.equal(runValidate({ lawdCd: '11680', dealYm: '199912' }).status, 400);
  // 프런트는 한국 시간으로 이번 달을 만든다 — 1월 1일 00~09시 KST 는 UTC 로 전년이라 다음 해 1월도 받아야 한다
  assert.deepEqual(runValidate({ lawdCd: '11680', dealYm: `${new Date().getUTCFullYear() + 1}01` }), { status: null, nexted: true });
  assert.equal(runValidate({ lawdCd: '11680', dealYm: `${new Date().getUTCFullYear() + 2}01` }).status, 400);
});

test('analysis·building-register 도 알려진 지역 코드만 받고, 공개 aptKey 는 받지 않는다', () => {
  assert.match(read('../routes/analysis.js'), /isKnownLawdCd\(lawdCd\)/);
  const props = read('../routes/properties.js');
  assert.match(props, /const \{ lawdCd, sigungu, umd, apt \} = req\.query;/);
  assert.doesNotMatch(props, /aptKey: aptKey/);
  assert.doesNotMatch(props, /error: e\.message, title: null/);
});

test('청약·뉴스 캐시 키는 정규화된 값만', () => {
  const subs = read('../routes/subscription.js');
  assert.match(subs, /if \(sido && !SIDO\.includes\(sido\)\) return res\.status\(400\)/);
  assert.match(subs, /\[30, 60, 90, 180\]\.find/);
  // 화면 칩 값은 모두 허용 목록 안
  const chips = [...html.matchAll(/data-sido="([^"]*)"/g)].map(m => m[1]).filter(Boolean);
  const SIDO = (subs.match(/const SIDO = \[([^\]]+)\]/) || [])[1];
  for (const c of chips) assert.ok(SIDO.includes(`'${c}'`), c);
  assert.match(read('../routes/news.js'), /hasOwnProperty\.call\(KEYWORDS, _c\) \? _c : 'hot'/);
});

// ── 보안 #4: 푸시 주소 ──────────────────────────────────────────────────
test('푸시 구독 주소는 브라우저 푸시 서비스 호스트만', () => {
  const { _isPushServiceEndpoint: ok } = require('../routes/push');
  for (const u of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/x',
    'https://web.push.apple.com/QK', 'https://wns2-bl2p.notify.windows.com/w/?token=x']) assert.equal(ok(u), true, u);
  for (const u of ['https://example.com/x', 'https://fcm.googleapis.com.evil.com/x', 'https://evilpush.apple.com/x',
    'https://notify.windows.com.attacker.net/', 'not a url', 'https://127.0.0.1/x']) assert.equal(ok(u), false, u);
  assert.match(read('../jobs/pushNotify.js'), /\{ TTL: 86400, timeout: 10000 \}/);
});

// ── 보안 #2: 무인증 동의 기록 ───────────────────────────────────────────
test('동의 기록은 같은 연결의 10분 안 반복을 건너뛴다(영구 보관 행 폭증 방지)', () => {
  const acc = read('../routes/account.js');
  assert.match(acc, /const CONSENT_DEDUP_MS = 10 \* 60 \* 1000;/);
  assert.match(acc, /if \(last && now - last < CONSENT_DEDUP_MS\) return res\.json\(\{ ok: true, deduped: true \}\);/);
  // 전체 IP 로 판정(같은 /24 의 다른 사람을 묶지 않게), 키는 기록한 뒤에 남긴다
  assert.match(acc, /const dedupKey = `\$\{req\.ip \|\| ''\}\|/);
  assert.match(acc, /await writeAudit\(req, 'consent\.accept', 'consent', null, meta\);\n\s*_consentSeen\.set\(dedupKey, now\);/);
  // 카카오도 구글·이메일처럼 리다이렉트 전에 동의를 기록한다
  const kakao = html.slice(html.indexOf('async function loginKakao(){'), html.indexOf('async function loginEmail(){'));
  assert.match(kakao, /await _recordConsentAudit\(\);\s*\n\s*try \{ await A\.signInWithKakao\(\); \}/);
});

// ── 뉴스 관련성 ─────────────────────────────────────────────────────────
test('뉴스 관련성 — 전세버스·해외 기사는 빠지고 부동산 기사는 남는다(운영 실측 표본)', () => {
  const { _relevantNews } = require('../routes/news');
  const tennis = { title: "17세 '안동시청 선수' 김원민, 홍종문배 국제주니어테니스 우승", description: '단풍철이라 구하기 힘든 전세버스까지 미리 확보해' };
  const lease = { title: '"딱 2년만 더 살고 싶은데"…서울 전세 ', description: '국토교통부의 8월 주택통계에 따르면' };
  const china = { title: '[중국증시 주간 포인트] 中 3Q GDP∙9월 실물경제 지표', description: '중국의 GDP 성장률은' };
  const hot = { title: '강남 아파트값 10주째 하락…정부 "하향 안정 지표"', description: '' };
  assert.deepEqual(_relevantNews('lease', [tennis, lease]), [lease]);
  assert.deepEqual(_relevantNews('region', [china, hot]), [hot]);
  assert.deepEqual(_relevantNews('hot', [hot]), [hot]);
});

// ── 프런트: 목록 숫자 · 가격 자리수 · 데이터 상태 · 문구 ────────────────
test("목록 머리말은 '전체 단지 N개 중'(부분집합 아님) 대신 실제 모집단을 밝힌다", () => {
  assert.doesNotMatch(html, /전체 단지 \$\{ta\}개 중이에요/);
  assert.match(html, /최근 6개월 거래가 있는 단지 \$\{tt\}곳을 살폈어요/);
  assert.match(html, /const tt = searchMeta && Number\(searchMeta\.totalTx\) > 0 \? _num\(searchMeta\.totalTx\) : '';/, '0곳이 표시되면 안 된다');
});

test('같은 값의 억 표기는 소수 둘째 자리로 통일, 소개 카드는 60일 평균 라벨', () => {
  // LANDING-V5-2026-10-21: 소개 화면의 평균가 칸은 구별 1위 목록으로 옮겼다 — 같은 둘째 자리 표기·라벨
  assert.match(html, /const amt = Number\(p\.avgDealAmount\) > 0 \? `\$\{\(Number\(p\.avgDealAmount\) \/ 10000\)\.toFixed\(2\)\}억` : '';/);
  assert.match(html, /<span class="lv-ds">\$\{amt \? '평균 거래가' : ''\}<\/span>/);
  assert.match(html, /<span class="ass-price-v">\$\{\(p\.avgPrice\)\.toFixed\(2\)\}억<\/span>/);
  assert.doesNotMatch(html, /\$\{\(p\.avgPrice\)\.toFixed\(1\)\}억/);
});

test('데이터 상태 창 — 내부 작업명 대신 한글 이름표, 기준은 cronStats 와 같게', () => {
  const cron = read('../services/cronStats.js');
  const block = html.slice(html.indexOf('const JOB_LABEL={'), html.indexOf('};', html.indexOf('const JOB_LABEL={')));
  const pairs = [...block.matchAll(/'([a-z-]+)':\['[^']+',(\d+)\]/g)].map(m => [m[1], Number(m[2])]);
  assert.ok(pairs.length >= 14, '이름표가 비었다');
  for (const [name, h] of pairs) {
    const m = cron.match(new RegExp(`'${name}':\\s*(\\d+)`));
    assert.ok(m, `cronStats CRON_MAX_AGE_H 에 ${name} 이 없다`);
    assert.equal(Number(m[1]), h, `${name} 기준이 서버(${m[1]})와 다르다`);
  }
  assert.doesNotMatch(html, /자동 작업 · \$\{_escHtml\(String\(j\.name/);
});

test('문구 사실 정정 — 수집 범위 · 결제 FAQ · 프로 플랜 한도', () => {
  assert.doesNotMatch(html, /이메일 외 다른 정보는 수집하지 않아요/);
  assert.doesNotMatch(html, /사업자등록이 끝난 뒤 열릴 예정/);
  assert.doesNotMatch(html, /프로 플랜이 나오면 무제한/);
  // 프로 플랜이 실제로 무제한이 아님(근거)
  const { PLAN_LIMITS } = (() => { try { return require('../services/planService'); } catch (_) { return {}; } })();
  if (PLAN_LIMITS && PLAN_LIMITS.pro) assert.ok(Number.isFinite(PLAN_LIMITS.pro.dailyReport));
});
