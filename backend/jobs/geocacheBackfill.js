/**
 * apt_geocache 점진 백필 — STAB-AUDIT-2026-05-06 (운영자 발견 후속)
 *
 * 배경:
 *   - molit_transactions 16,044 distinct 단지 vs apt_geocache 172 row (1.07% coverage)
 *   - 사용자 검색 시 99% 단지가 마커 미표시 (lazy fill 의존만으로는 영원히 안 채워짐)
 *   - 운영자 ASSERT: "172 row 밖에 안되는거야"
 *
 * 전략:
 *   - 매일 1회 cron (vercel.json "0 4 * * *") + budgetMs 안 multi-chunk (50건/chunk default)
 *   - 거래 활발 단지 우선 (최근 60일 거래량 desc)
 *   - 정확 매칭 (sigungu+umd_nm+aptName) 만 INSERT — PR #44 환각 차단 검증 강제
 *   - 외부 geocoding quota 무료 한도 내 운용 목표 (월 사용량은 런타임 가변 — 고정 산정 불가)
 *
 * 안전:
 *   - NOT EXISTS apt_geocache 에만 처리 (덮어쓰기 X)
 *   - sigungu 검증 실패 시 INSERT 안 함 (환각 차단)
 *   - serverless maxDuration 안 — budgetMs(기본 240s)-15s 마진에서 chunk loop 종료 (run 함수)
 *   - resolveCoord 자체가 saveToDb 진행 → INSERT 자동
 */
const { getSupabaseAdmin } = require('../db/client');
const { resolveCoordBatch, kakaoGeocode, getKakaoUsageStats, kakaoAddressGeocode, markGeoFail, filterOutGeoFailed, buildKey, saveToDb } = require('../services/geocodeCacheService');
const { isValidKoreaCoord } = require('../utils/geo');
const logger = require('../logger');

// 단지명 핵심 추출(접미사 아파트/단지/차/괄호/숫자/공백 제거) — reheal 관련성 판정용.
function _aptCore(s) { return String(s || '').replace(/아파트|오피스텔|단지|[차()\s\d]/g, ''); }

// CANON-COORD-FIX-2026-06-03 (운영자 승인 "재지오코딩 진행"): 비주거 place_name 으로 잘못 찍힌 기존 좌표를
//   본체로 in-place 재치유. 일일 backfill cron 시작 시 1회 호출.
//   2026-06-03 확장 (운영자 "태강아파트(아이파크) → 아이파크 공인중개사사무소 에 찍힘" 발견):
//   시설(충전소/주차장)뿐 아니라 사무소(공인중개사/부동산)·상점·음식점 등 비주거 전체로 탐지 확장.
const REHEAL_NONRES_KEYWORDS = [
  '공인중개사','중개사','부동산','사무소','편의점','마트','슈퍼','충전소','주차장','정류장','정문','후문',
  '관리사무소','경비실','놀이터','식당','음식점','카페','커피','병원','약국','의원','치과','한의원','학원',
  '교습소','은행','주유소','미용','이용원','세탁','노래','호프','치킨','국밥','분식','족발','횟집','고깃집',
  '당구','헬스','문구','마켓','상회','정비','공업사','교회','성당','어린이집','유치원',
  // NONRES-EXPAND-2026-08-10 (Sprint KKKKKKK, 좌표 1,340건 전수 분류에서 실측된 상호 토큰):
  //   단지명이 2글자인 경우(`현대`·`삼성`·`세종`·`동신`·`미성`·`성원`·`SK` 등, 불일치의 39%)
  //   카카오 장소검색이 그 두 글자가 든 무관 업소를 1순위로 잡는 것이 지배적 실패 모드였다.
  //   실제 사례: 세종→세종통신 / 현대→현대자동차블루핸즈 / 동신→동신손세차 / 미성→미성인테리어 /
  //   성원→성원비철금속 / 갈마·누리→○○네거리(교차로 지점) / 신창→신창시장.
  '통신','인테리어','세차','자동차','렌터카','타이어','전자','설비','공사','건축','금속','엘리베이터',
  '요양','건강원','도서관','네거리','오거리','삼거리','시장','조합','필라테스','서비스센터','접수센터',
  // SANGGA-REHEAL-2026-07-17 (Sprint YYYYY, 운영자 "지도 매칭 안 되는 것 많다" — DB 실측 확정):
  //   place_name '%상가%' 1,091건(source=kakao, 전체 10.3%)이 단지 본체 아닌 상가동 좌표로 잔존 —
  //   비단지 place 최대 단일 원인(운영자 15건 표본에서 4건). 과거 "주상복합 명칭 충돌 애매"로 제외했으나,
  //   reheal 은 재지오코딩 결과가 '더 나은 주거 본체'일 때만 UPDATE(아니면 kakao-sub 마킹)라 안전 —
  //   진짜 이름에 상가가 든 단지도 전국 2건뿐(SQL 실측). cap 300/일 → 약 4일 내 자동 스윕.
  '상가',
];
const REHEAL_NONRES_RE = new RegExp(REHEAL_NONRES_KEYWORDS.join('|'));

