'use strict';
/**
 * CPU-METER-2026-11-08 (Vercel Hobby Active CPU 초과로 팀 정지, plans/188).
 * Vercel 화면은 모든 요청을 함수 하나(/api/index)로만 보여 줘 어느 기능이 CPU 를 쓰는지 알 수 없다.
 * 요청마다 이 프로세스가 쓴 CPU 시간(process.cpuUsage)을 재서 한 줄 로그로 남긴다. 로그는 최근 1시간을 읽어 기능별로 더한다.
 *  - 같은 인스턴스에서 동시에 처리한 요청이 있으면 그 CPU 가 섞인다. 그래서 그 순간 동시 처리 수(inflight)를 함께 남겨
 *    inflight 1 인 줄만 따로 볼 수 있게 한다.
 *  - 경로는 숫자가 든 칸을 :id 로 바꿔 묶는다(단지 번호마다 따로 세지 않게). 질의 문자열은 남기지 않는다(개인정보).
 */
const BOT_RE = /bot|crawl|spider|slurp|facebookexternalhit|kakaotalk-scrap|yeti|daum|headless|preview/i;

function routeKey(url) {
  const path = String(url || '').split('?')[0];
  const seg = path.split('/').filter(Boolean).slice(0, 3).map(s => (/\d/.test(s) || s.length > 40 ? ':id' : s));
  return '/' + seg.join('/');
}

// 봇 이름만 뽑는다(전체 UA 문자열은 남기지 않는다). 예: "Googlebot", "Yeti", "AhrefsBot". 못 찾으면 null.
const BOT_NAME_RE = /([A-Za-z][A-Za-z0-9._-]*(?:bot|crawler|spider|slurp|scrap|preview))|\b(Yeti|Daum|HeadlessChrome)\b/i;
function botName(ua) {
  const m = String(ua || '').match(BOT_NAME_RE);
  return m ? (m[1] || m[2]).slice(0, 40) : null;
}

let inflight = 0;
function cpuMeter(logger) {
  return (req, res, next) => {
    const c0 = process.cpuUsage();
    const t0 = Date.now();
    inflight += 1;
    const peak = { n: inflight };
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      inflight -= 1;
      try {
        const d = process.cpuUsage(c0);
        const ua = String(req.get('user-agent') || '');
        logger.info({ cpuMeter: {
          botName: botName(ua),
          route: routeKey(req.originalUrl),
          ms: Math.round((d.user + d.system) / 1000),
          wallMs: Date.now() - t0,
          status: res.statusCode,
          bot: BOT_RE.test(ua),
          inflight: peak.n,
        } }, 'cpu-meter');
      } catch (_) { /* 측정 실패는 응답에 영향 없다 */ }
    };
    // 처리 도중 다른 요청이 들어오면 그 수를 반영한다(섞였는지 판단용)
    const bump = setInterval(() => { if (inflight > peak.n) peak.n = inflight; }, 50);
    if (bump.unref) bump.unref();
    res.once('finish', () => { clearInterval(bump); finish(); });
    res.once('close', () => { clearInterval(bump); finish(); });
    next();
  };
}

module.exports = { cpuMeter, routeKey, botName, BOT_RE };
