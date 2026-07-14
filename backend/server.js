/**
 * 내집로그(MyHomeLog) - 백엔드 서버
 * 보안: Helmet + CORS + Rate Limiting + Input Validation
 * 캐시: node-cache (Redis 전환 가능)
 */
// ⚠️ Sentry 는 다른 어떤 import 보다 먼저 (v8 auto-instrumentation)
// api/index.js 에서 먼저 로드되지만, 로컬 `npm run dev` 진입점도 방어적으로 중복 로드
require('./sentry');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const dotenv = require('dotenv');
const { makeRateLimiter } = require('./middleware/rateLimit');

dotenv.config();

const logger = require('./logger');
const { maskIp } = require('./logger');

const app = express();

// Vercel/프록시 환경에서 X-Forwarded-For 신뢰 (express-rate-limit 호환)
app.set('trust proxy', 1);

const cache = require('./cache');

// ── 보안 미들웨어 ──────────────────────────────────────────
// CSP 정책:
//   - scriptSrc 에 'unsafe-inline' 이 필요 (index.html 에 3900줄 인라인 <script> 존재).
//     nonce 주입은 Phase 4 이후(Next.js 마이그) 에 도입.
//   - 외부 연결 대상을 화이트리스트로 좁혀 attack surface 최소화.
//   - connectSrc 에 Supabase·Toss·Sentry 도메인 명시 (XHR/Fetch 탈출 방지).
//   - frameSrc 는 Toss Widget 용으로만 허용.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'", // index.html 인라인 스크립트 (Phase 4 이후 nonce 로 교체)
        'https://browser.sentry-cdn.com',
        'https://cdn.jsdelivr.net',
        'https://unpkg.com',
        'https://js.tosspayments.com',
      ],
      scriptSrcAttr: ["'unsafe-inline'"], // onclick="" 등 인라인 핸들러
      styleSrc: [
        "'self'",
        "'unsafe-inline'", // 인라인 style + <style> 블록
        'https://unpkg.com', // leaflet.css
      ],
      imgSrc: [
        "'self'",
        'data:',
        'blob:',
        'https://*.tile.openstreetmap.org',
        'https://server.arcgisonline.com',
        'https://myhomelog.vercel.app',
      ],
      connectSrc: [
        "'self'",
        'https://*.supabase.co',
        'wss://*.supabase.co',
        'https://api.tosspayments.com',
        'https://*.ingest.sentry.io',
        'https://*.ingest.us.sentry.io',
      ],
      frameSrc: ["'self'", 'https://js.tosspayments.com', 'https://*.tosspayments.com'],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: [],
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
  // P0-2 (2026-05-04): PATCH/DELETE/PUT 추가 — 북마크/임장노트/챗 세션 수정·삭제 100% 차단 fix
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '50kb' }));

// ── Phase 19 (2026-05-04): access log middleware ──────────────
// 모든 /api/* 요청의 method/path/status/duration 표준 logger 출력.
// pino 사용 — Sentry breadcrumb 자동 인덱싱 (운영자 디버깅 가속).
// 정적 파일·health 는 noise 차단 (제외).
app.use('/api/', (req, res, next) => {
  const start = Date.now();
  const path = req.originalUrl || req.url;
  // /api/health 는 빈번 (cron·monitoring) — log noise 차단
  if (path.startsWith('/api/health')) return next();
  res.on('finish', () => {
    const dur = Date.now() - start;
    const slow = dur > 3000;
    const errored = res.statusCode >= 500;
    const meta = {
      method: req.method,
      path: path.split('?')[0], // query string 제거 (PII risk)
      status: res.statusCode,
      durationMs: dur,
      userId: req.user?.id ? String(req.user.id).slice(0, 8) : null,
    };
    if (errored) logger.error(meta, 'access');
    else if (slow) logger.warn(meta, 'access slow');
    else logger.info(meta, 'access');
  });
  next();
});

