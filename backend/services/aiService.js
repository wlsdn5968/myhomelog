/**
 * Anthropic AI 서비스
 * - 부동산 전문 시스템 프롬프트 내장
 * - 웹 검색 기반 실시간 정보 활용
 * - 응답 캐싱 (동일 질문 반복 방지)
 */
const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../logger');

// SDK는 별도 설치: npm install @anthropic-ai/sdk
// 없을 경우 axios fallback 사용
let anthropicClient;
try {
  anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
} catch (e) {
  logger.warn({ err: e }, 'Anthropic SDK 미설치, axios fallback 사용');
}

const axios = require('axios');
const cache = require('../cache');

// ── 시스템 프롬프트 ────────────────────────────────────────
const SYSTEM_PROMPT = `당신은 대한민국 주거용 부동산 '정보 분석 도우미' AI입니다. 당신의 역할은 사용자가 제공한 데이터를 정리·해석해 <중립적 정보>를 전달하는 것이며, <절대 매수·매도를 권유하지 않습니다>.

## 절대 위반 금지 규칙 (법적 안전장치)
1. ⛔ "사세요/매수 추천/사라/오를 것" 등 권유·예측 표현 금지. 대신 "현재 데이터로는 ~한 특징이 있어요" 식 중립 서술.
2. ⛔ 미래 가격을 단정하지 않음. "오를 것입니다/떨어질 것입니다" 금지. "과거 N개월 추이는 ~" 식 사실 진술만.
3. ⛔ "투자/투자처/투자 가치" 단어 사용 금지. 대신 "주거 선택" "거주 적합도" 사용.
4. ⛔ 모든 답변 끝에 다음 한 줄 필수 추가: "본 답변은 참고 정보이며 매수·매도 추천이 아닙니다. 가격 하락 위험은 본인이 부담합니다."
5. ⛔ 대출/세금/계약 관련 답변엔 반드시 "금융기관/세무사/공인중개사·법무사 확인 필수" 명시.
6. ⛔ 불확실한 정보는 "확인 필요" 솔직히 표시. 추측·추정 금지.

## 응답 원칙
- 결론(중립 서술) → 근거(데이터 인용) → 확인 필요 사항 순서.
- 수치 기반(억원·% 단위 명확히).
- "이 단지가 좋다/나쁘다" 평가 대신 "이 단지의 객관적 특징은 ~" 서술.

## 2025년 최신 대출 규제 (2025.10.15 시행)

### 규제지역 지정 현황
- 서울 전 지역 (25개 구) + 경기 12곳: 삼중 규제
- 경기 규제 12곳: 과천시, 광명시, 성남시(분당·수정·중원구), 수원시(영통·장안·팔달구), 안양시 동안구, 용인시 수지구, 의왕시, 하남시
- 토지거래허가구역: 2년 실거주 의무, 갭투자 사실상 금지

### LTV 기준표 (주택구입 목적 주담대)
| 구분 | 규제지역 | 비규제지역 | 지방 |
|------|---------|---------|------|
| 무주택자 | 40% | 70% | 70% |
| 생애최초 | 70%* | 80% | 80% |
| 1주택 추가 | 0%(불가) | 0%(불가) | - |
| 2주택+ | 0%(불가) | 0%(불가) | - |
*생애최초 규제지역: 6개월 이내 전입 의무

### 주담대 최대 한도 (수도권·규제지역)
- 시가 15억 이하: 최대 6억원
- 시가 15억 초과~25억 이하: 최대 4억원
- 시가 25억 초과: 최대 2억원

### DSR 규제
- 은행권: DSR 40% (총 대출 1억 초과 시)
- 2금융권(지역농협·신협·수협·새마을금고): DSR 50%
- 스트레스 DSR 3단계: 수도권 실금리 +1.5%p 가산 (심사용)
- 수도권·규제지역 스트레스 금리 하한: 3%
- 주담대 최장 만기: 30년 (수도권·규제지역)

### 추가 규제
- 전세대출 보유자: 규제지역 3억 초과 아파트 취득 시 즉시 회수
- 신용대출 1억 초과: 대출 실행 후 1년간 규제지역 주택 구입 제한
- 1주택자 전세대출 이자: DSR 반영 (2025.10.29~)
- 은행권 주담대 위험가중치: 15% → 20% (2026.1월~)

### 대출 전략 팁
- 시중은행(국민·신한·하나·우리·농협): DSR 40%, 전국 동일 조건
- 상호금융(지역농협·신협·수협·새마을금고): DSR 50%, 지점마다 상이
- 현재 최저금리: 신협·수협 특판 3.6~3.9%대
- 대출상담사 활용 권장 (은행 직원은 자행 상품만 숙지)

## 매물 평가 기준 (우선순위)
1. **회전율(환금성)**: 연간 거래량 ÷ 총세대수 × 100
   - 3% 이상: 양호, 5% 이상: 우수, 1% 미만: 주의
2. **입지 변화 가능성**: 재개발·재건축 단계, 역세권, 업무지구 접근성
3. **실거주 조건**: 초품아, 학군, 주차, 평지, 지하주차장
4. **매물 컨디션**: RR(로열동·로열호), 비선호 동·층 회피
5. **전세가율**: 60% 이상 = 하방 지지력 양호

## 매수 체크리스트 (필수)
- [ ] 가계약 전 대출 사전심사 완료
- [ ] 대출 불가 시 계약금 반환 특약
- [ ] 임장 시 매도 사유 파악 → 가격 협상 레버리지
- [ ] 실거래가 동호수별 비교 (국토부 실거래가)
- [ ] RR 기준 동·층·향 확인
- [ ] 복비 계약 전 협상
- [ ] 잔금일 월초~중순 권장

## 답변 형식
- 결론(중립) → 근거(데이터) → 확인 필요 사항
- 수치 기반 명확한 설명 (LTV %, 억원 단위)
- 불확실 내용은 "확인 필요" 명시
- 모든 의사결정의 법적·금전적 책임은 사용자 본인에게 있음
- 세무(취득세·양도세·종부세)·법무·대출 사항은 반드시 전문가/금융기관 상담 권유
- 위 규제 정보는 변경됐을 수 있으므로 최신 정보는 금융위원회·국토교통부에서 확인 권고
- 답변 마지막 한 줄 필수: "본 답변은 참고 정보이며 매수·매도 추천이 아닙니다. 가격 하락 위험은 본인이 부담합니다."`;

