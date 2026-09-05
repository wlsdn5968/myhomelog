/**
 * 인기 단지 집계 서비스 (Sprint LLLL, 2026-07-11)
 *
 * 배경 (전부 라이브 실측):
 *   - /api/search/popular 는 전국 60일 거래량 RPC(search_popular_apts) + 품질 후처리(GGGG:
 *     21일 지속거래·lawd_cd당 2곳 캡) + 좌표 join + lazy-fill 로 구성.
 *   - 콜드 DB 에서 RPC 가 statement timeout(8s)까지 가는 실사고(2026-07-11 00:44 UTC)와,
 *     성급한 abort 가 저품질 fallback(며칠치 샘플)을 장기 캐시에 박제하는 회귀(KKKK 자체 발각)를 겪음.
 *
 * 근본책: 일별 사전집계 스냅샷 (popular_apts_snapshot 테이블, id=1 단일 행 upsert)
 *   - cron/retention(18:00 UTC = ingest 1시간 뒤)에서 computeAndStoreSnapshot() 1회 실행.
 *   - /popular 은 스냅샷(신선 36h 이내)을 우선 서빙 — 콜드에서도 밀리초 응답.
 *   - 테이블 미생성(운영자 SQL 실행 전)이어도 완전 무해: 읽기/쓰기 실패는 조용히 라이브 경로 fallback.
 *
 * 운영자 SQL (SPRINT_NOTES 기록 — 실행 전까지 스냅샷 경로만 비활성, 나머지 동작 동일):
 *   create table if not exists public.popular_apts_snapshot (
 *     id int primary key default 1 check (id = 1),
 *     payload jsonb not null,
 *     computed_at timestamptz not null default now()
 *   );
 *   alter table public.popular_apts_snapshot enable row level security;
 *   create policy "popular_snapshot_read" on public.popular_apts_snapshot for select using (true);
 *   -- 쓰기 정책 없음: anon 쓰기 차단, service_role 은 RLS bypass 로 cron 만 upsert.
 */
// SSOT-2026-08-09 (Plan 007): 자체 createClient → db/client 팩토리
const { getSupabaseReadonly, getSupabaseAdmin } = require('../db/client');
const logger = require('../logger');
const { resolveCoordBatch } = require('./geocodeCacheService');
const { isValidKoreaCoord } = require('../utils/geo');

const SNAPSHOT_MAX_AGE_MS = 36 * 60 * 60 * 1000; // 36시간 — daily cron 1회 실패까지 허용

// POPULAR-WINDOW-2026-09-05: 랭킹의 집계 창을 화면이 정확히 적을 수 있게 서버가 계산해 준다.
//   RPC search_popular_apts 는 `deal_date >= CURRENT_DATE - 60` 이고 **DB TimeZone·Vercel 런타임 모두 UTC**
//   (실측 2026-09-05: db_tz=UTC · current_date=2026-09-05 · window_start=2026-07-07)라
//   기준일 = 그 집계가 돈 시점의 UTC 날짜다 — 스냅샷이면 computed_at, 라이브면 지금.
//   ⚠ 프론트가 자체 계산하면 사용자 로컬(KST)이라 09시 이전에 하루 어긋난다([[server-runtime-timezone-utc]]).
//   값을 못 믿으면 null 을 준다 — 화면은 항목째 비운다(지어내지 않는다).
const POPULAR_WINDOW_DAYS = 60;
function popularWindow(computedAt) {
  const base = computedAt ? new Date(computedAt) : new Date();
  const ms = base.getTime();
  if (!Number.isFinite(ms)) return null;
  return {
    days: POPULAR_WINDOW_DAYS,
    since: new Date(ms - POPULAR_WINDOW_DAYS * 86400000).toISOString().slice(0, 10),
    until: base.toISOString().slice(0, 10),
  };
}
const SNAPSHOT_SIZE = 12; // 프론트 고정 limit 와 동일 기준으로 저장