// ── Rate Limiting (Upstash Redis 분산 + in-memory fallback) ─
// 3개 스코프 분리: general(전체) / chat(AI) / data(외부 API 쿼터 보호)
const generalLimiter = makeRateLimiter({
  limit: parseInt(process.env.RATE_LIMIT_MAX || '60'),
  windowSec: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000') / 1000,
  scope: 'general',
  message: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
});

const chatLimiter = makeRateLimiter({
  limit: 20,
  windowSec: 60,
  scope: 'chat',
  keySuffix: ':chat',
  message: 'AI 채팅 요청 한도를 초과했습니다. 1분 후 다시 시도해주세요.',
});

const dataLimiter = makeRateLimiter({
  limit: 30,
  windowSec: 60,
  scope: 'data',
  message: '데이터 조회 한도 초과. 잠시 후 다시 시도해주세요.',
});

app.use('/api/', generalLimiter);

// HF-CHK-2026-07-14 (Sprint HHHHH, 검증 후 즉시 제거 — _brchk/_ecoschk 패턴):
//   운영자 data.go.kr 활용신청(디딤돌 15082028·u-보금자리론 15082039) 완료 → MOLIT_API_KEY 로
//   실호출 검증. 파라미터/응답 구조 추측 배제 — 파라미터 변형 3종 시도해 raw 응답 확인. 키 미노출.
app.get('/api/_hfchk_q72m8', async (req, res) => {
  const key = process.env.MOLIT_API_KEY || '';
  const out = { keyLen: key.length };
  if (!key) return res.json(out);
  const axios = require('axios');
  const tryGet = async (url, params) => {
    try {
      const r = await axios.get(url, { params, timeout: 8000 });
      const d = r.data;
      const s = typeof d === 'string' ? d.slice(0, 500) : JSON.stringify(d).slice(0, 900);
      return { ok: true, preview: s };
    } catch (e) {
      return { ok: false, status: e.response && e.response.status, body: e.response && String(typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data)).slice(0, 300), msg: e.message };
    }
  };
  const variants = [
    { serviceKey: key, pageNo: 1, numOfRows: 5, dataType: 'JSON' },
    { serviceKey: key, pageNo: 1, numOfRows: 5, _type: 'json' },
    { serviceKey: key, pageNo: 1, numOfRows: 5, resultType: 'json' },
  ];
  out.didimdol = [];
  out.uloan = [];
  for (const v of variants) {
    out.didimdol.push(await tryGet('https://apis.data.go.kr/B551408/didimdol-loan-rate/didimdol-info', v));
    out.uloan.push(await tryGet('https://apis.data.go.kr/B551408/u-loan-rate/uloan-info', v));
  }
  res.json(out);
});

// ── 라우터 연결 ────────────────────────────────────────────
const chatRouter = require('./routes/chat');
const transactionRouter = require('./routes/transactions');
const propertiesRouter = require('./routes/properties');
const regulationsRouter = require('./routes/regulations');
const clauseRouter = require('./routes/clause');
// Sprint RR (2026-05-19): 9bow/legalize-kr 통합 — 정부 공식 법령 직접 인용 (환각 차단)
const legalRouter = require('./routes/legal');
const geocodeRouter = require('./routes/geocode');
const analysisRouter = require('./routes/analysis');
const newsRouter = require('./routes/news');
const subscriptionRouter = require('./routes/subscription');
const shareRouter = require('./routes/share');
const bookmarksRouter = require('./routes/bookmarks');
const searchRouter = require('./routes/search');
const billingRouter = require('./routes/billing');
const chatSessionsRouter = require('./routes/chatSessions');
const accountRouter = require('./routes/account');
const cronRouter = require('./routes/cron');
const automatedDecisionRouter = require('./routes/automatedDecision');

