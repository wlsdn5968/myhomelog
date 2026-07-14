/**
 * 단지 마스터 동기화 (Phase 4, 2026-04-26)
 *
 * 목적:
 *   AptInfo API 의 get_apt_list 로 sgg_code 별 단지 목록 받아 apt_master 적재.
 *   거래 0건 단지도 검색에 노출 + AptInfo kapt_code 보유 → facility 풍부화 가능.
 *
 * 호출 빈도:
 *   주 1회 (월요일 03:00 KST) — 단지 마스터는 변동 적음 (신축 입주만 추가)
 *
 * 처리량:
 *   82 sgg_code × 평균 100 단지 = 8,000+ 단지. 페이지당 50개 → 평균 2~4 페이지.
 *   API 호출 ~250회 / job. 카카오·MOLIT 보다 가벼움.
 *
 * 멱등:
 *   apt_master.kapt_code PRIMARY KEY → ON CONFLICT DO NOTHING (이름 변경 무시).
 *   재실행해도 안전.
 */
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const logger = require('../logger');
const { LAWD_CODES, LAWD_CODE_TO_NAME } = require('../services/transactionService');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.service_role;

// 공공데이터포털 API (data.go.kr) — AptInfo 전용 키 (별도 발급)
const APT_INFO_KEY = process.env.APT_INFO_API_KEY || process.env.MOLIT_API_KEY;
// 시군구 코드 기반 단지 목록 endpoint (getSigunguAptList3)
const APT_LIST_URL = 'https://apis.data.go.kr/1613000/AptListService3/getSigunguAptList3';

const PAGE_SIZE = 100;
const MAX_PAGES = 20;
let _diagLogged = false; // 한 번만 진단 로그 (전체 backfill 동안)

function adminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase service_role 미설정 — apt-master-sync 불가');
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * 한 sgg_code 의 단지 목록 받아 INSERT (멱등 — 이미 있는 kapt 건너뜀).
 * 응답 형식 (AptInfo getRoadnameAptList3):
 *   <items><item>
 *     <kaptCode>A10022238</kaptCode>
 *     <kaptName>연수푸르지오1단지</kaptName>
 *     <as1>인천광역시</as1>
 *     <as2>연수구</as2>
 *     <as3>연수동</as3>
 *     <as4>...</as4>
 *     <bjdCode>2818510300</bjdCode>
 *   </item></items>
 */
