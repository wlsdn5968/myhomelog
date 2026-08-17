/**
 * cron 실행 결과 기록 — CRON-OBSERV-2026-07-25 (Sprint XXXXXX)
 *
 * [왜 만드나 — 실제로 겪은 관측 불가]
 *   좌표 백필이 07-13~24 사이 사실상 정체(cron 창 신규 0~38건, 대부분 한 자릿수)했는데,
 *   **왜 그랬는지 사후에 확인할 방법이 없었다**:
 *     - Vercel Hobby 런타임 로그 보존 = 1시간. cron 은 하루 1회(04:00 UTC).
 *       → 실행 로그를 보려면 그 1시간 안에 사람이 봐야 한다 = 사실상 영원히 못 본다.
 *     - job 은 rawPoolSize·poolSize·skippedKnownFail·inserted·sentinelMarked 같은 좋은 진단값을
 *       이미 계산해 로그로 남기는데, 그게 그대로 증발했다.
 *   그래서 원인 추적을 DB 행 카운트(cached_at 집계)로 대신할 수밖에 없었고, 그마저 사용자
 *   온디맨드 지오코딩과 섞여 cron 만의 성과를 분리하기 어려웠다.
 *
 * [설계]
 *   - **DB 스키마 변경 0** — 이미 쓰고 있는 Upstash Redis 에만 기록(신규 인프라·비용 0).
 *   - 최근 N회만 보관(기본 14 = 2주치). 실패해도 cron 본체에 영향 없게 전부 삼킨다(fail-open).
 *   - Redis 미설정이면 조용히 no-op → 로컬·테스트 환경 동작 불변.
 *
 * ⚠ 값은 그대로 저장하지 말고 화이트리스트로 골라 담는다 — job summary 에 나중에 민감한 필드가
 *   섞여도 새어나가지 않게. (health 로 노출되는 경로가 있으므로)
 */
const { getRedis } = require('../redis');

const KEY = 'cronstat:v1';
const KEEP = 14;

/** summary 에서 관측에 필요한 수치만 뽑는다(문자열은 길이 제한). */
function _pick(summary) {
  if (!summary || typeof summary !== 'object') return {};
  // MOLIT-OBSERV-2026-08-08 (Sprint AAAAAAA): molit-ingest 계열 카운터(ok·err·skipped·gap 채움) 추가.
  //   ok 가 숫자면 여기서 통과, boolean false 면 아래 실패 표기 분기 — 두 의미가 충돌하지 않는다.
  // GEO-VERIFY-OBSERV-2026-08-10 (Sprint KKKKKKK-3): 좌표 검증·교정 스윕(verifyByOfficialAddress)과
  //   reheal 의 성과가 여기 화이트리스트에 없어 health 로 전혀 보이지 않았다 — run 이 객체
  //   ({reheal},{addrVerify})로 돌려주는데 _pick 은 숫자만 통과시키기 때문. 오염 좌표 948건이
  //   며칠에 걸쳐 실제로 줄고 있는지 측정할 수단이 없어 튜닝이 추측이 된다. 평탄화 키를 추가한다.
  const NUM = ['processed', 'inserted', 'failed', 'batches', 'rawPoolSize', 'poolSize',
    'skippedKnownFail', 'sentinelMarked', 'elapsedMs', 'updated', 'scanned', 'gapsFixed',
    'ok', 'err', 'skipped', 'retried', 'filled', 'missed', 'addrTried', 'addrInserted',
    'verifyTried', 'verifyOk', 'verifyFixed', 'verifyNoAddr', 'verifyMs',
    // FAST-VERIFY-2026-08-10 (Sprint KKKKKKK-10): Kakao 무호출 통과분 / 이번 run 이 집은 행 수.
    'verifyFast', 'verifyRows',
    'rehealTried', 'rehealHealed', 'rehealMarked',
    // ZERO-FETCH-WATCH-2026-08-10 (Sprint KKKKKKK-4): 지역 단위 적재 중단 감시.
    'slot', 'regionsCount', 'zeroFetchRegions',
    // SEARCH-MV-2026-08-16 (Sprint TTTTTTT): 검색용 MV 갱신 소요. 이 값이 사라지면(=필드 부재)
    //   적재는 되는데 검색 인덱스가 안 도는 상태다 — 새 거래가 자동완성에 안 잡히므로 관측이 필요하다.
    'mvRefreshMs',
    // HH-BR-WRITEBACK-2026-08-17 (Sprint MMMMMMM-23): 건축물대장 세대수가 apt_master 로 실제 합류했는지.
    //   이 값이 0에 머물면 "수집은 되는데 화면엔 여전히 미상" 상태가 재현된 것이다.
    'brScanned', 'brWritten', 'brAmbiguous'];
  const out = {};
  for (const k of NUM) {
    const v = summary[k];
    // ⚠ `Number(v)` 로 바로 가면 안 된다 — Number(null)·Number('') 는 **0** 이라
    //   "보고되지 않음"이 "0건"으로 둔갑한다. 백필이 진짜 0건인지 필드가 없는 건지
    //   구별 못 하면 이 기록을 남기는 의미 자체가 없어진다(테스트로 고정).
    if (typeof v !== 'number' && typeof v !== 'string') continue;   // null·undefined·boolean·객체 배제
    if (typeof v === 'string' && v.trim() === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) out[k] = n;
  }
  if (summary.ok === false) out.ok = false;
  if (typeof summary.error === 'string') out.error = summary.error.slice(0, 120);
  // 적재 0건 지역의 lawd_cd 목록 — 숫자가 아니라 콤마 문자열이라 위 NUM 루프를 못 탄다.
  //   법정동 시군구 코드는 공개 정보라 민감하지 않다(error 와 동일하게 길이만 제한).
  if (typeof summary.zeroFetchLawds === 'string' && summary.zeroFetchLawds.trim()) {
    out.zeroFetchLawds = summary.zeroFetchLawds.slice(0, 120);
  }
  return out;
}