// 일일 무료 한도 (BYOK 제거에 따른 무료 체험 정책)
const { dailyLimit, getUsage } = require('./middleware/dailyLimit');
const { optionalAuth } = require('./middleware/auth');
// MOB-AUDIT-2026-05-03: parseInt NaN 검증 — env 오타(DAILY_SEARCH_LIMITS 등) 시 NaN → 모든 사용자 차단 차단
const _parseIntSafe = (v, def) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : def; };
const DAILY_SEARCH_LIMIT = _parseIntSafe(process.env.DAILY_SEARCH_LIMIT, 5);
const DAILY_CHAT_LIMIT = _parseIntSafe(process.env.DAILY_CHAT_LIMIT, 3); // 2026-06-01: 비로그인 AI챗 한도 15→3. Anthropic=유일 변동비라 비로그인 과대(15) 축소 + 로그인 유도. 로그인 free=3+bonus10=13.

// 채팅 세션/메시지 저장 (Supabase — JWT 필수, RLS 적용) — /api/chat 보다 먼저 마운트
app.use('/api/chat/sessions', dataLimiter, chatSessionsRouter);
// AI 엔드포인트: optionalAuth 를 앞단에 — 로그인 유저는 userId 기반 dailyLimit + 월 예산 가드,
// 비로그인은 IP 기반 dailyLimit 만 (월 예산은 로그인 유저 한정).
// P1 (2026-04-25 Phase 2 8-2): 로그인 사용자 보너스 — 비로그인은 base, 로그인 +N
//   chat: base 3 + 로그인 +10 = 13 (162bdbb 2026-06-01: 비로그인 base 15→3)
//   search: base 5 + 로그인 +5 = 10
app.use('/api/chat', optionalAuth, chatLimiter, dailyLimit({ limit: DAILY_CHAT_LIMIT, scope: 'chat', loggedInBonus: 10 }), chatRouter);
app.use('/api/transactions', dataLimiter, transactionRouter);
app.use('/api/properties', optionalAuth, dataLimiter, dailyLimit({ limit: DAILY_SEARCH_LIMIT, scope: 'search', loggedInBonus: 5 }), propertiesRouter);
app.use('/api/regulations', regulationsRouter);
// Sprint RR: 정부 공식 법령 API (인증 불필요 — 공개 정보)
app.use('/api/legal', dataLimiter, legalRouter);
app.use('/api/clause', optionalAuth, chatLimiter, dailyLimit({ limit: DAILY_CHAT_LIMIT, scope: 'chat', loggedInBonus: 10 }), clauseRouter);
app.use('/api/geocode', dataLimiter, geocodeRouter);
app.use('/api/analysis', dataLimiter, analysisRouter);
app.use('/api/news', optionalAuth, dataLimiter, newsRouter);
app.use('/api/subscription', dataLimiter, subscriptionRouter);
// 북마크 (Supabase 백엔드 — JWT 필수, RLS 적용)
app.use('/api/bookmarks', dataLimiter, bookmarksRouter);
// 검색 이력 (Supabase 백엔드 — JWT 필수, RLS 적용)
app.use('/api/search', dataLimiter, searchRouter);
// 결제/구독 (Toss Payments — JWT 필수, service_role 전용 쓰기)
app.use('/api/billing', dataLimiter, billingRouter);
// AI 답변 사용자 피드백 (Phase 3 — 정합성 측정 인프라)
app.use('/api/feedback', dataLimiter, require('./routes/feedback'));
// 임장노트 클라우드 동기화 (Phase 4 — 기존 localStorage → DB sync)
app.use('/api/field-notes', dataLimiter, require('./routes/fieldNotes'));
// Phase 5 (2026-04-26): 1Page 컨설팅 보고서 자동 생성 — 핵심 USP
// Phase B-5 (2026-05-01): chat scope → 별도 'report' scope. 비용 4배 단가에 맞는 한도 분리.
//   비로그인: 0 (로그인 유도) / 로그인 free: 1/일 (체험) / pro: 5/일 / team: 15/일
app.use('/api/report', optionalAuth, chatLimiter, dailyLimit({ limit: 0, scope: 'report', loggedInBonus: 1 }), require('./routes/report'));
// 계정 데이터 자기결정권 (PIPA 제35·36조 / GDPR Art.15·17) — JWT 필수
// GDPR Art.22 / PIPA 자동화 결정 설명권 — JWT 필수 (account 보다 먼저 마운트: prefix 세부 우선)
app.use('/api/account/automated-decision', dataLimiter, automatedDecisionRouter);
app.use('/api/account', dataLimiter, accountRouter);
// Cron 엔드포인트 — Vercel Cron 에서 호출 (CRON_SECRET 필수)
app.use('/api/cron', cronRouter);
// 관리자 전용 엔드포인트 — ADMIN_EMAILS 화이트리스트 인증
// STAB-AUDIT-2026-05-07: geocache 백필 즉시 trigger 등 (cron 다음 tick 전 운영자 직접 호출)
app.use('/api/admin', dataLimiter, require('./routes/admin'));
// 공유 딥링크 — 크롤러용 OG 메타 치환 (HTML 서빙)
app.use('/share', shareRouter);

