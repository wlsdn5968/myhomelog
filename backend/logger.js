/**
 * 구조화 로그 (pino)
 * - JSON 출력으로 Vercel/Axiom/Datadog 등 어떤 로그 드레인이든 파싱 가능
 * - PII (IP·이메일·전화·이름·토큰) 자동 redact
 * - dev 환경에선 pino-pretty 가 있으면 사용, 없으면 JSON 그대로
 *
 * 사용:
 *   const logger = require('./logger');
 *   logger.info({ aptSeq, ms }, '단지 조회 완료');
 *   logger.error({ err }, 'API 실패');     // err 는 자동 직렬화
 *   logger.child({ requestId }).warn(...); // 컨텍스트 묶기
 */
const pino = require('pino');

const isProd = process.env.NODE_ENV === 'production';

// REDACT-DEPTH-2026-09-10 (Plan 076): pino 의 `*` 는 정확히 한 단계만 매치한다(실측). 중첩 객체
//   ({ config: { kakao: { apiKey } } }) 를 그대로 로그에 넣어도 가려지도록 2·3단계를 명시한다.
const SECRET_KEYS = ['apiKey', 'api_key', 'serviceKey', 'password', 'token'];
const REDACT_PATHS = [
  // 흔한 PII 필드명
  'email', 'phoneNumber', 'phone', 'name', 'fullName',
  'ssn', 'rrn', 'creditScore',
  // HTTP req/res 안의 토큰
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  // 외부 API 키가 실수로 객체 안에 들어간 경우 — 최상위·1·2·3단계
  ...SECRET_KEYS,
  ...SECRET_KEYS.map((k) => `*.${k}`),
  ...SECRET_KEYS.map((k) => `*.*.${k}`),
  ...SECRET_KEYS.map((k) => `*.*.*.${k}`),
];

// /24 마스킹: 121.131.45.123 → 121.131.45.0  (GDPR/개보법 친화)
//             2001:db8:abcd:1234:: → 2001:db8:abcd::  (앞 3 segment 만 유지)
function maskIp(ip) {
  if (!ip || typeof ip !== 'string') return null;
  // IPv6 매핑된 IPv4 (::ffff:1.2.3.4) 정규화
  const cleaned = ip.replace(/^::ffff:/, '').trim();
  if (cleaned.includes('.')) {
    const parts = cleaned.split('.');
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }
  if (cleaned.includes(':')) {
    const parts = cleaned.split(':').filter(Boolean);
    return parts.slice(0, 3).join(':') + '::';
  }
  return 'unknown';
}

function _safeErr(e) {
  if (!e || typeof e !== 'object') return e;
  const out = {
    type: e.name || (e.constructor && e.constructor.name) || 'Error',
    message: typeof e.message === 'string' ? e.message.slice(0, 500) : String(e.message || ''),
  };
  if (e.code != null) out.code = e.code;
  if (e.status != null) out.status = e.status;
  else if (e.response && e.response.status != null) out.status = e.response.status;
  if (e.isAxiosError && e.config) {
    // 호스트·메서드만(경로·쿼리에 키가 들어가는 API 가 있다 — ECOS 는 경로, data.go.kr 은 쿼리)
    try { out.host = new URL(e.config.url, e.config.baseURL || undefined).host; } catch (_) { /* 무시 */ }
    if (e.config.method) out.method = String(e.config.method).toUpperCase();
  }
  if (typeof e.stack === 'string') out.stack = e.stack.slice(0, 2000);
  if (e.cause && e.cause !== e && typeof e.cause === 'object') out.cause = { type: e.cause.name, message: String(e.cause.message || '').slice(0, 300), code: e.cause.code };
  return out;
}

const logger = pino({
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  base: {
    service: 'myhomelog-api',
    env: process.env.VERCEL_ENV || process.env.NODE_ENV || 'local',
    region: process.env.VERCEL_REGION,
  },
  timestamp: pino.stdTimeFunctions.isoTime,

  // ── PII redaction ──────────────────────────────────────────
  // pino redact: 매칭 경로의 값을 '[REDACTED]' 로 치환
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]', remove: false },

  // ── 직렬화 커스터마이즈 ────────────────────────────────────
  serializers: {
    // LOG-ERR-SAFE-2026-10-30 (보안 점검 U14): 기본 err 직렬화는 axios 오류의 config·request·response 를 통째로 열거해
    //   serviceKey 원문(URL·원시 요청 헤더)과 릴레이 요청의 Authorization/apikey(service_role 키)까지 로그에 남겼다
    //   (로컬 재현: 오류 1줄 16KB 에 키 원문 25회·JWT 18회). redact 는 키 이름 일치만 보므로 막지 못한다 →
    //   안전한 필드만 골라 쓴다. 원인 추적에 필요한 종류·메시지·코드·HTTP 상태·스택은 남긴다.
    err: _safeErr,
    req(req) {
      return {
        method: req.method,
        url: req.url,
        ip: maskIp(req.ip || req.headers?.['x-forwarded-for']?.split(',')[0]),
        userAgent: req.headers?.['user-agent'],
      };
    },
    res(res) {
      return { statusCode: res.statusCode };
    },
  },

  // dev 에선 색깔 있게, prod 에선 raw JSON (Vercel/Axiom 이 파싱)
  transport: isProd ? undefined : (() => {
    try {
      require.resolve('pino-pretty');
      return {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname,service,env',
          singleLine: false,
        },
      };
    } catch {
      return undefined; // pino-pretty 미설치 시 JSON 그대로
    }
  })(),
});

module.exports = logger;
module.exports.maskIp = maskIp;
module.exports.REDACT_PATHS = REDACT_PATHS;
