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

// Vercel/프록시 환경에서 X-Forwarded-For 신뢰 (express-rate-limit 호환)
app.set('trust proxy', 1);

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
const newsRouter = require('./routes/news');
const subscriptionRouter = require('./routes/subscription');

// 일일 무료 한도 (BYOK 제거에 따른 무료 체험 정책)
const { dailyLimit, getUsage } = require('./middleware/dailyLimit');
const DAILY_SEARCH_LIMIT = parseInt(process.env.DAILY_SEARCH_LIMIT || '5');
const DAILY_CHAT_LIMIT = parseInt(process.env.DAILY_CHAT_LIMIT || '15');

app.use('/api/chat', chatLimiter, dailyLimit({ limit: DAILY_CHAT_LIMIT, scope: 'chat' }), chatRouter);
app.use('/api/transactions', dataLimiter, transactionRouter);
app.use('/api/properties', dataLimiter, dailyLimit({ limit: DAILY_SEARCH_LIMIT, scope: 'search' }), propertiesRouter);
app.use('/api/regulations', regulationsRouter);
app.use('/api/clause', chatLimiter, dailyLimit({ limit: DAILY_CHAT_LIMIT, scope: 'chat' }), clauseRouter);
app.use('/api/geocode', dataLimiter, geocodeRouter);
app.use('/api/analysis', dataLimiter, analysisRouter);
app.use('/api/news', dataLimiter, newsRouter);
app.use('/api/subscription', dataLimiter, subscriptionRouter);

// ── API 활성화 진단 (공개 — 데이터 소스 현황 확인용) ────
app.get('/api/health/apis', async (req, res) => {
  const axios = require('axios');
  const molit = process.env.MOLIT_API_KEY;
  const kakao = process.env.KAKAO_REST_API_KEY;
  const checks = { molit_key: !!molit, kakao_key: !!kakao };

  // 1) MOLIT 실거래가 (활성 필수) — 최근 완료된 달 사용 (당월은 데이터 없을 수 있음)
  if (molit) {
    try {
      const d = new Date();
      const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
      const ym = `${prev.getFullYear()}${String(prev.getMonth() + 1).padStart(2, '0')}`;
      const r = await axios.get('https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev', {
        params: { serviceKey: molit, LAWD_CD: '11350', DEAL_YMD: ym, pageNo: 1, numOfRows: 1, _type: 'json' },
        timeout: 6000,
        headers: { Accept: 'application/json' },
      });
      const code = r.data?.response?.header?.resultCode;
      const msg = r.data?.response?.header?.resultMsg;
      const rawType = typeof r.data;
      // 성공 코드: '00' (구버전) 또는 '000' (신버전 MOLIT)
      checks.molit_transaction = code === '00' || code === '000';
      checks.molit_transaction_code = code;
      checks.molit_transaction_msg = msg;
      // 일부 API가 XML로 응답하거나 에러 페이지를 HTML로 주는 경우 감지
      if (!code) {
        checks.molit_transaction_raw = typeof r.data === 'string' ? String(r.data).slice(0, 300) : rawType;
      }
      checks.molit_transaction_ymd = ym;
    } catch (e) {
      checks.molit_transaction = false;
      checks.molit_transaction_err = e.response?.status ? `HTTP ${e.response.status}` : e.message;
    }
  }

  // 2) K-apt 단지 리스트 (AptListService3)
  if (molit) {
    try {
      const r = await axios.get('https://apis.data.go.kr/1613000/AptListService3/getSigunguAptList3', {
        params: { serviceKey: molit, sigunguCode: '11350', numOfRows: 1, pageNo: 1, _type: 'json' },
        timeout: 6000,
      });
      const code = r.data?.response?.header?.resultCode;
      checks.kapt_list = code === '00' || code === '000';
      checks.kapt_list_code = code;
      checks.kapt_list_msg = r.data?.response?.header?.resultMsg;
    } catch (e) { checks.kapt_list = false; checks.kapt_list_err = e.response?.status ? `HTTP ${e.response.status}` : e.message; }
  }

  // 3) K-apt 단지 기본정보 (AptBasisInfoServiceV3)
  if (molit) {
    try {
      const r = await axios.get('https://apis.data.go.kr/1613000/AptBasisInfoServiceV3/getAphusBassInfoV3', {
        params: { serviceKey: molit, kaptCode: 'A10020255', _type: 'json' },
        timeout: 6000,
        headers: { Accept: 'application/json' },
      });
      const code = r.data?.response?.header?.resultCode;
      checks.kapt_basis = code === '00' || code === '000';
      checks.kapt_basis_code = code;
      checks.kapt_basis_msg = r.data?.response?.header?.resultMsg;
      if (!code) {
        checks.kapt_basis_raw = typeof r.data === 'string' ? String(r.data).slice(0, 300) : typeof r.data;
      }
    } catch (e) {
      checks.kapt_basis = false;
      checks.kapt_basis_err = e.response?.status ? `HTTP ${e.response.status}` : e.message;
    }
  }

  // 4) Kakao 로컬 키워드 검색
  if (kakao) {
    try {
      const r = await axios.get('https://dapi.kakao.com/v2/local/search/keyword.json', {
        headers: { Authorization: `KakaoAK ${kakao}` },
        params: { query: '강남역', size: 1 },
        timeout: 5000,
      });
      checks.kakao_keyword = (r.data?.meta?.total_count || 0) > 0;
    } catch (e) { checks.kakao_keyword = false; checks.kakao_keyword_err = e.response?.status || e.message; }
  }

  // 5) Kakao 카테고리 검색 (주변시설)
  if (kakao) {
    try {
      const r = await axios.get('https://dapi.kakao.com/v2/local/search/category.json', {
        headers: { Authorization: `KakaoAK ${kakao}` },
        params: { category_group_code: 'SC4', x: 127.06, y: 37.65, radius: 500 },
        timeout: 5000,
      });
      checks.kakao_category = (r.data?.meta?.total_count || 0) >= 0;
    } catch (e) { checks.kakao_category = false; }
  }

  // 6) Kakao 모빌리티 directions
  if (kakao) {
    try {
      const r = await axios.get('https://apis-navi.kakaomobility.com/v1/directions', {
        headers: { Authorization: `KakaoAK ${kakao}` },
        params: { origin: '127.06,37.65', destination: '127.03,37.50', priority: 'RECOMMEND' },
        timeout: 6000,
      });
      checks.kakao_mobility = !!r.data?.routes?.[0]?.summary?.duration;
    } catch (e) { checks.kakao_mobility = false; checks.kakao_mobility_err = e.response?.status || e.message; }
  }

  res.json({ timestamp: new Date().toISOString(), checks });
});

// 헬스체크 (사용 한도 잔량 포함 — 프론트 사용 한도 표시에 사용)
app.get('/api/health', (req, res) => {
  const used = getUsage(req, 'search');
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV,
    cache: { keys: cache.keys().length, stats: cache.getStats() },
    usage: {
      used,
      limit: DAILY_SEARCH_LIMIT,
      remaining: Math.max(0, DAILY_SEARCH_LIMIT - used),
    },
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
