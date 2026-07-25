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
  const NUM = ['processed', 'inserted', 'failed', 'batches', 'rawPoolSize', 'poolSize',
    'skippedKnownFail', 'sentinelMarked', 'elapsedMs', 'updated', 'scanned', 'gapsFixed'];
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

// _pick 은 "민감 필드가 health 로 새지 않는다"는 보안 성질을 담당하므로 테스트에서 직접 고정한다.
module.exports = { recordCronRun, getCronRuns, getCronLatest, _pick };