/**
 * cron 1회 실행 결과 기록. 절대 throw 하지 않는다(cron 본체 보호).
 * @param {string} name  잡 이름 (예: 'geocache-backfill')
 * @param {object} summary  job 이 돌려준 요약
 */
async function recordCronRun(name, summary) {
  try {
    const r = getRedis();
    if (!r) return;
    const entry = { name: String(name || '').slice(0, 40), at: new Date().toISOString(), ..._pick(summary) };
    const prev = (await r.get(KEY)) || {};
    const list = Array.isArray(prev[entry.name]) ? prev[entry.name] : [];
    list.unshift(entry);
    prev[entry.name] = list.slice(0, KEEP);
    // TTL 30일 — 방치돼도 스스로 사라진다(관측용 데이터를 영구 보관할 이유 없음).
    await r.set(KEY, prev, { ex: 30 * 24 * 3600 });
  } catch (_) { /* 관측 실패가 본 작업을 막아선 안 된다 */ }
}

/** 잡별 최근 실행 이력. 실패 시 null. */
async function getCronRuns() {
  try {
    const r = getRedis();
    if (!r) return null;
    return (await r.get(KEY)) || null;
  } catch (_) { return null; }
}

/** 잡별 **최근 1회**만 요약 — health 노출용(응답 비대화 방지). */
async function getCronLatest() {
  const all = await getCronRuns();
  if (!all) return null;
  const out = {};
  for (const [name, list] of Object.entries(all)) {
    if (Array.isArray(list) && list[0]) out[name] = list[0];
  }
  return Object.keys(out).length ? out : null;
}