async function syncOneSgg(admin, lawdCd) {
  const all = [];
  // ROBUSTNESS-2026-06-13: 페이지 재시도 상태 — 일시적 5xx 시 break(뒷페이지 전체 유실) 대신 동일 페이지 재시도.
  let _pageRetry = 0;
  const MAX_PAGE_RETRY = 2;
  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
    let r;
    try {
      r = await axios.get(APT_LIST_URL, {
        params: {
          serviceKey: APT_INFO_KEY,
          sigunguCode: lawdCd,
          pageNo,
          numOfRows: PAGE_SIZE,
          _type: 'json',
        },
        timeout: 8000,
        headers: { Accept: 'application/json' },
      });
    } catch (e) {
      // 진단 (1회만): axios 에러 raw — 4xx/5xx 시 message+status+body
      if (!_diagLogged) {
        _diagLogged = true;
        const rd = e?.response?.data;
        const bodyPreview = typeof rd === 'string' ? rd.slice(0, 400) : JSON.stringify(rd || {}).slice(0, 400);
        logger.error({
          lawdCd, pageNo,
          status: e?.response?.status,
          msg: e.message,
          bodyPreview,
          keyLen: APT_INFO_KEY ? APT_INFO_KEY.length : 0,
          keyHasPercent: APT_INFO_KEY ? APT_INFO_KEY.includes('%') : null,
        }, 'AptInfo axios 진단 (1회)');
      }
      // ROBUSTNESS-2026-06-13: molit 와 동일하게 동일 페이지 재시도(backoff) 후에만 포기 → 일시 오류로 인한 뒷페이지 유실 방지.
      if (_pageRetry < MAX_PAGE_RETRY) {
        _pageRetry++;
        await new Promise(rs => setTimeout(rs, 400 * _pageRetry));
        pageNo--; // 같은 페이지 재시도
        continue;
      }
      logger.warn({ err: e.message, lawdCd, pageNo, retries: _pageRetry }, 'AptInfo 페이지 호출 실패 — 재시도 소진, 이 sgg 중단');
      break;
    }
    _pageRetry = 0; // 페이지 성공 → 재시도 카운터 리셋(페이지별 예산)
    const header = r.data?.response?.header;
    // 진단 (1회만): 응답 raw 한번만 로깅 (구조 파악)
    if (!_diagLogged) {
      _diagLogged = true;
      const rawData = r.data;
      const preview = typeof rawData === 'string' ? rawData.slice(0, 600) : JSON.stringify(rawData || {}).slice(0, 600);
      logger.warn({
        lawdCd, pageNo,
        url: APT_LIST_URL,
        keyLen: APT_INFO_KEY ? APT_INFO_KEY.length : 0,
        keyHasPercent: APT_INFO_KEY ? APT_INFO_KEY.includes('%') : null,
        contentType: r.headers?.['content-type'],
        responsePreview: preview,
      }, 'AptInfo 응답 진단 (1회)');
    }
    if (header?.resultCode && !['00', '000'].includes(header.resultCode)) {
      logger.warn({ lawdCd, pageNo, code: header.resultCode, msg: header.resultMsg },
        'AptInfo 응답 비정상');
      break;
    }
    const body = r.data?.response?.body;
    // AptInfo 응답: body.items 가 직접 배열 (MOLIT 의 items.item 래핑 없음)
    const itemsRaw = body?.items;
    const list = Array.isArray(itemsRaw)
      ? itemsRaw
      : (itemsRaw?.item
          ? (Array.isArray(itemsRaw.item) ? itemsRaw.item : [itemsRaw.item])
          : []);
    if (!list.length) break;
    all.push(...list);
    if (list.length < PAGE_SIZE) break;
    const total = body?.totalCount != null ? parseInt(body.totalCount, 10) : null;
    if (total != null && all.length >= total) break;
  }

  if (!all.length) return { lawdCd, fetched: 0, inserted: 0 };

  // ON CONFLICT (kapt_code) DO NOTHING — 신규만 INSERT
  const sigunguShort = LAWD_CODE_TO_NAME[lawdCd] || null;
  const mapped = all
    .filter(it => it.kaptCode && it.kaptName)
    .map(it => ({
      kapt_code: String(it.kaptCode).trim(),
      apt_name: String(it.kaptName).trim(),
      lawd_cd: lawdCd,
      sigungu: sigunguShort,
      umd_nm: it.as3 ? String(it.as3).trim() : null,
      source: 'aptinfo',
    }));
  // NAME-UNIQ-DEDUP-2026-07-14 (Sprint IIIII — 부산연제/대구동구/고양덕양 apt_master 0행 근본원인):
  //   DB 에 uq_apt_master_name_lawd_umd(apt_name, lawd_cd, umd_nm) 유니크 제약 존재. KAPT 목록엔 동명 단지가
  //   실재(26470 "연산현대아파트"×2 — A61176202/A61181202 [VERIFIED]) → chunk INSERT 가 duplicate key 로
  //   전체 실패 → 그 지역 0행이 매주 조용히 반복(경고 로그만). onConflict 는 kapt_code 만 지정 가능하므로
  //   ① 동일 (이름,법정동) 조합은 첫 항목만 유지(이름 매칭 관점에선 어차피 구분 불가) ② 아래 행별 fallback.
  const _seenNameKey = new Set();
  const rows = [];
  for (const r of mapped) {
    const k = `${r.apt_name}|${r.lawd_cd}|${r.umd_nm || ''}`;
    if (_seenNameKey.has(k)) {
      logger.warn({ lawdCd, dupName: r.apt_name, skippedKapt: r.kapt_code }, '동명 단지(이름 유니크 충돌) skip');
      continue;
    }
    _seenNameKey.add(k);
    rows.push(r);
  }

  if (!rows.length) return { lawdCd, fetched: all.length, inserted: 0 };

  // 500개씩 batch upsert
  let inserted = 0;
  let upsertError = null; // 실패 사유가 로그로만 남아 조용히 유실되던 것 — 반환에 포함(runAptMasterSync 가시성)
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error, count } = await admin
      .from('apt_master')
      .upsert(chunk, { onConflict: 'kapt_code', ignoreDuplicates: true, count: 'exact' });
    if (error) {
      // NAME-UNIQ-DEDUP-2026-07-14 fallback: chunk 실패(사전 dedup 못 잡는 기존 DB 행과의 이름 충돌 등) 시
      //   행별 upsert 로 격리 — 충돌 행만 유실, 나머지 전부 구제. DB-only 라 추가 API 비용 0.
      logger.warn({ err: error.message, lawdCd }, 'apt_master upsert 실패 (chunk) — 행별 fallback');
      if (!upsertError) upsertError = error.message;
      for (const row of chunk) {
        const { error: e1, count: c1 } = await admin
          .from('apt_master')
          .upsert(row, { onConflict: 'kapt_code', ignoreDuplicates: true, count: 'exact' });
        if (!e1) inserted += (c1 ?? 0);
      }
      continue;
    }
    inserted += (count ?? 0);
  }
  return { lawdCd, fetched: rows.length, inserted, ...(upsertError ? { upsertError } : {}) };
}

async function runAptMasterSync() {
  if (!APT_INFO_KEY || APT_INFO_KEY === 'your_molit_api_key') {
    logger.warn('AptInfo API 키 미설정 — apt-master-sync skip');
    return { skipped: true, reason: 'APT_INFO_API_KEY missing' };
  }
  const admin = adminClient();
  const codes = Object.values(LAWD_CODES);
  const started = Date.now();
  const results = [];

  // 동시 5 worker (AptInfo 는 MOLIT 보다 rate limit 여유 — 보통 일 10K 호출 가능)
  const queue = [...codes];
  async function worker() {
    while (queue.length) {
      const code = queue.shift();
      if (!code) break;
      try {
        const r = await syncOneSgg(admin, code);
        results.push(r);
      } catch (e) {
        logger.warn({ err: e.message, code }, 'syncOneSgg 실패');
        results.push({ lawdCd: code, error: e.message });
      }
    }
  }
  await Promise.all(Array.from({ length: 5 }, () => worker()));

  const fetchedTotal = results.reduce((s, r) => s + (r.fetched || 0), 0);
  const insertedTotal = results.reduce((s, r) => s + (r.inserted || 0), 0);
  const errCount = results.filter(r => r.error).length;
  const elapsedMs = Date.now() - started;

  logger.info({
    source: 'apt-master-sync',
    sggs: codes.length,
    fetched: fetchedTotal,
    inserted: insertedTotal,
    errors: errCount,
    elapsedMs,
  }, 'apt-master-sync 완료');

  return { sggs: codes.length, fetched: fetchedTotal, inserted: insertedTotal, errors: errCount, elapsedMs };
}

// TEMP-SYNCHK-2026-07-14 (Sprint IIIII 진단): syncOneSgg 를 targeted 진단 endpoint 에서 재사용 — 검증 후 원복.
module.exports = { runAptMasterSync, syncOneSgg, adminClient };

if (require.main === module) {
  runAptMasterSync()
    .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}