/**
 * 비주거 place_name 좌표 재치유 — Kakao 재지오코딩(하드닝 필터) 후 "더 나은(주거 본체) 좌표"만 in-place UPDATE.
 * 안전: 비주거-아님 + 한국 유효좌표 + 동일 시군구(kakaoGeocode 내부 검증) + 단지명 관련성 + 이동 20m~2km 일 때만 갱신.
 *      개선 불가(여전히 비주거/실패)는 source='kakao-sub' 마킹 → 다음 run 제외(무한 재시도 방지).
 */
async function rehealSubfeatures(admin, { cap = 300, budgetMs = 120000 } = {}) {
  const started = Date.now();
  const { data: rows } = await admin
    .from('apt_geocache')
    .select('apt_key, apt_name, sigungu, umd_nm, lat, lng, place_name, address')
    .eq('source', 'kakao')
    .or(REHEAL_NONRES_KEYWORDS.map(k => `place_name.ilike.%${k}%`).join(','))
    .limit(cap);
  const subs = (rows || []).filter(r => REHEAL_NONRES_RE.test(r.place_name || ''));
  if (!subs.length) return { tried: 0, healed: 0, marked: 0 };

  let tried = 0, healed = 0, marked = 0;
  const queue = [...subs];
  async function worker() {
    while (queue.length && (Date.now() - started) < budgetMs) {
      const r = queue.shift();
      tried++;
      try {
        const fresh = await kakaoGeocode({ aptName: r.apt_name, sigungu: r.sigungu, umdNm: r.umd_nm, address: r.address });
        let didHeal = false;
        if (fresh && isValidKoreaCoord(fresh.lat, fresh.lng) && !REHEAL_NONRES_RE.test(fresh.placeName || '')) {
          // 안전장치: 재지오코딩 결과 place_name 이 단지명과 관련될 때만(이웃 단지 오매칭 차단)
          const aCore = _aptCore(r.apt_name);
          const pCore = _aptCore(fresh.placeName || '');
          const related = aCore.length >= 2 && (pCore.includes(aCore) || aCore.includes(pCore));
          const dx = (fresh.lng - Number(r.lng)) * Math.cos(fresh.lat * Math.PI / 180);
          const moved = 111000 * Math.sqrt(Math.pow(fresh.lat - Number(r.lat), 2) + Math.pow(dx, 2));
          if (related && moved >= 20 && moved <= 2000) {
            await admin.from('apt_geocache').update({
              lat: fresh.lat, lng: fresh.lng, place_name: fresh.placeName, address: fresh.address, source: 'kakao',
            }).eq('apt_key', r.apt_key);
            healed++; didHeal = true;
          }
        }
        // 개선 불가/관련성 미달 → 좌표 불변, source 마킹해 다음 run 제외(무한 재시도 방지).
        //   단, fresh=null(Kakao 일시실패/쿼터소진/페널티거부)은 마킹 안 함 → 다음 run 재시도(false-마킹 방지).
        if (!didHeal && fresh) {
          await admin.from('apt_geocache').update({ source: 'kakao-sub' }).eq('apt_key', r.apt_key);
          marked++;
        }
      } catch (_) { /* 개별 실패(Kakao 일시오류 등) 무시 — source 유지 → 다음 run 재시도 */ }
    }
  }
  await Promise.all(Array.from({ length: 8 }, () => worker())); // PERF-2026-06-13: reheal 동시성 4→8 (Kakao 100K/일 한도 대비 안전, 개별 실패는 source 유지로 graceful)
  logger.info({ source: 'geocache-reheal', tried, healed, marked, elapsedMs: Date.now() - started },
    `geocache reheal: ${healed} 본체교정 / ${marked} 개선불가마킹 / ${tried} 시도`);
  return { tried, healed, marked };
}

