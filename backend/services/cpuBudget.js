'use strict';
/**
 * CPU-BUDGET-1115: 하루 CPU 사용량을 서비스가 스스로 세고, 기준을 넘으면 알리고 검색 로봇 요청을 잠시 돌려보낸다.
 *
 * [왜] Vercel Hobby 팀은 Active CPU 를 30일 합계 4시간까지 쓸 수 있고 넘으면 팀 전체가 30일 정지된다(2026-11-08 실제 정지).
 *   2026-11-15 사용량 화면 실측: 내집로그 30일 3시간 26분. 조용한 날은 하루 2.5~3.1분인데
 *   수집기가 몰리거나 점검과 배포가 많은 날은 12~20분이었고, 그 며칠이 30일 합계의 절반을 넘었다.
 *   함수 기록은 1시간만 남아 "오늘 얼마나 썼는지"를 서비스 안에서 볼 방법이 없었다.
 *
 * [어떻게]
 *   - 이 프로세스가 시작한 뒤 쓴 CPU 전체(process.cpuUsage, 새 인스턴스가 모듈을 읽는 시간 포함)를
 *     5분에 한 번만 Redis 의 날짜 키에 더한다(INCRBY 한 번). 요청마다 쓰지 않는다.
 *     예약 작업은 응답 직전에 한 번 더 기록한다(flushBeforeJson). 작업 뒤 인스턴스가 바로 사라져도 그 CPU 가 빠지지 않게.
 *     인스턴스가 사라지기 직전 5분 안의 일반 요청 CPU 는 빠질 수 있다. 그래서 이 값은 Vercel 화면 값보다 작거나 같다.
 *     요청별 값을 더하지 않으므로 같은 인스턴스에서 겹친 요청이 두 번 세어지지 않는다.
 *   - INCRBY 가 돌려준 그날 합계를 인스턴스가 기억한다. 읽기 명령을 따로 쓰지 않는다.
 *   - 합계가 경보 기준을 넘는 순간 Sentry 경고 한 번(INCRBY 는 원자적이라 넘는 순간을 보는 인스턴스는 하나다).
 *   - 합계가 차단 기준을 넘으면 그날 남은 시간 동안 서버 렌더 페이지를 찾는 검색 로봇에게 503 과 Retry-After 를 준다.
 *     사람 방문과 API 는 막지 않는다. 팀 한도를 넘으면 모든 서비스가 30일 꺼지므로 로봇 수집 하루치를 미루는 쪽이 낫다.
 *   - Redis 가 없거나 실패하면 아무것도 막지 않는다.
 *
 * [기준] 조용한 날 실측이 하루 3분 안팎이다. 경보 5분, 차단 8분(Vercel 화면 값보다 이 측정이 작게 나올 수 있어 보수적으로 잡았다).
 *   날짜 경계는 UTC. 환경 변수 CPU_DAY_ALERT_MS, CPU_DAY_SHED_MS 로 바꿀 수 있다.
 */
const FLUSH_GAP_MS = 5 * 60 * 1000;
const KEY_TTL_SEC = 3 * 24 * 3600;
const FLUSH_WAIT_MS = 1500;
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const ALERT_MS = num(process.env.CPU_DAY_ALERT_MS, 5 * 60 * 1000);
const SHED_MS = num(process.env.CPU_DAY_SHED_MS, 8 * 60 * 1000);

const st = { flushedUs: 0, lastFlushAt: 0, flushing: false, day: null, totalMs: null };

const dayOf = (now) => new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
const keyOf = (day) => `cpu:day:${day}`;
function procUs() { const u = process.cpuUsage(); return u.user + u.system; }

