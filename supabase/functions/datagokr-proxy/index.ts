// datagokr-proxy — RELAY-2026-08-08 (Sprint BBBBBBB, 운영자 승인)
//
// data.go.kr 게이트웨이가 2026-08-02 부터 Vercel(AWS) egress 요청을 키와 무관하게 거부(400/code=10)하여
// 이미 쓰는 Supabase Edge 를 릴레이로 쓴다(Edge egress 는 정상 취급 실측 — 더미키 403/30·ECOS 200).
//
// 보안 장치 3중:
//  1) verify_jwt: 게이트웨이가 JWT 서명 검증(비프로젝트 토큰 차단)
//  2) role === 'service_role' 요구 — 공개된 anon 키로는 호출 불가(백엔드만 보유)
//  3) 대상 host 화이트리스트 — 공공 API 3종 외에는 전달 불가(오픈 프록시 방지)
// ⚠ URL 은 serviceKey 를 포함하므로 절대 로깅하지 않는다.
const ALLOWED = new Set(['apis.data.go.kr', 'ecos.bok.or.kr', 'api.odcloud.kr']);
const JSON_HDR = { 'Content-Type': 'application/json' };

function jwtRole(req: Request): string | null {
  try {
    const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const seg = tok.split('.')[1] || '';
    const pad = seg.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(pad)).role ?? null;
  } catch { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: JSON_HDR });
  if (jwtRole(req) !== 'service_role') {
    return new Response(JSON.stringify({ error: 'service_role 전용' }), { status: 403, headers: JSON_HDR });
  }
  let target: URL;
  let accept: string | undefined;
  try {
    const b = await req.json();
    target = new URL(String(b.url || ''));
    accept = typeof b.accept === 'string' ? b.accept : undefined;
  } catch {
    return new Response(JSON.stringify({ error: 'body.url 필요' }), { status: 400, headers: JSON_HDR });
  }
  if (target.protocol !== 'https:' || !ALLOWED.has(target.host)) {
    return new Response(JSON.stringify({ error: '허용되지 않은 대상' }), { status: 400, headers: JSON_HDR });
  }
  try {
    const r = await fetch(target.toString(), {
      headers: accept ? { Accept: accept } : undefined,
      signal: AbortSignal.timeout(13000),
    });
    const body = await r.text();
    return new Response(JSON.stringify({ status: r.status, contentType: r.headers.get('content-type') || '', body }), { headers: JSON_HDR });
  } catch (e) {
    return new Response(JSON.stringify({ status: 0, netErr: String((e as Error).name || e).slice(0, 60) }), { headers: JSON_HDR });
  }
});