/**
 * CRON-STALE-2026-08-17 (Sprint MMMMMMM-12): "안 돈 cron" 을 감지한다.
 *
 * [왜 필요한가 — 2026-08-16 실측]
 *   그날 geocache-backfill(04:00) · building-register-backfill(06:00) · retention(18:00) 세 cron 의
 *   실행 기록이 **통째로 없었다**. 그런데 Sentry 의 cron 오류도 0건이었다.
 *   즉 "실패한 것"이 아니라 "아예 안 돈 것"인데, 우리에겐 그걸 알아차릴 수단이 하나도 없었다.
 *   health.crons 는 **마지막 성공 시각만** 보여주므로 사람이 날짜를 직접 빼서 비교해야만 보인다.
 *   좌표 백필이 조용히 멈추면 지도 핀이 그대로 늙는다 — 같은 부류의 사고를 이 저장소는
 *   이미 여러 번 겪었다(광주 44일 무적재).
 *
 * [기준값을 왜 50h 로 잡았나]
 *   Vercel Hobby cron 은 정시가 아니다 — 같은 날 실측에서 05:00 예정이 05:08, 17:30 예정이 17:34 에
 *   기록됐다. 26h(=1회 누락)로 잡으면 이 지터와 배포 타이밍만으로도 경보가 뜬다.
 *   **2회 연속 누락**을 기준으로 삼아 오탐을 줄인다. 주 1회 잡은 2회면 15일이라 너무 늦어 10일로 둔다.
 */
const CRON_MAX_AGE_H = {
  'retention': 50,
  'popular-snapshot': 50,          // 별도 cron 경로 없음 — retention 안에서 계산·기록된다
  'molit-ingest': 50,
  'apt-master-sync': 240,          // 주 1회(월 20:00 UTC) — 10일
  'regulations-check': 50,
  'regulations-auto-fetch': 50,
  'audit-prune': 50,
  'geocache-backfill': 50,
  'facility-backfill': 50,
  'building-register-backfill': 50,
  'push-notify': 50,
};

/**
 * vercel.json 의 cron path → 그 요청이 남기는 잡 이름(들).
 * ⚠ 이 맵과 vercel.json 은 **계약 테스트로 묶여 있다**. cron 을 추가·삭제하면 여기도 고쳐야 하고,
 *   안 고치면 테스트가 막는다 — 새 cron 이 감시 대상에서 조용히 빠지는 것을 원천 차단한다.
 *   (molit-ingest 는 슬롯 3개가 같은 이름 하나로 기록된다 — 최신 1회만 남는 구조.)
 */
const CRON_PATH_TO_JOBS = {
  '/api/cron/retention': ['retention', 'popular-snapshot'],
  '/api/cron/molit-ingest': ['molit-ingest'],
  '/api/cron/apt-master-sync': ['apt-master-sync'],
  '/api/cron/regulations-check': ['regulations-check'],
  '/api/cron/regulations-auto-fetch': ['regulations-auto-fetch'],
  '/api/cron/audit-prune': ['audit-prune'],
  '/api/cron/geocache-backfill': ['geocache-backfill'],
  '/api/cron/facility-backfill': ['facility-backfill'],
  '/api/cron/building-register-backfill': ['building-register-backfill'],
  '/api/cron/push-notify': ['push-notify'],
};

/**
 * 기대 주기를 넘긴 잡을 찾는다. 순수 함수(테스트에서 직접 고정).
 * @param {object|null} latest  getCronLatest() 결과 — { [job]: { at, ... } }
 * @param {number} nowMs
 * @returns {{ stale: Array<{job,ageH,lastAt}>, never: string[] }}
 *   never = 기록이 한 번도 없는 잡. ⚠ **경보로 올리지 않는다** — 이 기능을 막 배포한 직후엔
 *   아직 한 번도 안 돈 잡이 정상적으로 여기 들어오기 때문이다(오탐). 진단용으로만 함께 싣는다.
 *   기존 checkIngestFreshness 의 "판단 불가 시 침묵" 원칙과 같은 결정이다.
 */
function findStaleCrons(latest, nowMs) {
  const stale = [], never = [];
  for (const [job, maxH] of Object.entries(CRON_MAX_AGE_H)) {
    const rec = latest && latest[job];
    const at = rec && rec.at ? Date.parse(rec.at) : NaN;
    if (!Number.isFinite(at)) { never.push(job); continue; }
    const ageH = (nowMs - at) / 3600000;
    if (ageH > maxH) stale.push({ job, ageH: Math.round(ageH), lastAt: rec.at });
  }
  return { stale, never };
}

