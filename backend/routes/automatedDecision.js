/**
 * Automated Decision Explanation (GDPR Art.22 / PIPA 개인정보보호위 가이드라인)
 *
 * 제공 이유:
 *   - 우리 서비스는 단지 점수(score), 대출 한도(LTV), AI 중립 요약 등 "자동화된 결정"을 내림.
 *   - EU GDPR Art.22 는 이런 결정에 대해 사용자에게 **로직·중요성·결과 설명 요구권**을 부여.
 *   - 불이행 시 과징금 최대 매출 4% 또는 €20M 중 큰 금액.
 *   - PIPA 도 2023 개정 이후 같은 취지 (개인정보보호위 가이드라인).
 *
 * 정책:
 *   - 특정 단지에 대한 개별 설명 아닌, **우리가 쓰는 factor·가중치·공식의 일반 설명**.
 *     개별 단지 결과는 이미 응답에 pros/cons/risk 로 포함되어 있음.
 *   - 사용자 개인정보와 직접 연관 없음 → 로그인 필수는 아니지만, 본인 범위 설명을 위해
 *     requireAuth 유지 (본인 검색 이력 컨텍스트 반영 옵션).
 *
 * 향후 확장:
 *   - body.aptSeq / body.query 받아 "이 단지 score 가 왜 이 값인지" 개별 설명 (feature importance).
 *     현재는 공식 기반 결정론적 스코어라 계산식 역산으로 충분.
 */
const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// 환경변수로 운영자 이메일 교체 가능 — 운영 이관 시 .env 에 SUPPORT_EMAIL 지정.
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'privacy@myhomelog.app';

// GET /api/account/automated-decision/explain
// Body 없이 — 우리 AI·스코어링의 구조·factor·법적 근거 일반 설명.
router.get('/explain', (req, res) => {
  res.json({
    _meta: {
      basis: ['GDPR Art.22 (2018)', 'PIPA 제37조의2 (2023 개정)'],
      lastUpdated: '2026-04-24',
      dataController: '내집로그 (MyHomeLog)',
      supportContact: SUPPORT_EMAIL,
      rightToObject: `설명을 받은 후 이 결정에 이의를 제기하려면 ${SUPPORT_EMAIL} 로 요청해주세요.`,
    },

    decisions: [
      {
        name: '단지 추천 스코어 (0~95)',
        purpose: '사용자 조건(예산·지역·주택보유상태)에 맞는 단지를 거래 활발도 기준으로 정렬',
        method: '결정론적 공식 — AI 예측 아님. 공공데이터(MOLIT 실거래) 기반.',
        formula: 'score = min(95, 50 + min(dealCount, 30) × 1.5)',
        factors: [
          {
            name: 'dealCount (최근 6개월 거래량)',
            weight: '유일 변수 (30건에서 상한)',
            source: '국토교통부 실거래가 공개 API',
            rationale: '거래량은 환금성 지표 — 많을수록 매도 용이 (출구 전략).',
          },
        ],
        notShown: [
          '미래 가격 예측 (불가능 + 법적 리스크)',
          '개별 세대의 하자·소음 등 정성 정보 (임장 필수)',
        ],
        recourse: '사용자 조건 재입력 또는 지역·평형·연식 필터 조정으로 결과 재조회 가능',
      },

      {
        name: '대출 한도 계산 (LTV / DSR)',
        purpose: '2025.10.15 규제 기준 매수 시 은행권 대출 가능 금액 참고치 제시',
        method: '정부 고시 규제표에 따른 결정론적 산식',
        formula: 'maxLoan = min(시세 × LTV%, 규제지역별 상한(6억/4억/2억))',
        factors: [
          { name: '규제지역 여부', source: '국토부 지정 규제지역 리스트 (하드코딩 + 갱신)' },
          { name: '주택보유 상태', source: '사용자 입력 (무주택/1주택/2주택+)' },
          { name: '생애최초 여부', source: '사용자 입력' },
          { name: '시세', source: 'MOLIT 실거래 최근 6개월 평균' },
        ],
        disclaimer: '실제 한도는 금융기관 심사 결과로 확정 — 본 계산은 참고치',
      },

      {
        name: 'AI 채팅·분석·특약 생성',
        purpose: '사용자 질문에 대한 부동산 정보 정리 (매수·매도 추천 절대 금지)',
        method: 'Anthropic Claude Sonnet 4 + 시스템 프롬프트 (가드레일 10개)',
        factors: [
          { name: '사용자 질문', source: '사용자 입력 (XML 태그로 격리 — prompt injection 방어)' },
          { name: '현재 조건·단지 컨텍스트', source: '세션 상태 (예산·지역·단지·점수)' },
          { name: '2025 규제 정보', source: '시스템 프롬프트 내 고시 정보' },
        ],
        safeguards: [
          '매수·매도 권유 표현 금지',
          '미래 가격 단정 금지',
          '별점/점수 강조 금지',
          '특정 단지 부정 평가 금지 (표시광고법·명예훼손 회피)',
          '세무·법무·대출 관련은 반드시 전문가 상담 안내',
        ],
        notUsed: [
          '사용자 신용점수·소득 (수집하지 않음)',
          '결제 이력 (AI 컨텍스트 미포함)',
          '다른 사용자의 데이터 (RLS 로 물리적 분리)',
        ],
        humanOversight: `답변이 부정확하거나 편향되면 ${SUPPORT_EMAIL} 로 신고 가능`,
      },
    ],

    userRights: {
      access: 'GET /api/account/export — 전체 데이터 JSON 다운로드',
      delete: 'POST /api/account/delete — 30일 유예 후 영구 삭제',
      restore: 'POST /api/account/restore — 유예기간 내 철회',
      object: `본 설명에 이의가 있으면 ${SUPPORT_EMAIL} 로 요청 — 72시간 내 담당자 응답`,
      humanReview: '자동화 결정에 이의가 있으면 수동 검토 요청 가능',
    },
  });
});

module.exports = router;
