/**
 * 내집로그(MyHomeLog) - 백엔드 서버
 * 보안: Helmet + CORS + Rate Limiting + Input Validation
 * 캐시: node-cache (Redis 전환 가능)
 */
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const cache = require('./cache');

// ── 보안 미들웨어 ──────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
  .split(',').map(o => o.trim());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS 차단: 허용되지 않은 출처'));
  },
  credentials: true,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '50kb' }));

// ── Rate Limiting ──────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
  max: parseInt(process.env.RATE_LIMIT_MAX || '60'),
  message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// AI 채팅은 별도 더 엄격한 제한
const chatLimiter = rateLimit({
  windowMs: 60000,
  max: 20,
  message: { error: 'AI 채팅 요청 한도를 초과했습니다. 1분 후 다시 시도해주세요.' },
  keyGenerator: (req) => req.ip + ':chat',
});

// 실거래가 조회도 별도 제한 (공공 API 쿼터 보호)
const dataLimiter = rateLimit({
  windowMs: 60000,
  max: 30,
  message: { error: '데이터 조회 한도 초과. 잠시 후 다시 시도해주세요.' },
});

app.use('/api/', generalLimiter);

// ── 라우터 연결 ────────────────────────────────────────────
const chatRouter = require('./routes/chat');
const transactionRouter = require('./routes/transactions');
const propertiesRouter = require('./routes/properties');
const regulationsRouter = require('./routes/regulations');
const clauseRouter = require('./routes/clause');
const geocodeRouter = require('./routes/geocode');
const analysisRouter = require('./routes/analysis');

app.use('/api/chat', chatLimiter, chatRouter);
app.use('/api/transactions', dataLimiter, transactionRouter);
app.use('/api/properties', dataLimiter, propertiesRouter);
app.use('/api/regulations', regulationsRouter);
app.use('/api/clause', chatLimiter, clauseRouter);
app.use('/api/geocode', dataLimiter, geocodeRouter);
app.use('/api/analysis', dataLimiter, analysisRouter);

// 헬스체크
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV,
    cache: { keys: cache.keys().length, stats: cache.getStats() },
  });
});

// ── 전역 에러 핸들러 ───────────────────────────────────────
app.use((err, req, res, next) => {
  // 에러 로그는 서버에만, 클라이언트엔 최소 정보만
  console.error(`[${new Date().toISOString()}] ${err.message}`, {
    url: req.url, method: req.method, ip: req.ip,
  });
  const status = err.status || 500;
  res.status(status).json({
    error: process.env.NODE_ENV === 'production'
      ? '서버 오류가 발생했습니다.'
      : err.message,
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: '요청한 리소스를 찾을 수 없습니다.' });
});

// Vercel 서버리스 환경에서는 listen 불필요
if (process.env.VERCEL !== '1') {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`✅ 내집로그 서버 실행 중: http://localhost:${PORT}`);
    console.log(`   환경: ${process.env.NODE_ENV}`);
  });
}

module.exports = app;
module.exports.cache = cache;
