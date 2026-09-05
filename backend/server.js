/**
 * 내집로그(MyHomeLog) - 백엔드 서버
 * 보안: Helmet + CORS + Rate Limiting + Input Validation
 * 캐시: node-cache (Redis 전환 가능)
 */
// ⚠️ Sentry 는 다른 어떤 import 보다 먼저 (v8 auto-instrumentation)
// api/index.js 에서 먼저 로드되지만, 로컬 `npm run dev` 진입점도 방어적으로 중복 로드
const Sentry = require('./sentry');

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

// ── TRACE-FALLBACK-2026-08-09 (Sprint JJJJJJJ): Vercel 프로덕션 HTTP 스팬 수동 폴백 ──
//   v10 업그레이드 후 프로덕션에서만 트랜잭션 스팬 0건(FFFFFFF 판별: 로컬은 정상 생성 →
//   SDK·설정 정상, Vercel 환경에서 OTel 자동 계측 미부착). 활성 span 이 이미 있으면
//   (=자동 계측이 동작하는 환경) no-op 이라 중복 생성이 구조적으로 불가능하고, 없을 때만
//   공식 API(startSpan+forceTransaction)로 수동 트랜잭션을 연다. 샘플링은 SDK 가
//   tracesSampleRate 로 동일 적용. 실패는 전부 삼켜 응답 경로를 보호한다.
app.use((req, res, next) => {
  let nextCalled = false;
  const safeNext = () => { if (!nextCalled) { nextCalled = true; next(); } };
  try {
    if (!Sentry.isEnabled || typeof Sentry.startSpan !== 'function' || Sentry.getActiveSpan()) {
      return safeNext();
    }
    Sentry.startSpan(
      {
        name: `${req.method} ${req.path}`,
        op: 'http.server',
        forceTransaction: true,
        attributes: { 'http.request.method': req.method, 'url.path': req.path, 'sentry.source': 'url' },
      },
      (span) => new Promise((resolve) => {
        const done = () => {
          try {
            span.setAttribute('http.response.status_code', res.statusCode);
            span.setStatus({ code: res.statusCode >= 500 ? 2 : 1 }); // 2=error, 1=ok
          } catch (_) { /* span 상태 실패 무시 */ }
          resolve();
        };
        res.once('finish', done);
        res.once('close', done); // 클라이언트 중단도 종료 처리 (중복 resolve 무해)
        safeNext();
      })
    );
  } catch (_) { safeNext(); }
});

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
      // ⚠ CSP-SHARE-2026-08-25 (Sprint NNNNNNN-22): 이 CSP 는 Express 를 거치는 경로에만 붙는다
      //   (vercel.json 상 /api/*, /share*, /briefing*, /sitemap.xml). 루트 / 는 정적 서빙이라 CSP 가 없다.
      //   그래서 **같은 index.html 인데 /share 에서만** 네이버 지도 SDK·Pretendard·Sora 가 차단되고 있었다
      //   (라이브 콘솔 실측: "Refused to load ... violates ... Content Security Policy" 4건 + Leaflet 폴백).
      //   공유 링크는 신규 방문자의 첫 화면이라 폰트·지도가 깨진 채 노출되던 것 — 아래 도메인은
      //   루트에서 실제 로드되는 것만 performance.getEntriesByType('resource') 로 실측해 추가했다.
      scriptSrc: [
        "'self'",
        "'unsafe-inline'", // index.html 인라인 스크립트 (Phase 4 이후 nonce 로 교체)
        'https://browser.sentry-cdn.com',
        'https://cdn.jsdelivr.net',
        'https://unpkg.com',
        'https://js.tosspayments.com',
        'https://oapi.map.naver.com', // 네이버 지도 SDK 본체
        'https://*.pstatic.net',      // 지도 SDK 가 이어서 부르는 스크립트(nrbe/ssl 등 호스트 분산)
      ],
      scriptSrcAttr: ["'unsafe-inline'"], // onclick="" 등 인라인 핸들러
      styleSrc: [
        "'self'",
        "'unsafe-inline'", // 인라인 style + <style> 블록
        'https://unpkg.com', // leaflet.css
        'https://cdn.jsdelivr.net',    // Pretendard Variable
        'https://fonts.googleapis.com', // Sora · JetBrains Mono
        'https://*.pstatic.net',        // 지도 SDK 스타일
      ],
      imgSrc: [
        "'self'",
        'data:',
        'blob:',
        'https://*.tile.openstreetmap.org',
        'https://server.arcgisonline.com',
        'https://myhomelog.vercel.app',
        'https://*.pstatic.net', // 네이버 지도 타일·마커 이미지
      ],
      connectSrc: [
        "'self'",
        'https://*.supabase.co',
        'wss://*.supabase.co',
        'https://api.tosspayments.com',
        'https://*.ingest.sentry.io',
        'https://*.ingest.us.sentry.io',
        'https://oapi.map.naver.com',
        'https://*.pstatic.net',
        'https://*.navercorp.com', // 지도 SDK 내부 로그 수집(nelo) — 차단 시 콘솔 에러만 남는다
      ],
      frameSrc: ["'self'", 'https://js.tosspayments.com', 'https://*.tosspayments.com'],
      fontSrc: [
        "'self'",
        'data:',
        'https://cdn.jsdelivr.net',  // Pretendard woff2
        'https://fonts.gstatic.com', // Google Fonts 실제 폰트 파일
      ],
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
// CHAT-ZERO-COST-2026-08-12 (Sprint KKKKKKK-16): 챗이 룰베이스 데이터 라우터로 전환되며 한도의
//   근거였던 "Anthropic=유일 변동비"가 소멸 → 3 → 30 상향(운영자 "최대한 활용"). 비용은 DB 조회뿐이고
//   분당 chatLimiter 가 버스트를 방어한다. 특약(clause)은 여전히 Anthropic 유료 경로라 **별도 상수·별도
//   scope** 로 분리 — 종전엔 scope 'chat' 공유라 챗 사용이 특약 한도를 잠식했는데, 챗 30 상향 시
//   공유 유지하면 특약이 사실상 무제한이 되는 구멍이 생긴다.
const DAILY_CHAT_LIMIT = _parseIntSafe(process.env.DAILY_CHAT_LIMIT, 30);
const DAILY_CLAUSE_LIMIT = _parseIntSafe(process.env.DAILY_CLAUSE_LIMIT, 3); // 기존 유료 한도 그대로

