/**
 * 웹푸시 구독 API — 관심단지 신규 실거래 알림 (Sprint EEEEEE)
 *
 * 설계:
 *   - 익명 동작: 구독은 브라우저 endpoint 단위, 관심단지 목록(items)을 스냅샷으로 함께 저장
 *     (익명 사용자의 북마크는 localStorage 에만 있어 서버가 조인할 수 없음)
 *   - 게이트 2종 — 하나라도 없으면 완전 no-op (503/키 null):
 *     ① VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY env  ② push_subscriptions 테이블(운영자 SQL 승인)
 *   - 발송은 cron(jobs/pushNotify.js)이 담당 — 이 라우트는 구독 CRUD 만
 *
 * 엔드포인트:
 *   GET  /api/push/key          — VAPID 공개키 (미설정 시 {key:null} → 프론트가 UI 숨김)
 *   POST /api/push/subscribe    — { subscription:{endpoint,keys:{p256dh,auth}}, items:[...] } upsert
 *   POST /api/push/unsubscribe  — { endpoint } 삭제
 */
const express = require('express');
const logger = require('../logger');
// SSOT-2026-08-09 (Plan 007): 자체 createClient → db/client 팩토리 (null-게이트 의미 유지)
const { getSupabaseAdmin } = require('../db/client');

const router = express.Router();

// PUSH-HOST-2026-10-18: 구독 주소가 아무 https 주소나 되어, 매일 알림 작업이 그 주소로 서버발 요청을 보냈다(보안 감사 #4).
//   브라우저 푸시 서비스 호스트만 받는다. 근거: 크롬 fcm.googleapis.com(운영 저장 2건 전부) · 파이어폭스 *.push.services.mozilla.com
//   (Mozilla autopush 문서) · 사파리 *.push.apple.com(Apple WWDC22 "Web Push for Web Apps and Browsers" — 하위 도메인 전체 허용 권고)
//   · 엣지 *.notify.windows.com(공식 문서 미확인 — 마이크로소프트 소유 도메인이라 외부 서버로 새지 않는다).
const PUSH_HOST_SUFFIXES = ['fcm.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];
function isPushServiceEndpoint(endpoint) {
  let host;
  try { host = new URL(endpoint).hostname.toLowerCase(); } catch (_) { return false; }
  return PUSH_HOST_SUFFIXES.some(s => host === s || host.endsWith('.' + s));
}

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || null;

function dbClient() {
  return getSupabaseAdmin();
}

const MAX_ITEMS = 30;

/** 관심단지 항목 정제 — 프론트 입력을 그대로 믿지 않음 */
function sanitizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, MAX_ITEMS).map(it => ({
    aptName: String(it?.aptName || '').slice(0, 60),
    lawdCd: /^\d{5}$/.test(String(it?.lawdCd || '')) ? String(it.lawdCd) : null,
    sigungu: String(it?.sigungu || '').slice(0, 20),
    umdNm: String(it?.umdNm || '').slice(0, 20),
  })).filter(it => it.aptName && it.lawdCd);
}

router.get('/key', (_req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY });
});

router.post('/subscribe', async (req, res) => {
  try {
    if (!VAPID_PUBLIC_KEY) return res.status(503).json({ error: '푸시 알림이 아직 활성화되지 않았어요.' });
    const admin = dbClient();
    if (!admin) return res.status(503).json({ error: '서버 설정 미완료' });

    const sub = req.body?.subscription;
    const endpoint = String(sub?.endpoint || '');
    const p256dh = String(sub?.keys?.p256dh || '');
    const auth = String(sub?.keys?.auth || '');
    if (!endpoint.startsWith('https://') || endpoint.length > 700 || !p256dh || !auth || !isPushServiceEndpoint(endpoint)) {
      return res.status(400).json({ error: '유효하지 않은 구독 정보' });
    }
    const items = sanitizeItems(req.body?.items);
    if (!items.length) return res.status(400).json({ error: '알림 받을 관심단지가 없어요. 관심단지를 먼저 추가해주세요.' });

    const { error } = await admin.from('push_subscriptions').upsert({
      endpoint, p256dh, auth,
      items,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'endpoint' });
    if (error) {
      // 테이블 미생성(42P01) — 게이트 미승인 상태를 명확히 구분
      if (['42P01','PGRST205'].includes(String(error.code))) {
        logger.warn('push_subscriptions 테이블 미생성 — 운영자 SQL 승인 대기');
        return res.status(503).json({ error: '푸시 알림이 아직 활성화되지 않았어요.' });
      }
      throw new Error(error.message);
    }
    return res.json({ ok: true, items: items.length });
  } catch (e) {
    logger.warn({ err: e.message }, 'push subscribe 실패');
    require('../utils/captureError').captureRouteError(e, 'push');
    return res.status(500).json({ error: '구독 저장에 실패했어요. 잠시 후 다시 시도해주세요.' });
  }
});

router.post('/unsubscribe', async (req, res) => {
  try {
    const admin = dbClient();
    const endpoint = String(req.body?.endpoint || '');
    if (!admin || !endpoint) return res.json({ ok: true });
    await admin.from('push_subscriptions').delete().eq('endpoint', endpoint);
    return res.json({ ok: true });
  } catch (e) {
    return res.json({ ok: true }); // 해지는 최선노력 — 실패해도 사용자 흐름 차단 안 함
  }
});

module.exports = router;
module.exports._isPushServiceEndpoint = isPushServiceEndpoint;