// STAB-3 (2026-05-03): /api/admin/kapt-diag endpoint 제거
//   사유: KAPT API 키 진단용 임시 endpoint. 활용신청 확인 후 역할 종료.
//        - 운영 단계에서 사용 빈도 0
//        - 잠재 정보 leak (API 키 prefix·길이 노출)
//        - admin only 라도 외부 노출면 production 에 둘 이유 없음
//        - 필요 시 git history 에서 복원 가능 (server.js commit 7개 이전)
//   영향: 운영자 본인 외 사용자 0건 (admin only 였음).

// ── API 활성화 진단 (운영자 전용 — x-health-key 헤더 필수) ────
// Phase 1.8: 과거 공개 엔드포인트는 외부 API 쿼터(MOLIT 1만/일, Kakao 30만/일) 소진 공격에 노출 →
//   1) HEALTH_API_KEY 환경변수 미설정 시 404 (production 기본 차단)
//   2) 헤더 불일치 시 404 (존재 자체 비공개)
//   3) 인증 통과 시에도 30초 결과 캐시 — 폭주 방지
app.get('/api/health/apis', async (req, res) => {
  const expected = process.env.HEALTH_API_KEY;
  const provided = req.headers['x-health-key'];
  if (!expected || provided !== expected) {
    return res.status(404).json({ error: 'Not Found' });
  }

  // 30초 결과 캐시 — 같은 운영자가 새로고침해도 외부 API 안 때림
  const HEALTH_CACHE_KEY = 'health:apis:v1';
  const cached = cache.get(HEALTH_CACHE_KEY);
  if (cached) {
    return res.json({ ...cached, fromCache: true });
  }

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

  const result = { timestamp: new Date().toISOString(), checks };
  cache.set(HEALTH_CACHE_KEY, result, 30); // 30s
  res.json(result);
});

// 헬스체크 (사용 한도 잔량 포함 — 프론트 사용 한도 표시에 사용)
// getUsage 가 Redis 연동으로 async 가 되었으므로 핸들러도 async
// Phase 3.3 + 4.9: 검색·AI 일일 잔량 + 월 예산 잔여 동시 반환 — 헤더 pill / 구독 CTA 용
const budgetService = require('./services/budgetService');

// DATA-COUNTS-2026-06-14: 랜딩/배너 표시 건수 동적화(하드코딩 stale 방지). 일 단위 변동(MOLIT ingest) → node-cache 6h, head:true(행 미전송이라 가벼움).
async function getDataCounts() {
  const CK = 'meta:dataCounts';
  const hit = cache.get(CK);
  if (hit) return hit;
  try {
    const { getSupabaseAdmin } = require('./db/client');
    const admin = getSupabaseAdmin();
    if (!admin) return null;
    const [tx, apt] = await Promise.all([
      admin.from('molit_transactions').select('*', { count: 'exact', head: true }),
      admin.from('apt_master').select('*', { count: 'exact', head: true }),
    ]);
    const out = { tx: tx.count || 0, apt: apt.count || 0 };
    cache.set(CK, out, 21600); // 6h
    return out;
  } catch (e) { return null; }
}