// 읽기용(공개 데이터) = getSupabaseReadonly, 쓰기용(RLS bypass) = getSupabaseAdmin — 키 체인 동일
const anonClient = () => getSupabaseReadonly();
const serviceClient = () => getSupabaseAdmin();

/**
 * 인기 단지 라이브 집계 — search.js /popular 에서 이동 (Sprint LLLL, 로직 무변경).
 * @param {number} limit
 * @param {{client?: object, rpcTimeoutMs?: number}} opts  SNAPROLE-2026-08-16: 조회 클라이언트 주입점.
 *   미지정이면 종전과 동일하게 공개키(anon) — 사용자 요청 경로 동작 불변.
 *   cron 만 service_role 을 넘긴다(아래 computeAndStoreSnapshot 주석에 실측 근거).
 * @returns {{ results: Array, usedFallback: boolean }}
 */
async function buildPopularResults(limit = 12, opts = {}) {
  const admin = opts.client || anonClient();
  if (!admin) throw new Error('Supabase 미설정');

  // ① 전국 60일 실거래량 top — RPC 집계 (정직한 거래량순)
  //   GEOCODE-ROBUST-2026-06-14: 라이브 지오코딩(lazy-fill)이 불안정해도 마커를 꽉 채우기 위해
  //   limit 보다 넉넉히(×5, 최대 80) 받아 → 좌표 보유 단지를 거래량 순서대로 limit 개 선택.
  const fetchN = Math.min(limit * 5, 80);
  let top = null;
  let usedFallback = false;
  // ② RPC 7초 컷 — POPULAR-QUALITY-FIX-2026-07-11: 4초 컷이 콜드 RPC 를 성급히 끊어
  //   저품질 fallback 을 장기 캐시에 박제한 회귀의 재발 방지 균형점.
  //   ⚠ SNAPROLE-2026-08-16 (Sprint MMMMMMM): 공개키(anon)로 붙는 한 이 숫자는 한 번도
  //   작동한 적이 없다 — DB 가 role 단위로 statement_timeout=3s 를 먼저 끊는다(pg_roles 실측).
  //   즉 클라이언트 컷은 DB 컷보다 뒤에 있어 무의미했다. service_role 을 주입한 cron 경로에서만
  //   이 값이 실제 상한으로 작동한다.
  const { data: rpcRows, error: rpcErr } = await admin
    .rpc('search_popular_apts', { p_limit: fetchN })
    .abortSignal(AbortSignal.timeout(opts.rpcTimeoutMs || 7000));
  if (!rpcErr && Array.isArray(rpcRows) && rpcRows.length) {
    // RPC 행(camelCase) → 좌표-join 로직이 기대하는 shape 로 정규화
    top = rpcRows.map(r => ({
      apt_name: r.aptName, sigungu: r.sigungu, umd_nm: r.umdNm,
      lawd_cd: r.lawdCd, build_year: r.buildYear,
      latest: r.recentDealDate, count: Number(r.dealCount60d) || 0,
      deal_amount: r.avgDealAmount,
    }));
  } else {
    // RPC 실패/빈 결과 시에만 degrade — 지역 하드코딩 없는 전국 최근거래 샘플 그룹핑 (며칠치 표본, 저품질)
    usedFallback = true;
    if (rpcErr) logger.warn({ err: rpcErr.message }, 'search_popular_apts RPC 실패 — 전국 샘플 fallback');
    const sinceIso = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    // REST-CAP-FIX-2026-08-09 (Sprint GGGGGGG): 기존 limit(1000) 은 전국 60일 실측 47,444건의
    //   2.1%(최근 며칠 버스트)만 보게 해 거래량 랭킹이 왜곡됐다. range 페이징 상한 10,000
    //   (~최근 2주 커버, 최대 10왕복)으로 표본 10배 확대 — fallback 은 여전히 근사치이며
    //   주경로(RPC search_popular_apts·일일 스냅샷)가 정상이면 이 코드는 돌지 않는다.
    const rows = [];
    for (let _from = 0; _from <= 9000; _from += 1000) {
      const { data: _page, error: e2 } = await admin
        .from('molit_transactions')
        .select('apt_name, sigungu, umd_nm, lawd_cd, build_year, deal_date, deal_amount')
        .gte('deal_date', sinceIso)
        .order('deal_date', { ascending: false })
        .order('id', { ascending: false })
        .range(_from, _from + 999);
      if (e2) throw e2;
      if (_page && _page.length) rows.push(..._page);
      if (!_page || _page.length < 1000) break;
    }
    const byApt = {};
    for (const r of (rows || [])) {
      const k = `${r.apt_name}|${r.sigungu}|${r.umd_nm}`;
      if (!byApt[k]) byApt[k] = { ...r, count: 0, latest: r.deal_date };
      byApt[k].count++;
      if (r.deal_date > byApt[k].latest) byApt[k].latest = r.deal_date;
    }
    top = Object.values(byApt).sort((a, b) => b.count - a.count).slice(0, fetchN);
  }
  if (!top || !top.length) return { results: [], usedFallback };

  // ⑥ POPULAR-QUALITY-2026-07-11 (Sprint GGGG): (a) 21일 지속거래 필터 — 신축 일괄등기 버스트 차단
  //   (b) lawd_cd(시군구 고유코드)당 최대 2곳 캡 — 동탄 도배 방지 (sigungu 문자열은 '서구' 충돌 실측).
  //   캡 초과분은 뒤로 밀어 limit 미달 시에만 재투입 (항상 꽉 채움 보장 유지).
  const activeCutoff = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const fresh = top.filter(t => String(t.latest || '') >= activeCutoff);
  if (fresh.length >= limit) { // 필터 후에도 충분할 때만 적용 (데이터 희소 시 원본 유지)
    const bySgg = {};
    const capped = [];
    const overflow = [];
    for (const t of fresh) {
      const g = String(t.lawd_cd || t.sigungu || '?');
      bySgg[g] = (bySgg[g] || 0) + 1;
      (bySgg[g] <= 2 ? capped : overflow).push(t);
    }
    top = capped.concat(overflow);
  }

  // ③ apt_geocache 좌표 join — 환각 차단(2026-05-06): (apt_name|sigungu|umd_nm) 정확 키만
  const names = [...new Set(top.map(t => t.apt_name))];
  const { data: coords } = await admin.from('apt_geocache')
    .select('apt_name, sigungu, umd_nm, lat, lng')
    .in('apt_name', names);
  const coordMap = new Map();
  for (const c of (coords || [])) {
    // COORD-GUARD-2026-07-25 (Sprint NNNNNN): 한국 범위 밖 좌표가 인기 마커로 새어나가지 않게 방어.
    //   미달이면 miss 취급되어 아래 lazy-fill 이 온디맨드 재시도(기존 동작). DB CHECK 와 이중 안전망.
    if (!isValidKoreaCoord(Number(c.lat), Number(c.lng))) continue;
    coordMap.set(`${c.apt_name}|${c.sigungu || ''}|${c.umd_nm || ''}`, c);
  }
  // POPULAR-QUALITY (c): MOLIT raw 접두("산척동,") 제거 — 표시용만 (좌표 join 키는 raw 유지)
  const _cleanName = (n) => String(n || '').replace(/^[가-힣0-9]{1,8}(동|리|가),\s*/, '');
  const _row = (t, c) => ({
    aptName: _cleanName(t.apt_name), sigungu: t.sigungu, umdNm: t.umd_nm,
    lawdCd: t.lawd_cd, buildYear: t.build_year,
    recentDealDate: t.latest, dealCount60d: t.count, avgDealAmount: t.deal_amount,
    lat: Number(c.lat), lng: Number(c.lng),
  });

  // ④ 상위 limit 후보의 미좌표만 즉시 lazy-fill (첫 호출만 수초, 이후 apt_geocache 영속 hit)
  const head = top.slice(0, limit);
  const headMissing = head.filter(t => !coordMap.has(`${t.apt_name}|${t.sigungu || ''}|${t.umd_nm || ''}`));
  if (headMissing.length) {
    const filled = await resolveCoordBatch(headMissing.map(t => ({
      aptName: t.apt_name, sigungu: t.sigungu, umdNm: t.umd_nm,
    })), 5);
    headMissing.forEach((t, i) => {
      const f = filled[i];
      if (f && f.lat && f.lng) coordMap.set(`${t.apt_name}|${t.sigungu || ''}|${t.umd_nm || ''}`, f);
    });
  }
  // ⑤ 거래량 순서대로 좌표 보유 단지 limit 개 — 못 채운 자리는 다음 순위가 메움(항상 꽉)
  const out = [];
  for (const t of top) {
    const c = coordMap.get(`${t.apt_name}|${t.sigungu || ''}|${t.umd_nm || ''}`);
    if (c && c.lat && c.lng) out.push(_row(t, c));
    if (out.length >= limit) break;
  }
  return { results: out, usedFallback };
}

