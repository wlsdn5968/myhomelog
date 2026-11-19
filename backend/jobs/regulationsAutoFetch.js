/**
 * 정책 변경 자동 감지 cron (Phase 20, 2026-05-04)
 *
 * 목적:
 *   금융위·국토교통부·재정경제부·국세청 보도자료 목록을 매일 읽는다(2026-11-19 부터 RSS 대신 누리집 목록, 아래 POLICY-SRC-HTML-1119).
 *   부동산 정책 키워드 (LTV·DSR·취득세·양도세·종부세·생애최초·청약·디딤돌·보금자리·규제지역)
 *   매칭 시 운영자 즉시 알림 (Sentry warn).
 *
 * 운영자 명령 (2026-05-04):
 *   "자동적으로 확인하고 패치해줘야 어드바이저"
 *   "맨날 내가 업데이트 시켜주면 이게 서비스가 안되지"
 *
 * 자동 update 정책:
 *   - 검출만 자동, DB insert 는 운영자 검증 후 (legal risk 차단)
 *   - 알림: Sentry capture + logger.warn (Phase 9 룰 #4 + 본 cron)
 *   - 검출 결과는 cache 에 저장 (운영자 /api/health 응답에 노출)
 *
 * 호출 빈도:
 *   매주 화요일 06:00 UTC (KST 15:00) — 평일 정책 발표 후
 *
 * 멱등:
 *   매번 RSS fetch — 누적 검출 X (마지막 1주일 항목만)
 *
 * 호출:
 *   POST /api/cron/regulations-auto-fetch (Vercel Cron)
 *   GET  도 동일 (수동 trigger)
 */
const axios = require('axios');
const logger = require('../logger');

// ── RSS 소스 (정부 보도자료) ───────────────────────────────
// 금융위원회 / 국토교통부 / 국세청 RSS URL
// 변경 시 본 객체만 수정 — endpoint/parser 영향 X
// Sprint QQ (2026-05-19): 한국부동산원 + 정책브리핑 추가 — 2026.4.17 만기연장 금지 등 누락 방지
// POLICY-SRC-HTML-1119 (운영자 승인 "권고대로 진행", 2026-11-19): 아래 RSS 네 곳이 모두 죽었다(11-18 확인).
//   정책브리핑 RSS 세 곳(dept_molit, dept_nts, policy)은 2026-07-01 제공 중단(공지 korea.kr newsId=132038885), 지금 404.
//   금융위원회 RSS 는 503 "현재 RSS 서비스 점검 중입니다"(11-18, 11-19 재확인).
//   그래서 기관 누리집의 보도자료 목록(HTML)을 직접 읽는다. 2026-11-19 에 네 곳 모두 아래 주소로 200, 상세 주소도 GET 으로 그 글이 열리는 것을 확인했다.
//   robots.txt: 국토교통부(이 경로 제한 없음), 금융위원회(Allow: /), 재정경제부(검색과 설문만 제한), 국세청(Allow: /).
//   예약 작업은 하루 한 번이라 첫 쪽만 읽는다(11-19 실측: 국토부 하루 최대 6건이라 40건(약 7일), 금융위 10건이 약 6일, 재정경제부 10건이 약 4일, 국세청 10건이 약 한 달).
//   목록에서 0건이면 RSS 로도 해석해 본다(기관이 RSS 를 되살리면 그대로 읽힌다).
const RSS_SOURCES = [
  {
    name: '금융위원회',
    url: 'https://www.fsc.go.kr/no010101',
    parse: 'fsc',
    // POLICY-MISS-1116 (운영자 지적 "왜 현재까지 대책을 못 따라가는거야"): 2026-08-13 「부동산 시장 안정을 위한 금융 종합대책」의
    //   보도자료 제목은 "수도권 23만호+α 추가 공급, 주택 공급 촉진 및 청년 등 실수요자 금융지원 강화"였다. 아래 낱말 가운데
    //   하나도 제목에 없어 감지되지 않았다(11-16 확인). '주택', '부동산', '전세', '가계대출'을 더하고 제목과 요약을 함께 본다.
    keywords: ['LTV', 'DSR', '주담대', '대출', '주택담보', '규제지역', '스트레스', '디딤돌', '보금자리', '가계부채', '만기연장', '주택', '부동산', '전세', '가계대출'],
  },
  {
    name: '국토교통부',
    url: 'https://www.molit.go.kr/USR/NEWS/m_71/lst.jsp?psize=40&lcmspage=1',
    parse: 'molit',
    cookieRetry: true, // 첫 요청은 쿠키를 심고 같은 주소로 307 을 돌려준다(쿠키 없이 따라가면 끝없이 돈다)
    keywords: ['주택', '부동산', '규제지역', '청약', '재건축', '재개발', '분양', 'LTV', 'DSR', '토지거래허가'],
  },
  {
    name: '재정경제부',
    url: 'https://mofe.go.kr/nw/nes/nesdta.do?bbsId=MOSFBBS_000000000028&menuNo=4010100',
    parse: 'mofe',
    keywords: ['부동산', '주택', '세제', '세법', '양도소득세', '양도세', '종합부동산세', '종부세', '취득세', '가계부채', '전세'],
  },
  {
    name: '국세청',
    url: 'https://www.nts.go.kr/nts/na/ntt/selectNttList.do?mi=2201&bbsId=1028',
    parse: 'nts',
    keywords: ['취득세', '양도세', '양도소득세', '종부세', '종합부동산세', '주택세', '부동산세', '중과', '기준시가'],
  },
];

