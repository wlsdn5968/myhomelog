/**
 * backend/test/report.test.js
 *
 * characterization.test.js(Plan 066, 10,056줄·327 test 단일 파일)를 도메인별로 분할한 조각.
 * 동작을 하나도 바꾸지 않는 이동이다 — 테스트 이름·개수·본문은 원본과 동일하다.
 * 공용 목/스텁 유틸은 ./_helpers 에서 가져온다. 새 테스트는 이 파일의 주제와 맞으면 여기에,
 * 아니면 backend/test/README.md 규칙대로 새 도메인 파일을 만든다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _reportFn } = require('../testSupport/_helpers');



test('보고서 일괄 관심추가가 정식 북마크 형태를 만든다 (Sprint MMMMMMM-6)', () => {
  // 알림 대상 필터는 lawdCd 가 5자리 숫자인 북마크만 통과시킨다. 일괄 추가가 그 필드를 안 넣으면
  // "N단지 관심 추가 완료" 토스트만 뜨고 **알림에서는 조용히 빠진다**.
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const rep = fs.readFileSync(path.join(__dirname, '../routes/report.js'), 'utf8');

  // 전제 ①: 보고서 응답이 식별 필드를 실제로 내려준다
  for (const f of ['aptName: c.apt_name', 'sigungu: c.sigungu', 'umdNm: c.umd_nm', 'lawdCd: c.lawd_cd']) {
    assert.ok(rep.includes(f), `보고서 apartments 에 ${f} 가 없다 — 일괄 추가가 쓸 소스가 사라졌다`);
  }
  // 전제 ②: 알림 대상 필터가 lawdCd 5자리를 요구한다
  assert.ok(html.includes('.test(x.lawdCd)') && html.includes('slice(0,30)'),
    '알림 대상 필터 형태가 바뀌었다 — 아래 판단 근거를 다시 확인할 것');

  const m = html.match(/function _addAllReportAptsToBookmarks\(\)[\s\S]*?\n\}/);
  assert.ok(m, '_addAllReportAptsToBookmarks 를 찾지 못했다');
  const fn = m[0];
  for (const need of ['lawdCd: a.lawdCd', 'sigungu: a.sigungu', 'umdNm: a.umdNm', 'savedAt: Date.now()']) {
    assert.ok(fn.includes(need), `일괄 추가가 ${need} 를 넣지 않는다`);
  }
  assert.equal(/aptName: a\.name\b/.test(fn), false, 'aptName 에 표시용 문자열이 되돌아왔다');
  assert.equal(/areaPyeong \+ '평'/.test(fn), false, "area 에 평형이 되돌아왔다 — 규제 판정이 area 를 지역으로 읽는다");
  assert.equal(/addedAt:/.test(fn), false, '타임스탬프 키가 정식(savedAt)과 다르다');
  assert.equal(/localStorage\.setItem\('mhl_bookmarks'/.test(fn), false,
    'saveBookmarks() 를 건너뛰고 localStorage 를 직접 쓴다');
  assert.ok(fn.includes('saveBookmarks(bks)'), '정식 저장 헬퍼를 쓰지 않는다');

  // 평형 칩 라벨 — '전체'/'34평+' 가 실제 조회 범위를 숨기고 있었다
  assert.match(html, /전체\(15~60평\)/, "'전체' 칩이 실제 범위를 밝히지 않는다");
  assert.match(html, /대형 34~60평/, "'대형 34평+' 가 상한을 숨긴다");
  const py = html.match(/function pyRange\(\)\{[\s\S]*?\n\}/);
  assert.ok(py && py[0].includes('{minArea:15,maxArea:60}'), 'pyRange 전체 분기가 바뀌었다 — 라벨도 함께 볼 것');
  assert.ok(py[0].includes('{minArea:34,maxArea:60}'), 'pyRange 대형 분기가 바뀌었다');
});



// ── POOL-COVERAGE-2026-08-17 (Sprint MMMMMMM-13) ──────────────────────────────
// [실측 배경] 보고서 후보 풀 상한 2,500 이 광역 보고서를 조용히 "최근 2개월"짜리로 만들고 있었다.
//   서울 광역·평형 전체·매수가 10억 기준: 밴드 내 180일 행수 11,983 → 풀이 실제로 덮는 시작일이
//   2026-06-19(59일). 적격 단지(n>=2) **1,329곳 → 508곳**, 즉 **821곳(62%)이 후보에 못 들어왔다.**
//   n 은 표시용이 아니라 TRUST-GATE(n>=2)와 점수의 입력이라 라벨 수정으로는 못 덮는다.
test('보고서 후보 풀 — 상한·시간예산·잘림 표기가 실제 커버리지를 따른다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/report.js'), 'utf8');

  // ① 상한이 서울 광역 최대 밴드(11,983행)를 덮는다. 낮추면 62% 탈락이 되살아난다.
  const m = src.match(/POOL_MAX\s*=\s*(\d+)/);
  assert.ok(m, 'report.js 에서 POOL_MAX 를 찾지 못했다');
  assert.ok(Number(m[1]) >= 12000,
    `POOL_MAX 가 ${m[1]} 이다 — 서울 광역 밴드 실측 최대 11,983행을 못 덮으면 후보가 조용히 탈락한다`);

  // ② 시간 예산이 있고, **왕복 실측을 덮을 만큼** 크다.
  //    [실측 — Supabase edge_logs `response.origin_time`, molit_transactions]
  //      1,000행 페이지 평균 935ms(최대 3,967) · 2페이지째 평균 1,076ms → 12페이지 순차 ≈ 11~12초.
  //    ⚠ 처음엔 8s 로 잡았다가 이 실측에서 뒤집혔다 — 8s 면 7~8페이지에서 끊겨
  //      "12,000 이면 전량 커버" 가 성립하지 않는다. 예산을 낮추려면 왕복부터 다시 재라.
  const bm = src.match(/POOL_BUDGET_MS\s*=\s*(\d+)/);
  assert.ok(bm, '후보 풀 페이징에 시간 예산이 없다');
  assert.ok(Number(bm[1]) >= 20000,
    `POOL_BUDGET_MS 가 ${bm[1]}ms 다 — 12페이지 순차 실측(≈11~12초)을 못 덮으면 상한 12,000 이 무의미하다`);

  // ②-b 잘림이 **얼마나 자주** 일어나는지 관측된다(Hobby 로그는 1시간이면 사라진다).
  assert.match(src, /await require\('\.\.\/services\/degradeStats'\)\.observeDegrade\('report-pool-cut'\)/,
    '풀 절단이 카운터로 남지 않는다 — 예산·병렬화를 데이터가 아니라 추측으로 정하게 된다');

  // ③ "다 가져왔는가" 를 별도 플래그로 판정하고, 그 결과가 후보에 실려 나간다.
  //    (행수만 보고 판단하면 "정확히 상한만큼 있는 경우"와 "잘린 경우"를 구별 못 한다.)
  assert.match(src, /poolComplete\s*=\s*true/, '전량 확보 판정 플래그가 없다');
  assert.match(src, /_poolTruncated:\s*poolTruncated/, '후보에 잘림 여부가 실리지 않는다');
  assert.match(src, /_poolFrom:\s*poolFromDate/, '후보에 실제 커버 시작일이 실리지 않는다');

  // ④ 페이지마다 **새 빌더**를 만든다 — supabase-js 빌더는 mutable 이라 한 인스턴스를 병렬로 쓰면
  //    .range() 가 서로를 덮어 같은 구간을 여러 번 읽거나 빠뜨린다(조용한 데이터 손상).
  assert.match(src, /const _newPageQuery = \(\) =>/, '페이지 쿼리 팩토리가 없다 — 병렬 요청이 서로를 덮는다');
  assert.equal(/_newPageQuery\(\)\.range\(/.test(src), true, '페이징이 팩토리로 만든 새 빌더를 쓰지 않는다');
  // 지역 판정은 **적용 함수**로만 담긴다(빌더를 직접 mutate 하면 팩토리가 무의미해진다).
  assert.match(src, /let _regionOp = null;/, '지역 필터가 적용 함수로 분리돼 있지 않다');
  assert.equal(/\bq = q\.(in|like)\(/.test(src), false,
    '지역 분기가 아직 빌더를 직접 mutate 한다 — 페이지 병렬 요청과 양립하지 않는다');
  // 동시성 상한이 있다 — 재보지 않은 부담을 떠안지 않는다.
  const cm = src.match(/POOL_CONCURRENCY\s*=\s*(\d+)/);
  assert.ok(cm && Number(cm[1]) >= 2 && Number(cm[1]) <= 8,
    `POOL_CONCURRENCY 가 ${cm && cm[1]} 이다 — 2~8 범위를 벗어나면 왕복 부담을 다시 실측할 것`);
  // ④-c ⚠ **첫 페이지는 단독**이어야 한다. 프로덕션 DB 실측에서 0번부터 4개를 동시에 던지면
  //     콜드 경합으로 **4개 전부 statement timeout**(4,177ms)이 났다. 한 번 워밍하면 4개 병렬이 167ms.
  //     statement_timeout 은 service_role 도 무제한이 아니다(authenticator 의 8s 를 물려받는다).
  assert.match(src, /첫 페이지 단독 — 콜드 경합 방지/, '첫 페이지 단독 워밍 단계가 사라졌다');
  const loopStart = src.match(/for \(let from = (\w+); from < POOL_MAX && !poolComplete;/);
  assert.ok(loopStart && loopStart[1] === 'PAGE',
    `병렬 루프가 ${loopStart && loopStart[1]} 부터 시작한다 — 0 부터면 첫 배치가 콜드 경합에 노출된다`);
  // 2차 정렬키 — 병렬이라 페이지 경계의 동점 처리가 더 중요해졌다.
  assert.match(src, /\.order\('id', \{ ascending: false \}\)/, '2차 정렬키(id)가 없다 — 페이지 경계에서 중복·누락이 생긴다');

  // ④-b 검색·보고서가 **같은 강등 모듈**을 쓴다(2026-08-17 통합 완료 — 종전엔 같은 코드가 두 벌이었다).
  //     키가 갈리면 /api/health 의 searchDegrade 에서 한쪽이 조용히 사라진다.
  const searchSrc = fs.readFileSync(path.join(__dirname, '../routes/search.js'), 'utf8');
  assert.match(searchSrc, /require\('\.\.\/services\/degradeStats'\)/,
    'search.js 가 공유 강등 모듈을 쓰지 않는다 — 사본이 갈리면 관측이 반쪽이 된다');

  // ⑤ '표본 적음(시세 판단 주의)' 는 잘린 풀에서 **거짓 경고**가 되므로 가드를 거친다.
  //    반대로 '거래 활발'(n>=20)은 잘려도 하한 보장이라 가드가 없어야 정상이다.
  //    PRICE-BASIS-2026-08-30: 건수 자체가 `c.n`(예산 밴드로 잘린 풀) → `_n`(밴드 미적용 재집계)로 바뀌었다.
  //    재집계가 실패하면 _n 이 c.n 으로 폴백하므로 잘림 가드는 그대로 필요하다.
  assert.match(src, /!c\._poolTruncated && _n <= 5/,
    "'표본 적음' 판정이 잘림 가드를 안 거친다 — 실제로 거래 많은 단지에 없는 위험을 붙인다");
  assert.match(src, /const _n = Number\(c\.areaTotalN\) > 0 \? Number\(c\.areaTotalN\) : \(c\.n \|\| 0\)/,
    '거래 건수가 예산 밴드로 잘린 c.n 을 그대로 쓴다 — 실제보다 적게 표기된다(동탄 실측 52 vs 66)');
});



test('보고서 지역 분기 — 검증된 매핑을 재사용하고 광역 폴백에 지방이 있다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/report.js'), 'utf8');

  // ① 별도 표를 새로 만들지 않고 propertyService 의 매핑을 재사용한다(세 번째 사본 방지).
  assert.match(src, /require\('\.\.\/services\/propertyService'\)/,
    '보고서가 검증된 지역 매핑을 재사용하지 않는다 — 사본을 새로 만들면 또 갈린다');
  // REGION-CODE-2026-08-30: 4번째 인자로 **시군구 코드**를 넘긴다 — 있으면 문자열 해석을 건너뛴다.
  assert.match(src, /pickRegions\(region, buy, '', _reqLawdCd\)/,
    'pickRegions 재사용 호출이 없다(또는 lawdCd 를 넘기지 않는다)');
  // MULTI-REGION-2026-08-30: 콤마 구분 다중 코드를 받는다. 형식 검증(5자리)은 그대로 —
  //   화이트리스트(LAWD_CODES) 검증·중복 제거·상한(6)은 pickRegions 가 맡는다.
  assert.ok(/const _reqLawdCd = String\(input\.lawdCd/.test(src),
    'lawdCd 를 다중 코드로 받지 않는다 — 복수 지역 선택이 보고서에 전달되지 않는다');
  assert.ok(/filter\(x => \/\^\\d\{5\}\$\/\.test\(x\)\)/.test(src),
    'lawdCd 를 5자리 숫자로 검증하지 않는다 — 임의 코드로 조회가 열린다');

  // ② ⚠ pickRegions 는 매칭 실패 시 **예산 기반 서울 인기 구**를 돌려준다(추천용 폴백).
  //    그게 그대로 새면 "경기 보고서에 서울 단지" 가 된다 → 시도 접두 검증이 반드시 있어야 한다.
  assert.match(src, /codes\.every\(c => String\(c\)\.startsWith\(wantPfx\)\)/,
    '세부 해석 결과의 시도 접두를 검증하지 않는다 — 다른 광역 단지가 섞인다');
  // ②-b 접두만으로는 부족하다. 매핑에 없는 세부는 **광역 대표 구 몇 개**로 폴백되는데 접두는 맞는다.
  //     name 이 광역 이름이면 해석 실패로 보고 광역 분기로 내려가야 한다.
  assert.match(src, /names\.some\(n => \['서울', '경기', '인천', '지방'\]\.includes\(n\)\)/,
    '해석 실패(광역 대표 구 폴백)를 걸러내지 않는다 — 고른 곳과 무관한 구를 조용히 뒤진다');

  // ③ '지방' 광역이 lawd_cd 필터 없이 **전국**으로 새던 분기가 막혀 있다.
  assert.match(src, /region\.includes\('지방'\)/,
    "'지방' 광역 분기가 없다 — 세부 미선택 시 전국이 후보 풀이 된다");
  // 어느 분기에도 안 걸리는 입력은 조용히 넘어가지 말고 흔적을 남긴다.
  assert.match(src, /지역 필터 미적용 — 전국이 후보 풀이 된다/,
    '예상치 못한 지역 문자열이 조용히 전국 조회가 된다');
});



// ── PEAK-FLOOR-2026-08-31 (Sprint PPPPPPP) ────────────────────────────────────
// 운영자가 준 컨설팅 보고서는 단지마다 "전고점"과 층·동 조건(RR)을 함께 적었다.
// 우리도 같은 판단 근거를 주되, **말할 수 있는 것만** 말한다:
//   · 우리 DB 는 2025-05 부터라 **역대 전고점을 모른다** → "최근 6개월 최고" 로만 쓴다.
//   · 층별 가격대는 표본이 얇으면 사례 하나에 끌려간다 → 층 정보 6건 미만이면 아예 만들지 않는다.
test('보고서 최고가·층별 가격대 — 기간을 속이지 않고, 표본이 얇으면 만들지 않는다', () => {
  const fs2 = require('node:fs'); const path2 = require('node:path');
  const rpt = fs2.readFileSync(path2.join(__dirname, '../routes/report.js'), 'utf8');
  const fe = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');

  // ① 값이 만들어지고 응답에 실린다.
  assert.match(rpt, /c\.peak6m = stats\[0\]\.max;/, '대표 평형 최고가를 계산하지 않는다');
  assert.match(rpt, /peak6mAuk:/, '최고가를 응답에 싣지 않는다');
  assert.match(rpt, /floorBands:/, '층별 가격대를 응답에 싣지 않는다');

  // ② ⚠ "전고점" 이라고 부르지 않는다 — 16개월치 DB 로 역대 최고가를 주장할 수 없다.
  //    ⚠ 소스 문자열 창을 훑지 않는다 — 주석에 적힌 "전고점 이라고 쓰지 않는다" 를 잡아
  //      멀쩡한 코드가 실패했다. **실제 출력**을 검사한다(아래 ④ 에서 만든 문구로).
  assert.match(fe, /최근 6개월 최고/, '기간을 밝히지 않은 최고가 문구다');

  // ③ 층별 가격대 표본 하한이 있다.
  assert.match(rpt, /if \(withF\.length >= 6\)/, '층 표본 하한이 없다 — 1~2건으로 층별 시세를 만든다');
  assert.match(rpt, /g\.length >= 2 \?/, '구간별 표본 하한이 없다');
  assert.match(rpt, /if \(b1 && b3\) floorBands =/,
    '저층·고층 중 하나가 비어도 층별 가격대를 만든다 — 비교 대상이 없으면 의미가 없다');

  // ④ 실제로 실행해 확인한다.
  // ⚠ 공용 스코프로 옮기면서 들여쓰기가 사라졌다 — 앵커를 들여쓰기에 의존시키지 않는다.
  const m = fe.match(/const _peakFloorLine = \(a\) => \{[\s\S]*?\n\};/);
  assert.ok(m, '문구 빌더를 찾지 못했다');
  const fn = new Function(`${m[0]}; return _peakFloorLine;`)();
  assert.equal(fn({}), '', '값이 없는데 빈 줄을 만든다');
  const withPeak = fn({ peak6mAuk: 8.35 });
  assert.ok(withPeak.includes('8.35억') && withPeak.includes('최근 6개월 최고'), '최고가 문구가 비었다');
  // ⚠ 실제 출력에 "전고점" 이 있으면 안 된다 — 우리 DB(2025-05~)로는 알 수 없는 사실이다.
  assert.ok(!withPeak.includes('전고점'), '표시 문구가 "전고점" 을 주장한다');

  // ⑥ ⚠ 이 함수는 **화면·인쇄 두 렌더러가 공유**한다. 한쪽 함수 안에 정의하면
  //    다른 쪽에서 `_peakFloorLine is not defined` 로 보고서가 통째로 죽는다(실제로 죽었다).
  //    선언이 어느 함수 본문에도 들어가 있지 않은지 — 즉 공용 스코프인지 확인한다.
  const defIdx = fe.indexOf('const _peakFloorLine = (a) =>');
  assert.ok(defIdx > 0, '_peakFloorLine 선언을 찾지 못했다');
  const before = fe.slice(0, defIdx);
  const renderIdx = before.lastIndexOf('function _renderReport(data) {');
  const pdfIdx = before.lastIndexOf('function _downloadReportPDF()');
  assert.equal(renderIdx, -1, '_peakFloorLine 이 _renderReport 안에 갇혀 있다 — 인쇄 쪽에서 죽는다');
  assert.equal(pdfIdx, -1, '_peakFloorLine 이 _downloadReportPDF 안에 갇혀 있다 — 화면 쪽에서 죽는다');
  const full = fn({ peak6mAuk: 8.35, floorBands: { low: { upTo: 5, n: 3, auk: 7.1 }, mid: { n: 4, auk: 7.9 }, high: { from: 12, n: 3, auk: 8.2 } } });
  assert.ok(full.includes('저층(~5층) 7.1억') && full.includes('고층(12층~) 8.2억'), '층별 문구가 비었다');
  // 층 정보가 없으면 층 문구는 빠지고 최고가만 남는다.
  assert.ok(!fn({ peak6mAuk: 8.35 }).includes('층별'), '층 정보가 없는데 층별 문구를 만든다');
});



// ── WATERMARK-ID-2026-08-31 (Sprint PPPPPPP) ──────────────────────────────────
// 운영자: "워터마크는 고객의 아이디나 이런 걸로 특정할 수 있도록 해놓은 거 맞지? 제대로 하자."
// 처음 넣은 워터마크는 브랜드명("내집로그 · myhomelog")뿐이라 **어느 계정에 발급된 문서인지
// 되짚을 수 없었다.** PDF 는 캡처·재배포되기 쉬우므로 발급 대상이 남아야 한다.
// ⚠ 그렇다고 이메일 전문을 박지 않는다 — 정상적으로 공유하는 경우에도 개인정보가 그대로 노출된다.
//   마스킹된 아이디(본인 식별) + 해시 8자(운영자가 DB 대조로 특정) 조합을 쓴다.
test('워터마크 — 발급 대상을 특정할 수 있되 이메일 전문은 노출하지 않는다', () => {
  const fs2 = require('node:fs'); const path2 = require('node:path');
  const fe = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');

  const m = fe.match(/const _issuedTo = \(\(\) => \{[\s\S]*?\}\)\(\);/);
  assert.ok(m, '발급 대상 식별자 생성 블록을 찾지 못했다');

  // 실제로 실행해 동작을 확인한다(소스 검사만으로는 부족하다).
  const run = (session) => {
    const localStorage = { getItem: () => JSON.stringify(session || {}) };
    return new Function('localStorage', `${m[0]}; return _issuedTo;`)(localStorage);
  };

  const r = run({ user: { email: 'wlsdn5968@kakao.com', id: 'fd15c0b7-6330-4bfa-a671-0aa6bcf4a2e3' } });
  assert.ok(r, '로그인 세션인데 발급 대상이 비었다');
  // ① 이메일 전문이 그대로 들어가면 안 된다.
  assert.ok(!r.label.includes('wlsdn5968'), '이메일 아이디가 마스킹되지 않았다');
  // ② 그러나 본인이 알아볼 수는 있어야 한다(앞 3자 + 도메인 유지).
  assert.ok(r.label.startsWith('wls'), '본인이 알아볼 단서가 없다');
  assert.ok(r.label.endsWith('@kakao.com'), '도메인이 사라져 식별이 어렵다');
  // ③ 운영자가 DB 와 대조할 수 있는 해시가 있어야 한다.
  assert.match(r.tag, /^[0-9a-f]{8}$/, '대조용 해시가 8자 16진수가 아니다');
  // ④ 같은 계정은 항상 같은 값이어야 대조가 된다.
  assert.equal(run({ user: { email: 'wlsdn5968@kakao.com', id: 'fd15c0b7-6330-4bfa-a671-0aa6bcf4a2e3' } }).tag, r.tag,
    '같은 계정인데 해시가 매번 달라진다 — 유출 추적이 불가능하다');
  // ⑤ 다른 계정은 달라야 한다.
  assert.notEqual(run({ user: { email: 'other@x.com', id: 'aaaaaaaa-0000-0000-0000-000000000000' } }).tag, r.tag,
    '다른 계정인데 해시가 같다');
  // ⑥ 짧은 아이디도 마스킹된다.
  assert.ok(!run({ user: { email: 'ab@x.com', id: 'u2' } }).label.startsWith('ab@'),
    '짧은 아이디가 마스킹 없이 그대로 노출된다');
  // ⑦ 비로그인/저장소 차단이면 null — 없는 사람을 지어내지 않는다.
  assert.equal(run({}), null, '세션이 없는데 발급 대상을 만들어낸다');

  // ⑧ 워터마크·하단에 실제로 쓰인다.
  assert.match(fe, /class="wmark"[^>]*><span>\$\{_issuedTo \?/, '워터마크가 발급 대상을 쓰지 않는다');
  assert.match(fe, /발급 대상 /, '하단에 발급 대상 표기가 없다');
  assert.match(fe, /제3자 공개·재배포를 삼가주세요/, '재배포 주의 문구가 없다');
});



// ── PRIMARY-SAMPLE-2026-08-31 (Sprint PPPPPPP) ────────────────────────────────
// 전국 실측(101지역·1,793건): 헤드라인 가격의 대표 평형이 거래 **1건**인 경우 **16.9%**,
//   2건 이하 29.1%. [사례] 이편한세상강동에코포레 — 단지 전체 11건인데 대표 16평은 1건,
//   그 한 건의 12.6억이 헤드라인이 됐다.
// 원인: 대표 평형을 **예산 근접만** 보고 골랐고 표본을 전혀 보지 않았다.
test('대표 평형 — 표본이 충분한 평형을 우선하되, 없으면 버리지 않는다', () => {
  const fs2 = require('node:fs'); const path2 = require('node:path');
  const svc = fs2.readFileSync(path2.join(__dirname, '../services/propertyService.js'), 'utf8');

  // ① 표본 하한이 존재하고, 충분한 것들 중에서 고른다.
  assert.match(svc, /const MIN_PRIMARY_N = 3;/, '대표 평형 표본 하한이 없다');
  assert.match(svc, /const _enough = fitPyeongs\.filter\(p => \(p\.dealCount \|\| 0\) >= MIN_PRIMARY_N\)/,
    '표본이 충분한 평형을 추려내지 않는다');

  // ② ⚠ 표본이 적다고 **단지를 버리지 않는다** — 예산대에 그 평형뿐일 수 있다.
  assert.match(svc, /_pickClosest\(_enough\.length \? _enough : fitPyeongs\)/,
    '표본이 부족하면 단지가 통째로 사라진다 — 폴백이 없다');

  // ③ 표본 수를 응답에 실어 화면이 "1건 기준" 임을 밝힐 수 있게 한다.
  assert.match(svc, /priceSampleN: p\.dealCount \|\| 0,/, '표본 수를 응답에 싣지 않는다');

  // ④ 실제 선택 로직을 돌려 확인한다 — 소스 검사만으로는 동작을 보장하지 못한다.
  const m = svc.match(/const MIN_PRIMARY_N = 3;[\s\S]*?const primaryPyeong = _pickClosest\(_enough\.length \? _enough : fitPyeongs\);/);
  assert.ok(m, '대표 평형 선택 블록을 찾지 못했다');
  const run = (fitPyeongs, maxBudget) => new Function('fitPyeongs', 'maxBudget',
    `${m[0]}; return primaryPyeong;`)(fitPyeongs, maxBudget);

  //   예산 12억. 16평은 1건(12.6억, 예산에 더 가까움) · 26평은 9건(11.0억).
  //   표본을 보지 않으면 16평이 뽑힌다 — 그게 이번에 고친 결함이다.
  const picked = run([
    { pyeong: 16, avgPrice: 126000, dealCount: 1 },
    { pyeong: 26, avgPrice: 110000, dealCount: 9 },
  ], 12);
  assert.equal(picked.pyeong, 26, '1건짜리 평형이 9건짜리를 제치고 대표가 된다');

  //   충분한 표본이 하나도 없으면 종전대로 예산 근접으로 고른다(단지를 버리지 않는다).
  const only = run([
    { pyeong: 16, avgPrice: 126000, dealCount: 1 },
    { pyeong: 26, avgPrice: 90000, dealCount: 2 },
  ], 12);
  assert.equal(only.pyeong, 16, '표본이 모두 부족할 때 예산 근접 폴백이 동작하지 않는다');

  // ⑤ 화면이 표본 적음을 밝힌다.
  const fe = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');
  assert.match(fe, /Number\(p\.priceSampleN\) <= 2/,
    '표본 1~2건인 가격에 아무 표시가 없다 — 사용자가 시세로 읽는다');
});



// ── REPORT-SUBWAY-NULL-2026-09-02 (감사 P0-2, 회귀 주입으로 발견한 무커버리지) ─────────
//   [왜] report.js 의 null 가드를 지우고 테스트를 돌렸더니 **136 pass 로 그냥 통과**했다.
//     즉 그 가드는 아무도 지키지 않고 있었다 — 다음 리팩터에서 조용히 사라질 수 있었다.
//   [무엇을 고정하나] 카카오 조회 실패(null)가 "반경 1.2km 지하철역 0곳" 이라는 사실 주장으로
//     둔갑하지 않고, 역세권·교통 점수를 최저 밴드로 깎지도 않는다.
test('보고서 점수: amenities.subway 가 null 이면 역세권 근거·점수를 만들지 않는다', () => {
  const { applyObjectiveScore } = require('../routes/report');
  const mk = (subway) => ({
    score: 0, sigungu: '강남구', lawd_cd: '11680', households: null, build_year: null,
    amenities: { subway, school: null, mart: null, hospital: null, park: null, cvs: null },
    scoreBreakdown: { priority_역세권: 10, priority_교통: 10 },
  });

  const unknown = mk(null);
  applyObjectiveScore(unknown, true);
  const zero = mk(0);
  applyObjectiveScore(zero, true);

  // ① 모름은 기존 우선순위 점수를 건드리지 않는다(코드 주석의 "모르는 것을 0 으로 바꾸지 않는다").
  assert.equal(unknown.scoreBreakdown.priority_역세권, 10,
    `조회 실패(null)인데 역세권 점수가 ${unknown.scoreBreakdown.priority_역세권} 로 덮어써졌다`);
  assert.equal(unknown.scoreBreakdown.priority_교통, 10,
    `조회 실패(null)인데 교통 점수가 ${unknown.scoreBreakdown.priority_교통} 로 덮어써졌다`);

  // ② 실제 0 곳은 반대로 반영돼야 한다 — 그래야 ①이 "그냥 아무것도 안 함" 이 아님이 증명된다.
  assert.equal(zero.scoreBreakdown.priority_역세권, 2,
    '실제 0곳인데 최저 밴드가 적용되지 않았다 — 테스트 전제가 깨졌다');

  // ③ 모름일 때 "0곳" 이라는 사실 주장 문구가 생기면 안 된다.
  assert.equal(unknown.scoreBreakdown._역세권_근거, undefined,
    `조회 실패인데 근거 문구가 붙었다: ${unknown.scoreBreakdown._역세권_근거}`);
  assert.ok(/0\s*곳/.test(String(zero.scoreBreakdown._역세권_근거 || '')),
    '실제 0곳일 때는 근거에 0곳이 적혀야 한다(대조군)');
});



// ── REG-NONSEOUL-2026-09-02 (감사 P1-9) ──────────────────────────────────────
//   [왜] 보고서의 규제 판정은 **서울만** 하고 비서울은 무조건 미확인이었다. 그 사이 2026.6.30 로
//     화성 동탄구·용인 기흥구·구리시가 규제지역에 추가됐는데 보고서는 한 글자도 반영하지 못했고,
//     같은 서비스의 지역 대시보드(routes/region.js)는 이미 정확히 판정하고 있었다 —
//     **같은 서비스가 서로 다른 사실을 말하는** 상태였다(절대룰 ②).
//   [무엇을 고정하나] 이름 문자열이 아니라 lawd_cd 집합으로 판정하고, 손으로 고른 몇 건이 아니라
//     **전 코드 전수 스윕**으로 양방향(누락·오탐)을 확인한다.
//     (이 저장소는 "케이스를 손으로 골라 중구를 빠뜨린" 사고를 겪었다 — 그래서 전수다.)
test('보고서 규제 판정: 규제 lawd_cd 집합 전수 — 누락도 오탐도 없다', async () => {
  const { getRegulatedLawdCodes } = require('../services/regulationsService');
  const { LAWD_CODES } = require('../services/transactionService');
  const getRegulationPenalty = _reportFn('getRegulationPenalty');
  const { codes, seoulRegulated, unmatched } = await getRegulatedLawdCodes();

  // 전제: 스냅샷(또는 폴백)이 실제로 해석된다. 미매핑이 있으면 그 지역은 조용히 빠진다.
  assert.deepEqual(unmatched, [], `규제지역 이름이 lawd_cd 로 해석되지 않았다: ${unmatched.join(', ')}`);
  assert.ok(codes.size >= 40, `규제 코드가 ${codes.size}개뿐 — 스냅샷 해석이 깨졌다`);

  const byCode = new Map();
  for (const [name, code] of Object.entries(LAWD_CODES)) if (!byCode.has(String(code))) byCode.set(String(code), name);

  // ① 누락 없음 — 규제 집합의 모든 코드가 규제로 판정돼야 한다
  const missed = [];
  for (const code of codes) {
    const name = byCode.get(String(code)) || code;
    const sgg = name.replace(/^(서울|경기|인천|부산|대구|대전|광주|울산|세종)\s*/, '') || name;
    const r = getRegulationPenalty(sgg, code, seoulRegulated, codes);
    if (r.status === '미확인') missed.push(`${code}(${name})`);
  }
  assert.deepEqual(missed, [],
    `규제지역인데 '미확인' 으로 빠진 코드:\n  ${missed.join('\n  ')}`);

  // ② 오탐 없음 — 규제 집합 밖의 코드는 절대 규제로 판정되면 안 된다(동명 구 오판 차단)
  const falsePos = [];
  for (const [name, code] of Object.entries(LAWD_CODES)) {
    const c = String(code);
    if (codes.has(c)) continue;
    const sgg = name.replace(/^(서울|경기|인천|부산|대구|대전|광주|울산|세종)\s*/, '') || name;
    const r = getRegulationPenalty(sgg, c, seoulRegulated, codes);
    if (r.status !== '미확인') falsePos.push(`${c}(${name}) → ${r.status}`);
  }
  assert.deepEqual(falsePos, [],
    `비규제 지역이 규제로 잘못 판정됐다:\n  ${falsePos.join('\n  ')}`);
});



