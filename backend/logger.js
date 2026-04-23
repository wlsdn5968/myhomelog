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
  redact: {
    paths: [
      // 흔한 PII 필드명
      'email', 'phoneNumber', 'phone', 'name', 'fullName',
      'ssn', 'rrn', 'creditScore',
      // HTTP req/res 안의 토큰
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'req.headers["set-cookie"]',
      'res.headers["set-cookie"]',
      // 외부 API 키가 실수로 객체 안에 들어간 경우
      '*.apiKey', '*.api_key', '*.serviceKey', '*.password', '*.token',
      'serviceKey', 'apiKey', 'token', 'password',
    ],
    censor: '[REDACTED]',
    remove: false,
  },

  // ── 직렬화 커스터마이즈 ────────────────────────────────────
  serializers: {
    err: pino.stdSerializers.err,
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
