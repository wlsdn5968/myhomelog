/**
 * backend/test/usertest-1118.test.js
 *
 * 2026-11-18 사용자 시나리오 점검(크롬 데스크톱, 앱 안 브라우저 375x812 와 375x667)에서 고친 것을 고정한다.
 *   DETAIL-LOAN-1118   단지 상세 실투자금이 사이드바 매수가(기본 7억)의 대출 한도를 쓰던 것
 *   ANCHOR-DAYS-1118   "최근 거래일 N일 전"이 KST 저녁에 하루 많던 것
 *   LEASE-TOHEO-1118   규제지역 전세 낀 집 특약에 토지거래허가 안내가 없던 것
 *   NEWS-REL-1118      브리핑 '그 밖의 소식'에 무관 기사가 섞이던 것
 *   FAB-SHEET-1118     휴대폰 지도에서 관심, 채팅 버튼이 지도 버튼 묶음을 덮던 것
 *   CHAT-CLOSE-1118    휴대폰 채팅 창에 닫는 버튼이 없던 것
 * 실행: cd backend && TZ=UTC node --test test/usertest-1118.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readIndexHtml } = require('../testSupport/readFrontend');

function fnSrc(html, name) {
  const i = html.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} 를 찾지 못했다`);
  return html.slice(i, html.indexOf('\n}\n', i) + 2);
}

test('DETAIL-LOAN-1118: 단지 상세 실투자금은 이 단지 가격과 시군구로 한도를 다시 계산한다', () => {
  const html = readIndexHtml();
  const calls = [];
  const sb = {
    document: { getElementById: (id) => ({ mc: { value: '3' }, inc: { value: '' } }[id] || null) },
    gct: (k) => ({ 'ch-h': '무주택', 'ch-f': '' }[k] || ''),
    getRegionForSearch: () => '서울',
    calcLTV: (...a) => { calls.push(a); return { fin: Math.min(a[0] * 0.4, 6) }; },
  };
  vm.runInNewContext(fnSrc(html, 'getLoanAmtFor') + '\nthis.f=getLoanAmtFor;', sb);
  const fin = sb.f({ avgPrice: 6.38, area: '노원구 상계동', lawdCd: '11350' });
  assert.equal(calls[0][0], 6.38, '사이드바 매수가가 아니라 이 단지 가격으로 계산한다');
  assert.equal(calls[0][6], '서울 노원구 상계동', '수도권 판정(스트레스 금리)을 위해 시도 이름을 붙인다');
  assert.equal(calls[0][7], '11350');
  assert.ok(Math.abs(fin - 2.552) < 1e-9);
  assert.equal(sb.f({ avgPrice: 0 }), 0, '가격이 없으면 0');
  // 두 호출부 모두 새 함수를 쓴다
  assert.ok(html.includes('const loanAmt=getLoanAmtFor(p);'));
  assert.ok(!/renderAnalysisFallback\(p\)\{\r?\n\s+const loanAmt=getLoanAmt\(\);/.test(html));
});

test('ANCHOR-DAYS-1118: 서버는 한국 날짜끼리 빼서 거래일 경과일을 센다', () => {
  const { _internals } = require('../services/analysisService');
  const tx = [{ dealYear: 2026, dealMonth: 11, dealDay: 12 }, { dealYear: 2026, dealMonth: 9, dealDay: 1 }];
  const real = Date.now;
  try {
    Date.now = () => Date.parse('2026-11-18T13:30:00Z'); // KST 11-18 22:30
    assert.equal(_internals.calcVolumeSignal(tx).daysSinceAnchor, 6);
    Date.now = () => Date.parse('2026-11-18T16:00:00Z'); // KST 11-19 01:00
    assert.equal(_internals.calcVolumeSignal(tx).daysSinceAnchor, 7);
  } finally { Date.now = real; }
  const html = readIndexHtml();
  assert.ok(html.includes("(${_anchorDays === 0 ? '오늘' : _anchorDays + '일 전'})"), '화면도 거래일 날짜로 다시 센다');
});

test('LEASE-TOHEO-1118: 규제지역 전세 낀 집 특약에는 토지거래허가와 실거주 유예 안내가 붙고, 비규제에는 붙지 않는다', () => {
  const html = readIndexHtml();
  const src = fnSrc(html, 'buildRuleClause');
  const run = (isReg) => {
    const sb = { isRegFront: () => isReg, _fmtSgg: (a) => a };
    vm.runInNewContext(src + '\nthis.f=buildRuleClause;', sb);
    const out = sb.f({ aptName: '헬리오시티', area: '송파구 가락동', price: 18, buildYear: 2018, issues: '전세 낀 집' });
    const all = [...(out.essential || []), ...(out.recommended || [])];
    return all.find((c) => c.title === '임대차 승계 조건 명시');
  };
  const reg = run(true);
  assert.ok(reg, '세입자 승계 특약이 있어야 한다');
  assert.match(reg.reason, /토지거래허가구역/);
  assert.match(reg.reason, /2027\.12\.31/);
  const non = run(false);
  assert.ok(non && !/토지거래허가/.test(non.reason));
});

test('NEWS-REL-1118: 요약에 단어가 하나뿐인 무관 기사는 빠지고, 제목에 부동산 단어가 있거나 요약에 3개 이상이면 남는다(운영 표본)', () => {
  const { _relevantNews } = require('../routes/news');
  const hearing = { title: '행안위, 김종철 경찰청장 후보자 청문보고서 채택…여야 평가 엇갈려', description: '국민의힘은 부동산 보유 등 청문회... 반면' };
  const tv = { title: '‘톡파원25시’ 이찬원 사로잡은 미국 샌프란시스코 펜트하우스', description: '부동산 투자 전문가 송희구와 함께 중국 옌타이 가성비 여행' };
  const tax = { title: '울산시, 고액·상습체납자 194명 명단 공개', description: '업종별로는 부동산업이 32명으로 16.5%를 차지해' };
  const rent = { title: '"신림동 빌라도 월세 100만원"…아파트 이어 빌라 월세도 최고치', description: '' };
  const desc3 = { title: '도심 정비 논의', description: '재건축 조합과 재개발 정비사업 일정' };
  assert.deepEqual(_relevantNews('hot', [hearing, tv, tax, rent]), [rent]);
  assert.deepEqual(_relevantNews('reno', [desc3]), [desc3], '요약에 분류 단어 3개면 남는다');
  assert.deepEqual(_relevantNews('lease', [{ title: '서울 집값 올라', description: '' }]).length, 1, '제목은 공통 단어도 본다');
});

test('FAB-SHEET-1118: 휴대폰 지도의 관심, 채팅 버튼 위치 규칙은 한 곳에만 있고 목록 시트 머리 안에 나란히 둔다', () => {
  const html = readIndexHtml();
  const defs = (sel) => (html.match(new RegExp(`body\\.hp-on \\${sel}\\{bottom:`, 'g')) || []).length;
  assert.equal(defs('.fab-ai'), 1, '같은 규칙이 두 곳이면 뒤엣것이 앞엣것을 덮는다(전에 그랬다)');
  assert.equal(defs('.fab-bm'), 1);
  assert.equal(defs('.bm-pop'), 1);
  assert.ok(html.includes('body.hp-on .fab-bm{bottom:calc(var(--hps-pad,0px) + 12px);right:68px;width:44px;height:44px}'));
  assert.ok(html.includes('body.ms-open .fab-ai,body.ms-open .fab-bm,body.ms-open .bm-pop{visibility:hidden}'));
});

test('CHAT-CLOSE-1118: 떠 있는 채팅 창 머리에 닫기 버튼이 있다', () => {
  const html = readIndexHtml();
  assert.ok(html.includes('<button type="button" class="chat-x" onclick="_closeAiPanel()" title="닫기" aria-label="데이터 도우미 닫기">'));
  assert.ok(html.includes('.rp.rp-overlay .chat-x{display:inline-flex}'));
  assert.ok(/\.chat-x\{display:none;[^}]*width:44px;height:44px/.test(html), '누르는 자리 44px');
});

test('COMM-NEG-1118: 복비의 협의 구간 표시는 9억 이상에만 붙는다(라벨 "2억 ~ 9억"에 걸리지 않는다)', () => {
  const html = readIndexHtml();
  assert.ok(html.includes('const isNegotiableTier = price >= 9;'));
  assert.ok(!html.includes("/협의|9억|12억|15억/.test(tier.label)"));
});

test('POLICY-1118: 실거주 유예 연장 카드는 법령 원문(시행령 제14조의2)으로 시행을 확인했다고 적는다', () => {
  const j = require('../data/policy-changes.json');
  const it = j.items.find((x) => x.title === '실거주 유예 신청 기한 1년 연장');
  assert.ok(it);
  assert.ok(!/확인하지 못했/.test(it.note));
  assert.ok(it.src.some((u) => u.startsWith('https://www.law.go.kr/') && u.includes('제14조의2')));
  assert.match(it.after, /2027\.12\.31/);
});