test('보고서 규제 판정: 2026.6.30 신규 지정 3곳이 실제로 반영된다', async () => {
  const { getRegulatedLawdCodes } = require('../services/regulationsService');
  const getRegulationPenalty = _reportFn('getRegulationPenalty');
  const { codes, seoulRegulated } = await getRegulatedLawdCodes();
  // 화성시 동탄구 41597 · 용인시 기흥구 41463 · 구리시 41310 (LAWD_CODES 실값)
  for (const [sgg, code] of [['동탄구', '41597'], ['기흥구', '41463'], ['구리시', '41310']]) {
    const r = getRegulationPenalty(sgg, code, seoulRegulated, codes);
    assert.equal(r.status, '조정대상지역', `${sgg}(${code}) 가 규제로 판정되지 않는다 — 2026.6.30 지정 누락`);
    assert.ok(r.bonus < 0, `${sgg} 규제 감점이 반영되지 않았다`);
  }
});



test('보고서 규제 판정: 서울 해제가 경기 판정을 흔들지 않는다 (독립성)', async () => {
  const { getRegulatedLawdCodes } = require('../services/regulationsService');
  const getRegulationPenalty = _reportFn('getRegulationPenalty');
  const { codes } = await getRegulatedLawdCodes();
  // 서울이 해제된 스냅샷을 가정 — 서울은 미확인으로 떨어지고, 경기는 그대로 규제여야 한다.
  assert.equal(getRegulationPenalty('강남구', '11680', false, codes).status, '미확인',
    '서울 해제 스냅샷인데 서울이 여전히 규제로 표시된다');
  assert.equal(getRegulationPenalty('동탄구', '41597', false, codes).status, '조정대상지역',
    '서울 해제가 경기 규제 판정까지 꺼버렸다 — 두 판정은 독립이어야 한다');
});