/**
 * 공식 주소 기반 좌표 검증·교정 스윕 — ADDR-VERIFY-2026-07-17 (Sprint ZZZZZ, 운영자 "지도 매칭" 1번 승인)
 *
 * 배경(전수 실측): 이름 키워드 지오코딩의 구조적 한계로 place_name↔단지명 무관 행 존재(표본: 문구점·
 *   교차로·자동차 대리점·타단지 차수혼동). 반면 이름 유사도는 판정 기준으로 부적합 —
 *   실사례: geocache apt_name '두산'(옛 스냅샷) vs KAPT 공식 '가산두산위브' → place '두산위브아파트'가
 *   오히려 정답. 유일하게 신뢰 가능한 기준 = 공식 주소와의 거리.
 *
 * 진실 소스(이름 무관·공식 데이터만):
 *   - kapt: 키 → apt_master.facility.kaptAddr (KAPT 공식 주소, 11,480단지 보유)
 *   - name: 키 → molit_transactions 해당 단지 최빈 지번 → "시군구 법정동 지번"
 *
 * 판정: 주소 지오코딩(모호성 0) 좌표와 기존 좌표 거리 d
 *   - d ≤ 300m → 좌표 유지 + source='kakao-v' (검증 통과 — 대단지 반경 감안, place 가 상가여도 실용 정확)
 *   - d > 300m → 공식 주소 좌표로 교정 + source='kakao-addr' + place_name 은 비움(이름 place 아님이 사실)
 *   - 주소 미확보/지오코딩 실패 → 아무것도 안 바꿈(마킹 없음 — 다음 run 재시도)
 * 처리된 행은 source 가 'kakao'에서 벗어나 반복 재검증·reheal 재시도에서 자연 제외(진행 보장).
 */
