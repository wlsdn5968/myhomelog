/**
 * 카카오톡 "나에게 보내기" (Memo API) 발송 서비스 — Sprint FFFFFF
 *
 * 출처: 운영자의 portai 저장소(wlsdn5968/portai, src/lib/kakao.ts) 실동작 구현을 Express 로 포팅.
 *   - 문서: https://developers.kakao.com/docs/latest/ko/message/rest-api#default
 *   - 알림톡(유료 대행)이 아님 — 사용자가 본인 카카오 계정을 OAuth(scope: talk_message)로 연결하면
 *     '본인 카카오톡'으로만 발송. talk_message 는 선택 동의라 개인 개발자 앱으로 가능(portai 실증).
 *   - access_token ~12h / refresh_token ~2개월 — 401 시 refresh 후 1회 재시도는 호출부 책임.
 */
const axios = require('axios');

const KAPI = 'https://kapi.kakao.com';
const KAUTH = 'https://kauth.kakao.com';

function isKakaoConfigured() {
  return !!process.env.KAKAO_REST_API_KEY;
}

/** Kakao Memo 는 object_type=text 만 — HTML 미지원이라 태그 제거 + 200자 경계 트렁케이트 (portai 검증 로직) */
function truncateForKakao(s, max = 200) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const boundary = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  const base = boundary > max * 0.6 ? cut.slice(0, boundary) : cut;
  return base.trimEnd() + '…';
}

/**
 * 본인 카카오톡으로 텍스트 메시지 발송.
 * @returns {ok, skipped?, needsRefresh?, error?}
 */
async function sendKakaoMemo({ accessToken, title, description, webUrl }) {
  if (!accessToken) return { ok: true, skipped: true };
  const url = webUrl || 'https://myhomelog.vercel.app';
  const template = {
    object_type: 'text',
    text: truncateForKakao([title, description].filter(Boolean).join('\n\n'), 200),
    link: { web_url: url, mobile_web_url: url },
    button_title: '자세히 보기',
  };
  try {
    const r = await axios.post(
      `${KAPI}/v2/api/talk/memo/default/send`,
      new URLSearchParams({ template_object: JSON.stringify(template) }).toString(),
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        },
        timeout: 8000,
        validateStatus: () => true,
      },
    );
    if (r.status === 401) return { ok: false, needsRefresh: true, error: 'access_token expired' };
    if (r.status !== 200) return { ok: false, error: `Kakao HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}` };
    if (r.data && r.data.result_code !== 0) return { ok: false, error: `Kakao result_code ${r.data.result_code}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** refresh_token 으로 access_token 재발급 (refresh_token 은 갱신될 수도, 유지될 수도 있음) */
async function refreshKakaoToken(refreshToken) {
  const restKey = process.env.KAKAO_REST_API_KEY;
  const clientSecret = process.env.KAKAO_CLIENT_SECRET; // 콘솔에서 활성화한 경우만
  if (!restKey) return { ok: false, error: 'KAKAO_REST_API_KEY not set' };
  if (!refreshToken) return { ok: false, error: 'refresh_token missing' };
  const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: restKey, refresh_token: refreshToken });
  if (clientSecret) body.set('client_secret', clientSecret);
  try {
    const r = await axios.post(`${KAUTH}/oauth/token`, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      timeout: 8000,
      validateStatus: () => true,
    });
    if (r.status !== 200) return { ok: false, error: `HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}` };
    return { ok: true, accessToken: r.data.access_token, refreshToken: r.data.refresh_token, expiresIn: r.data.expires_in };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** authorization code → 토큰 교환 (OAuth callback 용) */
async function exchangeKakaoCode(code, redirectUri) {
  const restKey = process.env.KAKAO_REST_API_KEY;
  const clientSecret = process.env.KAKAO_CLIENT_SECRET;
  if (!restKey) return { ok: false, error: 'KAKAO_REST_API_KEY not set' };
  const body = new URLSearchParams({
    grant_type: 'authorization_code', client_id: restKey, redirect_uri: redirectUri, code,
  });
  if (clientSecret) body.set('client_secret', clientSecret);
  try {
    const r = await axios.post(`${KAUTH}/oauth/token`, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      timeout: 8000,
      validateStatus: () => true,
    });
    if (r.status !== 200) return { ok: false, error: `HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}` };
    return {
      ok: true,
      accessToken: r.data.access_token,
      refreshToken: r.data.refresh_token,
      expiresIn: r.data.expires_in,
      scope: String(r.data.scope || ''), // 'talk_message profile_nickname' 형태 — 동의 여부 판정용
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { isKakaoConfigured, sendKakaoMemo, refreshKakaoToken, exchangeKakaoCode, truncateForKakao };