test('보고서 규제 판정: 코드 집합을 못 받으면 비서울은 미확인 (실패를 비규제로 단정하지 않는다)', () => {
  const getRegulationPenalty = _reportFn('getRegulationPenalty');
  // 조회 실패(regulatedCodes=null) 시 종전 동작 유지 — 하위호환이자 보수적 폴백.
  assert.equal(getRegulationPenalty('동탄구', '41597', true, null).status, '미확인',
    '집합 조회 실패인데 비서울을 단정했다');
  assert.equal(getRegulationPenalty('강남구', '11680', true, null).status, '투기과열·토허구역 일부',
    '집합이 없어도 서울 판정은 종전대로 동작해야 한다');
});



test('보고서 점수: 데이터가 없다는 이유로 순위가 밀리지 않는다 (모름 ≠ 최하위)', () => {
  const { applyObjectiveScore } = require('../routes/report');
  const mk = (over) => Object.assign({
    score: 0, sigungu: '수지구', lawd_cd: '41465', households: 1200, build_year: new Date().getFullYear() - 3,
    kaptInfo: { parking: 1500 }, amenities: null, scoreBreakdown: {},
  }, over);

  const known = mk({}); applyObjectiveScore(known, true, null);
  // 세대수만 모르는 단지 vs 확인된 소형(250세대)
  const unknownHh = mk({ households: null, kaptInfo: { parking: null } }); applyObjectiveScore(unknownHh, true, null);
  const smallHh = mk({ households: 250, kaptInfo: { parking: 100 } }); applyObjectiveScore(smallHh, true, null);

  assert.ok(unknownHh.scoreBreakdown['객관_세대수'] > 0,
    '세대수를 모른다는 이유로 0 점을 받았다 — 확인된 최하위와 구별되지 않는다');
  assert.ok(unknownHh.scoreBreakdown['객관_세대수_미확인'] === true,
    '미확인 표시가 없다 — 화면이 추정값을 사실처럼 보여줄 수 있다');
  // 보너스가 0 이면 breakdown 키 자체가 생기지 않는다(undefined) — 비교 전에 0 으로 보정한다.
  assert.ok(unknownHh.scoreBreakdown['객관_세대수'] > (smallHh.scoreBreakdown['객관_세대수'] || 0),
    '모름이 확인된 소형보다 낮거나 같다 — 모름을 나쁨으로 만들고 있다');
  assert.ok(unknownHh.scoreBreakdown['객관_세대수'] < known.scoreBreakdown['객관_세대수'],
    '모름이 확인된 대단지와 같은 점수다 — 모름을 좋음으로 만들고 있다');

  // 준공년도도 같은 규칙
  const unknownAge = mk({ build_year: null }); applyObjectiveScore(unknownAge, true, null);
  assert.ok(unknownAge.scoreBreakdown['객관_노후도'] > 0, '준공년도 미상이 0 점이다');
  assert.equal(unknownAge.scoreBreakdown['객관_노후도_미확인'], true, '노후도 미확인 표시가 없다');
});