/**
 * 스냅샷 읽기 — 신선(36h 이내)하고 limit 충족 시 results 반환, 아니면 null.
 * 테이블 미생성/조회 실패는 조용히 null (라이브 경로 fallback).
 */
// POPULAR-STALE-2026-08-16 (Sprint LLLLLLL — Sentry NODE-9): maxAgeMs 파라미터 추가.
//   기본값은 종전과 동일(36h)이라 정상 경로 동작 불변. 라이브 집계가 statement timeout 으로
//   죽었을 때만 호출부가 더 긴 age 를 넘겨 "만료된 스냅샷"을 최후 폴백으로 쓴다(빈 지도 방지).
async function readPopularSnapshot(limit = 12, maxAgeMs = SNAPSHOT_MAX_AGE_MS) {
  try {
    const admin = anonClient();
    if (!admin) return null;
    const { data, error } = await admin
      .from('popular_apts_snapshot')
      .select('payload, computed_at')
      .eq('id', 1)
      .maybeSingle();
    if (error || !data || !Array.isArray(data.payload)) return null;
    const age = Date.now() - new Date(data.computed_at).getTime();
    if (!(age >= 0 && age < maxAgeMs)) return null;
    if (data.payload.length < Math.min(limit, SNAPSHOT_SIZE)) return null;
    // 계산 시점을 **배열 속성**으로 싣는다 — 반환 형태를 바꾸면 호출부 4곳(검색 2·브리핑·챗)과
    //   테스트 스텁까지 함께 고쳐야 하고, 그 중 하나만 놓쳐도 조용히 빈 결과가 된다.
    const rows = data.payload.slice(0, limit);
    rows.computedAt = data.computed_at;
    return rows;
  } catch (_) { return null; }
}

