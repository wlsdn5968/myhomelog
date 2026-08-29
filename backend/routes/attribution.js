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
const EVENTS = new Set(['first_load', 'signup', 'search', 'report']);
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
