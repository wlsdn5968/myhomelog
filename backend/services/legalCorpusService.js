/**
 * 정부 공식 법령 corpus 서비스 (Sprint RR, 2026-05-19)
 *
 * 출처: 9bow/legalize-kr (GitHub)
 *   - License: 법령 원문 = 공공저작물 (자유 이용) / 메타데이터 = MIT
 *   - 원본 데이터: 국가법령정보센터 OpenAPI (law.go.kr) — 정부 공식
 *   - 갱신: 활발 (push 시점 매일 / 시행일 기준 git commit)
 *
 * 운영자 명령 (2026-05-19):
 *   "뉴스만 트레킹하면서 부정확한 내용 가져오면 안되잖아"
 *   → 정부 공식 법령 직접 인용으로 환각 차단
 *
 * 설계:
 *   - raw.githubusercontent.com 으로 markdown 직접 fetch (git clone X — 보안 + 디스크 절약)
 *   - in-memory cache (24h) — Vercel serverless cold start 마다 refetch 허용
 *   - force-push 위험 대응: 항상 latest raw fetch (commit hash 종속 X)
 *   - YAML frontmatter parser (간단 정규식 — 의존성 X)
 *
 * 적용 가능 법령 (부동산 핵심 10건, 검증된 HTTP 200):
 *   1. 주택법
 *   2. 지방세법 (취득세)
 *   3. 종합부동산세법
 *   4. 소득세법 (양도세 부분)
 *   5. 주택임대차보호법
 *   6. 공인중개사법
 *   7. 도시및주거환경정비법 (재건축/재개발)
 *   8. 부동산실권리자명의등기에관한법률
 *   9. 재건축초과이익환수에관한법률
 *   10. 민법 (부동산 §99 포함)
 */
const axios = require('axios');
const cache = require('../cache');
const logger = require('../logger');

const REPO_BASE = 'https://raw.githubusercontent.com/9bow/legalize-kr/main/kr';
const CACHE_TTL_S = 86400; // 24시간
const FETCH_TIMEOUT_MS = 10000;

// 부동산 핵심 법령 mapping
// key: 표준화된 영문 slug, value: 한글 법령명 (legalize-kr 디렉토리명)
const REAL_ESTATE_LAWS = {
  housing: { name: '주택법', desc: '주택 공급, 분양 등 기본법' },
  local_tax: { name: '지방세법', desc: '취득세·재산세 등 지방세' },
  comp_tax: { name: '종합부동산세법', desc: '종부세' },
  income_tax: { name: '소득세법', desc: '양도세 포함' },
  lease_protection: { name: '주택임대차보호법', desc: '임대차 (전세·월세) 보호' },
  realtor: { name: '공인중개사법', desc: '공인중개사 업무' },
  urban_renewal: { name: '도시및주거환경정비법', desc: '재건축·재개발' },
  real_owner: { name: '부동산실권리자명의등기에관한법률', desc: '실권리자 명의 등기 (명의신탁 금지)' },
  reconst_excess: { name: '재건축초과이익환수에관한법률', desc: '재건축 초과이익 환수' },
  civil: { name: '민법', desc: '부동산 § 99 등 기본 정의' },
};

const FILE_TYPES = ['법률', '시행령', '시행규칙'];

/**
 * YAML frontmatter 단순 파서 (의존성 X)
 * @param {string} content - markdown 본문
 * @returns {Object} { frontmatter: {...}, body: '...' }
 */
function parseFrontmatter(content) {
  if (!content || typeof content !== 'string') return { frontmatter: {}, body: content || '' };
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: content };
  const frontmatter = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([^:]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    let val = kv[2].trim();
    // 따옴표 제거
    val = val.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    frontmatter[key] = val;
  }
  return { frontmatter, body: m[2] };
}

/**
 * 한글 법령명 → raw URL
 */
function buildRawUrl(lawName, fileType = '법률') {
  const encodedLaw = encodeURIComponent(lawName);
  const encodedFile = encodeURIComponent(fileType);
  return `${REPO_BASE}/${encodedLaw}/${encodedFile}.md`;
}

/**
 * 단건 법령 fetch (in-memory cache)
 * @param {string} slug - REAL_ESTATE_LAWS key
 * @param {string} fileType - 법률/시행령/시행규칙
 * @returns {Promise<{ frontmatter, body, sourceUrl, fetchedAt } | null>}
 */
async function getLaw(slug, fileType = '법률') {
  const law = REAL_ESTATE_LAWS[slug];
  if (!law) {
    logger.debug({ slug }, 'getLaw: 미정의 slug');
    return null;
  }
  if (!FILE_TYPES.includes(fileType)) {
    logger.debug({ fileType }, 'getLaw: 미지원 fileType');
    return null;
  }
  const cacheKey = `law:${slug}:${fileType}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const url = buildRawUrl(law.name, fileType);
  try {
    const r = await axios.get(url, {
      timeout: FETCH_TIMEOUT_MS,
      responseType: 'text',
      headers: { 'User-Agent': 'myhomelog-bot/1.0 (legal-corpus)' },
    });
    const { frontmatter, body } = parseFrontmatter(r.data);
    const result = {
      slug,
      name: law.name,
      desc: law.desc,
      fileType,
      frontmatter,
      body, // markdown 본문 (조문)
      sourceUrl: `https://www.law.go.kr/법령/${encodeURIComponent(law.name)}`,
      repoUrl: url,
      fetchedAt: new Date().toISOString(),
    };
    cache.set(cacheKey, result, CACHE_TTL_S);
    return result;
  } catch (e) {
    if (e.response?.status === 404) {
      logger.debug({ slug, fileType, url }, 'getLaw: 법령 파일 없음 (404)');
    } else {
      logger.warn({ slug, fileType, err: e.message }, 'getLaw fetch 실패');
    }
    return null;
  }
}

/**
 * 모든 부동산 법령 목록 (메타데이터만 — body X)
 * @returns {Array}
 */
function listLaws() {
  return Object.entries(REAL_ESTATE_LAWS).map(([slug, info]) => ({
    slug,
    name: info.name,
    desc: info.desc,
    sourceUrl: `https://www.law.go.kr/법령/${encodeURIComponent(info.name)}`,
  }));
}

/**
 * 법령 키워드 검색 (간단 — 모든 법령 body 스캔)
 * @param {string} query - 검색어 (예: "취득세")
 * @param {number} maxResults
 * @returns {Promise<Array<{ slug, name, snippets: [...] }>>}
 */
async function searchLaws(query, maxResults = 5) {
  if (!query || query.length < 2) return [];
  const results = [];
  for (const slug of Object.keys(REAL_ESTATE_LAWS)) {
    const law = await getLaw(slug, '법률');
    if (!law) continue;
    const lines = String(law.body || '').split('\n');
    const snippets = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(query)) {
        snippets.push({
          line: i + 1,
          text: lines[i].slice(0, 200),
          context: lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 2)).join('\n').slice(0, 500),
        });
        if (snippets.length >= 3) break;
      }
    }
    if (snippets.length) {
      results.push({
        slug,
        name: law.name,
        sourceUrl: law.sourceUrl,
        matchCount: snippets.length,
        snippets,
      });
      if (results.length >= maxResults) break;
    }
  }
  return results;
}

module.exports = {
  REAL_ESTATE_LAWS,
  FILE_TYPES,
  getLaw,
  listLaws,
  searchLaws,
  parseFrontmatter, // 테스트용
};
