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
 *   apt_master.kapt_code PRIMARY KEY → ON CONFLICT DO UPDATE (이름·법정동·시군구 갱신).
 *   재실행해도 안전. facility·molit_aliases 는 이 upsert 의 컬럼이 아니라 보존된다.
 *   ⚠ 2026-08-30 이전에는 DO NOTHING 이라 **이름 변경이 영원히 반영되지 않았다**(NAME-REFRESH 주석 참조).
 */
const dgk = require('../services/dataGoKrClient'); // RELAY-2026-08-08 (Sprint BBBBBBB): 직접+Edge 릴레이
const { requireSupabaseAdmin } = require('../db/client');
const logger = require('../logger');
const { LAWD_CODES, LAWD_CODE_TO_NAME } = require('../services/transactionService');

// 공공데이터포털 API (data.go.kr) — AptInfo 전용 키 (별도 발급)
const APT_INFO_KEY = process.env.APT_INFO_API_KEY || process.env.MOLIT_API_KEY;
// 시군구 코드 기반 단지 목록 endpoint (getSigunguAptList3)
// KAPT-V5-2026-08-30 (Sprint OOOOOOO): AptListService3 폐기(400/12) → V4. 응답 필드명 동일(실측).
const APT_LIST_URL = 'https://apis.data.go.kr/1613000/AptListService4/getSigunguAptList4';

const PAGE_SIZE = 100;
const MAX_PAGES = 20;
let _diagLogged = false; // 한 번만 진단 로그 (전체 backfill 동안)

// PACER-2026-08-30 (Sprint OOOOOOO): **워커 공용 페이서.**
//   [무엇이 있었나] 동시성 5 로 KAPT 를 때리자 릴레이가 `upstream HTTP 429` 를 뱉어
//   경기도 시군구 **대부분과 신규 화성 3개 구가 전부 실패**했다. 그런데 요약은 `errors: 0` 이었다 —
//   syncOneSgg 가 페이지 실패 시 break 하고 `{fetched:0, inserted:0}` 을 돌려줘 실패가 집계에서 사라졌다.
//   [왜 동시성이 아니라 속도인가] 429 는 즉시 반환돼 워커가 곧바로 다음 요청을 쏜다 —
//   동시성을 낮춰도 초당 요청수가 안 떨어진다. 건축HUB 백필에서 이미 같은 것을 겪었고
//   답은 **공용 페이서**였다([[br-recap-rate-limit-429]]). 같은 방식을 쓴다.
//   429 를 만나면 간격을 늘려 스스로 물러난다(상한 4s).
const SYNC_MIN_INTERVAL_MS = 250;
let _interval = SYNC_MIN_INTERVAL_MS;
let _nextSlot = 0;
let _throttleHits = 0;
async function pace() {
  const now = Date.now();
  const slot = Math.max(now, _nextSlot);
  _nextSlot = slot + _interval;
  const wait = slot - now;
  if (wait > 0) await new Promise(res => setTimeout(res, wait));
}