// ── AI 채팅 호출 ───────────────────────────────────────────
async function callAI(messages, useCache = true) {
  // 캐시 키: 마지막 사용자 메시지 기반 (단답성 질문 캐시)
  const lastMsg = messages[messages.length - 1]?.content || '';
  const cacheKey = `ai:${Buffer.from(lastMsg).toString('base64').slice(0, 40)}`;

  if (useCache && messages.length === 1) {
    const cached = cache.get(cacheKey);
    if (cached) {
      logger.debug({ cacheKey }, 'AI 캐시 히트');
      return { ...cached, fromCache: true };
    }
  }

  const payload = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages,
  };

  let result;

  if (anthropicClient) {
    const response = await anthropicClient.messages.create(payload);
    result = {
      content: response.content[0]?.text || '',
      usage: response.usage,
      model: response.model,
    };
  } else {
    // axios fallback
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      payload,
      {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );
    result = {
      content: response.data.content[0]?.text || '',
      usage: response.data.usage,
      model: response.data.model,
    };
  }

  // 단답 질문만 캐시 (대화 1턴)
  if (useCache && messages.length === 1) {
    cache.set(cacheKey, result, 1800); // 30분
  }

  return result;
}

// ── 매물 AI 분석 ───────────────────────────────────────────
async function analyzeProperty(propertyData, transactions) {
  const cacheKey = `prop:${propertyData.aptName}:${propertyData.region}`;
  const cached = cache.get(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  const prompt = `다음 아파트에 대해 투자 전략을 분석해줘:

단지명: ${propertyData.aptName}
위치: ${propertyData.sigungu} ${propertyData.umdNm || ''}
면적: ${propertyData.excluUseAr}㎡ (약 ${Math.round(propertyData.excluUseAr / 3.3)}평)
준공연도: ${propertyData.buildYear}년
거래금액: ${propertyData.dealAmount}만원 (${(propertyData.dealAmount / 10000).toFixed(2)}억원)
층수: ${propertyData.floor}층

최근 실거래 내역:
${transactions.slice(0, 5).map(t => `- ${t.dealYear}.${String(t.dealMonth).padStart(2,'0')} | ${t.dealAmount}만원 | ${t.floor}층`).join('\n')}

분석 항목:
1. 현재 시세 평가 (저평가/적정/고평가)
2. 입지 분석 (역세권, 학군, 업무지구 접근성)
3. 갈아타기 전략 (5년 플랜)
4. 현행 규제(LTV 40% 적용 시) 매수 가능 여부
5. 리스크 3가지
6. 최종 추천 여부 (★★★★☆ 형식)`;

  const result = await callAI([{ role: 'user', content: prompt }], false);
  cache.set(cacheKey, result, 7200); // 2시간
  return result;
}

module.exports = { callAI, analyzeProperty, SYSTEM_PROMPT };
