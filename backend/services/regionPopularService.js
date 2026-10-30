'use strict';
/**
 * REGION-TOP10-2026-10-21 (운영자 요청): 서울 25개 구·경기 시군구(구 단위)마다 "최근 60일 거래가 많은 단지 TOP10".
 *
 * [왜] 전국 인기 12곳은 한 시군구 2곳 상한·21일 필터 때문에 지방 신축이 섞이고 서울이 0곳인 날이 있다
 *   (운영자 "서울이 아예 없으니 허접해 보인다"). 사람들은 "노원구 거래 많은 단지", "수원시 영통구"처럼 구 단위로 본다.
 * [어떻게] 새 표·새 DB 함수 없이 — 시군구마다 molit_transactions 의 60일 거래를 인덱스(lawd_cd, deal_date)로 읽어
 *   서버에서 센다. 서울 25회·경기 47회 조회(지역당 대개 1페이지). 매일 retention cron(ingest 1시간 뒤)에서 계산해
 *   computed_snapshots 에 시도별 한 행으로 둔다. 요청은 메모리 → 스냅샷(36시간) → 즉석 계산 순.
 * [같은 단지 쪼개짐 방지] 신고 이름이 "풍림아파트A·B" 처럼 갈라진 단지는 별칭(apt_master.molit_aliases)으로
 *   정식 단지 이름에 합친다(getAliasCanonicalMap — 추천·알림과 같은 규칙). 거래 건수도 합산된다.
 * [좌표] apt_geocache 의 (이름, 시군구, 동) 정확 키. 근거가 약한 좌표(검증 전 키워드 검색이고 장소 이름에 단지 이름이
 *   없는 것 — 2026-10-21 실측 514건, 예: "엘리스"→수제화 가게)는 쓰지 않는다 — 틀린 자리에 핀을 찍느니 목록에만 둔다.
 */
const logger = require('../logger');
const { getSupabaseAdmin } = require('../db/client');
const { LAWD_CODES, RETIRED_LAWD_CODES, getAliasCanonicalMap, aliasCanon } = require('./transactionService');
const { regionLabel } = require('./priceRecordsService');
const { isUnnamedApt, displayAptName } = require('../utils/aptDisplayName');
const { isValidKoreaCoord } = require('../utils/geo');
const { getSnapshot, putSnapshot } = require('./snapshotStore');

const WINDOW_DAYS = 60;
const TOP_N = 10;
const BURST_DAY = 10; // 한 단지 하루 거래가 이 이상이면 일괄 신고로 보고 순위에서 2건으로 센다
// REGION-ALL-SIDO-2026-10-21 (운영자 "서울·경기 등등 구별로 TOP5"): 실거래를 적재하는 시도 전부(2026-10-21 실측 9곳 —
//   molit_transactions 의 lawd_cd 앞 2자리와 LAWD_CODES 가 같은 범위). 광주(29)는 적재 대상이 아니라 없다.
const SIDOS = { '11': '서울', '41': '경기', '28': '인천', '26': '부산', '27': '대구', '30': '대전', '31': '울산', '36': '세종', '43': '충북' };
const CRON_BUDGET_MS = 150000; // retention 의 다른 일(경신 워밍·브리핑·금리)이 남도록 — 넘으면 남은 시도는 요청 때 즉석 계산
const SNAP_KEY = (sido) => `popular:region:v5:${sido}`; // v5: 일괄 등기 단지 제외·BURST-CAP(하루 10건 이상)·JIBUN-ALIAS(2026-10-21)

const _cleanName = (n) => String(n || '').replace(/^[가-힣0-9]{1,8}(동|리|가),\s*/, '');
const _core = (n) => String(n || '').replace(/\s+/g, '').replace(/\([^)]*\)/g, '').replace(/(아파트|APT)$/i, '').toLowerCase();
// 이름 합치기용 — 괄호 안(건설사·동 번호)을 남긴다: "후곡마을(대창)" ↔ "후곡마을(동양)" 은 다른 단지(2026-10-21 실측)
const _mergeCore = (n) => String(n || '').replace(/\s+/g, '').replace(/[()]/g, '').replace(/(아파트|APT)$/i, '').toLowerCase();

/** 시도 앞 2자리 → 그 시도의 현행 시군구 코드(이름순 아님, 코드순) */
function lawdsOfSido(sido) {
  return [...new Set(Object.values(LAWD_CODES))]
    .filter((c) => String(c).startsWith(sido) && !RETIRED_LAWD_CODES.has(String(c)))
    .sort();
}

