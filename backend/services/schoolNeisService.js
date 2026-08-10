/**
 * 학교알리미 NEIS OpenAPI 서비스 — 학교명 → 학생수·학급수·교사수
 *
 * STAB-AUDIT-2026-05-07 P1 (운영자 발견):
 *   호갱노노/네이버 부동산 수준 학교 정보 표시.
 *   카카오맵으로 학교 list (이름·거리)는 이미 있음 → NEIS API 로 풍부화.
 *
 * API: https://open.neis.go.kr/hub/schoolInfo
 *   - 무료 (KEY 없이 sample 호출 가능, 정식 KEY 발급 시 한도 ↑)
 *   - 전국 학교 정보 (학교명·코드·학생수·학급수·교사수·주소)
 *
 * 캐시 정책:
 *   - process cache 24h (학생수는 학기 단위 변동, 1일 충분)
 *   - 학교명 정확 매칭 어려움 (예: "서울가산초등학교" vs "가산초등학교")
 *     → 부분 매칭 (LIKE) + 시도+학교명 필터
 *
 * 한계:
 *   - 학업성취도·진학률은 NEIS public API X (학교알리미 PDF 다운로드 별도)
 *   - "학군 좋다" 정성적 평가 X (운영자 정직 정책 — 사실만 표시)
 */
const axios = require('axios');
const cache = require('../cache');
const logger = require('../logger');

const NEIS_KEY = process.env.NEIS_API_KEY || ''; // optional, 미설정 시 sample 키 사용
const NEIS_BASE = 'https://open.neis.go.kr/hub';
const TIMEOUT_MS = 5000;

// 시도교육청 코드 (NEIS 표준)
const ATPT_CODE = {
  '서울': 'B10', '서울특별시': 'B10',
  '부산': 'C10', '부산광역시': 'C10',
  '대구': 'D10', '대구광역시': 'D10',
  '인천': 'E10', '인천광역시': 'E10',
  '광주': 'F10', '광주광역시': 'F10',
  '대전': 'G10', '대전광역시': 'G10',
  '울산': 'H10', '울산광역시': 'H10',
  '세종': 'I10', '세종특별자치시': 'I10',
  '경기': 'J10', '경기도': 'J10',
  '강원': 'K10', '강원특별자치도': 'K10',
  '충북': 'M10', '충청북도': 'M10',
  '충남': 'N10', '충청남도': 'N10',
  '전북': 'P10', '전북특별자치도': 'P10', '전라북도': 'P10',
  '전남': 'Q10', '전라남도': 'Q10',
  '경북': 'R10', '경상북도': 'R10',
  '경남': 'S10', '경상남도': 'S10',
  '제주': 'T10', '제주특별자치도': 'T10',
};

/** lawd_cd 앞 2자리 → 시도. 이름 추정과 달리 **원리적으로 정확**하다. */
const LAWD_PREFIX_TO_SIDO = {
  '11': '서울', '26': '부산', '27': '대구', '28': '인천', '30': '대전', '31': '울산',
  '36': '세종', '41': '경기', '42': '강원', '51': '강원', '43': '충북', '44': '충남',
  '45': '전북', '52': '전북', '46': '전남', '47': '경북', '48': '경남', '50': '제주',
};

/** 서울 **고유** 자치구만 — '중구·동구·서구·남구·북구' 처럼 여러 시도에 함께 있는 이름은 뺐다. */
const SEOUL_ONLY_GU = new Set([
  '종로구', '용산구', '성동구', '광진구', '동대문구', '중랑구', '성북구', '강북구', '도봉구',
  '노원구', '은평구', '서대문구', '마포구', '양천구', '강서구', '구로구', '금천구', '영등포구',
  '동작구', '관악구', '서초구', '강남구', '송파구', '강동구',
]);

/**
 * 시군구 → 시도교육청 코드.
 *
 * LAWD-FIRST-2026-08-10 (Sprint KKKKKKK-7): 기존 구현은 **"…구로 끝나면 서울"** 로 단정해
 *   `해운대구`·`수성구`·`유성구`·`부산진구`·`청주시상당구` 를 전부 서울(B10)로 판정했다.
 *   NEIS 는 (시도교육청 + 학교명)으로 조회하므로, 동명 학교가 서울에 있으면 **서울 학교의
 *   학생수·주소가 그 단지 정보로 붙는다** — 조용한 환각이다(절대 룰 위반).
 *   → lawd_cd 가 있으면 **그것으로만** 판정하고(행정구역 판정은 코드로 — 메모리 교훈),
 *     없으면 서울 고유 자치구만 인정하고 나머지는 null 을 반환해 **조회 자체를 포기**한다.
 *     "정보 없음"이 "남의 지역 정보"보다 낫다.
 * @param {string} sigungu
 * @param {string} [lawdCd] 있으면 최우선 — 이름 추정의 모호성이 원천 제거된다
 */
