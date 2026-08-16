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
const SNAPSHOT_SIZE = 12; // 프론트 고정 limit 와 동일 기준으로 저장

// 읽기용(공개 데이터) = getSupabaseReadonly, 쓰기용(RLS bypass) = getSupabaseAdmin — 키 체인 동일
const anonClient = () => getSupabaseReadonly();
const serviceClient = () => getSupabaseAdmin();

/**
 * 인기 단지 라이브 집계 — search.js /popular 에서 이동 (Sprint LLLL, 로직 무변경).
 * @returns {{ results: Array, usedFallback: boolean }}
 */
async function buildPopularResults(limit = 12) {
  const admin = anonClient();
  if (!admin) throw new Error('Supabase 미설정');

  // ① 전국 60일 실거래량 top — RPC 집계 (정직한 거래량순)
  //   GEOCODE-ROBUST-2026-06-14: 라이브 지오코딩(lazy-fill)이 불안정해도 마커를 꽉 채우기 위해
  //   limit 보다 넉넉히(×5, 최대 80) 받아 → 좌표 보유 단지를 거래량 순서대로 limit 개 선택.
  const fetchN = Math.min(limit * 5, 80);
  let top = null;
  let usedFallback = false;
  // ② RPC 7초 컷 — POPULAR-QUALITY-FIX-2026-07-11: 4초 컷이 콜드 RPC 를 성급히 끊어
  //   저품질 fallback 을 장기 캐시에 박제한 회귀의 재발 방지 균형점.
  const { data: rpcRows, error: rpcErr } = await admin
    .rpc('search_popular_apts', { p_limit: fetchN })
    .abortSignal(AbortSignal.timeout(7000));
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
    return data.payload.slice(0, limit);
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
  let { results, usedFallback } = await buildPopularResults(SNAPSHOT_SIZE);
  // SNAPRETRY-2026-08-08 (Sprint BBBBBBB-4, NODE-9 근본원인): RPC 실측 3.5s(웜) — 콜드 DB 에선
  //   statement timeout(8s)을 넘겨 usedFallback → 저장 스킵 → 스냅샷 36h 노화 → 사용자가 라이브
  //   집계를 직접 타다 간헐 timeout(NODE-9, 15일 7회)이 나던 순환. 첫 시도가 DB 캐시를 데우므로
  //   1회 재시도로 대부분 성공한다(cron 은 요청 경로 300s 예산 — 재시도 여유 충분).
  if (usedFallback) ({ results, usedFallback } = await buildPopularResults(SNAPSHOT_SIZE));
  if (usedFallback || !results.length) {
    logger.warn({ usedFallback, count: results.length }, 'popular 스냅샷 스킵 — fallback/빈 결과는 저장 안 함');
    return { stored: false, usedFallback, count: results.length };
  }
  const r = await storePopularSnapshot(results);
  logger.info({ ...r, usedFallback }, 'popular 스냅샷 계산 완료');
  return { ...r, usedFallback };
}

module.exports = { buildPopularResults, readPopularSnapshot, storePopularSnapshot, computeAndStoreSnapshot };