/** 근거 있는 좌표인가 — 검증된 출처(kakao-v·kakao-addr 등)이거나, 키워드 검색이라도 장소 이름에 단지 이름이 들어 있을 때 */
function trustedCoord(c, aptName) {
  if (!c || !isValidKoreaCoord(Number(c.lat), Number(c.lng))) return false;
  if (c.source === 'kakao-x') return false; // NAME-HEAL-2026-10-22: 재검색 실패 + 가게·시설 자리
  if (c.source !== 'kakao' && c.source !== 'kakao-sub') return true;
  const core = _core(aptName);
  return !!(core && c.place_name && String(c.place_name).replace(/\s+/g, '').toLowerCase().includes(core));
}

async function _fetchLawdDeals(admin, lawd, sinceIso) {
  const rows = [];
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await admin.from('molit_transactions')
      .select('apt_name, sigungu, umd_nm, lawd_cd, apt_seq, build_year, deal_date, deal_amount, jibun')
      .eq('lawd_cd', lawd).gte('deal_date', sinceIso)
      .order('deal_date', { ascending: false }).order('id', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`${lawd}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

/** 한 시군구의 60일 TOP N(별칭 합침). 좌표는 아직 없음. */
// JIBUN-ALIAS-2026-10-21: 한 단지가 건설사별 이름으로 나뉘어 신고되는데(벽적골우성·벽적골두산·벽적골한신 — 지번 973-3,
//   공동주택 정보 "벽적골두산한신우성" 1,842세대) 별칭 함수는 건축년도 = 사용승인 연도를 요구해 1998년인 우성만 빠졌다.
//   전국 11쌍(서울·경기 7). 같은 동·같은 지번에 별칭으로 묶인 이름이 있고, 건축년도 차 1년 이내이며, 이 이름이 정식 이름의
//   글자 순서 부분열(벽적골우성 ⊂ 벽적골두산한신우성)일 때만 같은 정식 이름으로 본다. 근본 수정(별칭 함수)은 plans/169 §7.
function _isSubseq(a, b) { let i = 0; for (const ch of b) { if (ch === a[i]) i++; if (i === a.length) return true; } return a.length === 0; }
function jibunAliases(rows, aliasMap) {
  const anchor = new Map();   // umd|jibun → { canon, year }
  for (const t of rows) {
    if (!t.jibun) continue;
    const canon = aliasCanon(aliasMap, t.apt_name, t.umd_nm, t.build_year); // ALIAS-YEAR-2026-10-30 (Plan 178): 연도 별칭은 그 준공 연도 행만
    if (canon) anchor.set(`${t.umd_nm || ''}|${t.jibun}`, { canon, year: Number(t.build_year) || 0 });
  }
  const out = new Map();      // apt_name|umd → canon
  for (const t of rows) {
    const k = `${t.apt_name}|${t.umd_nm || ''}`;
    if (!t.jibun || aliasCanon(aliasMap, t.apt_name, t.umd_nm, t.build_year) || out.has(k)) continue;
    const a = anchor.get(`${t.umd_nm || ''}|${t.jibun}`);
    if (!a || Math.abs((Number(t.build_year) || 0) - a.year) > 1) continue;
    const raw = _mergeCore(_cleanName(t.apt_name)), canonC = _mergeCore(a.canon);
    if (raw.length >= 2 && raw !== canonC && _isSubseq(raw, canonC)) out.set(k, a.canon);
  }
  return out;
}

function rankLawd(rows, aliasMap, n = TOP_N) {
  const jAlias = jibunAliases(rows, aliasMap);
  const g = new Map();
  for (const t of rows) {
    const raw = _cleanName(t.apt_name);
    if (!raw) continue;
    const canon = aliasCanon(aliasMap, t.apt_name, t.umd_nm, t.build_year) || jAlias.get(`${t.apt_name}|${t.umd_nm || ''}`) || raw;
    const k = `${canon}|${t.umd_nm || ''}`;
    let e = g.get(k);
    if (!e) {
      e = { aptName: canon, sigungu: t.sigungu, umdNm: t.umd_nm, lawdCd: t.lawd_cd, buildYear: t.build_year,
        recentDealDate: t.deal_date, dealCount60d: 0, _sum: 0, _raws: new Set(), _perDay: new Map(), _seqC: null, _seqCD: '', _seqA: null, _seqAD: '' };
      g.set(k, e);
    }
    e.dealCount60d += 1;
    e._sum += Number(t.deal_amount) || 0;
    e._perDay.set(String(t.deal_date), (e._perDay.get(String(t.deal_date)) || 0) + 1);
    e._raws.add(raw);
    if (String(t.deal_date) > String(e.recentDealDate)) e.recentDealDate = t.deal_date;
    // 단지 번호: 정식 이름으로 신고된 거래 중 가장 최근 것 우선, 없으면 별칭 거래 중 가장 최근 것
    if (t.apt_seq) {
      const d = String(t.deal_date);
      if (raw === canon) { if (d >= e._seqCD) { e._seqC = t.apt_seq; e._seqCD = d; } }
      else if (d >= e._seqAD) { e._seqA = t.apt_seq; e._seqAD = d; }
    }
  }
  // BURST-CAP-2026-10-21: 순위는 "하루 2건까지만 센 건수" — 신축 일괄 등기처럼 60일 거래가 전부 하루에 몰린 곳
  //   (서울 실측: 미가마하나임 30건·스마트휴 29건·도무스서초청년주택 22건·상봉생활 21건, 모두 거래일 1일)이 1위를 차지했다.
  //   일반 단지는 하루 최대 2건(은마 14건/10일). 화면의 "거래 N건"은 실제 건수 그대로 둔다.
  // NAME-MERGE-2026-10-21: 별칭이 없는 이름 변경(과천 "래미안슈르" ↔ "과천래미안슈르")은 같은 동·같은 건축년도·이름 핵심이 서로 포함·
  //   숫자(단지 번호·차수)가 같을 때 합친다. 건축년도 조건이 "현대" ↔ "현대힐스테이트" 같은 다른 단지 오합침을 막는다.
  const merged = [];
  for (const e of [...g.values()].sort((a, b) => b.dealCount60d - a.dealCount60d)) {
    const c = _mergeCore(e.aptName), d = c.replace(/[^0-9]/g, '');
    const host = c.length >= 2 && e.buildYear && merged.find((k) => {
      if (k.umdNm !== e.umdNm || Number(k.buildYear) !== Number(e.buildYear)) return false;
      const kc = _mergeCore(k.aptName);
      return kc.replace(/[^0-9]/g, '') === d && (kc.includes(c) || c.includes(kc));
    });
    if (!host) { merged.push(e); continue; }
    host.dealCount60d += e.dealCount60d; host._sum += e._sum;
    for (const r of e._raws) host._raws.add(r);
    for (const [day, n] of e._perDay) host._perDay.set(day, (host._perDay.get(day) || 0) + n);
    if (String(e.recentDealDate) > String(host.recentDealDate)) host.recentDealDate = e.recentDealDate;
    if (!host._seqC && e._seqC) { host._seqC = e._seqC; host._seqCD = e._seqCD; }
    if (!host._seqA && e._seqA) { host._seqA = e._seqA; host._seqAD = e._seqAD; }
  }
  // BURST-CAP 보정(2026-10-21 운영 실측): 일반 단지도 하루 5~9건이 있다(벽적골우성 5·매교역푸르지오SKVIEW 8). 일괄 신고는 하루 18~36건이
  //   단 하루에 몰린다(미가마하나임 30·도무스서초청년주택 22·파주금촌금호어울림 18). 하루 10건 이상인 날만 2건으로 센다 —
  //   그 밖에는 순위 건수 = 화면 건수(하루 2건 상한은 월계동신 16건이 6위로 보이는 어긋남을 만들었다).
  for (const e of merged) {
    let r = 0, burst = 0;
    for (const c of e._perDay.values()) { if (c >= BURST_DAY) { r += 2; burst += c; } else r += c; }
    e._rankN = r; e._burstShare = e.dealCount60d ? burst / e.dealCount60d : 0;
  }
  // 거래의 절반 이상이 일괄 신고일인 단지(신축 일괄 등기 — 도무스서초청년주택 22건 전부 하루)는 "거래 많은 단지"가 아니다 → 빼고 고른다
  return merged
    .filter((e) => !isUnnamedApt(e.aptName) && e._burstShare < 0.5)
    .sort((a, b) => b._rankN - a._rankN || b.dealCount60d - a.dealCount60d || String(b.recentDealDate).localeCompare(String(a.recentDealDate)))
    .slice(0, n)
    .map(({ _seqC, _seqCD, _seqA, _seqAD, _perDay, _rankN, _burstShare, ...e }) => ({ ...e, aptSeq: _seqC || _seqA || null, avgDealAmount: Math.round(e._sum / e.dealCount60d), _raws: [...e._raws] }));
}

async function _attachCoords(admin, items) {
  const names = [...new Set(items.flatMap((e) => [e.aptName, ...e._raws]))];
  const coords = new Map();
  for (let i = 0; i < names.length; i += 200) {
    const { data } = await admin.from('apt_geocache')
      .select('apt_name, sigungu, umd_nm, lat, lng, source, place_name').in('apt_name', names.slice(i, i + 200));
    for (const c of (data || [])) coords.set(`${c.apt_name}|${c.sigungu || ''}|${c.umd_nm || ''}`, c);
  }
  for (const e of items) {
    let hit = null;
    for (const nm of [e.aptName, ...e._raws]) {
      const c = coords.get(`${nm}|${e.sigungu || ''}|${e.umdNm || ''}`);
      if (c && trustedCoord(c, nm)) { hit = c; break; }
    }
    e.lat = hit ? Number(hit.lat) : null;
    e.lng = hit ? Number(hit.lng) : null;
  }
}

/** 시도 하나 계산 — { sido, window, groups:[{lawdCd,label,deals60d,results}] } */
async function computeSido(sido, { concurrency = 6 } = {}) {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('DB 미설정');
  if (!SIDOS[sido]) throw new Error('지원하지 않는 시도');
  const until = new Date();
  const since = new Date(until.getTime() - WINDOW_DAYS * 86400e3);
  const sinceIso = since.toISOString().slice(0, 10);
  const lawds = lawdsOfSido(sido);
  let aliasMap = new Map();
  try { aliasMap = await getAliasCanonicalMap(lawds); } catch (e) { logger.warn({ err: e.message }, 'region top10: 별칭 맵 실패 — 신고 이름 그대로'); }

  const groups = new Array(lawds.length);
  let i = 0, failed = 0;
  async function worker() {
    while (i < lawds.length) {
      const idx = i++; const lawd = lawds[idx];
      try {
        const rows = await _fetchLawdDeals(admin, lawd, sinceIso);
        const top = rankLawd(rows, aliasMap);
        await _attachCoords(admin, top);
        groups[idx] = {
          lawdCd: lawd, label: regionLabel(lawd, ''), deals60d: rows.length,
          results: top.map(({ _sum, _raws, ...r }) => ({
            ...r, aptName: r.aptName, displayName: displayAptName(r.aptName, { umdNm: r.umdNm }),
          })),
        };
      } catch (e) {
        failed += 1;
        logger.warn({ err: e.message, lawd }, 'region top10: 시군구 계산 실패(건너뜀)');
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const ok = groups.filter(Boolean);
  return {
    sido, sidoName: SIDOS[sido],
    window: { days: WINDOW_DAYS, since: sinceIso, until: until.toISOString().slice(0, 10) },
    groups: ok, failed, computedAt: until.toISOString(),
  };
}

/** cron: 시도별 계산·저장. 시군구 실패가 절반을 넘으면 저장하지 않는다(어제 값 유지). */
async function computeAndStoreAll() {
  const out = {}; const t0 = Date.now();
  for (const sido of Object.keys(SIDOS)) {
    if (Date.now() - t0 > CRON_BUDGET_MS) { out[sido] = 'skip(time)'; continue; }
    try {
      const p = await computeSido(sido);
      const total = lawdsOfSido(sido).length;
      if (p.groups.length >= Math.ceil(total / 2)) { await putSnapshot(SNAP_KEY(sido), p); out[sido] = p.groups.length; }
      else out[sido] = `skip(${p.groups.length}/${total})`;
    } catch (e) { out[sido] = `err:${e.message}`; }
  }
  out.ms = Date.now() - t0;
  return out;
}

async function readSido(sido) {
  const s = await getSnapshot(SNAP_KEY(sido), 36 * 3600e3);
  return s ? s.payload : null;
}

module.exports = { jibunAliases, computeSido, computeAndStoreAll, readSido, lawdsOfSido, rankLawd, trustedCoord, SIDOS, SNAP_KEY };