// SSOT-2026-08-09 (Plan 007): 자체 createClient → db/client 팩토리
function adminClient() {
  return requireSupabaseAdmin('apt-master-sync 불가');
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
  let _fetchError = null; // PACER-2026-08-30: 페이지 조회 실패 사유(요약에 싣는다)
  // ROBUSTNESS-2026-06-13: 페이지 재시도 상태 — 일시적 5xx 시 break(뒷페이지 전체 유실) 대신 동일 페이지 재시도.
  let _pageRetry = 0;
  const MAX_PAGE_RETRY = 2;
  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
    let r;
    try {
      await pace();
      r = await dgk.get(APT_LIST_URL, {
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
      // PACER-2026-08-30: 429 면 스스로 물러난다(공용 간격을 늘려 전 워커에 적용).
      if (/429/.test(String(e && e.message))) {
        _throttleHits++;
        _interval = Math.min(4000, Math.round(_interval * 1.5) || 400);
      }
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
      // ⚠ 여기서 그냥 break 하면 `{fetched:0}` 이 돼 요약의 errors 에 잡히지 않는다 —
      //   실제로 경기도 전역이 실패했는데 `errors: 0` 으로 보고된 원인이다. 사유를 들고 나간다.
      _fetchError = e.message;
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

  if (!all.length) return { lawdCd, fetched: 0, inserted: 0, ...(_fetchError ? { fetchError: _fetchError } : {}) };

  // NAME-REFRESH-2026-08-30 (Sprint OOOOOOO, 운영자 "동탄파크자이가 아니고 동탄역자이로 바뀐 거 아니야?"):
  //   여기는 오랫동안 `ignoreDuplicates: true`(= ON CONFLICT DO NOTHING) 였다. 그래서 **한 번 들어온
  //   단지의 이름은 KAPT 가 바꿔도 영원히 갱신되지 않았다.**
  //   [실측] KAPT 라이브 kaptCode A10026074 = "동탄역자이 아파트" · 지번 영천동 892
  //          우리 DB           = "동탄파크자이아파트" · 지번 영천동 651-1372
  //          MOLIT 실거래 지번도 **892**(53건) 이고, 네이버 지도도 "동탄역자이아파트 · 영천동 892" 다.
  //          → 바뀐 쪽이 맞고 우리가 안 따라간 것. 3개 독립 출처가 일치한다.
  //   [규모] 전국 시군구 목록(getSigunguAptList4) 122콜 전수 대조: **119곳 중 63곳이 불일치**.
  //          인천 제물포구(44)·영종구(61)는 DB 에 아예 없고, 서해구는 1/135·검단구는 2/128 만 있었다.
  //   → 이름·법정동·시군구는 **갱신한다**. facility·molit_aliases 는 이 upsert 의 컬럼이 아니라 보존된다.
  //   ⚠ uq_apt_master_name_lawd_umd 유니크 제약과 충돌하면 chunk 가 실패하는데, 아래 행별 fallback 이
  //     이미 그 경우를 격리한다(2026-07-14 IIIII 에서 만든 경로를 그대로 탄다).
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

  // RENAME-DETECT-2026-08-30 (Sprint OOOOOOO): **무엇이 바뀌었는지 알 수 있게** 갱신 전 이름을 찍어둔다.
  //   [왜 필요한가] ① 그동안 이 잡은 "몇 건 넣었다"만 반환해 **이름이 바뀐 사실 자체가 보이지 않았다**.
  //     동탄역자이 개명을 3개월 넘게 아무도 몰랐던 이유다.
  //   ② facility(주소·주차·세대수)는 이름과 **같은 KAPT 레코드**에서 온다. 이름이 바뀌었다는 건
  //     그 레코드가 갱신됐다는 뜻인데, facilityBackfill 은 `facility IS NULL`·`_dtl 없음`만 대상으로 삼아
  //     **완전한 레코드는 영원히 재조회하지 않는다**(실측: 동탄 facility 가 2026-07-07 자, 90일 TTL).
  //     그래서 이름은 새 값인데 주소는 옛 값인 상태가 생긴다 → 개명 단지는 facility 를 무효화한다.
  //   ⚠ PostgREST 는 1000행에서 조용히 잘린다(레포 6회 재발) → range 페이징. 최대 지역이 328행이라
  //     한 페이지로 끝나지만, 지역이 커져도 조용히 틀리지 않게 페이징을 둔다.
  const prevName = new Map();
  try {
    for (let from = 0; from <= 4000; from += 1000) {
      const { data: page, error } = await admin
        .from('apt_master').select('kapt_code, apt_name')
        .eq('lawd_cd', lawdCd)
        .order('kapt_code', { ascending: true })
        .range(from, from + 999);
      if (error) throw error;
      for (const r of (page || [])) prevName.set(r.kapt_code, r.apt_name);
      if (!page || page.length < 1000) break;
    }
  } catch (e) {
    logger.warn({ err: e.message, lawdCd }, '개명 감지용 기존 이름 조회 실패 — 이번 회차는 감지 생략');
  }
  const renamed = prevName.size
    ? rows.filter(r => prevName.has(r.kapt_code) && prevName.get(r.kapt_code) !== r.apt_name)
    : [];

  // 500개씩 batch upsert
  let inserted = 0;
  let upsertError = null; // 실패 사유가 로그로만 남아 조용히 유실되던 것 — 반환에 포함(runAptMasterSync 가시성)
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error, count } = await admin
      .from('apt_master')
      .upsert(chunk, { onConflict: 'kapt_code', ignoreDuplicates: false, count: 'exact' });
    if (error) {
      // NAME-UNIQ-DEDUP-2026-07-14 fallback: chunk 실패(사전 dedup 못 잡는 기존 DB 행과의 이름 충돌 등) 시
      //   행별 upsert 로 격리 — 충돌 행만 유실, 나머지 전부 구제. DB-only 라 추가 API 비용 0.
      logger.warn({ err: error.message, lawdCd }, 'apt_master upsert 실패 (chunk) — 행별 fallback');
      if (!upsertError) upsertError = error.message;
      for (const row of chunk) {
        const { error: e1, count: c1 } = await admin
          .from('apt_master')
          .upsert(row, { onConflict: 'kapt_code', ignoreDuplicates: false, count: 'exact' });
        if (!e1) inserted += (c1 ?? 0);
      }
      continue;
    }
    inserted += (count ?? 0);
  }
  // RENAME-DETECT-2026-08-30: 개명 단지는 facility 도 옛 KAPT 레코드다 → 재조회 대상으로 표시.
  //   facility 값 자체는 지우지 않는다(지우면 그 사이 카드에서 세대수·주차가 사라진다) —
  //   `facility_fetched_at = null` 로만 표시하고 facilityBackfill 이 그걸 보고 다시 받아간다.
  let renamedMarked = 0;
  if (renamed.length) {
    const codes = renamed.map(r => r.kapt_code);
    for (let i = 0; i < codes.length; i += 200) {
      const { error } = await admin.from('apt_master')
        .update({ facility_fetched_at: null }).in('kapt_code', codes.slice(i, i + 200));
      if (error) { logger.warn({ err: error.message, lawdCd }, '개명 단지 facility 무효화 실패'); break; }
      renamedMarked += Math.min(200, codes.length - i);
    }
    logger.info({
      lawdCd, renamed: renamed.length, marked: renamedMarked,
      samples: renamed.slice(0, 5).map(r => `${prevName.get(r.kapt_code)} → ${r.apt_name}`),
    }, 'apt_master 단지명 변경 감지');
  }
  return {
    lawdCd, fetched: rows.length, inserted,
    renamed: renamed.length,
    ...(_fetchError ? { fetchError: _fetchError } : {}),
    ...(upsertError ? { upsertError } : {}),
  };
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

  // DEADLINE-2026-08-28 (Plan 032): 다른 backfill job(molitIngest·facility·geocache·buildingRegister)
  //   과 동일한 maxDuration(300s) 보호. AptInfo 가 느려지면 지역 루프가 300s 를 넘겨 임의 시점에
  //   잘린다. syncOneSgg 는 upsert 기반(멱등)이라 남은 큐는 다음 run 이 그대로 이어받는다.
  const HARD_DEADLINE = started + 250000;

  // 동시 5 worker (AptInfo 는 MOLIT 보다 rate limit 여유 — 보통 일 10K 호출 가능)
  const queue = [...codes];
  async function worker() {
    while (queue.length) {
      if (Date.now() > HARD_DEADLINE) break; // maxDuration 보호 — 남은 큐는 다음 run 이 이어받음(멱등)
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
  const errCount = results.filter(r => r.error || r.fetchError).length;
  const renamedTotal = results.reduce((s2, r) => s2 + (r.renamed || 0), 0);
  const failedLawds = results.filter(r => r.error || r.fetchError).map(r => r.lawdCd);
  const elapsedMs = Date.now() - started;

  logger.info({
    source: 'apt-master-sync',
    sggs: codes.length,
    fetched: fetchedTotal,
    inserted: insertedTotal,
    errors: errCount,
    renamed: renamedTotal,
    throttleHits: _throttleHits,
    intervalMs: _interval,
    failedLawds: failedLawds.slice(0, 40),
    elapsedMs,
    remaining: queue.length,   // >0 이면 데드라인에 걸려 중단됐다는 뜻 — 다음 run 이 이어받는다
  }, 'apt-master-sync 완료');

  return {
    sggs: codes.length, fetched: fetchedTotal, inserted: insertedTotal,
    errors: errCount, renamed: renamedTotal, throttleHits: _throttleHits,
    intervalMs: _interval, failedLawds: failedLawds.slice(0, 40),
    elapsedMs, remaining: queue.length,
  };
}

module.exports = { runAptMasterSync };

if (require.main === module) {
  runAptMasterSync()
    .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}
