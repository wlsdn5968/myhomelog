/**
 * 한국은행 ECOS 금리 조회 — ECOS-2026-07-13 (Sprint FFFFF, 집사닷컴 벤치마킹 권고 #1)
 *
 * 배경:
 *   - 대출계산기(dc) 기준금리 4% 고정·신용/전세 가정치가 하드코딩 → 시중금리 변동 시 stale.
 *   - 임시 검증 엔드포인트(_ecoschk, b0cce80~6540f80)로 2026-07-13 실호출 검증 후 배선한 코드만 사용:
 *     · 기준금리: KeyStatisticList "한국은행 기준금리" [실측 2.5%, cycle 20260711]
 *     · 주담대 가중평균금리(신규취급액): StatisticSearch 121Y006/M/BECBLA0302 "주택담보대출"
 *       [실측 202603 4.34 · 202604 4.31 · 202605 4.32]
 *   - ⚠ 보금자리론·디딤돌 등 정책자금 금리는 HF/주택도시기금 공시 — ECOS 에 없음(본 서비스 범위 밖).
 *
 * 정책:
 *   - ECOS_API_KEY 미설정/호출 실패 시 null (하드코딩 fallback 없음 — 낡은 값 오표시 방지).
 *   - 12h 캐시(월 단위 통계·기준금리는 변동 드묾). 실패 시 10분 후 재시도.
 */
const dgk = require('./dataGoKrClient'); // RELAY-2026-08-08 (Sprint BBBBBBB): ECOS 도 iad1/icn1 발 타임아웃 실측 — 릴레이 폴백
const cache = require('../cache');
const logger = require('../logger');

const BASE = 'https://ecos.bok.or.kr/api';
const CACHE_KEY = 'ecos:rates:v1';

async function getEcosRates() {
  const hit = cache.get(CACHE_KEY);
  if (hit !== undefined) return hit;
  // REDIS-2026-08-08 (Sprint BBBBBBB-3): hfService 와 동일 — 성공 값 인스턴스 간 공유(동결 취약점 보완).
  try {
    const rHit = await require('./redisCache').rget(CACHE_KEY);
    if (rHit) { cache.set(CACHE_KEY, rHit, 43200); return rHit; }
  } catch (_) { /* Redis 실패는 무시하고 외부 조회 */ }
  const key = process.env.ECOS_API_KEY;
  if (!key) { cache.set(CACHE_KEY, null, 21600); return null; }
  try {
    const now = new Date();
    const ym = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
    const from = new Date(now); from.setMonth(from.getMonth() - 6); // M 통계 공표지연 감안 6개월 창
    const [ksR, mgR] = await Promise.all([
      dgk.get(`${BASE}/KeyStatisticList/${key}/json/kr/1/100`, { timeout: 15000 }),
      dgk.get(`${BASE}/StatisticSearch/${key}/json/kr/1/12/121Y006/M/${ym(from)}/${ym(now)}/BECBLA0302`, { timeout: 15000 }),
    ]);
    const ksRow = (ksR.data && ksR.data.KeyStatisticList && ksR.data.KeyStatisticList.row) || [];
    const baseRow = ksRow.find(r => r.KEYSTAT_NAME === '한국은행 기준금리');
    const mgRows = (mgR.data && mgR.data.StatisticSearch && mgR.data.StatisticSearch.row) || [];
    const mgLast = mgRows[mgRows.length - 1];
    const out = {
      baseRate: baseRow ? parseFloat(baseRow.DATA_VALUE) : null,
      baseRateDate: baseRow ? String(baseRow.CYCLE || '') : null,       // 예: '20260711'
      mortgageRate: mgLast ? parseFloat(mgLast.DATA_VALUE) : null,       // 신규취급 가중평균 주담대(%)
      mortgageRateMonth: mgLast ? String(mgLast.TIME || '') : null,      // 예: '202605'
      source: '한국은행 ECOS',
    };
    if (out.baseRate == null && out.mortgageRate == null) { cache.set(CACHE_KEY, null, 600); return null; }
    cache.set(CACHE_KEY, out, 43200); // 12h
    require('./redisCache').rset(CACHE_KEY, out, 43200).catch(() => {}); // 인스턴스 간 공유 (Sprint BBBBBBB-3)
    // OBSERV-SUCCESS-2026-08-12 (Sprint KKKKKKK-12): **성공도 기록한다.** 실패만 기록하니 health 에
    //   마지막 실패가 영구 잔류해, 값이 정상 유입 중인데도 "며칠째 실패"로 읽혔다(08-10 실제 오판 사례 —
    //   ecos-rates 기록은 08-08 실패인데 그 뒤로 매일 성공하고 있었다). 캐시 히트가 아닌 실제 외부
    //   fetch 성공 지점에만 넣는다 — 캐시 히트에 찍으면 신선도 감시가 다시 거짓말이 된다.
    require('./cronStats').recordCronRun('ecos-rates', { ok: 1 }).catch(() => {});
    return out;
  } catch (e) {
    logger.warn({ err: e.message }, 'ECOS 금리 조회 실패 — null (표시 생략, 10분 후 재시도)');
    // EXT-OBSERV-2026-08-08 (Sprint AAAAAAA): 실패 사유를 health.crons 에 남긴다 — 이 warn 로그는
    //   1시간 뒤 증발해 "왜 null 인지"를 사후 확인할 수 없었다(08-08 ecosRates null 실사고).
    //   ⚠ e.message 는 쓰지 않는다 — ECOS 는 키가 URL 경로에 들어가 메시지에 섞일 수 있다.
    //   상태코드/에러코드만(키 유출 원천 차단).
    const brief = e.response ? `HTTP ${e.response.status}` : String(e.code || 'ERR');
    require('./cronStats').recordCronRun('ecos-rates', { ok: false, error: brief }).catch(() => {});
    cache.set(CACHE_KEY, null, 600);
    return null;
  }
}

module.exports = { getEcosRates, ECOS_CACHE_KEY: CACHE_KEY };