// DB-STABILITY-2026-07-11 (Sprint OOOO): 무료 500MB 한도 조기경보 — 초과 시 쓰기 실패=서비스 다운.
//   pg_database_size 는 RPC(get_db_size_bytes) 필요 — 미생성 시 graceful null(운영자 SQL 실행 전엔 비활성, 무해).
async function getDbUsage() {
  const CK = 'meta:dbUsage';
  const hit = cache.get(CK);
  if (hit) return hit;
  try {
    const { getSupabaseAdmin } = require('./db/client');
    const admin = getSupabaseAdmin();
    if (!admin) return null;
    const { data, error } = await admin.rpc('get_db_size_bytes');
    if (error || data == null) return null;
    const usedMb = Math.round(Number(data) / (1024 * 1024));
    const limitMb = parseInt(process.env.DB_LIMIT_MB || '500', 10); // Supabase free tier
    const pct = limitMb > 0 ? Math.round((usedMb / limitMb) * 100) : null;
    const out = { usedMb, limitMb, pct, warn: pct != null && pct >= 80 };
    cache.set(CK, out, 21600); // 6h — DB 용량은 일 단위 완만 변동
    return out;
  } catch (e) { return null; }
}

// DATA-QUALITY-MONITOR-2026-07-12 (Sprint AAAAA, 운영자 "이런 에러 사전 자동검출 — 일일이 안 찾게"):
//   apt_master.facility 데이터 품질 지표. 주차(_dtl) 누락·세대수 0·KAPT 조회실패(_empty)·facility 없음을
//   카운트해 /api/health 로 노출 + warn 플래그(임계 초과). count head 쿼리 5개(6h 캐시)라 부하 무시.
//   ⚠ 조건은 검증된 SQL 과 동일(주차누락 dtl null·세대수0 kaptdaCnt 0/null·_empty 키 존재). 배포 후 실측 대조.
async function getFacilityQuality() {
  const CK = 'meta:facilityQuality';
  const hit = cache.get(CK);
  if (hit) return hit;
  try {
    const { getSupabaseAdmin } = require('./db/client');
    const admin = getSupabaseAdmin();
    if (!admin) return null;
    const H = () => ['*', { count: 'exact', head: true }];
    const [total, facNull, empty, dtlMissing, hhZero] = await Promise.all([
      admin.from('apt_master').select(...H()),
      admin.from('apt_master').select(...H()).is('facility', null),
      admin.from('apt_master').select(...H()).not('facility->_empty', 'is', null),
      admin.from('apt_master').select(...H()).not('facility', 'is', null).is('facility->_empty', null).is('facility->_dtl', null),
      admin.from('apt_master').select(...H()).not('facility', 'is', null).is('facility->_empty', null).or('facility->>kaptdaCnt.eq.0,facility->>kaptdaCnt.is.null'),
    ]);
    const t = total.count || 0;
    const dtl = dtlMissing.count || 0, hh = hhZero.count || 0, emp = empty.count || 0, fnull = facNull.count || 0;
    const dtlPct = t > 0 ? Math.round((dtl / t) * 100) : null;
    const out = {
      total: t,
      facilityNull: fnull,          // facility 미적재 (백필 대상)
      emptyFetch: emp,              // KAPT 조회 실패 sentinel
      parkingMissing: dtl,          // 주차(_dtl) 누락 → 주차필터 제외 원인
      parkingMissingPct: dtlPct,
      householdsZero: hh,           // 세대수 0/null → "미상" 표시
      warn: (dtlPct != null && dtlPct >= 15) || hh >= 200 || emp >= 50 || fnull >= 10,
    };
    // 자동 사전검출: 품질 저하 시 Sentry 경보(6h 캐시라 최대 6h 1회 — 스팸 없음). 운영자가 직접 안 찾아도 통지.
    if (out.warn) {
      try {
        const Sentry = require('@sentry/node');
        Sentry.captureMessage(
          `facility 데이터 품질 경보: 주차누락 ${dtl}(${dtlPct}%)·세대수0 ${hh}·조회실패 ${emp}·미적재 ${fnull}`,
          { level: 'warning', tags: { monitor: 'facility-quality' }, extra: out }
        );
      } catch (_) {}
    }
    cache.set(CK, out, 21600); // 6h — 데이터 품질은 일 단위 완만 변동(백필 cron 이후 갱신)
    return out;
  } catch (e) { return null; }
}