/** 지난 기록 뒤로 쓴 CPU 를 Redis 에 더한다. 절대 throw 하지 않는다. deps 는 검사용 주입. */
async function flush(now = Date.now(), deps = {}) {
  if (st.flushing) return null;
  st.lastFlushAt = now;
  const curUs = (deps.procUs || procUs)();
  const deltaMs = Math.floor((curUs - st.flushedUs) / 1000);
  if (deltaMs <= 0) return null;
  let r = null;
  try { r = (deps.getRedis || require('../redis').getRedis)(); } catch (_) { r = null; }
  if (!r) return null;
  st.flushing = true;
  try {
    const day = dayOf(now);
    const total = Number(await r.incrby(keyOf(day), deltaMs));
    st.flushedUs += deltaMs * 1000;
    if (!Number.isFinite(total)) return null;
    if (total === deltaMs) { try { await r.expire(keyOf(day), KEY_TTL_SEC); } catch (_) { /* 실패해도 본 처리는 계속 */ } }
    st.day = day; st.totalMs = total;
    const prev = total - deltaMs;
    const crossed = (line) => prev < line && total >= line;
    if (crossed(ALERT_MS) || crossed(SHED_MS)) {
      const shed = crossed(SHED_MS);
      try {
        (deps.sentry || require('../sentry')).captureMessage(
          `하루 CPU ${Math.round(total / 6000) / 10}분 사용(UTC ${day}) — ${shed ? '차단 기준을 넘어 검색 로봇 요청을 돌려보내는 중' : '경보 기준 초과'}. Vercel 사용량 화면과 방화벽 트래픽을 확인`,
          { level: shed ? 'error' : 'warning', tags: { monitor: 'cpu-budget' } });
      } catch (_) { /* 실패해도 본 처리는 계속 */ }
    }
    return total;
  } catch (_) {
    return null; // 더하지 못한 양은 flushedUs 를 옮기지 않았으므로 다음 기록에 다시 들어간다
  } finally { st.flushing = false; }
}

/** 시간 상한이 있는 기록. Redis 가 답하지 않아도 FLUSH_WAIT_MS 뒤에는 돌아온다. */
function flushBounded(now = Date.now(), deps) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), FLUSH_WAIT_MS);
    flush(now, deps).then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(null); });
  });
}

/**
 * 예약 작업 경로용. 응답을 보내기 직전에 한 번 기록한다.
 * 작업 도중의 기록(recordCronRun) 뒤에 도는 계산(보존 작업의 인기 단지 집계 등)까지 하루 합계에 들어가게 하고,
 * 작업 뒤 인스턴스가 바로 사라져도 빠지지 않게 한다.
 */
function flushBeforeJson() {
  return (_req, res, next) => {
    const send = res.json.bind(res);
    let sent = false;
    res.json = (body) => {
      if (sent) return send(body);
      sent = true;
      flushBounded().then(() => send(body), () => send(body));
      return res;
    };
    next();
  };
}

/**
 * 요청 맨 앞에 두는 미들웨어. 5분이 지났을 때만 기록하고, 그 한 번은 끝날 때까지(최대 1.5초) 기다린 뒤 요청을 처리한다.
 * 응답을 보낸 뒤에 시작한 Redis 호출은 서버리스 인스턴스가 멈추면 끝나지 않을 수 있어서 응답 앞에 둔다.
 */
function gate() {
  return (_req, _res, next) => {
    const now = Date.now();
    if (st.flushing || now - st.lastFlushAt < FLUSH_GAP_MS) return next();
    let done = false;
    const go = () => { if (!done) { done = true; next(); } };
    const timer = setTimeout(go, FLUSH_WAIT_MS);
    flush(now).then(() => { clearTimeout(timer); go(); }, () => { clearTimeout(timer); go(); });
  };
}

/** 이 인스턴스가 아는 오늘 합계. 아직 기록 전이면 ms 가 null(모름을 0 으로 만들지 않는다). */
function snapshot(now = Date.now()) {
  const today = dayOf(now);
  return { day: today, ms: st.day === today ? st.totalMs : null };
}

function shouldShed(now = Date.now()) {
  return st.day === dayOf(now) && st.totalMs != null && st.totalMs >= SHED_MS;
}

/** 어제 하루 합계(보존 작업이 하루 한 번 읽어 실행 기록에 남긴다). 못 읽으면 null. */
async function readDay(day, deps = {}) {
  try {
    const r = (deps.getRedis || require('../redis').getRedis)();
    if (!r) return null;
    const v = await r.get(keyOf(day));
    const n = Number(v);
    return v != null && Number.isFinite(n) ? n : null;
  } catch (_) { return null; }
}
const yesterdayOf = (now = Date.now()) => dayOf(now - 24 * 3600 * 1000);

/** 서버 렌더 페이지 앞에 두는 미들웨어. 차단 기준을 넘은 날, 검색 로봇에게만 503. */
function shedBots(isBot) {
  return (req, res, next) => {
    try {
      if (shouldShed() && isBot(String(req.get('user-agent') || '').slice(0, 256))) {
        res.set('Retry-After', '3600');
        res.set('Cache-Control', 'no-store');
        return res.status(503).type('text/plain; charset=utf-8').send('잠시 뒤에 다시 와 주세요.');
      }
    } catch (_) { /* 판단 실패는 통과 */ }
    next();
  };
}

module.exports = { flush, flushBounded, flushBeforeJson, gate, snapshot, shouldShed, shedBots, readDay, yesterdayOf, dayOf, _st: st, ALERT_MS, SHED_MS, FLUSH_GAP_MS };