async function verifyByOfficialAddress(admin, { cap = 300, budgetMs = 60000 } = {}) {
  const started = Date.now();
  // SUB-INCLUDE-2026-08-10 (Sprint KKKKKKK): 'kakao-sub' 도 대상에 포함(실측 1,980행).
  //   reheal 이 이 행들을 마킹한 이유는 **이름 재지오코딩**이 개선에 실패했기 때문인데, 주소 기반
  //   지오코딩(모호성 0)은 애초에 시도조차 안 됐다. 즉 가장 의심스러운 행들이 유일하게 정확한
  //   검증 경로에서 영구 제외돼 있었다 — 인기 단지 6위 '평촌어바인퍼스트'(실거래 지번 호계동 1296,
  //   저장 좌표 946-13 '1단지 상가')가 이 상태였다. 처리 후 source 가 kakao-v/kakao-addr 로 바뀌어
  //   재시도 루프는 생기지 않는다(진행 보장 유지).
  //   의심도가 높은 kakao-sub 를 먼저 소진하도록 정렬('kakao-sub' > 'kakao' 문자열 역순).
  const { data: rows } = await admin
    .from('apt_geocache')
    .select('apt_key, apt_name, sigungu, umd_nm, lat, lng, place_name')
    .in('source', ['kakao', 'kakao-sub'])
    .order('source', { ascending: false })
    .limit(cap);
  if (!rows || !rows.length) return { tried: 0, verified: 0, corrected: 0, skippedNoAddr: 0 };

  // kapt: 키의 공식 주소 배치 조회 (N+1 회피)
  const kaptCodes = rows.filter(r => r.apt_key.startsWith('kapt:')).map(r => r.apt_key.slice(5));
  const addrByKapt = new Map();
  if (kaptCodes.length) {
    const { data: masters } = await admin.from('apt_master')
      .select('kapt_code, facility').in('kapt_code', kaptCodes);
    for (const m of (masters || [])) {
      const a = m.facility && m.facility.kaptAddr;
      if (a && String(a).trim().length >= 5) addrByKapt.set(m.kapt_code, String(a).trim());
    }
  }

  let tried = 0, verified = 0, corrected = 0, skippedNoAddr = 0;
  const queue = [...rows];
  async function worker() {
    while (queue.length && (Date.now() - started) < budgetMs) {
      const r = queue.shift();
      try {
        // 1) 공식 주소 결정 — **실거래 신고 지번을 먼저** 본다.
        //    IDENTITY-GATE-2026-08-10 (Sprint KKKKKKK): kapt: 키의 kaptAddr 를 1순위로 쓰면 안 된다.
        //    그 kaptCode 는 이름 유사도 매칭의 산물이라 키 자체가 오염돼 있을 수 있다 — 실측으로
        //    3,169세대 "신동아아파트1"(방학동 271-1)의 apt_key 가 104세대 타워 코드(kapt:A10026856,
        //    방학동 736)로 저장돼 있었다. 이 상태로 kaptAddr 를 정답 삼으면 이 스윕이 대단지 마커를
        //    남의 단지 자리로 "교정"해 오매칭을 좌표까지 전파시킨다.
        //    MOLIT 신고 지번은 이름 매칭이 개입하지 않는 원본이라 이 오염에 면역이다.
        let addr = null;
        if (r.sigungu && r.umd_nm) {
          // molit 최빈 지번 — 동일 (단지명, 시군구, 법정동) 신고 거래의 mode(jibun)
          const { data: tx } = await admin.from('molit_transactions')
            .select('jibun').eq('apt_name', r.apt_name).eq('sigungu', r.sigungu).eq('umd_nm', r.umd_nm)
            .not('jibun', 'is', null).neq('jibun', '').limit(60);
          if (tx && tx.length) {
            const freq = {};
            for (const t of tx) freq[t.jibun] = (freq[t.jibun] || 0) + 1;
            const top = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
            if (top) addr = `${r.sigungu} ${r.umd_nm} ${top[0]}`.trim();
          }
        }
        // 신고 지번이 없을 때만 KAPT 공식 주소 (거래가 드문 단지 — 오염 위험보다 커버리지 이득이 크다)
        if (!addr && r.apt_key.startsWith('kapt:')) {
          addr = addrByKapt.get(r.apt_key.slice(5)) || null;
        }
        if (!addr) { skippedNoAddr++; continue; }
        // 2) 주소 지오코딩(모호성 0) — 실패 시 아무것도 안 바꿈
        const fresh = await kakaoAddressGeocode(addr);
        if (!fresh) continue;
        tried++;
        // 3) 거리 판정
        const dx = (fresh.lng - Number(r.lng)) * Math.cos(fresh.lat * Math.PI / 180);
        const moved = 111000 * Math.sqrt(Math.pow(fresh.lat - Number(r.lat), 2) + Math.pow(dx, 2));
        // NONRES-FORCE-2026-08-10 (Sprint KKKKKKK): 비주거 상호에 찍힌 좌표는 **300m 이내여도 교정**한다.
        //   기존엔 거리만 봐서, 같은 동 안의 무관 업소(예: 산본동 '세종'→'세종통신', 월계동 '동신'→'동신손세차')가
        //   300m 안에 있으면 'kakao-v'(검증 통과)로 마킹돼 오염이 영구 박제됐다. 좌표 1,340건 분류에서
        //   C계(무관 상호) 668건·49.9%로 최대 덩어리였다. 공식 주소 좌표가 어차피 더 정확하므로 손해가 없고,
        //   place_name 은 비워진다(프론트 미사용 필드 — 렌더 영향 0, grep 실측).
        const nonRes = r.place_name && REHEAL_NONRES_RE.test(r.place_name);
        if (moved <= 300 && !nonRes) {
          await admin.from('apt_geocache').update({ source: 'kakao-v' }).eq('apt_key', r.apt_key);
          verified++;
        } else {
          await admin.from('apt_geocache').update({
            lat: fresh.lat, lng: fresh.lng, address: fresh.address, place_name: null, source: 'kakao-addr',
          }).eq('apt_key', r.apt_key);
          corrected++;
          logger.info({ source: 'geocache-addr-verify', aptKey: r.apt_key, movedM: Math.round(moved), addr },
            `좌표 교정: ${r.apt_name} ${Math.round(moved)}m 이동 (공식주소 기반)`);
        }
      } catch (_) { /* 개별 실패 무시 — source 유지 → 다음 run 재시도 */ }
    }
  }
  await Promise.all(Array.from({ length: 8 }, () => worker())); // reheal 과 동일 동시성(Kakao 한도 대비 충분히 안전)
  const elapsedMs = Date.now() - started;
  logger.info({ source: 'geocache-addr-verify', tried, verified, corrected, skippedNoAddr, rows: rows.length, elapsedMs },
    `주소 검증 스윕: ${verified} 통과 / ${corrected} 교정 / ${skippedNoAddr} 주소없음 / ${tried} 판정`);
  return { tried, verified, corrected, skippedNoAddr, elapsedMs, rows: rows.length };
}

const DEFAULT_CHUNK = 50;
const MAX_CHUNK = 100;

// SSOT-2026-08-09 (Plan 007): 자체 createClient → db/client 팩토리 (null-게이트 의미 유지)
function adminClient() {
  return getSupabaseAdmin();
}