/** 스냅샷 저장 (service_role 전용) — 실패는 { stored:false } 로 조용히. */
async function storePopularSnapshot(results) {
  try {
    const sc = serviceClient();
    if (!sc) return { stored: false, reason: 'service_role 미설정' };
    const { error } = await sc
      .from('popular_apts_snapshot')
      .upsert({ id: 1, payload: results, computed_at: new Date().toISOString() });
    if (error) return { stored: false, reason: error.message };
    return { stored: true, count: results.length };
  } catch (e) { return { stored: false, reason: e.message }; }
}

/** cron 용 — RPC 성공본(정상 품질)만 저장. fallback/빈 결과는 저장하지 않음. */
async function computeAndStoreSnapshot() {
  // SNAPROLE-2026-08-16 (Sprint MMMMMMM) — NODE-9 순환의 마지막 고리.
  //   [실측 확인됨]
  //   · pg_db_role_setting: anon = statement_timeout **3s** / authenticated = 8s /
  //     authenticator(유일한 login 역할, rolcanlogin=true) = 8s / **service_role = 항목 없음**.
  //     코드는 이 한계를 8s 로 알고 있었다(BBBBBBB-4 주석) — 공개키 경로에선 실제보다 관대한 오인.
  //   · 집계 RPC `search_popular_apts(60)` EXPLAIN ANALYZE 2회 연속(LLLLLLL 크로스체크):
  //     **콜드 5,672ms → 웜 198ms**. temp read 481 / written 483 = 정렬이 work_mem 을 넘겨
  //     디스크로 흘렀다(GROUP BY apt_name,sigungu,umd_nm + ORDER BY count DESC).
  //     cron 은 하루 1회라 **항상 콜드에 가깝다** → 5.67s 는 anon 3s 를 확실히 초과. 실패가 설명된다.
  //   [미검증 — 추측하지 말 것]
  //   · service_role 의 **실효** statement_timeout 값은 측정하지 못했다. PostgREST 는 authenticator
  //     로 로그인(8s 세션값) 후 SET ROLE 하는데, service_role 에 per-role 항목이 없으므로 세션값
  //     8s 가 남는지 DB 기본(2min)으로 가는지는 service_role 키 없이 확인 불가(DDL 도 운영자 전용).
  //     확실한 것은 **anon 3s 보다는 크다**는 것뿐. 만약 8s 라면 콜드 5.67s 는 통과하되 여유가
  //     2.3s 뿐이라 거래량 증가 시 재실패할 수 있다 → 그때는 RPC 자체(디스크 정렬) 최적화가 답.
  //     같은 이유로 아래 rpcTimeoutMs 25s 도 DB 컷보다 뒤일 수 있다(무해하나 상한 역할은 못 한다).
  //   [증상 — health.crons 로 독립 확인]
  //   · 스냅샷 computed_at 이 08-13 18:22 에서 정지, 08-14·08-15 cron 연속 실패
  //     (health.crons['popular-snapshot'].error = "canceling statement due to statement timeout"),
  //     54h 노화 → 36h 신선도 미달 → 사용자가 라이브 집계를 직접 타는 원래 순환으로 복귀.
  //   Sprint LLLLLLL 의 stale 폴백(최대 7일)은 이 상태에서 **빈 지도만** 막는 증상 처치다.
  //   생산 자체를 살리려면 cron 이 3s 제약을 벗어나야 한다.
  //   [안전성] cron 은 서버 내부 작업이고 조회 대상도 동일한 공개 데이터라 RLS 우회 키로 노출면이
  //   늘지 않는다(스냅샷 저장은 이미 service_role — 읽기만 anon 이던 비대칭을 맞추는 것).
  //   ⚠ 사용자 요청 경로(/popular 라이브 집계)는 종전대로 공개키 — 방어층 불변.
  //   [확인 지점] 다음 18:00 UTC 실행 후 health.crons['popular-snapshot'].ok 로 판정.
  const sc = serviceClient();
  const opts = sc ? { client: sc, rpcTimeoutMs: 25000 } : {};  // 25s: 300s 예산 안에서 재시도 포함 2회
  let { results, usedFallback } = await buildPopularResults(SNAPSHOT_SIZE, opts);
  // SNAPRETRY-2026-08-08 (Sprint BBBBBBB-4): 첫 시도가 DB 캐시를 데우므로 1회 재시도로 대부분
  //   성공한다(cron 은 요청 경로 300s 예산 — 재시도 여유 충분). service_role 전환 후에도 유지:
  //   RPC 가 아닌 다른 이유(일시 네트워크)로 실패했을 때의 값이 남는다.
  if (usedFallback) ({ results, usedFallback } = await buildPopularResults(SNAPSHOT_SIZE, opts));
  const via = sc ? 'service_role' : 'anon';
  if (usedFallback || !results.length) {
    logger.warn({ usedFallback, count: results.length, via }, 'popular 스냅샷 스킵 — fallback/빈 결과는 저장 안 함');
    return { stored: false, usedFallback, count: results.length };
  }
  const r = await storePopularSnapshot(results);
  logger.info({ ...r, usedFallback, via }, 'popular 스냅샷 계산 완료');
  return { ...r, usedFallback };
}

module.exports = { buildPopularResults, readPopularSnapshot, storePopularSnapshot, computeAndStoreSnapshot, popularWindow };