const FETCH_TIMEOUT_MS = 15000;
// Sprint QQ: cron 매일 실행 변경 — 7일 lookback 으로 누락 방지
const LOOK_BACK_DAYS = 7;

/**
 * RSS XML 단순 파싱 (xml2js 의존성 회피 — 단순 regex).
 * RSS 2.0 표준 구조: <item><title>...</title><link>...</link><pubDate>...</pubDate></item>
 *
 * @param {string} xml RSS XML body
 * @returns {Array<{title: string, link: string, pubDate: Date|null}>}
 */
function parseRss(xml) {
  if (!xml || typeof xml !== 'string') return [];
  const items = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const titleM = block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    const linkM = block.match(/<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i);
    // COVERAGE-2026-06-13: korea.kr 은 <pubDate>, 금융위(fsc) 는 <dc:date> 사용 → 둘 다 파싱(없으면 날짜필터 통과).
    const pubM = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)
      || block.match(/<dc:date[^>]*>([\s\S]*?)<\/dc:date>/i);
    const title = titleM ? titleM[1].trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '';
    // POLICY-MISS-1116: 요약(description)도 낱말 대조에 쓴다. 제목에 정책 낱말이 없는 발표를 놓치지 않기 위해서다.
    //   느린 정규식을 늘리지 않으려고 위치로 잘라 낸다(앞 600자만).
    let desc = '';
    const _lower = block.toLowerCase();
    const _di = _lower.indexOf('<description');
    if (_di >= 0) {
      const _ds = block.indexOf('>', _di) + 1, _de = _lower.indexOf('</description>', _ds);
      if (_ds > 0 && _de > _ds) desc = block.slice(_ds, _de).replace('<![CDATA[', '').replace(']]>', '').replace(/<[^>]{0,300}>/g, ' ').replace(/&[a-z]{2,6};/g, ' ').slice(0, 600);
    }
    const link = linkM ? linkM[1].trim() : '';
    const pubStr = pubM ? pubM[1].trim() : '';
    let pubDate = null;
    if (pubStr) {
      const d = new Date(pubStr);
      if (!isNaN(d)) pubDate = d;
    }
    if (title) items.push({ title, link, pubDate, desc });
  }
  return items;
}

