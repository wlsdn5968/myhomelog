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
      logger.warn({ err: e.message, lawdCd, pageNo }, 'AptInfo 페이지 호출 실패');
      break;
    }
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
    const items = body?.items?.item;
    const list = Array.isArray(items) ? items : items ? [items] : [];
    if (!list.length) break;
    all.push(...list);
    if (list.length < PAGE_SIZE) break;
    const total = body?.totalCount != null ? parseInt(body.totalCount, 10) : null;
    if (total != null && all.length >= total) break;
  }

  if (!all.length) return { lawdCd, fetched: 0, inserted: 0 };

  // ON CONFLICT (kapt_code) DO NOTHING — 신규만 INSERT
  const sigunguShort = LAWD_CODE_TO_NAME[lawdCd] || null;
  const rows = all
    .filter(it => it.kaptCode && it.kaptName)
    .map(it => ({
      kapt_code: String(it.kaptCode).trim(),
      apt_name: String(it.kaptName).trim(),
      lawd_cd: lawdCd,
      sigungu: sigunguShort,
      umd_nm: it.as3 ? String(it.as3).trim() : null,
      source: 'aptinfo',
    }));

  if (!rows.length) return { lawdCd, fetched: all.length, inserted: 0 };

  // 500개씩 batch upsert
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error, count } = await admin
      .from('apt_master')
      .upsert(chunk, { onConflict: 'kapt_code', ignoreDuplicates: true, count: 'exact' });
    if (error) {
      logger.warn({ err: error.message, lawdCd }, 'apt_master upsert 실패 (chunk)');
      continue;
    }
    inserted += (count ?? 0);
  }
  return { lawdCd, fetched: rows.length, inserted };
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

module.exports = { runAptMasterSync };

if (require.main === module) {
  runAptMasterSync()
    .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}
