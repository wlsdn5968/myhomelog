// Vercel 서버리스 진입점 — Express 앱을 핸들러로 내보냄
// ⚠️ Sentry 는 다른 어떤 import 보다 먼저 (v8 auto-instrumentation 요구사항)
require('../backend/sentry');
const app = require('../backend/server');
module.exports = app;
