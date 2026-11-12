/**
 * ATTRIBUTION-2026-08-29 (Sprint NNNNNNN-31): POST /api/attribution — 유입 채널 자체 기록.
 *
 * [왜 필요한가 — 실측] Vercel Web Analytics 는 계측은 되지만 **이 플랜에서 조회 API 가 404** 다
 *   (2026-08-29 확인). 즉 스레드·인스타 자동화가 돌아도 **어느 채널이 먹히는지 알 방법이 없었다.**
 *   프론트엔 `utm_` 를 다루는 코드가 아예 0건이었다(grep). 광고·채널 판단의 근거가 없는 상태다.
 *
 * [무엇을 저장하지 않는가] user_id · IP · User-Agent · 화면 크기 — **아무 개인 식별자도 안 남긴다.**
 *   채널별 "몇 건"만 세면 목적이 달성되므로, 개인정보를 만들 이유가 없다(PIPA 최소수집).
 *   그래서 이 테이블은 개인정보가 아니고, 가입 귀속도 user_id 없이 이벤트 종류로만 본다.
 *
 * [남용 방지] 값 길이를 자르고 화이트리스트 이벤트만 받는다. 쓰기 전용이며 조회는 admin 경로에만 있다.
 */
'use strict';

const express = require('express');
const logger = require('../logger');
const { getSupabaseAdmin } = require('../db/client');
const router = express.Router();

// 늘릴 때는 admin 집계 화면도 같이 본다 — 아무 문자열이나 받으면 집계가 쓰레기가 된다.
// VISITS-2026-10-20: daily_visit = 운영 도메인에서 브라우저당 하루 1회(식별자 없음) — /api/visits/today 가 센다.
const EVENTS = new Set(['first_load', 'signup', 'search', 'report', 'daily_visit']);
const DAILY_VISIT_IP_CAP = 30;
// 한 시간 방문 경보 기준 40. 근거(visit_attribution 실측): 10-20~11-11 정상 방문은 하루 1~69건, 한 시간 최대 8건.
//   수집기가 온 11-12 는 하루 977건, 한 시간 최대 97건. 정상 최대의 5배라 사람 방문으로는 울리지 않는다.
const VISIT_SURGE_HOURLY = Math.max(10, parseInt(process.env.VISIT_SURGE_HOURLY || '40', 10) || 40);
const cut = (v, n) => {
  const s = String(v == null ? '' : v).trim();
  return s ? s.slice(0, n) : null;
};

router.post('/', async (req, res) => {
  const b = req.body || {};
  const event = String(b.event || '').trim();
  // 모르는 이벤트는 조용히 무시한다(200) — 프론트가 재시도로 몰아치지 않게.
  if (!EVENTS.has(event)) return res.status(204).end();

  const admin = getSupabaseAdmin();
  if (!admin) return res.status(204).end();

  // AUDIT3-CAP-1112 (보안 점검 run-3, daily-visit-event-inflation): daily_visit 는 화면의 "오늘 방문", "누적 방문" 숫자가 된다.
  //   인증도 일일 한도도 없어 한 곳에서 계속 보내면 숫자를 부풀릴 수 있었다. IP 하나가 하루 30건까지만 센다.
  //   30 은 같은 IP 를 여러 사람이 쓰는 경우(공유기, 통신사)를 막지 않으려는 값이다. 넘으면 조용히 버린다(204).
  if (event === 'daily_visit') {
    try {
      const { incrementUsage, getClientIp, todayKey, secondsUntilMidnight } = require('../middleware/dailyLimit');
      const ip = require('../utils/ipKey').normalizeIpKey(getClientIp(req));
      const { used } = await incrementUsage(`dl:dvisit:${todayKey()}:${ip}`, secondsUntilMidnight());
      if (used > DAILY_VISIT_IP_CAP) return res.status(204).end();
      // SURGE-ALERT-2026-11-13 (중국 클라우드 수집기 사고 후속): 2026-11-12 에 방문이 하루 25 → 950 으로 뛰었는데
      //   알려 주는 장치가 없어 운영자가 화면을 보고서야 알았다. 한 시간 방문 수가 기준을 넘는 순간 Sentry 경보(운영자 메일)를 한 번 보낸다.
      //   계수는 이미 쓰는 Redis INCR 한 번이라 비용이 거의 없다. 기준 10배를 넘으면 한 번 더 보낸다.
      const hourKey = new Date().toISOString().slice(0, 13).replace(/\D/g, '');
      const { used: hourUsed } = await incrementUsage(`dl:dvisit-hour:${hourKey}`, 7200);
      if (hourUsed === VISIT_SURGE_HOURLY || hourUsed === VISIT_SURGE_HOURLY * 10) {
        require('../sentry').captureMessage(`방문 급증: 이번 시간(UTC ${hourKey}) 방문 기록 ${hourUsed}건 — 수집기 의심, Vercel 방화벽 트래픽에서 AS 확인`, {
          level: hourUsed >= VISIT_SURGE_HOURLY * 10 ? 'error' : 'warning',
          tags: { monitor: 'visit-surge', country: String(req.headers['x-vercel-ip-country'] || '').slice(0, 2) },
        });
      }
    } catch (_) { /* 세지 못하면 막지 않는다 */ }
  }

  try {
    await admin.from('visit_attribution').insert({
      event,
      utm_source: cut(b.utmSource, 60),
      utm_medium: cut(b.utmMedium, 60),
      utm_campaign: cut(b.utmCampaign, 80),
      referrer_host: cut(b.referrerHost, 120),
      landing_path: cut(b.landingPath, 160),
    });
  } catch (e) {
    // 기록 실패가 사용자 경험을 막으면 안 된다 — 삼키되 로그는 남긴다.
    logger.warn({ err: e.message, event }, 'attribution 기록 실패(무시)');
  }
  res.status(204).end();
});

module.exports = router;