/**
 * 백필 실행 — 후보 풀 1회 조회 후 budget 안에서 batch 순회
 * @param {Object} opts
 * @param {number} [opts.chunk=50]   — 1 batch 처리 단지 수 (resolveCoordBatch 단위)
 * @param {number} [opts.daysBack=180] — 거래 lookback 일수
 * @param {number} [opts.budgetMs=240000] — 총 실행 budget (Vercel maxDuration 300s 안전 마진)
 * @param {number} [opts.pool=800]   — 1회 조회할 후보 풀 크기 (거래량 desc)
 *
 * GEOCODE-SWEEP-2026-06-21 (운영자 "이어서 진행해" — 좌표갭 5,042 활성단지 trickle 정체 근본수정):
 *   [근본원인] 기존 run 은 매 chunk 마다 RPC top-50 을 재조회 → 고거래량 hard-fail 단지(Kakao 매칭 실패)는
 *     apt_geocache 에 row 가 안 남아 NOT EXISTS 로 매번 top-50 을 영구 점유 → 그 아래 지오코딩 가능 단지에
 *     영원히 미도달. 실측: cron 은 매일 정상(06-20 facility 680건)인데 geocode 는 일부 날 0건 삽입 = 순수 spin.
 *   [Fix] 후보 풀(거래량순 top-N)을 1회 조회 후 budget 안에서 batch 순회 → top-50 이 막혀도 하위 랭크까지 sweep.
 *     실패 단지는 다음 날 재시도(Kakao 호출 풀 800×최대4 ≈ 한도 100K/일 의 ~3% 안전). saveToDb 검증(sigungu/umd
 *     하드체크)은 불변 → 환각 좌표 위험 0 (동일 검증, 처리 단지만 더 깊게).
 */
