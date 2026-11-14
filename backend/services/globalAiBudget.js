/**
 * 전역 AI 지출 상한 — 2026-11-13 부터 유료 AI 를 쓰지 않아 사용량 검사와 기록 함수는 지웠다.
 * aiService.js 가 오류 클래스(GlobalAiBudgetExceededError)를 하위 호환용으로 내보내므로 클래스만 남긴다.
 */
class GlobalAiBudgetExceededError extends Error {
  constructor(info) {
    super('GLOBAL_AI_BUDGET_EXCEEDED');
    this.name = 'GlobalAiBudgetExceededError';
    this.code = 'global_ai_budget';
    this.info = info || {};
  }
}

module.exports = {
  GlobalAiBudgetExceededError,
};