// ── DSR-STATE-2026-09-05 ─────────────────────────────────────────────────────────
//   외부 검토(Codex) 재현: 7억·연소득 5,000·기존 월 200만원·현금 3억·무주택·생애최초·서울규제 → 추천한도 4.90억 · 부족 '충분' · DSR 104%.
//   원인: dc() 의 `Math.min(lL, dL>0 ? dL : lL)` 이 계산값 0 을 소득 미입력으로 읽었다.
test('상세 대출계산 — 소득 미입력 / 여력 0 / 양수 한도를 구분하고 대표 숫자·월상환·부족자금이 같은 상태에서 나온다', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../frontend/index.html'), 'utf8');
  const m = html.match(/function calcLoanLimitsPure\(\{[\s\S]*?\r?\n\}\r?\n/);
  assert.ok(m, '순수 산식 calcLoanLimitsPure 가 없다');
  const fn = new Function(`${m[0]}; return calcLoanLimitsPure;`)();
  const base = { buy: 7, inc: 5000, rate: 0.04, yrs: 30, cash: 3, ltv: 0.7, cap: 6, isLoc: false };
  // ① 기존 월상환 200만원 > 허용 166.7만원 → 여력 0: 한도 0·월상환 0·부족 4억·DSR 은 기존 부채만으로 48%
  const zero = fn({ ...base, exAdded: 200 });
  assert.equal(zero.dsrState, 'zero');
  assert.equal(zero.fin, 0, '여력 0 인데 LTV 한도로 되돌아갔다(외부 검토 재현 결함)');
  assert.equal(zero.mo, 0);
  assert.equal(zero.need, 4, '부족자금이 매수가-현금(4억)이 아니다');
  assert.equal(zero.dsr, 48);
  assert.ok(Math.abs(zero.lL - 4.9) < 1e-9, 'LTV 한도 자체는 4.9억이어야 한다(표시용)');
  // ② 소득 미입력 → DSR 미반영, LTV 한도만
  const none = fn({ ...base, inc: 0, exAdded: 200 });
  assert.equal(none.dsrState, 'none'); assert.ok(Math.abs(none.fin - 4.9) < 1e-9); assert.equal(none.dL, 0); assert.equal(none.dsr, 0);
  // ③ 여력이 정확히 0(허용액과 같은 기존 상환) → 여력 0
  const exact = fn({ ...base, exAdded: 5000 * 0.4 / 12 });
  assert.equal(exact.dsrState, 'zero'); assert.equal(exact.fin, 0);
  // ④ 작은 양수 여력(기존 150만원 → 월 16.7만원) → 양수 한도이되 LTV 보다 훨씬 작다
  const small = fn({ ...base, exAdded: 150 });
  assert.equal(small.dsrState, 'ok'); assert.ok(small.dL > 0 && small.dL < 1, `작은 여력의 한도가 이상하다: ${small.dL}`);
  assert.equal(small.fin, small.dL); assert.ok(small.mo > 0 && small.need > 2);
  // ⑤ 기존 부채 없음 → 종전 정상 계산 보존(LTV 4.9억이 DSR 한도보다 작아 4.9억)
  const normal = fn({ ...base, exAdded: 0 });
  //   연소득 5,000 → 월 허용 166.7만원 → 스트레스 7%·30년 환산 ≈ 2.5억 < LTV 4.9억 → DSR 한도가 대표값(종전 코드와 같은 결과)
  assert.equal(normal.dsrState, 'ok'); assert.equal(normal.fin, normal.dL); assert.ok(normal.dL > 2 && normal.dL < 3, `DSR 한도가 예상 범위 밖: ${normal.dL}`);
  assert.ok(normal.mo > 100 && normal.mo < 130, `월상환이 예상 범위 밖: ${normal.mo}`); assert.ok(normal.dsr > 0 && normal.dsr <= 40, `정상 케이스 DSR 이상: ${normal.dsr}`);
  assert.ok(normal.need > 1 && normal.need < 2, `부족자금이 예상 범위 밖: ${normal.need}`);
  // ⑥ LTV 0(2주택+) 은 무엇이든 0
  const noltv = fn({ ...base, exAdded: 0, ltv: 0 });
  assert.equal(noltv.fin, 0); assert.equal(noltv.mo, 0);
  // ⑦ 금리 0 이어도 NaN 이 나오지 않는다(원금균등 근사)
  const r0 = fn({ ...base, exAdded: 0, rate: 0 });
  assert.ok(Number.isFinite(r0.fin) && Number.isFinite(r0.mo) && r0.mo > 0, '금리 0 에서 NaN');
  // dc() 가 순수 함수를 쓰고, 옛 결함 패턴이 남아 있지 않다
  const dcStart = html.indexOf('function dc(){');
  const dcBody = html.slice(dcStart, dcStart + 6000);
  assert.match(dcBody, /const _r=calcLoanLimitsPure\(\{buy,inc,rate,yrs,exAdded,cash,ltv,cap,isLoc\}\);/, 'dc() 가 순수 산식을 쓰지 않는다');
  assert.ok(!/dL>0\?dL:lL/.test(dcBody), '옛 결함 패턴(dL>0?dL:lL)이 남아 있다');
  assert.match(dcBody, /dsrState==='zero'\?'0원 \(기존 부채로 여력 없음\)'/, '여력 0 표시가 없다');
  assert.match(dcBody, /dsrState==='none'\?'소득 입력 필요'/, '소득 미입력 표시가 없다');
});



