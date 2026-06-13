/**
 * 정책 변경 자동 감지 cron (Phase 20, 2026-05-04)
 *
 * 목적:
 *   금융위·국토교통부·국세청 보도자료 RSS 매주 fetch.
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
const RSS_SOURCES = [
  // ── 2026-06-13 전수 재검증 (구 4개 URL 전부 사망 확인: 금융위 404 · 국토부 무한리다이렉트 · 국세청 HTML · korea.kr 삭제) ──
  //   교체 URL 은 모두 실제 WebFetch 로 유효 RSS(<item>+최근 날짜) 확인 후 반영.
  {
    name: '금융위원회',
    url: 'https://www.fsc.go.kr/about/fsc_bbs_rss/?fid=0111', // 보도자료 RSS (검증 2026-06-13: 구 wsbiz/rss/in.do 404 → 본 경로 ~10건 유효, dc:date)
    keywords: ['LTV', 'DSR', '주담대', '대출', '주택담보', '규제지역', '스트레스', '디딤돌', '보금자리', '가계부채', '만기연장'],
  },
  {
    name: '국토교통부',
    url: 'https://www.korea.kr/rss/dept_molit.xml', // korea.kr 부처별 피드 (검증 2026-06-13: molit.go.kr 자체 RSS 무한리다이렉트 → korea.kr proxy 50건, 부동산 정책 확인)
    keywords: ['주택', '부동산', '규제지역', '청약', '재건축', '재개발', '분양', 'LTV', 'DSR', '토지거래허가'],
  },
  {
    name: '국세청',
    url: 'https://www.korea.kr/rss/dept_nts.xml', // korea.kr 부처별 피드 (검증 2026-06-13: nts.go.kr 자체 RSS 없음 → korea.kr proxy 50건)
    keywords: ['취득세', '양도세', '종부세', '종합부동산세', '주택세', '부동산세', '중과'],
  },
  // Sprint QQ: 정책브리핑 (korea.kr) — 부처 종합 정책 발표, 4.17 만기연장 같은 직접 발표 cover
  {
    name: '정책브리핑',
    url: 'https://www.korea.kr/rss/policy.xml', // 정책뉴스 RSS (검증 2026-06-13: 구 rssList.do?section= 삭제 → 정적 .xml 30건 유효)
    keywords: ['부동산', '주택', '대출', '가계부채', 'LTV', 'DSR', '청약', '취득세', '양도세'],
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
    const link = linkM ? linkM[1].trim() : '';
    const pubStr = pubM ? pubM[1].trim() : '';
    let pubDate = null;
    if (pubStr) {
      const d = new Date(pubStr);
      if (!isNaN(d)) pubDate = d;
    }
    if (title) items.push({ title, link, pubDate });
  }
  return items;
}

/**
 * 한 RSS 소스 fetch + 키워드 매칭.
 *
 * @param {{name: string, url: string, keywords: string[]}} src
 * @returns {Promise<{name: string, total: number, matched: Array, error: string|null}>}
 */
async function fetchSource(src) {
  try {
    const resp = await axios.get(src.url, {
      timeout: FETCH_TIMEOUT_MS,
      headers: { 'User-Agent': 'myhomelog-bot/1.0 (regulations monitoring)' },
      responseType: 'text',
      // RSS 가 아니어도 HTML 응답 받아서 키워드 매칭 가능
    });
    const items = parseRss(resp.data);
    const cutoff = Date.now() - LOOK_BACK_DAYS * 86400000;
    const matched = [];
    for (const it of items) {
      // 최근 7일 안 항목만
      if (it.pubDate && it.pubDate.getTime() < cutoff) continue;
      // 키워드 매칭
      const hits = src.keywords.filter(k => it.title.includes(k));
      if (hits.length) {
        matched.push({ ...it, hits });
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

  return {
    sources: results.map(r => ({
      name: r.name,
      total: r.total,
      matched_count: r.matched.length,
      matched: r.matched.slice(0, 5).map(m => ({ // 최대 5건만 응답
        title: m.title.slice(0, 200),
        link: m.link,
        pubDate: m.pubDate ? m.pubDate.toISOString() : null,
        hits: m.hits,
      })),
      error: r.error,
    })),
    totalMatched,
    topAlert,
  };
}

module.exports = { run, parseRss, RSS_SOURCES };