app.get('/api/health', optionalAuth, async (req, res) => {
  const [searchUsed, chatUsed] = await Promise.all([
    getUsage(req, 'search'),
    getUsage(req, 'chat'),
  ]);

  // 월 예산 (로그인 사용자 한정)
  let monthlyBudget = null;
  if (req.user?.id) {
    const b = await budgetService.checkBudget(req.user.id);
    if (b) {
      monthlyBudget = {
        usedUsd: (b.usedX1000 / 1000 / 1000).toFixed(3),
        limitUsd: (b.limitX1000 / 1000 / 1000).toFixed(2),
        remainingPct: Math.max(0, Math.round((1 - b.usedX1000 / b.limitX1000) * 100)),
        resetAt: b.resetAt.toISOString(),
        exceeded: !b.allowed,
      };
    }
  }

  // MOB-AUDIT-2026-05-03: STAB #42 — ai_ready·deploy version 추가 (운영자 키 만료·배포 추적)
  const _aiReady = !!process.env.ANTHROPIC_API_KEY;
  const _deploy = process.env.VERCEL_GIT_COMMIT_SHA ? process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7) : null;
  // MOB-AUDIT-2026-05-03: regulations stale 알림 — 6개월(180일) 초과 시 운영자 갱신 신호
  let _regulations = null;
  try {
    const regSvc = require('./services/regulationsService');
    const [housing, tax] = await Promise.all([
      regSvc.getSnapshot('housing_loan_2025').catch(() => null),
      regSvc.getSnapshot('acquisition_tax_2025').catch(() => null),
    ]);
    _regulations = {
      housing_loan: { effectiveDate: housing?.effectiveDate, daysSince: housing?.daysSinceEffective, stale: (housing?.daysSinceEffective || 0) > 180, source: housing?.source },
      acquisition_tax: { effectiveDate: tax?.effectiveDate, daysSince: tax?.daysSinceEffective, stale: (tax?.daysSinceEffective || 0) > 180, source: tax?.source },
    };
  } catch(_){}
  // NAVER-MAPS-2026-05-13 (Sprint GG): NCP Web Dynamic Map client ID 노출 (public — frontend SDK 로드용)
  //   env NAVER_MAPS_CLIENT_ID 설정 시 frontend 가 네이버 지도 사용, 미설정 시 Leaflet/OSM fallback.
  //   NCP 정책: client ID 는 도메인 등록 기반 보호 (다른 도메인에서 사용 불가) — 공개해도 안전.
  const _naverMapsClientId = process.env.NAVER_MAPS_CLIENT_ID || null;
  const _dataCounts = await getDataCounts();
  const _dbUsage = await getDbUsage();
  // 데이터 품질 모니터 (Sprint AAAAA) — HOTPATH-NONBLOCK-2026-07-12 (Sprint DDDDD): count 5개가 콜드 health 를
  //   ~2s 느리게 해 chkAPI 5s 타임아웃 오프라인 오표시 유발 → health 핫패스에선 캐시만 읽고, 미스 시 백그라운드
  //   계산 트리거 후 이번엔 null 반환(health 지연 0). 다음 호출부터 값 노출.
  let _facQuality = cache.get('meta:facilityQuality');
  if (_facQuality === undefined) { _facQuality = null; getFacilityQuality().catch(() => {}); }
  // ECOS-2026-07-13 (Sprint FFFFF): 시중 금리(기준금리·주담대 가중평균) — facilityQuality 와 동일 비차단 패턴.
  let _ecosRates = cache.get('ecos:rates:v1');
  if (_ecosRates === undefined) { _ecosRates = null; try { require('./services/ecosService').getEcosRates().catch(() => {}); } catch (_) {} }
  // QUOTA-PLAN-2026-07-12 (Sprint YYYY, 운영자 "admin 인데 검색 0/5 표시"): usage 한도를 사용자 plan 반영.
  //   기존엔 DAILY_SEARCH_LIMIT(=5) 고정 → admin·pro·로그인free 모두 5로 오표시(admin 은 초과 시 0/5).
  //   dailyLimit 과 동일 규칙: admin 무제한 · pro/team 플랜한도 · 로그인 free 는 base+bonus(검색5·챗10).
  let _searchLimit = DAILY_SEARCH_LIMIT, _chatLimit = DAILY_CHAT_LIMIT, _unlimited = false;
  try {
    const { isAdminEmail, getActivePlan, getLimitsForPlan } = require('./services/planService');
    if (isAdminEmail(req.user?.email)) {
      _unlimited = true;
    } else if (req.user?.id) {
      const _plan = await getActivePlan(req.user.id);
      if (_plan === 'admin') _unlimited = true;
      else if (_plan !== 'free') { const _pl = getLimitsForPlan(_plan); _searchLimit = _pl.dailySearch || _searchLimit; _chatLimit = _pl.dailyChat || _chatLimit; }
      else { _searchLimit += 5; _chatLimit += 10; } // 로그인 free 보너스 (loggedInBonus: search 5·chat 10)
    }
  } catch (_) {}
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV,
    deploy: _deploy,
    ai_ready: _aiReady,
    naverMapsClientId: _naverMapsClientId,
    dataCounts: _dataCounts,
    db: _dbUsage,
    facilityQuality: _facQuality,
    ecosRates: _ecosRates,
    regulations: _regulations,
    cache: { keys: cache.keys().length, stats: cache.getStats() },
    usage: _unlimited
      ? { used: searchUsed, limit: '무제한', remaining: '무제한', unlimited: true }
      : { used: searchUsed, limit: _searchLimit, remaining: Math.max(0, _searchLimit - searchUsed) },
    chat: _unlimited
      ? { used: chatUsed, limit: '무제한', remaining: '무제한', unlimited: true }
      : { used: chatUsed, limit: _chatLimit, remaining: Math.max(0, _chatLimit - chatUsed) },
    monthlyBudget,
    // kakaoQuota: geocodeCacheService 좌표해결 경로의 부분 지표 (_trackKakaoCall 집계분).
    //   directions/category/학교·학원 검색/geocode-batch 직접 호출은 미포함 — 전체 Kakao 사용량 아님.
    // 무료 한도 100K/일, 60K 도달 시 Sentry alert. 운영자 대시보드/모니터링 용도.
    kakaoQuota: (() => {
      try {
        const { getKakaoUsageStats } = require('./services/geocodeCacheService');
        return getKakaoUsageStats();
      } catch (_) { return null; }
    })(),
  });
});

// ── Sentry 에러 핸들러 (우리 에러 핸들러보다 먼저) ─────────
// v8 는 setupExpressErrorHandler 로 모든 라우트 에러를 자동 캡쳐
const Sentry = require('@sentry/node');
Sentry.setupExpressErrorHandler(app);

// ── 전역 에러 핸들러 ───────────────────────────────────────
app.use((err, req, res, next) => {
  // 에러 로그는 서버에만, 클라이언트엔 최소 정보만 — IP 는 /24 마스킹 (PII 최소화)
  logger.error({
    err,
    url: req.url,
    method: req.method,
    ip: maskIp(req.ip),
    status: err.status || 500,
  }, '요청 처리 실패');
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
    logger.info({ port: PORT, env: process.env.NODE_ENV }, '내집로그 서버 시작');
  });
}

module.exports = app;
module.exports.cache = cache;
