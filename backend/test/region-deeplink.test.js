/**
 * backend/test/region-deeplink.test.js
 *
 * Plan 125 — `/region/:lawdCd` CTA 딥링크(`?region=`) + 공유 URL 의 세부 지역 선택이
 * 늦은 메뉴 로드로 지워지던 기존 버그.
 *
 * [배경 — 계획서 §1 실측] region.js `/menu` 핸들러 안에서만 계산되던 광역·라벨 규칙을
 *   `menuEntryForLawd(code)` 순수 함수로 뽑아 `regionPage.js` 의 지역 상세 CTA 가 **같은 규칙**으로
 *   앱 딥링크(`?region=<광역> <세부>`)를 만들게 했다. 프론트에서는 `restoreSearchFromUrl()`
 *   (동기, `:3655` 에서 호출)이 세부 지역 칩을 켠 뒤 `loadRegionMenu()`(비동기, `:3580` 에서 시작)가
 *   서버 메뉴로 `#ch-r-sub` 를 다시 그리며 그 선택을 지우던 버그를, 요청 목록을 남기는
 *   `window._pendingRegionSubs` 와 두 함수가 공유하는 매칭 헬퍼 `_applyRegionSubs()` 로 고쳤다.
 *
 * ⚠ 프론트(index.html)는 DOM 이 없는 backend test 환경에서 실행 검증이 어렵다 — 배선(공유 헬퍼
 *   사용·호출 존재)만 소스 문자열로 고정한다(frontend-contracts.test.js 의 읽기 방식을 따름).
 *   실제 브라우저 동작(칩이 실제로 켜지는지)은 배포 후 리뷰어가 라이브로 확인한다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REGION_PAGE_JS_PATH = path.join(__dirname, '../routes/regionPage.js');
const INDEX_HTML_PATH = path.join(__dirname, '../../frontend/index.html');

// ── menuEntryForLawd: 라이브 메뉴 실측 7건 + 경계값 (계획서 §1) ────────────────────────────────
test('menuEntryForLawd — 라이브 /api/region/menu 실측 7건과 일치하고, 퇴역·미상 코드는 null (Plan 125)', () => {
  const { menuEntryForLawd } = require('../routes/region');
  const { RETIRED_LAWD_CODES } = require('../services/transactionService');

  // 2026-09-28 계획자 라이브 실측(계획서 §1) — 서울·경기·인천은 그대로, 그 외 시도는 '지방' + 시도명.
  assert.deepEqual(menuEntryForLawd('11350'), { wide: '서울', label: '노원구' });
  assert.deepEqual(menuEntryForLawd('41131'), { wide: '경기', label: '성남시 수정구' });
  assert.deepEqual(menuEntryForLawd('41117'), { wide: '경기', label: '수원시 영통구' });
  assert.deepEqual(menuEntryForLawd('26350'), { wide: '지방', label: '부산 해운대구' });
  assert.deepEqual(menuEntryForLawd('43113'), { wide: '지방', label: '충북 청주시 흥덕구' });
  assert.deepEqual(menuEntryForLawd('28185'), { wide: '인천', label: '연수구' });
  assert.deepEqual(menuEntryForLawd('36110'), { wide: '지방', label: '세종 세종특별자치시' });

  // 퇴역 코드(RETIRED_LAWD_CODES) — 메뉴에서 빠지는 것과 같은 이유로 null.
  assert.ok(RETIRED_LAWD_CODES.size > 0, 'RETIRED_LAWD_CODES 가 비었다 — 이 테스트의 전제가 깨졌다');
  for (const code of RETIRED_LAWD_CODES) {
    assert.equal(menuEntryForLawd(code), null, `퇴역 코드 ${code} 가 null 이 아니다`);
  }
  // 존재하지 않는/빈 코드
  assert.equal(menuEntryForLawd('99999'), null);
  assert.equal(menuEntryForLawd(''), null);
  assert.equal(menuEntryForLawd(undefined), null);
});

// ── /menu 출력 불변: 추출 전 알고리즘 복제본으로 전체 LAWD_CODES 대조 ─────────────────────────
// [왜 이렇게 검증하나] `/menu` 를 실제로 HTTP 호출하면 활성 시군구 필터(activeLawdCodes)가 Supabase 를
//   타므로 테스트에 네트워크 의존이 생긴다. 대신 menuEntryForLawd 로 뽑아내기 **전** region.js 의
//   `/menu` 핸들러 안에 있던 계산을 이 테스트 안에 그대로 복제해 기대값 생성기로 쓰고, 전체
//   LAWD_CODES 코드에 대해 menuEntryForLawd 결과와 비교한다. active 필터·정렬·캐시 헤더는 여전히
//   `/menu` 핸들러 쪽 책임이라 이 비교 범위 밖이다(계획서 §2-1 "출력은 바이트 동일").
test('menuEntryForLawd — 추출 전 /menu 알고리즘과 전체 LAWD_CODES 에서 결과가 같다 (active 필터 제외, Plan 125)', () => {
  const { menuEntryForLawd } = require('../routes/region');
  const { LAWD_CODES, LAWD_CODE_TO_NAME, RETIRED_LAWD_CODES } = require('../services/transactionService');

  // region.js 의 옛 /menu 핸들러(Plan 125 이전)에 있던 계산을 그대로 복제한 기대값 생성기.
  const SIDO_BEFORE_EXTRACTION = {
    '11': '서울', '41': '경기', '28': '인천', '26': '부산', '27': '대구',
    '30': '대전', '31': '울산', '36': '세종', '43': '충북',
  };
  function expectedEntry(code) {
    if (RETIRED_LAWD_CODES.has(code)) return null;
    const sido = SIDO_BEFORE_EXTRACTION[code.slice(0, 2)];
    const label = LAWD_CODE_TO_NAME[code];
    if (!sido || !label) return null;
    const wide = ['서울', '경기', '인천'].includes(sido) ? sido : '지방';
    const pretty = label.replace(/^([가-힣]{2,}시)([가-힣]+[구군])$/, '$1 $2');
    const shown = wide === '지방' ? `${sido} ${pretty}` : pretty;
    return { wide, label: shown, lawdCd: code };
  }

  const codes = [...new Set(Object.values(LAWD_CODES).map(String))];
  assert.ok(codes.length >= 100, `LAWD_CODES 파생 코드 수가 비정상적으로 적다(${codes.length})`);

  let compared = 0, excluded = 0;
  for (const code of codes) {
    const expected = expectedEntry(code);
    const actual = menuEntryForLawd(code);
    if (expected === null) {
      excluded++;
      assert.equal(actual, null, `${code}: 추출 전엔 메뉴에서 빠지는데 menuEntryForLawd 가 값을 낸다`);
    } else {
      compared++;
      assert.deepEqual(actual, { wide: expected.wide, label: expected.label },
        `${code}: menuEntryForLawd 결과가 추출 전 알고리즘과 다르다 (기대 ${JSON.stringify(expected)})`);
    }
  }
  assert.ok(compared >= 100, `실제 비교된 코드 수가 너무 적다(${compared}) — 테스트가 사실상 빈 집합을 돈 것일 수 있다`);
  assert.equal(excluded, RETIRED_LAWD_CODES.size, '제외된 코드 수가 RETIRED_LAWD_CODES 크기와 다르다');
});

// ── regionPage.js — 지역 상세 CTA 가 menuEntryForLawd 로 만든 ?region= 딥링크를 쓴다 ────────────
test('regionPage.js — 지역 상세 CTA 가 menuEntryForLawd 로 ?region= 딥링크를 만들고, 실패 시 루트로 폴백한다 (Plan 125)', () => {
  const src = fs.readFileSync(REGION_PAGE_JS_PATH, 'utf8');

  const hrefCount = (src.match(/\?region=\$\{encodeURIComponent\(/g) || []).length;
  assert.equal(hrefCount, 1, `CTA 의 '?region=\${encodeURIComponent(' 패턴이 ${hrefCount}회다(1회여야 한다)`);

  const requireCount = (src.match(/\{\s*menuEntryForLawd\s*\}\s*=\s*require\(['"]\.\/region['"]\)/g) || []).length;
  assert.equal(requireCount, 1, `menuEntryForLawd require 가 ${requireCount}회다(1회여야 한다)`);

  // 메뉴 매칭 실패(퇴역·미상 코드) 시 지금처럼 맥락 없는 루트로 폴백 — 죽은 딥링크를 만들지 않는다.
  assert.ok(src.includes(': `${ORIGIN}/`'), '메뉴 매칭 실패 폴백(루트 단독 링크)이 없다');

  // /region 목록 페이지(전체 지역 허브)의 CTA 는 이 계획 범위 밖 — 그대로여야 한다.
  assert.ok(src.includes('<a class="cta" href="${ORIGIN}/">지도·계산기와 함께 보기 →</a>'),
    '/region 목록 페이지 CTA(범위 밖)가 바뀌었다 — 이 계획은 상세 페이지 CTA 만 바꾼다');

  assert.ok(src.includes('REGION-DEEPLINK-2026-09-28'), 'REGION-DEEPLINK-2026-09-28 주석 태그가 없다');
});

// ── 프론트 — restoreSearchFromUrl · loadRegionMenu 가 _applyRegionSubs 를 공유한다 ──────────────
// frontend-contracts.test.js 와 같은 방식(fs.readFileSync + 소스 문자열/정규식 검사)으로 배선만 고정한다.
test('index.html — restoreSearchFromUrl 과 loadRegionMenu 가 _applyRegionSubs 를 공유하고, loadRegionMenu 가 _pendingRegionSubs 를 재적용한다 (Plan 125)', () => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

  assert.match(html, /function _applyRegionSubs\(labels\)\{/, '_applyRegionSubs 공유 헬퍼가 없다');
  assert.ok(html.includes('REGION-SUB-RESTORE-2026-09-28'), 'REGION-SUB-RESTORE-2026-09-28 주석 태그가 없다');
  assert.ok(html.includes('window._pendingRegionSubs'), 'window._pendingRegionSubs 가 없다');

  // restoreSearchFromUrl() — 매칭 성공 여부와 무관하게 요청 목록을 남기고, 같은 헬퍼로 즉시 적용한다.
  const restoreStart = html.indexOf('function restoreSearchFromUrl(){');
  assert.ok(restoreStart >= 0, 'restoreSearchFromUrl 을 찾지 못했다');
  const restoreEnd = html.indexOf('\nfunction ', restoreStart + 1);
  assert.ok(restoreEnd > restoreStart, 'restoreSearchFromUrl 다음 function 경계를 찾지 못했다');
  const restoreBody = html.slice(restoreStart, restoreEnd);
  assert.ok(restoreBody.includes('window._pendingRegionSubs={wide, subs:_subs};'),
    'restoreSearchFromUrl 이 _pendingRegionSubs 를 남기지 않는다');
  assert.ok(restoreBody.includes('_applyRegionSubs(_subs);'),
    'restoreSearchFromUrl 이 _applyRegionSubs 를 호출하지 않는다');

  // loadRegionMenu() — 다시 그리기 전 켜진 칩(prevOn)과 _pendingRegionSubs 를 모아 재적용해야 한다.
  const loadStart = html.indexOf('async function loadRegionMenu(){');
  assert.ok(loadStart >= 0, 'loadRegionMenu 를 찾지 못했다');
  const loadEnd = html.indexOf('\nfunction ', loadStart + 1);
  assert.ok(loadEnd > loadStart, 'loadRegionMenu 다음 function 경계를 찾지 못했다');
  const loadBody = html.slice(loadStart, loadEnd);
  assert.ok(loadBody.includes('_applyRegionSubs(labels);'), 'loadRegionMenu 본문에 _applyRegionSubs( 호출이 없다');
  assert.ok(loadBody.includes('window._pendingRegionSubs'), 'loadRegionMenu 본문에 _pendingRegionSubs 참조가 없다');
  assert.ok(loadBody.includes('populateRegionSub(wideNow);'), 'loadRegionMenu 가 다시 그리기 호출을 하지 않는다');

  // 사용자가 광역 칩을 직접 바꾸는 cp() 경로는 이 계획이 건드리지 않는다 — 기존처럼 선택을 비운다.
  assert.match(html, /function cp\(el,id\)\{[\s\S]{0,200}if\(id==='ch-r'\)populateRegionSub\(el\.textContent\.trim\(\)\);/,
    'cp() 의 광역 직접 전환 경로가 바뀌었다 — 이 계획은 이 경로를 건드리면 안 된다(기존대로 선택 비움)');
});
