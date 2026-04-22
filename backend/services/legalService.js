/**
 * 한국 법령 인용 서비스 (특약 작성 강화용)
 * - 국가법령정보 공공 API (law.go.kr) DRF 사용
 * - 이슈 키워드 → 관련 조문/판례 스니펫 매핑
 *
 * 주의: law.go.kr API는 OC 파라미터(이메일 아이디)만으로 동작하는 개방 API.
 * 본 서비스는 예산/인프라 미설정 시에도 정적 매핑으로 폴백함.
 */
const axios = require('axios');
const cache = require('../cache');

const LAW_LIST = 'https://www.law.go.kr/DRF/lawSearch.do';
const LAW_TEXT = 'https://www.law.go.kr/DRF/lawService.do';

/**
 * 이슈 → 대표 법령·조문 정적 매핑
 * (확장성: 필요시 실제 API 호출로 치환)
 */
const ISSUE_TO_CITATIONS = {
  '누수': [
    { law: '민법', article: '제580조', title: '매도인의 하자담보책임',
      summary: '매매 목적물에 하자가 있는 경우 매수인은 계약 해제 또는 손해배상 청구 가능.' },
    { law: '민법', article: '제584조', title: '하자담보책임의 행사기간',
      summary: '하자를 안 날로부터 6개월 내에 권리 행사.' },
  ],
  '전세': [
    { law: '주택임대차보호법', article: '제3조의2', title: '보증금의 회수',
      summary: '대항력 + 확정일자 요건 충족 시 임차인 우선변제권 인정.' },
    { law: '주택임대차보호법', article: '제8조', title: '소액임차인의 최우선변제',
      summary: '소액임차인은 보증금 중 일정액을 최우선변제 받을 권리.' },
  ],
  '세입자승계': [
    { law: '주택임대차보호법', article: '제3조', title: '대항력',
      summary: '임차인이 주택을 인도받고 전입신고를 마치면 새 소유자에게도 대항 가능.' },
    { law: '주택임대차보호법', article: '제6조의3', title: '계약갱신요구권',
      summary: '임차인은 계약만료 6개월~2개월 전 갱신요구권 행사 가능(1회 한정).' },
  ],
  '재건축': [
    { law: '도시 및 주거환경정비법', article: '제39조', title: '조합원의 자격',
      summary: '재건축 조합원은 정비구역 내 토지·건축물 소유자.' },
    { law: '주택법', article: '제64조', title: '전매행위 제한',
      summary: '투기과열지구 내 재건축 조합원 지위 양도 제한.' },
  ],
  '주차': [
    { law: '주택건설기준 등에 관한 규정', article: '제27조', title: '주차장 설치기준',
      summary: '세대당 1대 이상 주차장 확보 의무(지역에 따라 상이).' },
  ],
  '확장': [
    { law: '건축법', article: '제19조', title: '용도변경·대수선',
      summary: '발코니 확장 등은 구조안전 확인 및 신고 대상이 될 수 있음.' },
  ],
  '대출': [
    { law: '은행업감독규정', article: '제29조의3', title: 'LTV 규제',
      summary: '주택담보대출 한도는 주택가격 대비 비율(LTV)로 제한.' },
    { law: '소득세법', article: '제89조', title: '1세대 1주택 비과세',
      summary: '양도소득세 비과세 요건: 보유기간·거주기간 등.' },
  ],
  '하자': [
    { law: '민법', article: '제580조', title: '매도인의 하자담보책임',
      summary: '매매 목적물의 하자 발견 시 손해배상·해제 청구.' },
    { law: '공동주택관리법', article: '제36조', title: '하자담보책임',
      summary: '공동주택 하자담보 기간 2~10년(부위별 상이).' },
  ],
};

/**
 * 이슈 리스트 → 관련 법령 인용 묶음 반환
 */
function getCitationsForIssues(issues = '') {
  const text = String(issues).toLowerCase();
  const hits = new Map();
  for (const [kw, cites] of Object.entries(ISSUE_TO_CITATIONS)) {
    if (text.includes(kw)) {
      cites.forEach((c, i) => hits.set(`${kw}-${i}`, c));
    }
  }
  // 기본 보편 법령 (입력 없을 때)
  if (!hits.size) {
    ISSUE_TO_CITATIONS['하자'].forEach((c, i) => hits.set(`기본-${i}`, c));
    ISSUE_TO_CITATIONS['전세'].slice(0, 1).forEach((c, i) => hits.set(`기본전세-${i}`, c));
  }
  return Array.from(hits.values()).slice(0, 6);
}

/**
 * law.go.kr DRF API 기반 법령 검색 (선택적 — OC 환경변수 있을 때만 활성화)
 */
async function searchLaw(keyword) {
  const oc = process.env.LAW_GO_KR_OC;
  if (!oc) return null;
  const ck = `law:search:${keyword}`;
  const cached = cache.get(ck);
  if (cached !== undefined) return cached;
  try {
    const r = await axios.get(LAW_LIST, {
      params: { OC: oc, target: 'law', type: 'JSON', query: keyword, display: 5 },
      timeout: 6000,
    });
    const list = r.data?.LawSearch?.law || [];
    cache.set(ck, list, 86400 * 30);
    return list;
  } catch (e) {
    return null;
  }
}

module.exports = { getCitationsForIssues, searchLaw };
