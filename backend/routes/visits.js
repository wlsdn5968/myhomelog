/**
 * VISITS-2026-10-20: GET /api/visits/today — 오늘(KST) 방문 브라우저 수.
 *
 * [무엇을 세는가] 프런트가 운영 도메인에서 **브라우저당 하루 1회** 보내는 `daily_visit` 이벤트(visit_attribution)의 오늘 건수.
 *   식별자(user_id·IP·UA·브라우저 ID)는 어디에도 저장하지 않는다 — 프런트는 localStorage 에 "보낸 날짜"만 둔다.
 *   그래서 "사람 수"가 아니라 "브라우저 수"다(같은 사람이 폰·PC로 오면 2, 사이트 데이터를 지우면 다시 1).
 * [비용] 새 표·Redis 없음. 인덱스 idx_visit_attr_event(event, created_at desc) 위의 head count 1회,
 *   메모리 60초 + 엣지 60초 캐시라 방문자가 늘어도 DB 조회는 분당 1회 수준.
 * [실패] DB 를 못 읽으면 today:null — 화면은 줄을 숨긴다(모름을 0 으로 만들지 않는다).
 */
'use strict';

const express = require('express');
const logger = require('../logger');
const cache = require('../cache');
const { getSupabaseAdmin } = require('../db/client');
const router = express.Router();

const KEY = 'visits:today:v2'; // v2: 누적(total·since) 추가 2026-10-21

/** 지금 시각의 KST 날짜('YYYY-MM-DD')와 그날 0시의 UTC ISO */
function kstDayStart(nowMs) {
  const k = new Date(nowMs + 9 * 3600 * 1000);
  const day = k.toISOString().slice(0, 10);
  const startIso = new Date(Date.parse(`${day}T00:00:00Z`) - 9 * 3600 * 1000).toISOString();
  return { day, startIso };
}

const TOTAL_SINCE = '2026-10-20'; // 운영 도메인 daily_visit 첫 기록(2026-10-20 23:43 KST)

router.get('/today', async (req, res) => {
  const { day, startIso } = kstDayStart(Date.now());
  const hit = cache.get(KEY);
  if (hit && hit.day === day) {
    res.set('Cache-Control', 'public, max-age=30, s-maxage=60');
    return res.json(hit);
  }
  let today = null, total = null;
  const admin = getSupabaseAdmin();
  if (admin) {
    try {
      const [t, a] = await Promise.all([
        admin.from('visit_attribution').select('id', { count: 'exact', head: true }).eq('event', 'daily_visit').gte('created_at', startIso),
        // SITE-LIVE-TOTAL-2026-10-21: 누적 — daily_visit 은 2026-10-20 부터 쌓였다(그 전 first_load 는 탭 세션 기준이라 섞지 않는다)
        admin.from('visit_attribution').select('id', { count: 'exact', head: true }).eq('event', 'daily_visit'),
      ]);
      if (t.error) throw new Error(t.error.message);
      today = Number.isFinite(t.count) ? t.count : null;
      if (!a.error && Number.isFinite(a.count)) total = a.count;
    } catch (e) {
      logger.warn({ err: e.message }, 'visits/today 조회 실패 — today:null');
    }
  }
  const body = { day, today, total, since: TOTAL_SINCE };
  if (today != null) {
    cache.set(KEY, body, 60);
    res.set('Cache-Control', 'public, max-age=30, s-maxage=60');
  } else {
    res.set('Cache-Control', 'no-store');
  }
  return res.json(body);
});

module.exports = router;
module.exports._kstDayStart = kstDayStart;
