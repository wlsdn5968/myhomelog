/**
 * SEC-1030-IPV6 (C14): 비로그인 한도 식별자용 IP 정규화.
 *
 * 근거: IPv6 사용자는 보통 /64 이상을 통째로 받아 주소를 무한히 바꿀 수 있다 → 주소 단위 키는
 *   한도를 우회한다. IPv6 는 앞 4개 그룹(/64)만 남겨 키로 쓴다. IPv4 와 IPv4-mapped(::ffff:1.2.3.4)는 IPv4 그대로.
 * rateLimit.js / dailyLimit.js 가 같은 함수를 쓴다(드리프트 방지).
 */
function normalizeIpKey(ip) {
  if (ip === undefined || ip === null) return 'unknown';
  let s = String(ip).trim();
  if (!s) return 'unknown';
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(':')) return s; // IPv4 (또는 알 수 없는 문자열) 그대로
  const lower = s.toLowerCase();
  // IPv4-mapped (점 표기): ::ffff:1.2.3.4
  const m = lower.match(/^(?:0{0,4}:){2,5}ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (m) return m[1];
  // IPv4-mapped (16진 표기): ::ffff:0102:0304
  const h = lower.match(/^(?:0{0,4}:){2,5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (h) {
    const hi = parseInt(h[1], 16);
    const lo = parseInt(h[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  if (lower.includes('.')) return lower; // 그 외 점 표기 혼합형 — 건드리지 않는다
  const parts = lower.split('::');
  if (parts.length > 2) return lower;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  let groups;
  if (parts.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return lower;
    groups = [...head, ...Array(fill).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return lower;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

module.exports = { normalizeIpKey };