// GEOCODE-ACCEL-2026-06-22: pool 800→2000·budget 240→270s (감속 대응 실측 근거).
//   6/22 cron 커버리지 65.9%·+60/일 감속 — 잔여 미좌표 4,731 >> 풀 800 이라 풀 밖 geocodable 단지 미도달(pool-bound).
//   reheal 실측 13행(~10s)이라 sweep ~215s 확보 → 2000 처리 여유. budget 270s = 루프 255s 중단 + 최종배치 ≈269s < maxDuration 300s
//   (함수 300s 가능 검증: molit cron 정상패스>60s 후 retryFailedGaps 8건 처리 = 함수 >200s 실행 확인). Kakao 2000×최대4=8000=13%<60K 경고한도.
//   주의: 풀 상단의 영구 하드페일(Kakao 무매칭·row 미생성)은 매 run 재시도로 budget·call 일부 낭비 — 향후 sentinel 제외 최적화 후보(미적용, 위험 회피).
// GEOCODE-ACCEL-2-2026-07-22 (Sprint MMMMMM, 백로그 감사 A2): pool 2000→4000.
//   실측: 10일 신규 +738(일 ~74)·미좌표 잔여 ~4,542그룹(이름+동 근사) > 풀 2000 — 6/22와 동일한
//   pool-bound 재발(하드페일이 풀 상단 점유 + 잔여가 풀보다 큼). 풀 4000 = 잔여 전체 포괄.
//   Kakao 4000×최대4=16K(일한도 100K의 16%, 경고 60K의 27%) — 사용자검색·BR백필 합산해도 안전.
//   budget 270s 불변(시간이 먼저 끊어 초과 위험 0) — 하루에 다 못 돌면 다음날 이어서.
//   잔여 병목(Kakao 무매칭 영구 하드페일의 매일 재시도)은 sentinel 도입이 근본책 — DB 영향이라 별도 결정.
async function run({ chunk = DEFAULT_CHUNK, daysBack = 180, budgetMs = 270000, pool = 4000 } = {}) {
  const started = Date.now();
  const admin = adminClient();
  if (!admin) {
    return { ok: false, error: 'Supabase 미설정', processed: 0 };
  }

  const batchSize = Math.min(Math.max(parseInt(chunk) || DEFAULT_CHUNK, 1), MAX_CHUNK);
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // CANON-COORD-FIX-2026-06-03: 하위시설 좌표 재치유 (1회 본체 교정) — sweep 루프 전.
  //   GEOCODE-SWEEP-2026-06-21: reheal 실측 작업량 13행뿐 → 60s 예산이면 충분(기존 120s 과대, sweep 예산 확보).
  //   GEO-BUDGET-2026-08-10 (Sprint KKKKKKK-3): reheal 60s → 30s. 실측 작업량이 13행뿐이라 60s 는
  //   여전히 과대했고, 그 여유를 아래 주소 검증(오염 좌표 948건 교정)에 넘긴다.
  let reheal = { tried: 0, healed: 0, marked: 0 };
  try { reheal = await rehealSubfeatures(admin, { cap: 300, budgetMs: 30000 }); }
  catch (e) { logger.warn({ err: e.message }, 'geocache reheal 실패(무시)'); }

  // ADDR-VERIFY-2026-07-17 (Sprint ZZZZZ): 공식 주소 기반 좌표 검증·교정 — 일 300행씩 전 행 점진 커버
  //   (미검증 10.4K → ~35일, admin 수동 트리거로 가속 가능). 예산 60s 는 sweep 몫에서 차감되지만
  //   신규 백필보다 기존 오좌표 교정이 사용자 체감 우선(운영자 "지도 매칭" 지적).
  //   GEO-BUDGET-2026-08-10 (Sprint KKKKKKK-3): cap 300→1000 · 60s→120s.
  //   [근거] 전수 대조로 오염 좌표 948건이 확정됐는데 일 300행 페이스로는 대상 12,076행
  //   (kakao 10,096 + kakao-sub 1,980)을 훑는 데 ~40일이 걸린다. 예산 실측: run 전체 270s 중
  //   최근 실행이 194.7s 사용(processed 4,000 = 풀 완주) → 여유 ~75s + reheal 감축분 30s.
  //   Kakao 호출은 verify 1,000 + sweep 최대 16K = 17K 로 일 한도 100K 의 17%(경고 60K 미만).
  //   시간이 먼저 끊으면 남은 행은 다음 날 이어서 처리된다(진행 보장 구조 불변).
  let addrVerify = { tried: 0, verified: 0, corrected: 0, skippedNoAddr: 0 };
  try { addrVerify = await verifyByOfficialAddress(admin, { cap: 1000, budgetMs: 120000 }); }
  catch (e) { logger.warn({ err: e.message }, 'geocache 주소검증 실패(무시)'); }

  // 후보 풀 1회 조회 → budget 안에서 batch 순회 (재조회 spin 제거)
  const rawPool = await fetchCandidatePool(admin, pool, since);
  // GEO-FAIL-SENTINEL-2026-07-25 (Sprint NNNNNN): 최근 30일 내 "Kakao 무매칭 확정" 단지를 풀에서 제외 —
  //   상단을 영구 점유하던 하드페일을 걷어내야 그 아래 지오코딩 가능한 단지에 도달한다(본 cron 의 핵심 병목).
  //   Redis 미설정이면 skipped=0 으로 기존 동작 유지.
  const _filtered = await filterOutGeoFailed(
    rawPool.map(t => ({ aptName: t.apt_name, sigungu: t.sigungu, umdNm: t.umd_nm }))
  );

  // ── ADDR-FALLBACK-2026-08-09 (Sprint CCCCCCC): 이름 무매칭 확정 단지의 지번 주소 폴백 ──
  // [근거 실측] 미좌표 활성 6,389그룹 중 5,040(78.9%)이 molit 지번 보유. 거래량 상위 무매칭이
  //   전부 이름 이형('황골마을주공1'·'충무주공(872)' 등 — Kakao 이름 검색에 없음)인데,
  //   같은 단지가 '영통동 955-1' 지번 주소로는 정확히 매칭됨(카카오맵 실검증).
  // [원칙] 이름 매칭 "완화"(환각 위험)가 아니라 **신고 지번이라는 더 정확한 근거**로의 폴백.
  //   결과 주소에 시군구(공백 무시)+법정동 포함을 재검증해 동명 오배치를 차단한다.
  /** molit 'sigungu' 붙임 표기("안양시동안구")를 Kakao 주소 파서용("안양시 동안구")으로 — 단일어 구는 불변 */
  const _sggWithSpace = (sgg) => String(sgg || '').replace(/^(.{2,}?시)(.{2,}구)$/, '$1 $2');
  /** 단지의 최근 1년 최빈 지번 — 없으면 null */
  const _modeJibun = async (it) => {
    try {
      let q = admin.from('molit_transactions').select('jibun')
        .eq('apt_name', it.aptName).eq('sigungu', it.sigungu)
        .not('jibun', 'is', null)
        .gte('deal_date', new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10))
        .limit(40);
      if (it.umdNm) q = q.eq('umd_nm', it.umdNm);
      const { data } = await q;
      const cnt = new Map();
      for (const r of (data || [])) {
        const j = String(r.jibun || '').trim();
        if (j) cnt.set(j, (cnt.get(j) || 0) + 1);
      }
      let best = null, bestN = 0;
      for (const [j, n] of cnt.entries()) if (n > bestN) { best = j; bestN = n; }
      return best;
    } catch (_) { return null; }
  };
  /** nomatch 항목 1개의 주소 폴백 시도 — 성공 시 저장까지. true=좌표 확보 */
  const _tryAddrFallback = async (it) => {
    const jibun = await _modeJibun(it);
    if (!jibun) return false;
    const address = `${_sggWithSpace(it.sigungu)} ${it.umdNm || ''} ${jibun}`.replace(/\s+/g, ' ').trim();
    const g = await kakaoAddressGeocode(address);
    if (!g || !isValidKoreaCoord(g.lat, g.lng)) return false;
    // 동명 오배치 방어 — 응답 주소가 우리 시군구(공백 무시)·법정동을 실제로 포함하는지(kakaoGeocode 검증과 동일 원칙)
    const flat = String(g.address || '').replace(/\s+/g, '');
    if (it.sigungu && !flat.includes(String(it.sigungu).replace(/\s+/g, ''))) return false;
    if (it.umdNm && !flat.includes(String(it.umdNm).replace(/\s+/g, ''))) return false;
    await saveToDb(buildKey(it), { ...it, lat: g.lat, lng: g.lng, address: g.address, source: 'kakao-addr' });
    return true;
  };
  const candidates = _filtered.kept.map(i => ({ apt_name: i.aptName, sigungu: i.sigungu, umd_nm: i.umdNm }));
  const skippedKnownFail = _filtered.skipped;
  let totalProcessed = 0, totalInserted = 0, totalFailed = 0, totalSentinel = 0, batches = 0, idx = 0;
  let addrTried = 0, addrInserted = 0; // Sprint CCCCCCC — 주소 폴백 관측(health.crons 노출)
  while (idx < candidates.length && (Date.now() - started) < budgetMs - 15000) {  // 15s 마진
    const slice = candidates.slice(idx, idx + batchSize);
    idx += slice.length;
    // resolveCoordBatch — sigungu 검증 강제 (PR #44 fix), saveToDb 자동 INSERT
    const items = slice.map(t => ({ aptName: t.apt_name, sigungu: t.sigungu, umdNm: t.umd_nm }));
    // PERF-2026-06-13: 동시성 8 (Kakao 무료 100K/일·경고 60K 대비 안전).
    // GEO-FAIL-SENTINEL-2026-07-22 (Sprint MMMMMM-3): diags 로 실패 사유 수집 —
    //   'nomatch'(Kakao 정상응답·매칭없음 확정)만 sentinel 기록해 내일부터 후보 제외.
    //   'error'(HTTP 오류·타임아웃 등 일시 가능성)는 기록 안 함 → 다음 run 재시도.
    const diags = new Array(items.length);
    const results = await resolveCoordBatch(items, 8, diags);
    let inserted = 0;
    const noMatches = [];
    for (let i = 0; i < items.length; i++) {
      if (results[i] && results[i].lat && results[i].lng) { inserted++; continue; }
      if (diags[i] && diags[i].outcome === 'nomatch') noMatches.push(items[i]);
    }
    // ADDR-FALLBACK-2026-08-09 (Sprint CCCCCCC): 이름 무매칭은 곧장 sentinel 이 아니라 지번 주소로 2차 시도.
    //   8개씩 병렬(위 resolveCoordBatch 동시성과 동일한 Kakao 보호 수준). 주소까지 실패한 것만 확정 실패.
    const toMark = [];
    for (let i = 0; i < noMatches.length; i += 8) {
      const chunk = noMatches.slice(i, i + 8);
      const hits = await Promise.all(chunk.map(it => _tryAddrFallback(it).catch(() => false)));
      for (let k = 0; k < chunk.length; k++) {
        addrTried++;
        if (hits[k]) { inserted++; addrInserted++; }
        else toMark.push(chunk[k]);
      }
    }
    if (toMark.length) {
      // Redis 기록은 병렬 — 순차 await 로 batch 시간을 잡아먹지 않게(이전 DB INSERT 판의 교훈)
      const marks = await Promise.all(toMark.map(it => markGeoFail(it).catch(() => false)));
      totalSentinel += marks.filter(Boolean).length;
    }
    totalProcessed += slice.length;
    totalInserted += inserted;
    totalFailed += (slice.length - inserted);
    batches++;
  }
  const elapsed = Date.now() - started;
  logger.info({
    source: 'geocache-backfill',
    batches, rawPoolSize: rawPool.length, poolSize: candidates.length, skippedKnownFail,
    totalProcessed, totalInserted, totalFailed, totalSentinel, elapsedMs: elapsed,
  }, `geocache backfill: ${batches} batches, ${totalInserted}/${totalProcessed} 백필 (풀 ${rawPool.length}→${candidates.length}, 기지실패제외 ${skippedKnownFail}, sentinel ${totalSentinel}) (${elapsed}ms)`);
  // KAKAO-DIAG-2026-07-10 (Sprint CCCC): 실패 사유 원격 확정용 — 이 run 인스턴스의 Kakao ok/무매칭/에러코드 분포 동봉.
  return {
    ok: true, reheal, addrVerify, batches,
    rawPoolSize: rawPool.length, poolSize: candidates.length, skippedKnownFail,
    processed: totalProcessed, inserted: totalInserted, failed: totalFailed, sentinelMarked: totalSentinel,
    addrTried, addrInserted, elapsedMs: elapsed, kakao: getKakaoUsageStats(),
    // GEO-VERIFY-OBSERV-2026-08-10 (Sprint KKKKKKK-3): cronStats._pick 이 숫자만 통과시켜
    //   위 reheal/addrVerify 객체는 health 에 안 잡힌다 → 평탄화해서 관측 가능하게.
    verifyTried: addrVerify.tried, verifyOk: addrVerify.verified, verifyFixed: addrVerify.corrected,
    verifyNoAddr: addrVerify.skippedNoAddr, verifyMs: addrVerify.elapsedMs,
    rehealTried: reheal.tried, rehealHealed: reheal.healed, rehealMarked: reheal.marked,
  };
}

