/**
 * 국토교통부 실거래가 API 서비스
 * 공공데이터포털 (data.go.kr) 무료 API
 * API 신청: data.go.kr → '아파트매매 실거래가 상세자료' 검색 → 활용신청
 */
const dgk = require('./dataGoKrClient'); // RELAY-2026-08-08 (Sprint BBBBBBB): 직접+Edge 릴레이
// SSOT-2026-08-09 (Plan 007): 자체 createClient → db/client 팩토리 (DB_FIRST 게이트 의미 유지)
const { getSupabaseAdmin, hasAdminEnv } = require('../db/client');
const cache = require('../cache');
const logger = require('../logger');
// TXAPT-MATCH-2026-05-13 (Sprint Z + Z+): master 정식명 ↔ MOLIT raw 매칭
//   - Z: 양방향 contains + baseAptName (suffix 정규화)
//   - Z+: LCS insertion (builder/지역명 중간 삽입 case — 서강쌍용예가↔서강예가, 한신코아↔한신잠실코아)
const { baseAptName, normalizeAptName, isInsertionMatch } = require('../utils/aptName');
const { itemArray, parseAmountManwon, isCanceled } = require('../utils/molitParse');

const MOLIT_DETAIL_URL = 'https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev';
// MOLIT API 성공 코드: '00'(구버전) 또는 '000'(신버전) — 다른 서비스에서도 재사용
const MOLIT_OK_CODES = new Set(['00', '000']);

// DB 사용 여부 — Supabase 설정되어 있고, MOLIT_DB_FIRST 가 'false' 가 아니면 DB 우선
const DB_FIRST = (process.env.MOLIT_DB_FIRST !== 'false') && hasAdminEnv();

function dbClient() {
  return getSupabaseAdmin();
}

/**
 * DB 에서 region-month 거래 조회. molit_ingest_runs 로 ingest 이력 확인.
 * 이력 없거나 rows 0 이면 null 반환 → 호출자가 MOLIT API fallback 트리거.
 */