// 채팅 세션/메시지 저장 (Supabase — JWT 필수, RLS 적용) — /api/chat 보다 먼저 마운트
app.use('/api/chat/sessions', dataLimiter, chatSessionsRouter);
// AI 엔드포인트: optionalAuth 를 앞단에 — 로그인 유저는 userId 기반 dailyLimit + 월 예산 가드,
// 비로그인은 IP 기반 dailyLimit 만 (월 예산은 로그인 유저 한정).
// P1 (2026-04-25 Phase 2 8-2): 로그인 사용자 보너스 — 비로그인은 base, 로그인 +N
//   chat: base = DAILY_CHAT_LIMIT(기본 30) + 로그인 +10 = 40
//     QUOTA-TRUTH-2026-08-16 (Sprint NNNNNNN): 이 줄이 "base 3 → 13" 으로 stale 이었고, 프론트
//     사용법 탭도 그 옛 숫자("무료 일 3회")를 하드코딩해 사용자에게 **실제의 1/10** 로 안내했다.
//     한도 숫자는 이 상수(그리고 /api/health 응답)가 유일한 진실 — 주석·HTML 에 복제하지 말 것.
//   search: base = DAILY_SEARCH_LIMIT(기본 5) + 로그인 +5 = 10
app.use('/api/chat', optionalAuth, chatLimiter, dailyLimit({ limit: DAILY_CHAT_LIMIT, scope: 'chat', loggedInBonus: 10 }), chatRouter);
app.use('/api/transactions', dataLimiter, transactionRouter);
app.use('/api/properties', optionalAuth, dataLimiter, dailyLimit({ limit: DAILY_SEARCH_LIMIT, scope: 'search', loggedInBonus: 5 }), propertiesRouter);
app.use('/api/regulations', regulationsRouter);
// REGION-DASH-2026-07-25 (Sprint TTTTTT): 지역 대시보드 — 공식 통계 조립(AI 0·DB 변경 0).
//   공개 정보라 인증 불필요, dataLimiter 만 적용(검색과 동일 등급).
app.use('/api/region', dataLimiter, require('./routes/region'));
// DEAD-ENDPOINT-REMOVED-2026-09-05 (감사 P2-11): /api/legal(법령 코퍼스) 제거 — 프론트는 law.go.kr 을 직접 링크하고
//   이 API 를 부르는 곳이 없었다(호출 0건). RAG/법령 효력 비교는 감사 L(만들지 말 것)에서 폐기 확정.
app.use('/api/clause', optionalAuth, chatLimiter, dailyLimit({ limit: DAILY_CLAUSE_LIMIT, scope: 'clause', loggedInBonus: 10 }), clauseRouter);
// GEOCAP-2026-08-09 (Plan 002): 공개 라우트 + 자유 텍스트 캐시 키 = Kakao 호출 증폭 벡터 —
//   IP 일일 캡(요청 단위 60/일, 정상 지도 사용 여유) + 라우트 내부 전역 일일 캡(geocode.js) 이중 상한.
app.use('/api/geocode', dataLimiter, dailyLimit({ limit: 60, scope: 'geocode' }), geocodeRouter);
app.use('/api/analysis', dataLimiter, analysisRouter);
app.use('/api/news', optionalAuth, dataLimiter, newsRouter);
app.use('/api/subscription', dataLimiter, subscriptionRouter);
// 웹푸시 구독 (Sprint EEEEEE — 익명 동작, VAPID/테이블 게이트 미충족 시 no-op)
app.use('/api/push', dataLimiter, require('./routes/push'));
// 카카오 연결 해제 웹훅 (Sprint NNNNNNN-22) — 카카오 서버가 호출하는 엔드포인트.
//   ⚠ dataLimiter 앞에 마운트하는 이유: 카카오는 3초 내 200 을 요구하고, 비-200 이 반복되면 웹훅을
//     비활성화한다. 사용자 IP 기준 레이트리밋에 걸려 429 가 나가면 그 자체로 웹훅이 죽는다.
//     대신 Authorization(어드민 키) 검증이 라우트 내부의 실질 게이트다.
app.use('/api/kakao/unlink-callback', require('./routes/kakaoWebhook'));
// 카카오톡 알림 연결 (Sprint FFFFFF — portai Memo API 패턴, 콘솔/테이블 게이트 미충족 시 no-op)
app.use('/api/kakao', dataLimiter, require('./routes/kakao'));
// 북마크 (Supabase 백엔드 — JWT 필수, RLS 적용)
app.use('/api/bookmarks', dataLimiter, bookmarksRouter);
// 검색 이력 (Supabase 백엔드 — JWT 필수, RLS 적용)
app.use('/api/search', dataLimiter, searchRouter);
// 결제/구독 (Toss Payments — JWT 필수, service_role 전용 쓰기)
app.use('/api/billing', dataLimiter, billingRouter);
// AI 답변 사용자 피드백 (Phase 3 — 정합성 측정 인프라)
app.use('/api/feedback', dataLimiter, require('./routes/feedback'));
// ATTRIBUTION-2026-08-29 (Sprint NNNNNNN-31): 유입 채널 자체 기록(개인 식별자 미수집).
//   Vercel Web Analytics 조회 API 가 이 플랜에서 404 라 채널 판단 근거가 없었다.
app.use('/api/attribution', dataLimiter, require('./routes/attribution'));
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
// BRIEFING-ARCHIVE-2026-08-19 (Sprint NNNNNNN-6): 날짜별 서버렌더 브리핑(SEO·공유 실체) — /share 와 같은 계열.
app.use('/briefing', require('./routes/briefing'));
// REGION-PAGE-2026-08-29 (Sprint NNNNNNN-31): 서버렌더 지역 페이지 118개 — /briefing 과 같은 계열.
//   실측 배경: sitemap 이 16개 URL 뿐이었다(단지·지역 페이지 0개). SEO 유입과 SNS 링크 도착지를 동시에 만든다.
//   ⚠ vercel.json 의 routes 에 `/region(.*)` 를 넣지 않으면 정적 catch-all 로 빠져 index.html 이 나간다.
app.use('/region', require('./routes/regionPage'));
// APT-PAGE-2026-08-29 (Sprint NNNNNNN-32): 단지별 서버렌더 페이지 — 한국 검색의 주력은 "단지명 + 실거래가" 다.
//   ⚠ vercel.json 의 routes 에 `/apt(.*)` 를 넣지 않으면 정적 catch-all 로 빠져 index.html 이 나간다.
app.use('/apt', require('./routes/aptPage'));
// OG-IMAGE-DYNAMIC-2026-09-02 (Sprint RRRRRRR): 단지별 링크 미리보기 이미지.
//   `/api/(.*)` 가 이미 이 함수로 라우팅되므로 vercel.json 변경은 필요 없다(실측 확인).
//   satori·resvg 는 렌더 시점에만 지연 로드된다 — 다른 요청의 콜드스타트에 얹히지 않는다.
app.use('/api/og', require('./routes/ogImage'));
// SITEMAP-DYNAMIC-2026-08-19 (Sprint NNNNNNN-7B): /sitemap.xml 동적 생성 — briefing 아카이브 반영(정적 파일 대체).
app.use('/sitemap.xml', require('./routes/sitemap'));

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

  const axios = require('axios'); // Kakao 진단용
  const dgk = require('./services/dataGoKrClient'); // RELAY-2026-08-08 (Sprint BBBBBBB): data.go.kr 진단도 실경로와 동일하게
  const molit = process.env.MOLIT_API_KEY;
  const kakao = process.env.KAKAO_REST_API_KEY;
  const checks = { molit_key: !!molit, kakao_key: !!kakao };

  // 1) MOLIT 실거래가 (활성 필수) — 최근 완료된 달 사용 (당월은 데이터 없을 수 있음)
  if (molit) {
    try {
      const d = new Date();
      const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
      const ym = `${prev.getFullYear()}${String(prev.getMonth() + 1).padStart(2, '0')}`;
      const r = await dgk.get('https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev', {
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

  // 2) K-apt 단지 리스트 (AptListService4 — V3 는 2026-08-30 폐기 확인)
  if (molit) {
    try {
      const r = await dgk.get('https://apis.data.go.kr/1613000/AptListService4/getSigunguAptList4', {
        params: { serviceKey: molit, sigunguCode: '11350', numOfRows: 1, pageNo: 1, _type: 'json' },
        timeout: 6000,
      });
      const code = r.data?.response?.header?.resultCode;
      checks.kapt_list = code === '00' || code === '000';
      checks.kapt_list_code = code;
      checks.kapt_list_msg = r.data?.response?.header?.resultMsg;
    } catch (e) { checks.kapt_list = false; checks.kapt_list_err = e.response?.status ? `HTTP ${e.response.status}` : e.message; }
  }

  // 3) K-apt 단지 기본정보 (AptBasisInfoServiceV5 — V2~V4 는 2026-08-30 폐기 확인)
  if (molit) {
    try {
      const r = await dgk.get('https://apis.data.go.kr/1613000/AptBasisInfoServiceV5/getAphusBassInfoV5', {
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
// HEALTH-PERF+SYNCTIME-2026-07-25 (Sprint VVVVVV):
//   [문제 1 — 성능] 위 6h node-cache 는 **서버리스에서 공유되지 않는다**(Sprint TTTTTT-3 과 동일 클래스).
//     `/api/health` 는 모든 페이지 로드에서 호출되는데, 프로덕션 5회 연속 실측이 632~793ms 로
//     캐시가 사실상 안 먹고 있었다. 원인은 exact count 2건 — EXPLAIN ANALYZE 로 molit COUNT(*) 가
//     **781ms**(168,964행 × 2 워커 Index Only Scan, Heap Fetches 169,698). 즉 초기 로딩에 직격.
//     → Redis 2차 캐시로 인스턴스 간 공유. 미설정 시 rget/rset 이 no-op → 기존 동작 폴백.
//   [문제 2 — 정확성] 프론트 배너 "마지막 데이터 동기화"가 `health.timestamp`(= 응답 생성 시각 = 지금)를
//     쓰고 있어 **언제 접속하든 항상 '방금 갱신됨'** 으로 보였다. 데이터가 며칠 안 들어와도 알 수 없는
//     허위 신뢰 시그널(절대 룰 ② 위반). → 실제 최신 적재 시각(molit ingested_at 최대값)을 함께 반환.
//     MAX(ingested_at) 은 인덱스가 없어 975ms(seq scan)지만 위 count 들과 **병렬**이라 캐시 미스 시
//     벽시계 증가는 ~200ms 뿐이고, Redis 캐시로 미스 자체가 하루 몇 번으로 줄어든다.
//     ⚠ ingested_at 인덱스 추가는 DDL — 운영자 승인 사항이라 하지 않았다(현 비용으로 충분히 수용 가능).
async function getDataCounts() {
  const CK = 'meta:dataCounts:v2';
  const hit = cache.get(CK);
  if (hit) return hit;
  const redisCache = require('./services/redisCache');
  try {
    const rHit = await redisCache.rget(CK);
    if (rHit) { cache.set(CK, rHit, 21600); return rHit; }
  } catch (_) { /* Redis 실패는 무시하고 DB 조회 */ }
  try {
    const { getSupabaseAdmin } = require('./db/client');
    const admin = getSupabaseAdmin();
    if (!admin) return null;
    const [tx, apt, lastIngest] = await Promise.all([
      admin.from('molit_transactions').select('*', { count: 'exact', head: true }),
      admin.from('apt_master').select('*', { count: 'exact', head: true }),
      // 최신 1건의 ingested_at — 실패해도 아래에서 null 로 흘려보낸다(배너는 시각 표기만 생략).
      admin.from('molit_transactions').select('ingested_at').order('ingested_at', { ascending: false }).limit(1).maybeSingle(),
    ]);
    const out = {
      tx: tx.count || 0,
      apt: apt.count || 0,
      // ISO 문자열 또는 null. 프론트는 null 이면 "언제 갱신됐는지" 표기를 아예 하지 않는다.
      lastIngestedAt: lastIngest?.data?.ingested_at || null,
    };
    cache.set(CK, out, 21600); // 6h
    redisCache.rset(CK, out, 21600).catch(() => {}); // 인스턴스 간 공유(fire-and-forget)
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
    // HH-BR-OBSERV-2026-08-17 (Sprint MMMMMMM-26): 아래 emptyFetch·householdsZero 는 **KAPT 커버리지**를
    //   재는 지표다. 건축물대장으로 세대수를 채워도(Sprint MMMMMMM-23) 그 두 수치는 그대로 남는다 —
    //   KAPT 가 여전히 못 준 것은 사실이기 때문이다. 그래서 지표만 보면 "407곳 미확인" 이 영원히 유지되고
    //   실제로 해소된 몫이 보이지 않는다. crons.brWritten 은 **그 회차 처리량**이라 누계를 알 수 없다.
    //   → 두 모집단 **안에서** 건축물대장으로 해소된 수를 따로 세어 '실질 미확인' 을 함께 낸다.
    //   ⚠ `_br` 전체를 세면 안 된다 — KAPT 가 나중에 성공한 행도 `_br` 을 보존하므로(재조회 시 유실 방지)
    //     모집단 밖 행까지 빼게 되어 실질 미확인이 과소 집계된다. 반드시 각 조건과 AND 로 묶어 센다.
    const [total, facNull, empty, dtlMissing, hhZero, brInEmpty, brInZero] = await Promise.all([
      admin.from('apt_master').select(...H()),
      admin.from('apt_master').select(...H()).is('facility', null),
      admin.from('apt_master').select(...H()).not('facility->_empty', 'is', null),
      admin.from('apt_master').select(...H()).not('facility', 'is', null).is('facility->_empty', null).is('facility->_dtl', null),
      // HH-HOCNT-FALLBACK-2026-07-14 (Sprint IIIII): hoCnt fallback 도입 후 "세대수 미상"은 kaptdaCnt·hoCnt 둘 다
      //   무효인 경우만(실측 346→16). 두 .or() 는 PostgREST 에서 AND 로 결합.
      admin.from('apt_master').select(...H()).not('facility', 'is', null).is('facility->_empty', null)
        .or('facility->>kaptdaCnt.eq.0,facility->>kaptdaCnt.is.null')
        .or('facility->>hoCnt.eq.0,facility->>hoCnt.is.null'),
      // 위 두 모집단 **안에서** 건축물대장으로 세대수가 채워진 수 (각 조건과 AND).
      admin.from('apt_master').select(...H()).not('facility->_empty', 'is', null).not('facility->_br', 'is', null),
      admin.from('apt_master').select(...H()).not('facility', 'is', null).is('facility->_empty', null)
        .or('facility->>kaptdaCnt.eq.0,facility->>kaptdaCnt.is.null')
        .or('facility->>hoCnt.eq.0,facility->>hoCnt.is.null')
        .not('facility->_br', 'is', null),
    ]);
    const t = total.count || 0;
    const dtl = dtlMissing.count || 0, hh = hhZero.count || 0, emp = empty.count || 0, fnull = facNull.count || 0;
    const brE = brInEmpty.count || 0, brZ = brInZero.count || 0;
    // 실질 미확인 = KAPT 도 건축물대장도 세대수를 못 준 수. 음수 방어(모집단 정의가 바뀌어도 안전).
    const hhUnknown = Math.max(0, (emp - brE)) + Math.max(0, (hh - brZ));
    const dtlPct = t > 0 ? Math.round((dtl / t) * 100) : null;
    const out = {
      total: t,
      facilityNull: fnull,          // facility 미적재 (백필 대상)
      emptyFetch: emp,              // KAPT 조회 실패 sentinel (건축물대장으로 채워져도 이 값은 유지된다)
      parkingMissing: dtl,          // 주차(_dtl) 누락 → 주차필터 제외 원인
      parkingMissingPct: dtlPct,
      householdsZero: hh,           // KAPT 세대수 0/null
      // HH-BR-OBSERV-2026-08-17: 위 두 수치는 **KAPT 커버리지**라 건축물대장 보강 뒤에도 안 줄어든다.
      //   실제로 화면에 세대수가 뜨는지는 아래 두 값이 말해준다.
      householdsFilledByBr: brE + brZ,   // 건축물대장으로 해소된 누계
      householdsUnknown: hhUnknown,      // 어느 원천으로도 못 채운 실질 미확인
      warn: (dtlPct != null && dtlPct >= 15) || hhUnknown >= 50 || fnull >= 10,
    };
    // ALERT-DEDUP-FIX-2026-07-14 (Sprint HHHHH-3, Sentry NODE-4 107 events 실측): health 경로 captureMessage 는
    //   서버리스 인스턴스별 캐시라 dedup 불가(인스턴스 수만큼 발생) + 주간 apt-master-sync 의 신규 단지 유입
    //   (facilityNull 0→3,452)이 임계를 상시 초과 → 경보 스팸. 경보는 facility-backfill cron(일 1회) 종료 시로
    //   이동(facilityBackfill.js) — health 는 지표 노출만.
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
  // Redis 조회 1회(수 ms). 실패해도 null 로 흘려보낸다 — health 가 이것 때문에 죽으면 안 된다.
  const _cronLatest = await require('./services/cronStats').getCronLatest().catch(() => null);
  const _dbUsage = await getDbUsage();
  // 데이터 품질 모니터 (Sprint AAAAA) — HOTPATH-NONBLOCK-2026-07-12 (Sprint DDDDD): count 5개가 콜드 health 를
  //   ~2s 느리게 해 chkAPI 5s 타임아웃 오프라인 오표시 유발 → health 핫패스에선 캐시만 읽고, 미스 시 백그라운드
  //   계산 트리거 후 이번엔 null 반환(health 지연 0). 다음 호출부터 값 노출.
  let _facQuality = cache.get('meta:facilityQuality');
  if (_facQuality === undefined) { _facQuality = null; getFacilityQuality().catch(() => {}); }
  // ECOS-2026-07-13 (Sprint FFFFF): 시중 금리(기준금리·주담대 가중평균) — facilityQuality 와 동일 비차단 패턴.
  let _ecosRates = cache.get('ecos:rates:v1');
  if (_ecosRates === undefined) { _ecosRates = null; try { require('./services/ecosService').getEcosRates().catch(() => {}); } catch (_) {} }
  // HF-2026-07-14 (Sprint HHHHH): 정책자금 공시 금리(디딤돌·u-보금자리론) — 동일 비차단 패턴.
  let _hfRates = cache.get('hf:rates:v1');
  if (_hfRates === undefined) { _hfRates = null; try { require('./services/hfService').getHfRates().catch(() => {}); } catch (_) {} }
  // INTENT-OBSERVE-2026-08-12 (Sprint KKKKKKK-20): 데이터 도우미 의도 분포(오늘·어제) + 최근
  //   미매칭 원문 10개 — "다음 인텐트"를 실사용이 결정하게 하는 관측 창. 실패는 null(fail-open).
  let _chatIntents = null;
  // SEARCH-DEGRADE-OBSERVE-2026-08-16 (Sprint LLLLLLL): 검색/인기단지 강등 빈도(오늘·어제).
  //   molit-timeout 은 pg 57014(2글자 ILIKE 340K행 seq scan vs anon 3s 한도)로 원인이 확정된
  //   기지 사항이라 Sentry 캡처를 뺐다 — 대신 여기서 빈도를 본다. 0 이 아니면 정상(강등이 동작 중).
  let _searchDegrade = null;
  // ⚠ HEALTH-PII-2026-08-16 (Plan 024): `recentMisses` 는 **사용자가 입력한 챗 원문 80자**다
  //   (chatDataRouter.js:516 `r.lpush('chatint:misses', String(message).slice(0, 80))`).
  //   그런데 이 라우트는 `optionalAuth` 라 **로그인 없이 누구나 호출**한다 — 즉 익명 방문자가
  //   다른 사용자의 마지막 챗 10건을 그대로 읽을 수 있었다(라이브 확인: 응답에 배열로 포함).
  //   부동산 챗 특성상 "신혼부부 3억", 특정 단지명 등 개인 사정이 그대로 담긴다.
  //   [설계] 유출을 "응답에서 지우는" 방식이 아니라 **관리자가 아니면 조회조차 하지 않는다** —
  //   나중에 누가 응답 조립부를 고쳐도 값이 애초에 존재하지 않아 구조적으로 샐 수 없다.
  //   집계 카운터(today/yesterday = 인텐트별 건수)는 개인정보가 아니므로 그대로 공개한다.
  let _isAdmin = false;
  try { _isAdmin = require('./services/planService').isAdminEmail(req.user?.email); } catch (_) {}
  try {
    const r = require('./redis').getRedis();
    if (r) {
      const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const yday = new Date(Date.now() - 864e5).toISOString().slice(0, 10).replace(/-/g, '');
      const [today, yesterday, recentMisses, degToday, degYday] = await Promise.all([
        r.hgetall(`chatint:${day}`), r.hgetall(`chatint:${yday}`),
        _isAdmin ? r.lrange('chatint:misses', 0, 9) : Promise.resolve(null),
        r.hgetall(`searchdeg:${day}`), r.hgetall(`searchdeg:${yday}`),
      ]);
      _chatIntents = { today: today || {}, yesterday: yesterday || {} };
      if (_isAdmin) _chatIntents.recentMisses = recentMisses || [];
      _searchDegrade = { today: degToday || {}, yesterday: degYday || {} };
    }
  } catch (_) { /* 관측 실패 무시 */ }
  // QUOTA-PLAN-2026-07-12 (Sprint YYYY, 운영자 "admin 인데 검색 0/5 표시"): usage 한도를 사용자 plan 반영.
  //   기존엔 DAILY_SEARCH_LIMIT(=5) 고정 → admin·pro·로그인free 모두 5로 오표시(admin 은 초과 시 0/5).
  //   dailyLimit 과 동일 규칙: admin 무제한 · pro/team 플랜한도 · 로그인 free 는 base+bonus(검색5·챗10).
  let _searchLimit = DAILY_SEARCH_LIMIT, _chatLimit = DAILY_CHAT_LIMIT, _unlimited = false;
  try {
    const { getActivePlan, getLimitsForPlan } = require('./services/planService');
    if (_isAdmin) { // HEALTH-PII-2026-08-16: 위에서 이미 판정 — 같은 요청에서 두 번 계산하지 않는다
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
    // WEBHOOK-GATE-2026-08-25 (Sprint NNNNNNN-22): 카카오 연결 해제 웹훅의 처리 게이트 상태.
    //   KAKAO_ADMIN_KEY 가 없으면 웹훅이 와도 인증 검증이 불가능해 **아무 처리도 하지 않는데**,
    //   응답은 규격상 200 이라 밖에서는 정상과 구분이 안 됐다(env 반영 여부를 확인할 방법이 없었다).
    //   노출하는 건 "설정됐는가" 뿐이고 키 값·길이는 싣지 않는다.
    kakaoUnlinkWebhookReady: !!process.env.KAKAO_ADMIN_KEY,
    // SYNCTIME-2026-07-25 (Sprint VVVVVV): 프론트 배너용 **실제** 데이터 동기화 시각.
    //   `timestamp` 는 이 응답을 만든 시각일 뿐 데이터 갱신 시각이 아니다 — 둘을 혼동해
    //   배너가 항상 '방금 갱신'을 보여주던 것이 원래 결함. 모르면 null(프론트가 표기 생략).
    dataSyncedAt: _dataCounts?.lastIngestedAt || null,
    dataCounts: _dataCounts,
    // CRON-OBSERV-2026-07-25 (Sprint XXXXXX): cron 최근 1회 결과(숫자 화이트리스트만).
    //   Vercel Hobby 로그가 1시간만 남아 하루 1회 cron 은 사실상 사후 확인이 불가능했다 —
    //   admin 전용으로 두면 진단 때마다 운영자를 거쳐야 해서 health 에 **건수만** 싣는다.
    //   민감값 없음(cronStats._pick 이 숫자 필드만 통과시킨다). Redis 미설정·실패 시 null.
    crons: _cronLatest,
    db: _dbUsage,
    facilityQuality: _facQuality,
    ecosRates: _ecosRates,
    hfRates: _hfRates,
    regulations: _regulations,
    cache: { keys: cache.keys().length, stats: cache.getStats() },
    usage: _unlimited
      ? { used: searchUsed, limit: '무제한', remaining: '무제한', unlimited: true }
      : { used: searchUsed, limit: _searchLimit, remaining: Math.max(0, _searchLimit - searchUsed) },
    chat: _unlimited
      ? { used: chatUsed, limit: '무제한', remaining: '무제한', unlimited: true }
      : { used: chatUsed, limit: _chatLimit, remaining: Math.max(0, _chatLimit - chatUsed) },
    monthlyBudget,
    chatIntents: _chatIntents, // KKKKKKK-20: 도우미 의도 분포 + 미매칭 원문(다음 인텐트 결정 재료)
    searchDegrade: _searchDegrade, // LLLLLLL: 검색 molit 타임아웃 강등 · 인기단지 stale 폴백 빈도
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
// setupExpressErrorHandler 로 모든 라우트 에러를 자동 캡쳐
// (Sentry 는 파일 상단에서 ./sentry 로 이미 로드됨 — JJJJJJJ 에서 재선언 제거)
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
