/* 내집로그 서비스워커 — 웹푸시 수신 전용 (Sprint EEEEEE)
 * 캐싱/오프라인 기능 없음: fetch 핸들러를 두지 않아 기존 네트워크 동작에 영향 0. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) {}
  const title = data.title || '내집로그 알림';
  const body = data.body || '관심단지에 새 소식이 있어요.';
  e.waitUntil(self.registration.showNotification(title, {
    body,
    icon: '/icon-192.png', // Sprint IIIIII: 브랜드 정사각 아이콘 신설 (manifest 와 동일)
    data: { url: data.url || '/' },
    tag: 'mhl-watch-feed', // 같은 태그 = 최신 1개만 유지 (알림 스팸 방지)
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if ('focus' in w) { await w.focus(); return; } }
    await self.clients.openWindow(url);
  })());
});