// ── FIRST-UNKNOWN-2026-09-05 ──────────────────────────────────────────────────────
test('생애최초 — 접힌 선택 항목의 기본값이 우대(예)가 아니고, 미선택은 미확인으로 요약·보고서에 드러난다', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../frontend/index.html'), 'utf8');
  const chf = html.match(/<div class="chips" id="ch-f">[\s\S]*?<\/div>/);
  assert.ok(chf, 'ch-f 칩 그룹이 없다');
  assert.ok(!/chip on/.test(chf[0]), '보고서·검색 폼의 생애최초가 기본 선택돼 있다(외부 검토 재현: 확인 없이 우대 조건 적용)');
  const ccf = html.match(/<div class="chips" id="cc-f">[\s\S]*?<\/div>/);
  assert.ok(ccf && /<span class="chip on"[^>]*>아니오<\/span>/.test(ccf[0]), '상세계산기 생애최초 기본값이 우대(예)다');
  assert.match(html, /const firstBuyerKnown = gct\('ch-f'\) !== '';/, '미확인 상태를 만들지 않는다');
  assert.match(html, /생애최초 \$\{firstBuyerKnown \? \(isFirstBuyer \? '예' : '아니오'\) : '미확인\(일반 기준\)'\}/, '입력 요약이 미확인을 밝히지 않는다');
  assert.match(html, /houseStatus, isFirstBuyer, firstBuyerKnown, pyeong, schoolNeeded,/, '보고서 요청에 firstBuyerKnown 이 없다');
  assert.match(html, /if\(body\.firstBuyerKnown!==false\)s\.set\('first',body\.isFirstBuyer\?'1':'0'\);/, 'URL 저장이 미확인을 기록한다');
  assert.match(html, /if\(_f==='1'\)setChip\('ch-f','예'\); else if\(_f==='0'\)setChip\('ch-f','아니오'\);/, 'URL 복원이 파라미터 없을 때 아니오를 강제한다');
  const rpt = require('node:fs').readFileSync(require.resolve('../routes/report'), 'utf8');
  assert.match(rpt, /userInput\.firstBuyerKnown = userInput\.firstBuyerKnown !== false;/, '백엔드가 미확인 플래그를 받지 않는다');
  assert.match(rpt, /if \(userInput\.firstBuyerKnown === false\) coreMessages\.push\('생애최초 여부를 선택하지 않아/, '데이터판이 미확인을 밝히지 않는다');
  assert.match(rpt, /생애 최초: \$\{input\.firstBuyerKnown === false \? '미확인/, 'AI 프롬프트가 미확인을 밝히지 않는다');
});



// ── LOGIN-GATE + REPORT-TIMEOUT-2026-09-05 ─────────────────────────────────────────
test('보고서 — 익명은 요청 전에 로그인으로 잇고(입력 보존), 제한 시간과 안내 문구는 한 상수에서 나온다', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../frontend/index.html'), 'utf8');
  const g = html.indexOf('async function generateReport(_isRetry) {');
  const body = html.slice(g, g + 9000);
  const gate = body.indexOf("if (!(window.MHL && window.MHL.auth && window.MHL.auth.user)) {");
  const fetchAt = body.indexOf('await fetch(`${CFG.api}/report/generate`');
  assert.ok(gate > 0 && fetchAt > 0 && gate < fetchAt, '익명 로그인 게이트가 없거나 요청 뒤에 있다');
  assert.match(body.slice(gate, gate + 1200), /report_login_required/, '로그인 필요 이벤트가 실패 이벤트와 구분되지 않는다');
  assert.match(body.slice(gate, gate + 1200), /openLogin&&openLogin\('report'\)/, '로그인 CTA 가 없다');
  assert.match(html, /const REPORT_TIMEOUT_MS = 90000;/, '타임아웃 상수가 없다');
  assert.match(html, /signal: AbortSignal\.timeout\(REPORT_TIMEOUT_MS\),/, '요청 제한이 상수를 쓰지 않는다');
  assert.ok(!html.includes("중단했어요 (3분)"), "옛 '3분' 문구가 남아 있다");
  assert.ok(!html.includes('보고서 생성 중... (1~3분)'), "옛 '1~3분' 문구가 남아 있다");
  assert.match(html, /응답 시간이 너무 길어 중단했어요 \(\$\{Math\.round\(REPORT_TIMEOUT_MS\/1000\)\}초\)/, '중단 안내가 상수에서 나오지 않는다');
});



// ── REFUND-2026-09-05 ─────────────────────────────────────────────────────────────
test('일일 한도 — 캐시 히트처럼 비용이 없는 요청은 한도를 되돌린다(보고서 타임아웃 뒤 재시도가 무료 1회를 또 먹던 것)', async () => {
  const { dailyLimit, getUsage, decrementUsage } = require('../middleware/dailyLimit');
  assert.equal(typeof decrementUsage, 'function', 'decrementUsage 가 없다');
  const ip = '203.0.113.' + Math.floor(Math.random() * 250);
  const req = { method: 'POST', ip, headers: {}, user: null };
  const res = { setHeader() {}, status() { return this; }, json() { return this; } };
  let nexted = 0;
  await dailyLimit({ limit: 5, scope: 'report', loggedInBonus: 1 })(req, res, () => { nexted++; });
  assert.equal(nexted, 1, '한도 안인데 next 가 불리지 않았다');
  assert.equal(await getUsage(req, 'report'), 1, '증가가 기록되지 않았다');
  assert.equal(typeof req.dailyLimitRefund, 'function', '환불 함수가 요청에 실리지 않았다');
  await req.dailyLimitRefund();
  assert.equal(await getUsage(req, 'report'), 0, '환불 뒤 사용량이 0 이 아니다');
  await req.dailyLimitRefund();
  assert.equal(await getUsage(req, 'report'), 0, '0 아래로 내려간다');
  const rpt = require('node:fs').readFileSync(require.resolve('../routes/report'), 'utf8');
  assert.match(rpt, /if \(hit\) \{[\s\S]{0,400}await req\.dailyLimitRefund\(\);[\s\S]{0,300}return res\.json\(\{ \.\.\.hit, fromCache: true \}\);/, '보고서 캐시 히트가 한도를 되돌리지 않는다(주입 실측: typeof 검사만 남아도 통과했다)');
});