function inferAtptCode(sigungu, lawdCd) {
  const pfx = String(lawdCd || '').slice(0, 2);
  if (pfx && LAWD_PREFIX_TO_SIDO[pfx]) return ATPT_CODE[LAWD_PREFIX_TO_SIDO[pfx]] || null;

  if (!sigungu) return null;
  const s = String(sigungu);
  // "수원시영통구" 같은 시+구 합성어 — 경기 (도시명이 붙어 있어 모호하지 않다)
  if (/(시[가-힣]+구)/.test(s)) return 'J10';
  if (SEOUL_ONLY_GU.has(s)) return 'B10';
  // 시도명으로 시작하면 그대로 매칭 ('부산…','대구…' 등)
  for (const [k, v] of Object.entries(ATPT_CODE)) {
    if (s.startsWith(k)) return v;
  }
  // 여기까지 왔다 = '중구'·'서구'처럼 여러 시도에 있는 이름이거나 미지원 표기 → 판정 포기
  return null;
}

/**
 * NEIS schoolInfo 조회 — 학교명 + 시도 코드로 매칭
 * @returns {Object|null} { studentCount, classCount, teacherCount, schoolType, address }
 */
async function fetchSchoolNeis(schoolName, atptCode) {
  if (!schoolName || !atptCode) return null;
  const ckey = `neis:${atptCode}:${schoolName}`;
  const hit = cache.get(ckey);
  if (hit !== undefined) return hit;

  try {
    const params = {
      Type: 'json',
      pIndex: 1,
      pSize: 5,
      ATPT_OFCDC_SC_CODE: atptCode,
      SCHUL_NM: schoolName,
    };
    if (NEIS_KEY) params.KEY = NEIS_KEY;

    const r = await axios.get(`${NEIS_BASE}/schoolInfo`, {
      params, timeout: TIMEOUT_MS,
    });

    const rows = r.data?.schoolInfo?.[1]?.row || [];
    if (!rows.length) {
      cache.set(ckey, null, 86400); // 24h 음성 캐시
      return null;
    }

    // 정확 매칭 우선 (학교명 일치 또는 부분 포함)
    const exact = rows.find(x => x.SCHUL_NM === schoolName);
    const partial = rows.find(x => x.SCHUL_NM?.includes(schoolName) || schoolName.includes(x.SCHUL_NM));
    const chosen = exact || partial || rows[0];

    const out = {
      schoolType: chosen.SCHUL_KND_SC_NM || null, // 초등/중/고등
      foundationType: chosen.FOND_SC_NM || null,  // 공립/사립
      address: chosen.ORG_RDNMA || null,           // 도로명 주소
      genderType: chosen.COEDU_SC_NM || null,      // 남녀공학/남고/여고
      schoolCode: chosen.SD_SCHUL_CODE || null,
    };
    cache.set(ckey, out, 86400 * 7); // FACILITY-PERF-2026-07-10 (Sprint FFFF): 1d→7d — 공립/사립·주소는 정적
    return out;
  } catch (e) {
    logger.debug({ err: e.message, schoolName, atptCode }, 'NEIS schoolInfo 실패');
    cache.set(ckey, null, 600); // 10분 음성 캐시 (재시도 가능)
    return null;
  }
}

/**
 * 학교 list 풍부화 — 각 학교에 NEIS 정보 추가
 * @param {Array} schools - schoolService.resolveSchools 결과
 * @param {string} sigungu - 단지 시·구 (lawdCd 가 없을 때의 폴백 추정용)
 * @param {string} [lawdCd] - 있으면 시도교육청 판정에 **최우선** 사용(이름 추정의 오판 제거)
 */
async function resolveSchoolNeisBatch(schools, sigungu, lawdCd) {
  if (!Array.isArray(schools) || !schools.length) return schools || [];
  const atptCode = inferAtptCode(sigungu, lawdCd);
  // 시도 판정 실패 → NEIS 호출 안 함. 남의 시도로 조회해 **동명 학교 정보를 붙이는 것**보다
  //   보강 데이터가 비는 편이 낫다(카카오 기반 학교 목록·거리는 그대로 표시된다).
  if (!atptCode) return schools;

  // 동시성 제한 (6개) — FACILITY-PERF-2026-07-10 (Sprint FFFF): 3→6, 콜드 9학교 3라운드→2라운드
  const enriched = new Array(schools.length);
  let i = 0;
  async function worker() {
    while (i < schools.length) {
      const idx = i++;
      const s = schools[idx];
      const neis = await fetchSchoolNeis(s.name, atptCode).catch(() => null);
      enriched[idx] = neis ? { ...s, neis } : s;
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, schools.length) }, () => worker()));
  return enriched;
}

module.exports = { fetchSchoolNeis, resolveSchoolNeisBatch, inferAtptCode };