/**
 * REGION-FRESHNESS-2026-08-17 (Sprint MMMMMMM-22): **지역 단위** 적재 중단 판정. 순수 함수.
 *
 * [왜 필요한가 — 이 저장소가 두 번 겪은 사고]
 *   · 광주 5개 구 44일 무적재(2026-06-27~) — 행정구역 통합으로 옛 코드에 빈 응답
 *   · 인천 중구·동구·서구 45일 무적재(2026-06-26~) — 완전히 같은 메커니즘
 *   둘 다 HTTP 200 · rows_fetched=0 이라 status='ok' 였고 오류 카운터에 잡히지 않았다.
 *
 * [기존 감시 두 개로는 원리적으로 못 잡는다]
 *   · checkIngestFreshness 는 **전역 MAX(ingested_at)** 하나만 본다 — 121곳 중 1곳만 살아 있어도 신선.
 *   · ZERO-FETCH-WATCH 는 health.crons 에 숫자만 올리고 경보가 없다. 게다가 molit-ingest 는
 *     slot 3개로 나뉘어 한 회차 기록엔 지역의 1/3 만 담긴다.
 *
 * [임계 30일의 근거 — 2026-08-17 전국 전수 실측]
 *   거래 이력이 있는 121개 지역의 "마지막 거래일로부터 경과일" 분포:
 *     ≤7일 **113곳** · 8~14일 4곳 · 15~30일 1곳(과천 20일) · 30일 초과 3곳
 *   30일 초과 3곳은 전부 폐지된 인천 옛 구(28110·28140·28260)로 **정상값**이다.
 *   → 30일이면 현재 오탐 0 이고, 위 두 사고(44일·45일)는 둘 다 잡힌다.
 *   여유가 가장 적은 정상 지역은 과천(20일)이라 10일치 완충이 남는다.
 *
 * @param {object} latestByCode  { [lawdCd]: 'YYYY-MM-DD' | null }  null = 거래 이력이 한 번도 없음
 * @param {Set<string>} retired  폐지 코드(신규 적재가 없는 것이 정상) — transactionService 가 소유
 * @returns {{ stale: Array<{lawdCd,lastDealDate,days}>, never: string[] }}
 *   never 는 **경보로 올리지 않는다** — 옹진군(28720)처럼 원래 아파트 거래가 없는 지역이 여기 들어온다
 *   (실측: LAWD_CODES 122개 중 거래 이력이 있는 곳은 121개). findStaleCrons 의 never 와 같은 원칙이다.
 */
const REGION_STALE_DAYS = 30;

function pickStaleRegions(latestByCode, retired, nowMs, staleDays) {
  const limitDays = Number.isFinite(staleDays) ? staleDays : REGION_STALE_DAYS;
  const stale = [], never = [];
  for (const [code, d] of Object.entries(latestByCode || {})) {
    if (retired && typeof retired.has === 'function' && retired.has(code)) continue;
    if (!d) { never.push(code); continue; }
    // deal_date 는 날짜형(YYYY-MM-DD) — UTC 자정으로 고정해 서버 TZ 에 좌우되지 않게 한다.
    const t = Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`);
    if (!Number.isFinite(t)) continue;      // 판독 불가 → 침묵(오탐 방지)
    const days = Math.floor((nowMs - t) / 86400000);
    if (days > limitDays) stale.push({ lawdCd: code, lastDealDate: String(d).slice(0, 10), days });
  }
  stale.sort((a, b) => b.days - a.days);
  return { stale, never };
}

// _pick 은 "민감 필드가 health 로 새지 않는다"는 보안 성질을 담당하므로 테스트에서 직접 고정한다.
module.exports = {
  recordCronRun, getCronRuns, getCronLatest, _pick,
  CRON_MAX_AGE_H, CRON_PATH_TO_JOBS, findStaleCrons,
  REGION_STALE_DAYS, pickStaleRegions,
};