async function getTransactionsFromDb(lawdCd, dealYm) {
  const admin = dbClient();
  if (!admin) return null;
  try {
    // 이 region-month 가 한 번이라도 성공적으로 ingest 됐는지 확인
    const run = await admin
      .from('molit_ingest_runs')
      .select('status, rows_fetched, finished_at')
      .eq('lawd_cd', lawdCd)
      .eq('deal_ym', dealYm)
      .eq('status', 'ok')
      .order('finished_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (run.error || !run.data) return null; // 아직 ingest 안 됨 → API fallback

    const dy = parseInt(dealYm.slice(0, 4), 10);
    const dm = parseInt(dealYm.slice(4, 6), 10);
    // PERF-2026-06-13: deal_year+deal_month equality 는 idx_molit_lawd_date(lawd_cd, deal_date DESC) 의
    //   deal_date 부분을 못 써 lawd_cd 의 전체 행을 bitmap heap 으로 긁고 month 필터+정렬 (실측 10.2ms).
    //   deal_date 범위로 변경 → 동일 결과(검증: 276,473행 중 deal_date NULL 0 · year/month 불일치 0)이며
    //   인덱스 (lawd_cd, deal_date) 완전 활용 + 정렬 제거 (실측 1.5ms, 7배 단축).
    const _mFrom = `${dy}-${String(dm).padStart(2, '0')}-01`;
    const _mNext = dm === 12 ? `${dy + 1}-01-01` : `${dy}-${String(dm + 1).padStart(2, '0')}-01`;
    // REST-CAP-FIX-2026-08-09 (Plan 001): 단일 .limit(1000) 은 PostgREST 서버 캡에 걸려 고거래 월
    //   데이터가 조용히 잘렸다 — DB 실측: 1000건 초과 (lawd,월) 7개 실존, 최대 화성동탄 202606
    //   1,905건(905건 47% 누락). getRegionRecentTransactions(REST-CAP-FIX-2026-07-10)와 동일한
    //   range 페이징 + 2차 정렬키 id(동점 페이지 경계 중복/누락 차단)로 교체.
    const PAGE = 1000;
    let data = [];
    for (let from = 0; from <= 11000; from += PAGE) {
      const { data: page, error } = await admin
        .from('molit_transactions')
        .select('apt_name, sigungu, umd_nm, exclu_use_ar, build_year, floor, deal_year, deal_month, deal_day, deal_amount, lawd_cd, apt_seq')
        .eq('lawd_cd', lawdCd)
        .gte('deal_date', _mFrom)
        .lt('deal_date', _mNext)
        .order('deal_date', { ascending: false })
        .order('id', { ascending: false })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (page && page.length) data = data.concat(page);
      if (!page || page.length < PAGE) break;
    }
    return (data || []).map(r => ({
      aptName: r.apt_name,
      sigungu: r.sigungu || '',
      umdNm: r.umd_nm || '',
      excluUseAr: Number(r.exclu_use_ar) || 0,
      buildYear: r.build_year || 0,
      floor: r.floor || 0,
      dealYear: r.deal_year,
      dealMonth: r.deal_month,
      dealDay: r.deal_day,
      dealAmount: Number(r.deal_amount) || 0,
      lawdCd: r.lawd_cd || lawdCd,
      aptSeq: r.apt_seq || '',
    }));
  } catch (e) {
    logger.warn({ err: e.message, lawdCd, dealYm }, 'molit DB 조회 실패 → API fallback');
    return null;
  }
}

/**
 * REC-PERF-2026-07-10 (Sprint EEEE): 지역 최근 N개월 거래를 단일 쿼리로 — recommend 전용.
 *   [근본원인 실측] recommend 콜드 22.4s 중 ~10.8s가 "지역 집계" 단계. 기존 경로는
 *   getTransactionsByApt(lawd,'') → 월별 getTransactions × 6 → 각 월마다 ingest-run 확인 1 + 데이터 1
 *   = 지역당 12왕복, 3지역 36왕복. 동일 데이터를 단일 range 쿼리로 받으면 131ms(EXPLAIN 실측,
 *   idx_molit_lawd_date 완전 활용) · pgrst.db_max_rows 미설정(무제한) 실측 확인.
 *   [안전장치] 빈 결과(미ingest 지역)면 null 반환 → 호출부가 기존 월별 경로(MOLIT API 폴백 포함)로
 *   fallback. 매핑은 getTransactionsFromDb 와 동일 포맷 → analyzeTransactions 그대로 호환.
 */
async function getRegionRecentTransactions(lawdCd, monthsBack = 6) {
  const admin = dbClient();
  if (!admin) return null;
  const ck = `txregion:${lawdCd}:${monthsBack}`;
  const hit = cache.get(ck);
  if (hit !== undefined) return hit;
  try {
    const since = new Date();
    since.setMonth(since.getMonth() - (monthsBack - 1));
    since.setDate(1);
    const sinceStr = since.toISOString().slice(0, 10);
    // REST-CAP-FIX-2026-07-10: Supabase REST 는 응답당 1000행 cap — .limit(12000) 요청도 서버가
    //   1000으로 자름(라이브 실측: analyzedCount 581→490, "구당 최근 1000행 cap" SQL 재현으로 490 정확 일치).
    //   → 1000행 range 페이징. 2차 정렬키 id 로 같은 deal_date 동점의 페이지 경계 중복/누락 차단.
    //   최대 지역(구로 6mo 2,007행 실측) = 3왕복 — 기존 월별 12왕복 대비 여전히 1/4.
    const PAGE = 1000;
    let data = [];
    for (let from = 0; from <= 11000; from += PAGE) {
      const { data: page, error } = await admin
        .from('molit_transactions')
        .select('apt_name, sigungu, umd_nm, exclu_use_ar, build_year, floor, deal_year, deal_month, deal_day, deal_amount, lawd_cd, apt_seq')
        .eq('lawd_cd', lawdCd)
        .gte('deal_date', sinceStr)
        .order('deal_date', { ascending: false })
        .order('id', { ascending: false })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (page && page.length) data = data.concat(page);
      if (!page || page.length < PAGE) break;
    }
    if (!data.length) { cache.set(ck, null, 300); return null; } // 미ingest → 기존 경로 폴백
    const mapped = data.map(r => ({
      aptName: r.apt_name,
      sigungu: r.sigungu || '',
      umdNm: r.umd_nm || '',
      excluUseAr: Number(r.exclu_use_ar) || 0,
      buildYear: r.build_year || 0,
      floor: r.floor || 0,
      dealYear: r.deal_year,
      dealMonth: r.deal_month,
      dealDay: r.deal_day,
      dealAmount: Number(r.deal_amount) || 0,
      lawdCd: r.lawd_cd || lawdCd,
      aptSeq: r.apt_seq || '',
    }));
    cache.set(ck, mapped, 21600); // 6h — daily ingest 주기 기준
    return mapped;
  } catch (e) {
    logger.warn({ err: e.message, lawdCd }, 'txregion 단일쿼리 실패 → 기존 월별 경로 폴백');
    return null;
  }
}

// 서울/경기 주요 구 법정동코드 (앞 5자리)
// Phase 4 (2026-04-26): 전국 광역시 + 주요 시군구 확장 (32 → 82 region)
// 핵심 신축 단지가 광역시 신도시에 많음. 사용자 검색 누락 해소.
// 도 단위는 거래량 적은 시군구 제외. MOLIT API 호출 최적화.
const LAWD_CODES = {
  // ── 서울 25개 구 ──
  '종로구': '11110', '중구': '11140', '용산구': '11170', '성동구': '11200',
  '광진구': '11215', '동대문구': '11230', '중랑구': '11260', '성북구': '11290',
  '강북구': '11305', '도봉구': '11320', '노원구': '11350', '은평구': '11380',
  '서대문구': '11410', '마포구': '11440', '양천구': '11470', '강서구': '11500',
  '구로구': '11530', '금천구': '11545', '영등포구': '11560', '동작구': '11590',
  '관악구': '11620', '서초구': '11650', '강남구': '11680', '송파구': '11710',
  '강동구': '11740',
  // ── 인천 14 ── INCHEON-REORG-2026-08-10 (운영자 질문 "지금 적재된 자료가 어디어디냐"에
  //   답하려 지역별로 조회하다 발견): 인천 중구·동구·서구가 **2026-06-26 을 마지막으로 45일간
  //   무적재**였다. 광주와 **완전히 같은 메커니즘** — molit_ingest_runs 실측 status='ok' +
  //   rows_fetched=0(HTTP 성공·데이터만 빈 응답). 행정안전부 행정표준코드관리시스템 실조회 결과
  //   인천에 **신설 구**가 생기고 옛 구는 현재 목록에서 빠졌다:
  //     제물포구 28125 / 영종구 28155 / 서해구 28275 / 검단구 28290
  //   (제물포구 하위 법정동 실조회: 만석·송현·창영·송림(옛 동구) + 중앙동·신포·답동(옛 중구 원도심)
  //    → 중구 원도심 + 동구 통합으로 확인.)
  //   ⚠ 옛 코드 3개(28110·28140·28260)는 **남긴다** — 이미 적재된 10,074건의 지역명 매핑과
  //     지역 대시보드(routes/region.js:32 가 LAWD_CODE_TO_NAME 으로 이름을 찾는다)가 깨지기 때문.
  //     이들은 앞으로 신규 적재가 없어 zeroFetch 감시에 계속 잡히는데, 그것이 정확한 상태다.
  '인천중구': '28110', '인천동구': '28140', '인천미추홀구': '28177',
  '인천연수구': '28185', '인천남동구': '28200', '인천부평구': '28237',
  '인천계양구': '28245', '인천서구': '28260',
  '인천강화군': '28710', '인천옹진군': '28720',
  '인천제물포구': '28125', '인천영종구': '28155',
  '인천서해구': '28275', '인천검단구': '28290',
  // ── 부산 16 ──
  '부산중구': '26110', '부산서구': '26140', '부산동구': '26170',
  '부산영도구': '26200', '부산진구': '26230', '부산동래구': '26260',
  '부산남구': '26290', '부산북구': '26320', '해운대구': '26350',
  '부산사하구': '26380', '부산금정구': '26410', '부산강서구': '26440',
  '부산연제구': '26470', '부산수영구': '26500', '부산사상구': '26530',
  '부산기장군': '26710',
  // ── 대구 8 ──
  '대구중구': '27110', '대구동구': '27140', '대구서구': '27170',
  '대구남구': '27200', '대구북구': '27230', '대구수성구': '27260',
  '대구달서구': '27290', '대구달성군': '27710',
  // ── 충북 청주 4 ── REGION-SWAP-2026-08-10 (운영자 지시: "광주말고 청주로. 전라도 쪽은 하지마")
  //   [광주 제거 근거 — 행정안전부 행정표준코드관리시스템 실조회로 확정]
  //   광주광역시(29)는 **'전남광주통합특별시'(12)로 통합**되어 시군구 코드가 바뀌었다
  //   (동구 12210 · 서구 12240 · 남구 12270 · 북구 12300 · 광산구 12330).
  //   그래서 국토부 API 가 구 코드 29xxx 에 **빈 응답**(HTTP 200·0건)을 주었고, 2026-06-27 부터
  //   광주 적재가 44일간 멈춰 있었다(status='ok' 라 오류 카운터에도 안 잡힘 — Sprint KKKKKKK-4 참조).
  //   운영자 방침상 전라권은 지원하지 않으므로 새 코드로 옮기지 않고 제거한다.
  //   [청주 코드 — 동일 공식 출처 실조회] 충청북도 43 + 상당구 111 / 서원구 112 / 흥덕구 113 / 청원구 114.
  //   ⚠ '청원구'(43114, 청주시 일반구)와 '청원군'(43710, 2014년 청주시 통합 전 옛 군)은 다른 코드다.
  '청주시상당구': '43111', '청주시서원구': '43112',
  '청주시흥덕구': '43113', '청주시청원구': '43114',
  // ── 대전 5 ──
  '대전동구': '30110', '대전중구': '30140', '대전서구': '30170',
  '대전유성구': '30200', '대전대덕구': '30230',
  // ── 울산 5 ──
  '울산중구': '31110', '울산남구': '31140', '울산동구': '31170',
  '울산북구': '31200', '울산울주군': '31710',
  // ── 세종 1 ──
  '세종특별자치시': '36110',
  // ── 경기 (수도권 신축 핵심) ──
  '과천시': '41290', '광명시': '41210', '성남시분당구': '41135',
  '수원시영통구': '41117', '안양시동안구': '41173', '하남시': '41450',
  '용인시수지구': '41465',
  // REG-UPDATE-2026-06-30: 국토부 6.29 주정심 신규 규제지역(투기과열+조정, 7.1 효력) → ingest 대상 편입.
  //   코드 공식 2중검증(AptInfo get_region_code + get_apt_price 실거래 실측): 구리 41310·기흥 41463·화성 동탄구 41597.
  //   ※ 화성시는 2025 행정구 분리로 동탄구가 자체 시군구코드 41597 보유(구 화성시 41590은 현재 0건).
  //     41597이 동탄 실거래를 직접 서빙(202606 10건 실측: 동탄린스트라우스·동탄역동원 등) → 법정동 필터 불요, 규제구역(동탄구)만 정확 편입.
  //   다음 daily cron에 거래+KAPT마스터 자동 적재. sigungu에 '동탄구' 포함 → isRegFront 정상 규제 판정.
  '구리시': '41310', '용인시기흥구': '41463', '화성시동탄구': '41597',
  // COVERAGE-EXPAND-2026-07-12 (Sprint VVVV): 수도권 커버리지 확장. 각 코드는 /api/transactions
  //   라이브 MOLIT(202605)로 실검증(count>0) 후 편입 — 추측 없음. 반려: 부천통합 41190(0)·화성외 41590(0).
  //   지역-청크 ingest(slotCount)로 maxDuration 300s 내 유지. 검색해석은 propertyService.REGION_KEYWORDS 동반 갱신.
  '수원시장안구': '41111', '수원시권선구': '41113', '수원시팔달구': '41115',
  '성남시수정구': '41131', '성남시중원구': '41133',
  '고양시덕양구': '41281', '고양시일산동구': '41285', '고양시일산서구': '41287',
  '용인시처인구': '41461', '안양시만안구': '41171',
  '부천시원미구': '41192', '부천시소사구': '41194', '부천시오정구': '41196',
  '안산시상록구': '41271', '안산시단원구': '41273',
  '남양주시': '41360', '평택시': '41220', '의정부시': '41150', '시흥시': '41390',
  '파주시': '41480', '김포시': '41570', '경기광주시': '41610', '군포시': '41410',
  '이천시': '41500', '오산시': '41370', '안성시': '41550', '의왕시': '41430',
  '양주시': '41630', '동두천시': '41250', '포천시': '41650', '여주시': '41670',
  '양평군': '41830', '가평군': '41820', '연천군': '41800',
};

// REGION-FRESHNESS-2026-08-17 (Sprint MMMMMMM-22): 위 인천 주석이 말한 "앞으로 신규 적재가 없고,
//   그것이 정확한 상태" 인 코드를 **기계가 읽을 수 있는 형태**로 고정한다.
//   주석으로만 있으면 지역 적재 중단 감시가 이 3곳을 매일 경보로 올려 **진짜 중단을 가린다**(경보 피로).
//   ⚠ LAWD_CODES 에서 지우는 것과는 다르다 — 지우면 적재된 10,074건의 지역명 매핑과
//     지역 대시보드(routes/region.js 의 LAWD_CODE_TO_NAME 조회)가 깨진다. 목록엔 남기고 감시만 뺀다.
//   폐지 근거는 위 INCHEON-REORG-2026-08-10 주석(행정안전부 행정표준코드관리시스템 실조회)과 동일.
const RETIRED_LAWD_CODES = new Set(['28110', '28140', '28260']);

function isMolitKeyMissing() {
  const key = process.env.MOLIT_API_KEY;
  return !key || key === 'your_molit_api_key';
}

/**
 * 실거래가 조회 (월별)
 */
async function getTransactions(lawdCd, dealYm) {
  const cacheKey = `tx:${lawdCd}:${dealYm}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached || []; // null/[] 캐시도 hit 처리

  // ── DB-first: ingest 된 region-month 은 DB 로만 응답 (latency ~20ms) ──
  if (DB_FIRST) {
    const fromDb = await getTransactionsFromDb(lawdCd, dealYm);
    if (fromDb && fromDb.length > 0) {
      cache.set(cacheKey, fromDb, 21600); // REC-PERF-2026-07-10 (Sprint EEEE): 1h→6h — 데이터는 daily cron(17:00 UTC)만 갱신, 콜드 빈도 축소
      return fromDb;
    }
    // fromDb === null (미ingest 또는 실패) 또는 빈 배열 → API fallback 으로 진행
  }

  if (isMolitKeyMissing()) {
    const err = new Error('국토부 실거래가 API 키가 설정되지 않았습니다. data.go.kr에서 무료 발급 후 환경변수 MOLIT_API_KEY에 설정하세요.');
    err.code = 'MOLIT_KEY_MISSING';
    err.status = 503;
    throw err;
  }

  try {
    // ── 페이징 완전 구현 ────────────────────────────────────
    // 기존: 1페이지(1000건)만 → 강남·송파·성동 등 월 1000+건 거래 구에서 최근 거래 누락
    // 개선: 최대 10페이지(1만건) 까지 순차 조회. totalCount 기반 조기 종료.
    // 왜 10페이지 상한: 서울 최대 월 거래 구(강남)도 통상 1500~2500건 수준
    //                  → 10페이지는 충분한 안전마진. Serverless 타임아웃 방어 상한.
    const MAX_PAGES = 10;
    const NUM_ROWS = 1000;
    const allItems = [];
    let header = null;
    let totalCount = null;
    let cancelledCount = 0;

    for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
      const response = await dgk.get(MOLIT_DETAIL_URL, {
        params: {
          serviceKey: process.env.MOLIT_API_KEY,
          LAWD_CD: lawdCd,
          DEAL_YMD: dealYm,
          pageNo,
          numOfRows: NUM_ROWS,
          _type: 'json',
        },
        timeout: 7000,
        headers: { Accept: 'application/json' },
      });

      const body = response.data?.response?.body;
      header = response.data?.response?.header || header;
      totalCount = body?.totalCount != null ? parseInt(body.totalCount, 10) : totalCount;
      const pageItems = itemArray(body?.items?.item);

      if (header && header.resultCode && !MOLIT_OK_CODES.has(header.resultCode)) {
        logger.warn({
          source: 'molit', lawdCd, dealYm, pageNo,
          resultCode: header.resultCode, resultMsg: header.resultMsg,
        }, 'MOLIT 거래 조회 비정상 응답코드');
        break; // 에러 응답이면 페이지 루프 중단
      } else if (!header && typeof response.data === 'string') {
        logger.warn({
          source: 'molit', lawdCd, dealYm, pageNo,
          sample: String(response.data).slice(0, 200),
        }, 'MOLIT 거래 비-JSON 응답');
        break;
      }

      allItems.push(...pageItems);

      // 페이지가 덜 채워졌거나 totalCount 초과 시 종료
      if (pageItems.length < NUM_ROWS) break;
      if (totalCount != null && allItems.length >= totalCount) break;
    }

    if (totalCount != null && allItems.length < totalCount) {
      logger.warn({
        source: 'molit', lawdCd, dealYm,
        fetched: allItems.length, total: totalCount, maxPages: MAX_PAGES,
      }, 'MOLIT 거래 일부 페이징 미완료 — MAX_PAGES 상한 도달');
    }

    // ── 해제(취소) 거래 필터링 ───────────────────────────
    // MOLIT 응답에 cdealType 이 있으면 해제 거래. 기본 제외.
    // 왜 제외: 네이버는 취소된 거래를 숨기지만 MOLIT 은 해제 플래그만 달고 유지 →
    //          필터 안 하면 "네이버엔 없는 거래가 여기엔 있다" 는 불일치 원인 (Bug #3)
    const result = allItems
      .filter(item => {
        if (isCanceled(item)) {
          cancelledCount++;
          return false;
        }
        return true;
      })
      .map(item => ({
        aptName: item.aptNm?.trim() || '',
        sigungu: item.sggNm?.trim() || '',
        umdNm: item.umdNm?.trim() || '',
        excluUseAr: parseFloat(item.excluUseAr) || 0,
        buildYear: parseInt(item.buildYear) || 0,
        floor: parseInt(item.floor) || 0,
        dealYear: parseInt(item.dealYear) || 0,
        dealMonth: parseInt(item.dealMonth) || 0,
        dealDay: parseInt(item.dealDay) || 0,
        dealAmount: parseAmountManwon(item.dealAmount),
        lawdCd: item.regionCode || lawdCd,
        aptSeq: item.aptSeq || '',
      }));

    if (cancelledCount > 0) {
      logger.info({ source: 'molit', lawdCd, dealYm, cancelledCount, activeCount: result.length },
        'MOLIT 해제 거래 필터링');
    }

    cache.set(cacheKey, result, 86400);
    return result;
  } catch (err) {
    if (err.code === 'MOLIT_KEY_MISSING') throw err;
    // 에러 캐시 5분 — 일시적 5xx/timeout 시 매 요청마다 외부 API 두드리는 부하 방지
    cache.set(cacheKey, [], 300);
    const apiErr = new Error(`국토부 API 호출 실패: ${err.message}`);
    apiErr.code = 'MOLIT_API_ERROR';
    apiErr.status = 502;
    throw apiErr;
  }
}

/**
 * 단지명 기반 최근 N개월 실거래가 조회 (기본 6개월)
 * COMPARE-12MO-2026-06-21 (단지 비교 Phase1): monthsBack 파라미터 추가.
 *   배경: 단지 비교 평당가는 "동일 전용면적대·n>=8·최근 12개월" 룰. 기존 6개월 윈도우는
 *         활성단지 n>=8 충족률 32% 에 그쳐(12개월=54%) 룰을 못 지킴 → 12개월 옵션 필요.
 *   하위호환: 미전달 호출자는 6개월 유지(회귀 0). cacheKey 에 monthsBack 포함해 6/12 분리 캐시.
 */
async function getTransactionsByApt(lawdCd, aptName, monthsBack = 6) {
  if (isMolitKeyMissing()) {
    const err = new Error('국토부 실거래가 API 키 미설정');
    err.code = 'MOLIT_KEY_MISSING';
    err.status = 503;
    throw err;
  }

  const cacheKey = `txapt:${lawdCd}:${aptName}:${monthsBack}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const now = new Date();
  const months = [];
  // 최근 N개월 조회 — 거래 희소 단지까지 커버
  for (let i = 0; i < monthsBack; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`);
  }

  const allResults = await Promise.all(
    months.map(m => getTransactions(lawdCd, m).catch(() => []))
  );

  const flat = allResults.flat();
  // TXAPT-MATCH-2026-05-13 (Sprint Z — 운영자 발견 "안 맞는 아파트 너무 많아" [VERIFIED]):
  //   기존: 한방향 contains — `MOLIT_raw.includes(user_query)` 만.
  //         "잠실파크리오" (KAPT 정식명 master 클릭) → MOLIT raw "파크리오" 매칭 실패 (substring 아님).
  //   변경: 양방향 contains + baseAptName (Sprint S helper) 으로 동/letter/층 suffix 제거 후 비교.
  //
  //   false-positive 가드:
  //     - lawdCd 가 같은 (구 안 데이터만) 이므로 sigungu 안에서 match — 동명이지 단지 위험 미미
  //     - normalize 후 길이 >= 3 만 매칭 (너무 짧은 단지명 차단)
  let filtered = flat;
  if (aptName) {
    const qStripped = String(aptName).replace(/\s/g, '');
    const qBase = baseAptName(aptName).replace(/\s/g, '');
    filtered = flat.filter(t => {
      const rawName = String(t.aptName || '');
      const rawStripped = rawName.replace(/\s/g, '');
      const rawBase = baseAptName(rawName).replace(/\s/g, '');
      // 1) 양방향 contains (raw ↔ query, base 양쪽)
      if (rawStripped.includes(qStripped)) return true;
      if (qStripped.length >= 3 && qStripped.includes(rawStripped) && rawStripped.length >= 3) return true;
      if (rawBase.includes(qBase) && qBase.length >= 3) return true;
      if (qBase.includes(rawBase) && rawBase.length >= 3) return true;
      // 2) LCS insertion (서강쌍용예가↔서강예가 같이 builder/지역명 중간 삽입 case)
      //    Sprint Z+ (2026-05-13) — Sprint T 의 KAPT-LOOKUP 알고리즘과 동일.
      //    sigungu 안에서만 적용되니 false-positive 위험 미미.
      if (isInsertionMatch(aptName, rawName)) return true;
      return false;
    });
  }

  const sorted = filtered.sort((a, b) => {
    const da = a.dealYear * 10000 + a.dealMonth * 100 + a.dealDay;
    const db = b.dealYear * 10000 + b.dealMonth * 100 + b.dealDay;
    return db - da;
  });

  // P1-12 (2026-05-04): cache TTL 3600s → 1800s (30분)
  //   기존: 1시간 — 신규 거래 발생 시 1시간 stale data 노출
  //   변경: 30분 — 매일 17:00 UTC molit-ingest 후 30분이면 모든 사용자가 최신 받음
  cache.set(cacheKey, sorted, 1800);
  return sorted;
}

// ── ALIAS-MERGE-2026-05-21 (전수조사: BUG2/가격시그널 동일 클래스) ─────────────────
//   master 단지(KAPT 정식명)의 MOLIT 신고명이 다를 때(예: 공릉풍림아이원 → 풍림아파트A/B),
//   이름 유사도 매칭이 실패 → 거래 부분 집계 → 가격시그널/분석 "표본부족" 불일치(실거래가 탭과 어긋남).
//   apt_master.molit_aliases (공식 매핑) 로 보강. 검색 path(openAptDetail) 와 동일 집합을 만들어 일관성 확보.

// (a) 단일 단지: canonical + alias 거래 fetch + 병합 (analysisService 가격시그널용)
//   COMPARE-12MO-2026-06-21: monthsBack 패스스루 (단지 비교 12개월). 미전달 시 6개월(회귀 0).
async function getTransactionsByAptInclAliases(lawdCd, aptName, monthsBack = 6) {
  const base = await getTransactionsByApt(lawdCd, aptName, monthsBack);
  if (!aptName) return base;
  const admin = dbClient();
  if (!admin) return base;
  try {
    const sigungu = LAWD_CODE_TO_NAME[lawdCd] || null;
    let q = admin.from('apt_master').select('molit_aliases')
      .eq('apt_name', aptName).not('molit_aliases', 'is', null).limit(1);
    if (sigungu) q = q.eq('sigungu', sigungu);
    const { data } = await q;
    const aliases = (data && data[0] && Array.isArray(data[0].molit_aliases)) ? data[0].molit_aliases : [];
    if (!aliases.length) return base;
    // master(공릉풍림아이원)는 canonical 명으로 MOLIT 실거래가 없음(전부 alias 로 신고) → base 의
    //   느슨한 매칭(insertion 등)은 spurious 일 수 있어 제외. alias 거래만 병합(검색 path 와 동일 = 정확).
    const aliasArrays = await Promise.all(
      aliases.slice(0, 5).map(a => getTransactionsByApt(lawdCd, a, monthsBack).catch(() => []))
    );
    const merged = [];
    const seen = new Set();
    for (const arr of aliasArrays) {
      for (const t of arr) {
        const k = `${t.dealYear}|${t.dealMonth}|${t.dealDay}|${t.excluUseAr}|${t.floor}|${t.dealAmount}|${t.aptName}`;
        if (!seen.has(k)) { seen.add(k); merged.push(t); }
      }
    }
    return merged.length ? merged : base; // alias 거래 0건이면 base fallback
  } catch (e) {
    logger.warn({ err: e.message, lawdCd, aptName }, 'getTransactionsByAptInclAliases alias 병합 실패 — base 반환');
    return base;
  }
}

// (b) 지역 단위: raw MOLIT명 → canonical master명 매핑 (propertyService 추천 relabel용)
//   key: `${rawAliasName}|${umdNm}` (동까지 매칭해 동명이지 오병합 차단).
//   ALIAS-REGION-FIX-2026-07-12 (Sprint RRRR): sigungu 명이 아니라 lawd_cd 로 조회.
//     [근본원인] propertyService 는 REGION_KEYWORDS 축약명('노원')을 넘기는데 apt_master.sigungu
//     값은 '노원구' → `.in('sigungu',['노원'])` 0건 → 맵 비어서 풍림아파트A/B relabel 미발동(raw 표시).
//     lawd_cd 는 숫자코드라 축약/전체명 모호성 없음. apt_master.lawd_cd 10,638/10,638 채움(검증).
async function getAliasCanonicalMap(lawdCds) {
  const admin = dbClient();
  if (!admin || !Array.isArray(lawdCds) || !lawdCds.length) return new Map();
  const map = new Map();
  try {
    // REST-CAP-FIX-2026-08-10 (Sprint KKKKKKK-11, 감사 발견 — DB 실측으로 발동 확인):
    //   이 조회에는 `.limit()`/`.range()` 가 없어 PostgREST max-rows(1000)에서 **조용히 잘렸다**.
    //   [왜 필터가 못 막나] `.not('molit_aliases','is',null)` 은 사실상 아무것도 안 거른다 —
    //     실측 apt_master 13,951행 **전부**가 molit_aliases 를 갖고 있다(자동 backfill 완료 상태).
    //   [실측 규모] lawd_cd 당 평균 122.4행(최대 328) → **9개 지역만 넘어도 1000행 초과**.
    //     보고서에서 "서울" 광역을 고르면 25개 구 = 3,384행이라 **70%가 소실**된다.
    //   [증상] 잘린 alias 는 맵에 없으니 relabel 이 안 걸려 raw MOLIT 명이 그대로 노출된다 —
    //     보고서는 같은 단지가 이름 이형으로 쪼개져 중복 표기되고(BUG2/ALIAS-MERGE 와 같은 실패),
    //     pushNotify 는 canonical 명으로 담은 관심단지의 새 거래를 **알림에서 놓친다**(조용한 미발송).
    //   ⇒ 페이지 루프. 2차 정렬키는 kapt_code(pg_index 실측 PRIMARY KEY)라 경계 드리프트가 없다.
    const uniq = [...new Set(lawdCds.filter(Boolean))];
    const PAGE = 1000;
    for (let from = 0; from < 20000; from += PAGE) {   // apt_master 13,951행 → 최대 14페이지
      const { data, error } = await admin.from('apt_master')
        .select('kapt_code, apt_name, umd_nm, molit_aliases')
        .in('lawd_cd', uniq)
        .not('molit_aliases', 'is', null)
        .order('kapt_code', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      if (!data || !data.length) break;
      for (const r of data) {
        const al = Array.isArray(r.molit_aliases) ? r.molit_aliases : [];
        for (const a of al) map.set(`${a}|${r.umd_nm || ''}`, r.apt_name);
      }
      if (data.length < PAGE) break;   // 마지막 페이지 — 통상 추천 경로(1~3지역)는 여기서 1회 종료
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'getAliasCanonicalMap 조회 실패 — 빈 맵');
  }
  return map;
}

// ── 통계 헬퍼 (P1 2026-04-25) ───────────────────────────────────
// 감사 보고서 1-3 (🔴 치명):
//   - 기존: 단순 산술평균. 30억 이상치 1건이 8억 단지 평균 +10% 왜곡.
//   - 개선: trimmed mean (상하 10% 제거) + median 동시 노출.
//   - 시간 가중: 최근 거래에 가중치 (90일 half-life) — 6개월 전 가격이 현재 시세 행세하는 문제 차단.
//   - 층 보정 안내: 1층/탑층 프리미엄/디스카운트는 MOLIT 데이터로 자동 보정 어려움 → "임장 확인 필수" 라벨.
function _median(sorted) {
  if (!sorted.length) return 0;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : Math.round((sorted[m - 1] + sorted[m]) / 2);
}
function _trimmedMean(values, trimRatio = 0.1) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const cut = Math.floor(sorted.length * trimRatio);
  const trimmed = sorted.slice(cut, sorted.length - cut);
  if (!trimmed.length) return Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
  return Math.round(trimmed.reduce((a, b) => a + b, 0) / trimmed.length);
}
// 시간 가중 평균 — 최근 거래일수록 높은 가중치 (반감기 90일)
function _weightedMean(transactions) {
  if (!transactions.length) return 0;
  const now = Date.now();
  let totalW = 0, sumW = 0;
  for (const t of transactions) {
    const d = new Date(t.dealYear, (t.dealMonth || 1) - 1, t.dealDay || 1).getTime();
    const daysAgo = Math.max(0, (now - d) / (1000 * 60 * 60 * 24));
    const w = Math.exp(-daysAgo / 90); // half-life 90일
    sumW += w * t.dealAmount;
    totalW += w;
  }
  return totalW > 0 ? Math.round(sumW / totalW) : 0;
}

/**
 * 지역별 시세 분석 — 단지 + 평형별 분리
 */
function analyzeTransactions(transactions) {
  if (!transactions || !transactions.length) return [];

  const byApt = {};
  for (const t of transactions) {
    // GENERIC-NAME-SPLIT-2026-05-21 (운영자 발견 "단지 정리 목록이 이상"):
    //   기존: aptName 단독 키 → "현대"·"벽산"·"청구" 등 동명 단지가 동/구를 넘어 1개로 합산 →
    //     가격범위 왜곡 (예: 현대 5.65~12.1억 = 상계동·중계동 별개 현대 단지 합산).
    //   변경: aptName|lawdCd|umdNm 복합키로 물리적 단지 분리 (report path fetchCandidateApts 와 동일 정책).
    //   주: BUG2 의 alias 병합(서로 다른 이름 = 같은 단지)과는 반대 방향 — 같은 이름 = 다른 단지를 분리.
    const gkey = `${t.aptName}|${t.lawdCd || ''}|${t.umdNm || ''}`;
    if (!byApt[gkey]) byApt[gkey] = [];
    byApt[gkey].push(t);
  }

  return Object.entries(byApt).map(([, list]) => {
    const sorted = [...list].sort((a, b) => {
      const da = a.dealYear * 10000 + a.dealMonth * 100 + a.dealDay;
      const db = b.dealYear * 10000 + b.dealMonth * 100 + b.dealDay;
      return db - da;
    });
    const prices = sorted.map(t => t.dealAmount);
    const sortedPrices = [...prices].sort((a, b) => a - b);
    // P1: 단순 평균 → trimmed mean (상하 10% 제거) + median + 시간 가중
    //     기본 avgPrice 는 weighted (사용자 노출용 — 가장 현재 시세 근접)
    const avg = _weightedMean(sorted);
    const median = _median(sortedPrices);
    const trimmed = _trimmedMean(prices, 0.1);

    const byPyeong = {};
    for (const t of sorted) {
      // PYEONG-M2-2026-08-17 (Sprint MMMMMMM-10): 평↔㎡ 계수가 저장소 안에서 3.3 과 3.3058 로 갈려 있었다.
      //   정확값은 1평 = 3.305785㎡ 이고, 이미 analysisService 에 _PYEONG_M2 = 3.3058 이 있었는데
      //   다른 자리들이 어림값 3.3 을 쓰고 있었다. 3.3058 로 통일한다.
      //   [영향 실측] 20~250㎡ 전 구간에서 반올림 결과가 갈리는 비율 7.2%. 다만 실제 대표 평형
      //   (59.82·84.92·114.97·134.9·164.9㎡)은 **전부 동일**하고, 불일치는 21~25㎡ 같은 소형 구간에 몰린다.
      //   ⚠ 회귀 위험: 평형 필터(15~60평) 경계에 걸린 극소수 매물이 들고날 수 있다.
      const py = Math.round(t.excluUseAr / 3.3058);
      if (!byPyeong[py]) byPyeong[py] = [];
      byPyeong[py].push(t);
    }
    const pyeongStats = Object.entries(byPyeong).map(([py, txs]) => {
      const ps = txs.map(t => t.dealAmount);
      const psSorted = [...ps].sort((a, b) => a - b);
      // 층 분포 — 1층(low)/탑층(high) 비율 노출 → 사용자에게 "RR 보정 안 됨" 인지
      const floors = txs.map(t => t.floor || 0).filter(f => f > 0);
      const minFloor = floors.length ? Math.min(...floors) : null;
      const maxFloor = floors.length ? Math.max(...floors) : null;
      // FLOOR-BANDS-2026-07-14 (Sprint KKKKK): 같은 평형 내 저/중/고층(그룹 내 3분위) 중위가.
      //   기존 floorAdjustmentNote 는 "층별 보정 불가·임장 필수" 회피 안내뿐이었으나, floor 컬럼은
      //   이미 전 거래에 보유 — 실측치로 보강. 밴드당 표본 4건 미만이면 중위가 노이즈 → 전체 null(비노출).
      //   절대룰: 과거 실거래 수치 나열만(층 프리미엄 % 산정·예측 표현 없음 — 그건 사용자 해석 영역).
      let floorBands = null;
      const fTxs = txs.filter(t => (t.floor || 0) > 0);
      if (fTxs.length >= 12) {
        const fSorted = [...fTxs].sort((a, b) => a.floor - b.floor);
        const third = Math.floor(fSorted.length / 3);
        const bandTx = [fSorted.slice(0, third), fSorted.slice(third, fSorted.length - third), fSorted.slice(fSorted.length - third)];
        const built = bandTx.map(b => (b.length >= 4 ? {
          range: `${b[0].floor}~${b[b.length - 1].floor}층`,
          n: b.length,
          median: _median(b.map(t => t.dealAmount).sort((x, y) => x - y)),
        } : null));
        if (built.every(Boolean)) floorBands = { low: built[0], mid: built[1], high: built[2] };
      }
      return {
        pyeong: parseInt(py),
        excluUseAr: parseFloat((txs[0].excluUseAr).toFixed(2)),
        dealCount: txs.length,
        avgPrice:    _weightedMean(txs), // 시간 가중 평균 (사용자 노출 기본)
        medianPrice: _median(psSorted),  // 중앙값 (이상치 강건)
        trimmedAvgPrice: _trimmedMean(ps, 0.1),
        minPrice: Math.min(...ps),
        maxPrice: Math.max(...ps),
        floorRange: minFloor !== null ? { min: minFloor, max: maxFloor } : null,
        floorBands, // Sprint KKKKK — 저/중/고층 3분위 중위가 (표본 부족 시 null)
        recentTx: txs.slice(0, 5).map(t => ({
          date: `${t.dealYear}.${String(t.dealMonth).padStart(2, '0')}.${String(t.dealDay).padStart(2, '0')}`,
          floor: t.floor,
          price: t.dealAmount,
          excluUseAr: t.excluUseAr,
        })),
      };
    }).sort((a, b) => a.pyeong - b.pyeong);

    return {
      aptName: sorted[0].aptName,
      sigungu: sorted[0].sigungu,
      umdNm: sorted[0].umdNm,
      buildYear: sorted[0].buildYear,
      lawdCd: sorted[0].lawdCd,
      aptSeq: sorted[0].aptSeq,
      dealCount: sorted.length,
      avgPrice: avg,           // 시간 가중 (사용자 노출)
      medianPrice: median,     // 중앙값
      trimmedAvgPrice: trimmed,// trimmed mean (상하 10% 제거)
      minPrice: Math.min(...prices),
      maxPrice: Math.max(...prices),
      avgPriceAuk: (avg / 10000).toFixed(2),
      areas: pyeongStats.map(p => p.pyeong).join('·') + '평',
      recentDeal: `${sorted[0].dealYear}.${String(sorted[0].dealMonth).padStart(2, '0')}.${String(sorted[0].dealDay).padStart(2, '0')}`,
      pyeongStats,
      rawList: sorted.slice(0, 10),
      // P1 (2026-04-25): 층·향 자동 보정 불가 — 사용자에게 "RR/저층 임장 필수" 인지 강제
      floorAdjustmentNote: 'MOLIT 데이터는 층별 가격 변동(저층 -3%·탑층 +5%·RR 프리미엄)을 자동 보정할 수 없습니다. 동·층·향은 임장 확인 필수.',
    };
  }).sort((a, b) => b.dealCount - a.dealCount);
}

// 역매핑 — lawd_cd → 구이름 (ETL sigungu 채우기 / 검색 필터에서 사용)
// Phase 4 (2026-04-26): 광역시 prefix 제거 — DB sigungu 는 "해운대구" "연수구" 등 짧은 이름.
//   원본 LAWD_CODES 키는 "부산해운대구" 같이 광역시 prefix 가 있어 frontend 표시 시 중복 → 마지막 "구/시/군"부분만.
const _stripCityPrefix = (k) => {
  // 광역시 prefix (인천·부산·대구·대전·울산) 제거. "성남시분당구" 같이 시 단위 명칭은 보존.
  //   REGION-SWAP-2026-08-10: '광주' 제거 — LAWD_CODES 에서 광주 키가 사라져 죽은 분기가 됐다.
  //   ('경기광주시'는 '경기'로 시작해 원래 이 정규식에 걸리지 않으므로 영향 없음.)
  return k.replace(/^(인천|부산|대구|대전|울산)/, '');
};
const LAWD_CODE_TO_NAME = Object.fromEntries(
  Object.entries(LAWD_CODES).map(([name, code]) => [code, _stripCityPrefix(name)])
);

/**
 * APT-PAGE-2026-08-29 (Sprint NNNNNNN-32): **apt_seq 로 정확 조회**.
 *
 * [왜 새로 만드는가] 기존 getTransactionsByApt 는 **단지명 유사도 매칭**이다(양방향 contains·LCS).
 *   서버렌더 단지 페이지는 URL 이 곧 단지라 이름 매칭이 필요 없고, 오히려 위험하다 —
 *   '현대'·'벽산' 같은 흔한 이름이 다른 단지를 끌어오면 공개 페이지에 남의 거래가 실린다.
 *   apt_seq 는 MOLIT 이 부여한 식별자이고 전 22,473건이 `^\d{5}-\d+$` 형식임을 실측했다.
 *
 * ⚠ PostgREST 는 1000행에서 조용히 잘린다(레포 6회 재발). 단지 최다 거래가 477건(실측)이라
 *   1페이지로 충분하지만, 그 사실이 바뀔 수 있으므로 **명시 limit + 잘림 여부 확인**을 남긴다.
 */
async function getTransactionsByAptSeq(aptSeq, monthsBack = 24) {
  const admin = dbClient();
  if (!admin) return null;
  const seq = String(aptSeq || '').trim();
  if (!/^\d{5}-\d+$/.test(seq)) return null;
  const ck = `txseq:${seq}:${monthsBack}`;
  const hit = cache.get(ck);
  if (hit !== undefined) return hit;
  try {
    const since = new Date();
    since.setMonth(since.getMonth() - (monthsBack - 1));
    since.setDate(1);
    const LIM = 1000;
    const { data, error } = await admin
      .from('molit_transactions')
      .select('apt_name, sigungu, umd_nm, exclu_use_ar, build_year, floor, deal_year, deal_month, deal_day, deal_amount, lawd_cd, apt_seq')
      .eq('apt_seq', seq)
      .gte('deal_date', since.toISOString().slice(0, 10))
      .order('deal_date', { ascending: false })
      .order('id', { ascending: false })
      .limit(LIM);
    if (error) throw error;
    const rows = data || [];
    if (rows.length >= LIM) {
      logger.warn({ aptSeq: seq, limit: LIM }, 'apt_seq 거래가 조회 상한에 닿음 — 페이징 필요');
    }
    if (!rows.length) { cache.set(ck, null, 600); return null; }
    const mapped = rows.map(r => ({
      aptName: r.apt_name,
      sigungu: r.sigungu || '',
      umdNm: r.umd_nm || '',
      excluUseAr: Number(r.exclu_use_ar) || 0,
      buildYear: r.build_year || 0,
      floor: r.floor || 0,
      dealYear: r.deal_year,
      dealMonth: r.deal_month,
      dealDay: r.deal_day,
      dealAmount: Number(r.deal_amount) || 0,
      lawdCd: r.lawd_cd || '',
      aptSeq: r.apt_seq || seq,
    }));
    cache.set(ck, mapped, 21600); // 6h — daily ingest 주기 기준(getRegionRecentTransactions 와 동일)
    return mapped;
  } catch (e) {
    logger.warn({ err: e.message, aptSeq: seq }, 'apt_seq 거래 조회 실패');
    return null;
  }
}

module.exports = { getTransactions, getTransactionsByApt, getTransactionsByAptInclAliases, getAliasCanonicalMap, analyzeTransactions, getRegionRecentTransactions, getTransactionsByAptSeq, LAWD_CODES, LAWD_CODE_TO_NAME, RETIRED_LAWD_CODES };