/**
 * 후보 풀 조회 — 거래 활발(최근 daysBack일) + apt_geocache 미보유 단지 limit 개를 거래량 desc 로.
 *   RPC(geocache_backfill_candidates: NOT EXISTS apt_geocache 내장) 우선, 미정의 시 molit over-fetch fallback.
 */
async function fetchCandidatePool(admin, limit, since) {
  // 1) RPC (NOT EXISTS apt_geocache 내장 — 별도 existing 필터 불필요)
  try {
    // POSTGREST-PAGING-2026-07-25 (Sprint NNNNNN-3, admin 트리거 5회 실측으로 확정):
    //   PostgREST 는 응답을 서버 max-rows(=1000)에서 자른다. p_limit=4000 도, .range(0,3999) 한 번도
    //   실제 수신은 1000(rawPoolSize:1000 실측) — 6/22 pool 800→2000, 7/22 2000→4000 은 전부 실효 0이었다.
    //   ⇒ **페이지 루프**(range(0,999) → (1000,1999) → …)로만 1000을 넘을 수 있다. 각 페이지가 RPC
    //     재실행(실측 ~2s)이라 4페이지 ≈ 8s — budget 270s 대비 무해.
    //   왜 필요한가(실측): sentinel 이 확정 실패분을 걷어내자 상위 1000 창이 3회 실행 만에 69개까지
    //     소진됐다(skippedKnownFail 931). RPC 는 항상 같은 상위 1000 을 주므로 페이징 없이는 그 아래
    //     3,500여 단지에 영원히 도달하지 못한다. 페이징 + sentinel 둘 다 있어야 실제로 전진한다.
    const PAGE = 1000;
    const out = [];
    for (let from = 0; from < limit; from += PAGE) {
      const to = Math.min(from + PAGE, limit) - 1;
      const { data, error } = await admin
        .rpc('geocache_backfill_candidates', { p_limit: limit, p_since: since })
        .range(from, to);
      if (error) throw error;
      if (!data || !data.length) break;
      out.push(...data);
      if (data.length < (to - from + 1)) break; // 마지막 페이지 도달
    }
    if (out.length) return out;
  } catch (rpcErr) {
    logger.debug({ err: rpcErr.message }, 'geocache_backfill_candidates RPC 미정의 — fallback');
  }

  // 2) Fallback: molit over-fetch → distinct 거래량 집계 → 기존 보유 제외
  const { data, error } = await admin
    .from('molit_transactions')
    .select('apt_name, sigungu, umd_nm')
    .gte('deal_date', since)
    .limit(limit * 20); // 중복 많아 over-fetch
  if (error) {
    logger.error({ err: error.message }, 'geocache backfill 후보 조회 실패');
    return [];
  }
  const groups = {};
  for (const r of (data || [])) {
    const k = `${r.apt_name}|${r.sigungu}|${r.umd_nm}`;
    groups[k] = (groups[k] || 0) + 1;
  }
  const ranked = Object.entries(groups)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k]) => {
      const [apt_name, sigungu, umd_nm] = k.split('|');
      return { apt_name, sigungu, umd_nm };
    });
  // fallback 은 NOT EXISTS 미내장 → apt_geocache 보유분 제외
  const { data: existing } = await admin
    .from('apt_geocache')
    .select('apt_name, sigungu, umd_nm')
    .in('apt_name', ranked.map(c => c.apt_name).slice(0, 200));
  const existingSet = new Set((existing || []).map(e => `${e.apt_name}|${e.sigungu || ''}|${e.umd_nm || ''}`));
  return ranked.filter(c => !existingSet.has(`${c.apt_name}|${c.sigungu}|${c.umd_nm}`));
}

module.exports = { run };
