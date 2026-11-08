// Vercel 서버리스 진입점 — Express 앱을 핸들러로 내보냄
// ⚠️ Sentry 는 다른 어떤 import 보다 먼저 (v8 auto-instrumentation 요구사항)
require('../backend/sentry');
const app = require('../backend/server');
// CPU-METER-2026-11-08 (plans/188): 인스턴스가 새로 뜰 때 모듈을 읽는 데 쓴 CPU. 요청별 측정에는 들어가지 않아 따로 한 번 남긴다.
try {
  const u = process.cpuUsage();
  require('../backend/logger').info({ cpuMeter: { route: '(cold-start)', ms: Math.round((u.user + u.system) / 1000), uptimeMs: Math.round(process.uptime() * 1000) } }, 'cpu-meter');
} catch (_) { /* 측정 실패는 무시 */ }
module.exports = app;
