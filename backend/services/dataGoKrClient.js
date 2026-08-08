/**
 * data.go.kr·ECOS 호출 클라이언트 — 직접 호출 + Supabase Edge 릴레이 폴백
 * RELAY-2026-08-08 (Sprint BBBBBBB, 운영자 승인)
 *
 * [왜 존재하나 — 실측으로 확정된 근본 원인]
 *   2026-08-02 부터 data.go.kr 게이트웨이가 Vercel egress(AWS iad1·icn1 모두)의 요청을
 *   **키와 무관하게** 거부한다 — 더미 키 'test' 조차 400 INVALID_REQUEST_PARAMETER(code=10).
 *   같은 요청이 비 AWS IP 에선 정상 403/30. 한국은행 ECOS 는 같은 시기 타임아웃(drop).
 *   반면 **Supabase Edge Function egress 는 두 기관 모두 정상 취급**(실측: 403/30·200) —
 *   그래서 이미 쓰는 Supabase 를 릴레이로 쓴다(신규 벤더 0·비용 0).
 *
 * [설계]
 *   - 시그니처는 axios.get(url, config)와 동일한 get(url, config). 반환도 {status, data} 로 호환 —
 *     호출부 교체가 기계적이고, 실패 시 err.response = {status, data} 유지(molitErrReason 호환).
 *   - direct 우선 → "IP-거부 패턴"(민짜 400/ code=10 / RST / 타임아웃) 실패 시에만 릴레이.
 *     한 번 감지하면 10분간 릴레이 우선(재시도 낭비 제거). 차단이 풀리면 자연히 직접 호출로 복귀.
 *   - 릴레이 인증: 기존 SUPABASE_SERVICE_ROLE_KEY 를 Bearer 로 — Edge Function 이 verify_jwt +
 *     role==='service_role' 검사로 anon/외부를 거부한다. **신규 시크릿·운영자 env 작업 0.**
 *   - 릴레이는 완성 URL 을 전달만 한다(키는 여전히 Vercel env 에만, 함수는 URL 을 로깅하지 않음).
 *   - Edge/env 미설정 시 자동 no-relay(직접 호출만) — 로컬·테스트 동작 불변.
 *
 * ⚠ 로그에 URL 전체를 찍지 않는다 — serviceKey 가 포함된다. host 까지만.
 */
const axios = require('axios');
const logger = require('../logger');

// 릴레이 통과를 허용하는 대상 host — Edge Function 쪽 화이트리스트와 반드시 일치 유지
const ALLOWED_HOSTS = new Set(['apis.data.go.kr', 'ecos.bok.or.kr', 'api.odcloud.kr']);
const RELAY_FN = 'datagokr-proxy';
const RELAY_STICKY_MS = 10 * 60 * 1000; // IP-거부 감지 후 릴레이 우선 유지 시간

let _relayFirstUntil = 0; // 인스턴스 스코프 — 서버리스 인스턴스별로 독립(콜드 1회 direct 시도 비용만)

function _relayReady() {
  if (process.env.DATAGOKR_RELAY_OFF === '1') return false; // 운영자 긴급 차단 스위치(env, 선택)
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.service_role;
  return !!(process.env.SUPABASE_URL && key);
}

/** 직접 호출 실패가 "발신 IP 거부" 계열인지 — 이때만 릴레이가 의미 있다 */
function _isBlockedPattern(e) {
  if (!e) return false;
  if (['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT'].includes(e.code)) return true; // RST·drop 실측 계열
  const res = e.response;
  if (!res || res.status !== 400) return false;
  const hdr = res.data && res.data.OpenAPI_ServiceResponse && res.data.OpenAPI_ServiceResponse.cmmMsgHeader;
  // 민짜 400(본문 없음/비표준) 또는 code=10 — 08-02~ 실측 시그니처. 정상 4xx(403/30 등)는 제외.
  return !hdr || String(hdr.returnReasonCode) === '10';
}

/** axios params 와 동일 의미로 완성 URL 생성(릴레이 전달용) */
function _buildFullUrl(url, params) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

async function _viaRelay(url, config) {
  const host = new URL(url).host;
  if (!ALLOWED_HOSTS.has(host)) { const e = new Error(`relay 미허용 host: ${host}`); throw e; }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.service_role;
  const full = _buildFullUrl(url, config && config.params);
  const timeout = ((config && config.timeout) || 10000) + 5000; // upstream + 릴레이 왕복 마진
  const r = await axios.post(
    `${process.env.SUPABASE_URL}/functions/v1/${RELAY_FN}`,
    { url: full, accept: (config && config.headers && config.headers.Accept) || undefined },
    { timeout, headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' } },
  );
  const { status, body } = r.data || {};
  let data = body;
  if (typeof body === 'string') { try { data = JSON.parse(body); } catch (_) { /* XML 등은 문자열 유지 */ } }
  if (status >= 200 && status < 300) return { status, data };
  const err = new Error(`upstream HTTP ${status} (via relay)`);
  err.response = { status, data };
  throw err;
}

/**
 * axios.get 호환 — data.go.kr·ECOS·odcloud 전용.
 * @param {string} url
 * @param {{params?:object, timeout?:number, headers?:object}} [config]
 * @returns {Promise<{status:number, data:any}>}
 */
async function get(url, config) {
  const now = Date.now();
  const relayFirst = _relayReady() && now < _relayFirstUntil;

  if (!relayFirst) {
    try {
      return await axios.get(url, config);
    } catch (e) {
      if (!_relayReady() || !_isBlockedPattern(e)) throw e;
      _relayFirstUntil = Date.now() + RELAY_STICKY_MS;
      logger.warn({ host: new URL(url).host, reason: e.code || (e.response && e.response.status) },
        'data.go.kr 직접 호출 IP-거부 패턴 — Edge 릴레이 폴백 (10분간 릴레이 우선)');
      return _viaRelay(url, config);
    }
  }

  try {
    return await _viaRelay(url, config);
  } catch (eRelay) {
    // 릴레이 자체 장애 대비 — 직접 호출 한 번 더(차단이 풀렸으면 성공하고 sticky 도 자연 만료)
    try { return await axios.get(url, config); } catch (_) { throw eRelay; }
  }
}

module.exports = { get, _isBlockedPattern, _buildFullUrl, ALLOWED_HOSTS };