// POLICY-SRC-HTML-1119: 보도자료 목록 해석. 긴 정규식 대신 줄 단위로 잘라 짧은 패턴만 쓴다(느린 정규식 방지).
//   날짜는 목록에 적힌 한국 날짜(YYYY-MM-DD 또는 YYYY.MM.DD.)를 그날 0시(KST)로 읽는다.
function _kstDay(str) {
  const m = String(str || '').match(/(20\d{2})[.-](\d{1,2})[.-](\d{1,2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}T00:00:00+09:00`);
  return isNaN(d) ? null : d;
}
function _clean(t) {
  return String(t || '').replace(/<[^>]{0,300}>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&middot;/g, '·').replace(/\s+/g, ' ').trim();
}
const LIST_PARSERS = {
  // 국토교통부: <tr> 안에 <td class="bd_title"><a href="dtl.jsp?lcmspage=1&amp;id=95092623">제목</a> ... <td class="bd_date">2026-11-19</td>
  molit(html) {
    const out = [];
    for (const row of String(html || '').split(/<tr[\s>]/i)) {
      const ti = row.indexOf('class="bd_title"');
      if (ti < 0) continue;
      const id = (row.slice(ti, ti + 400).match(/dtl\.jsp\?[^"]{0,80}?id=(\d{1,12})/) || [])[1];
      const as = row.indexOf('>', row.indexOf('<a', ti)) + 1, ae = row.indexOf('</a>', as);
      const di = row.indexOf('class="bd_date"');
      if (!id || as <= 0 || ae < as) continue;
      const title = _clean(row.slice(as, ae).replace(/<i>[\s\S]{0,300}?<\/i>/gi, ''));
      if (title) out.push({ title, link: `https://www.molit.go.kr/USR/NEWS/m_71/dtl.jsp?id=${id}`, pubDate: di >= 0 ? _kstDay(row.slice(di, di + 60)) : null, desc: '' });
    }
    return out;
  },
  // 금융위원회: <li> 안에 <a href="/no010101/88173?..." title="제목"> ... <div class="day">2026-11-19
  fsc(html) {
    const out = [];
    for (const li of String(html || '').split(/<li[\s>]/i)) {
      const m = li.match(/href="\/no010101\/(\d{1,10})[^"]{0,200}"\s+title="([^"]{1,400})"/);
      const di = li.indexOf('class="day"');
      if (!m || di < 0) continue;
      out.push({ title: _clean(m[2]), link: `https://www.fsc.go.kr/no010101/${m[1]}`, pubDate: _kstDay(li.slice(di, di + 40)), desc: '' });
    }
    return out;
  },
  // 재정경제부: <li> 안에 <a href="javascript:fn_egov_select('MOSF_000000000080007');">제목</a> ... <span class="date">2026.11.19.</span>
  mofe(html) {
    const out = [];
    for (const li of String(html || '').split(/<li[\s>]/i)) {
      const m = li.match(/fn_egov_select\('([A-Z_0-9]{5,40})'\);">([^<]{1,400})<\/a>/);
      const di = li.indexOf('class="date"');
      if (!m || di < 0) continue;
      out.push({ title: _clean(m[2]), link: `https://mofe.go.kr/nw/nes/detailNesDtaView.do?searchBbsId1=MOSFBBS_000000000028&searchNttId1=${m[1]}&menuNo=4010100`, pubDate: _kstDay(li.slice(di, di + 40)), desc: '' });
    }
    return out;
  },
  // 국세청: <tr> 안에 <a href="javascript:;" data-id="1356171" title="제목" class="nttInfoBtn"> ... <td data-table="date">2026.11.17.</td>
  nts(html) {
    const out = [];
    for (const row of String(html || '').split(/<tr[\s>]/i)) {
      const m = row.match(/data-id="(\d{1,12})"\s+title="([^"]{1,400})"\s+class="nttInfoBtn"/);
      const di = row.indexOf('data-table="date"');
      if (!m || di < 0) continue;
      out.push({ title: _clean(m[2]), link: `https://www.nts.go.kr/nts/na/ntt/selectNttInfo.do?mi=2201&bbsId=1028&nttSn=${m[1]}`, pubDate: _kstDay(row.slice(di, di + 40)), desc: '' });
    }
    return out;
  },
};

/**
 * 국토교통부처럼 첫 응답에서 쿠키를 심고 같은 주소로 돌려보내는 곳: 쿠키를 받아 한 번만 다시 부른다.
 */
async function _getWithCookie(url, headers) {
  const first = await axios.get(url, { timeout: FETCH_TIMEOUT_MS, headers, responseType: 'text', maxRedirects: 0, validateStatus: (s) => s >= 200 && s < 400 });
  if (first.status < 300) return first;
  const set = [].concat((first.headers && first.headers['set-cookie']) || []).map((c) => String(c).split(';')[0]).filter(Boolean);
  if (!set.length) throw new Error(`redirect ${first.status} without cookie`);
  return axios.get(url, { timeout: FETCH_TIMEOUT_MS, headers: { ...headers, Cookie: set.join('; ') }, responseType: 'text', maxRedirects: 2 });
}

/**
 * 한 RSS 소스 fetch + 키워드 매칭.
 *
 * @param {{name: string, url: string, keywords: string[]}} src
 * @returns {Promise<{name: string, total: number, matched: Array, error: string|null}>}
 */
async function fetchSource(src) {
  try {
    const headers = { 'User-Agent': 'myhomelog-bot/1.0 (regulations monitoring)' };
    const resp = src.cookieRetry
      ? await _getWithCookie(src.url, headers)
      : await axios.get(src.url, { timeout: FETCH_TIMEOUT_MS, headers, responseType: 'text' });
    // POLICY-SRC-HTML-1119: 목록 해석이 먼저, 0건이면 RSS 로 해석한다.
    let items = (src.parse && LIST_PARSERS[src.parse]) ? LIST_PARSERS[src.parse](resp.data) : [];
    if (!items.length) items = parseRss(resp.data);
    const cutoff = Date.now() - LOOK_BACK_DAYS * 86400000;
    const matched = [];
    for (const it of items) {
      // 최근 7일 안 항목만
      if (it.pubDate && it.pubDate.getTime() < cutoff) continue;
      // 키워드 매칭
      const _hay = it.title + ' ' + (it.desc || '');
      const hits = src.keywords.filter(k => _hay.includes(k));
      if (hits.length) {
        matched.push({ title: it.title, link: it.link, pubDate: it.pubDate, hits });
      }
    }
    return { name: src.name, total: items.length, matched, error: null };
  } catch (e) {
    return { name: src.name, total: 0, matched: [], error: e.message };
  }
}

/**
 * 모든 RSS 소스 병렬 fetch + 종합.
 *
 * @returns {Promise<{
 *   sources: Array,        // 소스별 결과
 *   totalMatched: number,  // 전체 매칭 항목 수
 *   topAlert: string|null, // 운영자에게 강조할 한 줄
 * }>}
 */
async function run() {
  const results = await Promise.all(RSS_SOURCES.map(fetchSource));

  let totalMatched = 0;
  for (const r of results) {
    totalMatched += r.matched.length;
    if (r.error) {
      logger.warn({ source: r.name, err: r.error }, 'regulations-auto-fetch: 소스 fetch 실패');
    } else if (r.total === 0) {
      // COVERAGE-2026-06-13: fetch 는 성공했으나 <item> 0개 = RSS 가 깨짐(HTML/리다이렉트/오류 응답을 받아 파싱 0).
      //   기존에는 error 가 아니므로 조용히 넘어가 4개 소스가 모두 0건이어도 무경보였음(실측: 2026-06-13 전 소스 무효).
      //   운영자가 로그/Health 로 인지하도록 경고 — URL 점검 트리거.
      logger.warn({ source: r.name, url: r.url || null }, 'regulations-auto-fetch: 소스가 0개 항목 반환 — RSS URL 점검 필요(HTML/오류 응답 가능성)');
    }
    if (r.matched.length) {
      // 매칭된 항목들 logger.warn — Sentry capture
      for (const item of r.matched) {
        logger.warn({
          source: r.name,
          title: item.title.slice(0, 200),
          link: item.link,
          pubDate: item.pubDate ? item.pubDate.toISOString() : null,
          hits: item.hits,
        }, '🔔 regulations-auto-fetch: 정책 변경 의심 — 운영자 검토 필요');
      }
    }
  }

  // 종합 로그
  const summary = results.map(r => `${r.name}: ${r.matched.length}/${r.total}${r.error ? ' (err)' : ''}`).join(' | ');
  logger.info({
    sources: results.length,
    totalMatched,
    summary,
  }, totalMatched > 0
    ? `🔔 regulations-auto-fetch: ${totalMatched}건 검출 — 운영자 알림`
    : 'regulations-auto-fetch: 신규 변경 없음');

  const topAlert = totalMatched > 0
    ? `최근 ${LOOK_BACK_DAYS}일 정책 변경 의심 ${totalMatched}건 — Sentry 또는 logs 확인`
    : null;

  // POLICY-NOCUT-1118 (plans/209): 응답은 종전대로 소스당 5건만 싣는다. 저장과 계수는 걸린 글 전부(matchedAll)를 쓴다.
  //   종전에는 5건으로 자른 목록이 저장(persistDetected)과 대기 수(pendingReview)까지 그대로 갔다.
  //   한 소스에서 한 번에 6건 넘게 걸리면 6번째부터는 저장되지 않았다.
  const _slim = (m) => ({
    title: m.title.slice(0, 200),
    link: m.link,
    pubDate: m.pubDate ? m.pubDate.toISOString() : null,
    hits: m.hits,
  });
  return {
    sources: results.map(r => ({
      name: r.name,
      total: r.total,
      matched_count: r.matched.length,
      matched: r.matched.slice(0, 5).map(_slim), // 최대 5건만 응답
      matchedAll: r.matched.map(_slim),
      error: r.error,
    })),
    // POLICY-SRC-FAIL-1118 (plans/212): 못 읽은 소스 수. 오류가 났거나 항목이 0개인 소스를 센다.
    //   종전에는 경고 로그만 남아서, 네 곳을 모두 못 읽은 날도 실행 기록은 성공이고 대기 수는 0 이었다.
    sourcesTotal: results.length,
    sourcesFailed: results.filter(r => r.error || r.total === 0).length,
    totalMatched,
    topAlert,
  };
}

// LOOK_BACK_DAYS 도 export — regulationsAiCheck 가 사용자 노출 문구("최근 N일")에 쓴다.
//   상수를 복제하면 한쪽만 바뀌어 문구가 거짓이 되므로 여기가 단일 출처.
module.exports = { run, parseRss, RSS_SOURCES, LOOK_BACK_DAYS, LIST_PARSERS };
