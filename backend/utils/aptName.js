/**
 * 단지명 표시·매칭용 정규화 — NAMEFIX-2026-05-11
 *
 * 배경 (운영자 발견, 2026-05-11):
 *   MOLIT 실거래 raw 데이터는 한 단지를 층수별로 분리 등록한 케이스가 있음.
 *   예) "상계주공9(고층)", "상계주공9(저층)" — 동일 단지인데 라벨만 다름.
 *   결과:
 *     1) 사용자 표시 "상계주공9(고층)" 어색 — 운영자 직접 지적
 *     2) Kakao 좌표 매칭 시 query 가 "(고층)" 까지 포함되어 검색 실패
 *     3) 평형/거래량 합산이 분리되어 부정확
 *
 * NAME-MERGE-2026-05-12 (Sprint S — 운영자 발견 + 3-source cross-check):
 *   MOLIT 데이터에 더 광범위한 분리 신고 패턴 존재 [VERIFIED]:
 *     P1) "풍림아파트A" + "풍림아파트B"  (단일 A-E suffix)   — 4건
 *     P2) "한솔노블(104동)" + "한솔노블(105동)" ...           — 30+건
 *     P3) "상계주공1(고층)" + "상계주공1(저층)"                — 7건 (기존 P)
 *     P4) "글로리안(A)" + "글로리안(B)"  (단일 letter 괄호)   — 3건
 *   Cross-check (Kakao Map + KAPT AptInfo + Naver search_local):
 *     공릉동 풍림아파트A/B → KAPT 등록 "공릉풍림아이원" 1개, 같은 입주자대표회의, 같은 주소.
 *   → 단지정보 검색 dropdown 에 1 row 만 표시되도록 정규화 강화.
 *
 * 정책:
 *   - DB raw `apt_name` 은 그대로 유지 — molit_transactions / apt_geocache 등
 *     기존 row 와 호환성 보존 (재마이그레이션 회피).
 *   - 사용자 가시 응답 + 외부 API 매칭 query 시점에만 정규화.
 *   - normalizeAptName: 가벼운 정규화 (display 용) — (고|중|저)층 만 제거.
 *     차수("1차", "2차") · 동 정보는 단지 식별 핵심이라 보존.
 *   - baseAptName: 공격적인 base 추출 (grouping 용) — 동/letter/층 모두 제거.
 *     같은 base + 같은 (sigungu, umd_nm, build_year) 면 같은 단지로 추정.
 *
 * 적용처:
 *   - backend/services/propertyService.js  — recommend 응답의 aptName (normalize)
 *   - backend/services/transactionService.js — getTransactionsByApt / 그룹별 결과 (normalize)
 *   - backend/services/geocodeCacheService.js — kakaoGeocode 의 query 빌드 (normalize)
 *   - backend/routes/search.js — /api/search/apt dropdown grouping (baseAptName)
 *   - (DB cache key buildKey 는 raw 유지 — 호환성)
 */

// 기존 (고/중/저)층 제거
const FLOOR_SUFFIX_RE = /\s*\(\s*(?:고|중|저)\s*층\s*\)\s*/g;

// NAME-MERGE-2026-05-12: 동/letter suffix 제거 (grouping 전용 강력 정규화)
// 우선순위 순서:
//   1) (NNN동) (NN동) (NNN-NNN동) (NNN~NNN동) — 괄호/대괄호 옵션, 공백 옵션
//   2) NNN동 (괄호 없이 trailing) — 예: "한림101동"
//   3) (A) (B) (가) (나) — 단일 letter 괄호
//   4) 끝 단일 [A-E] — 예: "풍림아파트A" (단, base 길이 >= 3 보호)
//   5) (고|중|저)층 — 기존
const DONG_PAREN_RE   = /\s*[\(\[]\s*\d+(?:\s*[-~]\s*\d+)?\s*동\s*[\)\]]\s*$/;
const DONG_PLAIN_RE   = /\s*\d{1,4}동\s*$/; // 1~4자리 동 (가드는 base 길이 + 한글 prev character 로 처리)
const LETTER_PAREN_RE = /\s*[\(\[]\s*(?:[A-Z]|[가-하])\s*[\)\]]\s*$/;
const SINGLE_AE_RE    = /([A-E])$/; // base 길이 검사 후 제거

/**
 * 단지명을 표시·매칭용으로 정규화 (가벼움).
 *   - (고|중|저)층 suffix 만 제거 — display + Kakao query.
 * @param {string|null|undefined} name
 * @returns {string}  정규화된 단지명 (빈 입력은 빈 문자열)
 */
function normalizeAptName(name) {
  if (name == null) return '';
  return String(name)
    .replace(FLOOR_SUFFIX_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 단지명에서 grouping 용 base 추출 (공격적 정규화).
 *
 *   "풍림아파트A"        → "풍림아파트"
 *   "한솔노블(104동)"    → "한솔노블"
 *   "한림101동"          → "한림"
 *   "상계주공1(고층)"    → "상계주공1"     (차수 number 는 보존)
 *   "글로리안(A)"        → "글로리안"
 *   "공덕래미안자이"     → "공덕래미안자이" (변경 없음)
 *   "신봉마을엘지빌리지5차(A)" → "신봉마을엘지빌리지5차"  (차수 보존)
 *
 * 가드:
 *   - base 길이 >= 2 보호 (지나치게 짧으면 무효)
 *   - 단일 [A-E] 제거는 length 6+ 만 (false-positive 차단: "현대" → "현대"가 아닌 "현"으로 보장)
 *
 * @param {string|null|undefined} name
 * @returns {string}
 */
function baseAptName(name) {
  if (name == null) return '';
  let s = String(name).trim();
  if (!s) return '';

  // 1) display normalize 먼저 (고/중/저)층
  s = s.replace(FLOOR_SUFFIX_RE, ' ').replace(/\s+/g, ' ').trim();

  // 2) (NNN동) / (NNN-NNN동) 괄호 동 표기
  s = s.replace(DONG_PAREN_RE, '');

  // 3) 괄호 없이 trailing 동 (예: 한림101동, 리버펠리스1동) — 1~4자리 숫자+동
  //    가드: 제거 후 길이 >= 4 (지나치게 짧은 base 차단), 직전 character 가 한글이어야
  {
    const candidate = s.replace(DONG_PLAIN_RE, '');
    if (candidate.length >= 4 && candidate !== s) {
      const prev = candidate.charAt(candidate.length - 1);
      if (/[가-힣]/.test(prev)) s = candidate;
    }
  }

  // 4) (A)/(가) 등 단일 letter 괄호
  s = s.replace(LETTER_PAREN_RE, '');

  // 5) 끝 단일 [A-E] — length >= 6 + 직전 character 가 한글이어야 (false-positive 차단)
  //    예: "풍림아파트A" (length 7, 직전 '트' 한글) → "풍림아파트" OK
  //    예: "더샵A" (length 3) → 보호, 변경 X
  //    예: "ABM" (length 3) → 보호, 변경 X (직전 'B' 영문이라도 length<6)
  if (s.length >= 6 && SINGLE_AE_RE.test(s)) {
    const prev = s.charAt(s.length - 2);
    // 직전이 한글 (가-힣) 이면 단지명 + 동라벨 가능성 ↑
    if (/[가-힣]/.test(prev)) {
      s = s.replace(SINGLE_AE_RE, '');
    }
  }

  return s.replace(/\s+/g, ' ').trim() || String(name).trim();
}

module.exports = { normalizeAptName, baseAptName };
