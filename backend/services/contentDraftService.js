/**
 * CONTENT-DRAFT-2026-08-29 (Sprint NNNNNNN-30, 홍보 제안서 P2):
 * 스레드용 "데이터 드랍" 초안 생성기 — **AI 호출 0, 새 외부 수집 0**.
 *
 * [왜 AI 를 쓰지 않는가] 절대 룰(유료 LLM 경로 신규 추가 금지)이기도 하고, 애초에 필요가 없다.
 *   운영자가 실제로 쓰는 형식이 정해져 있고(아래), 들어갈 값은 전부 우리가 이미 계산해 둔 숫자다.
 *   AI 를 끼우면 숫자를 지어낼 위험만 생긴다.
 *
 * [형식의 출처 — 지어내지 않았다] 2026-08-29 @jipkimi 실제 게시물에서 관측한 구조를 그대로 쓴다:
 *   · 숫자 나열
 *   · "숫자만 전합니다. 시장 예측이나 매수·매도 권유가 아니에요."   ← 운영자의 실제 문구
 *   · "출처: …"
 *   · "이 숫자들은 내집로그에서 직접 볼 수 있어요. 지금은 무료입니다. myhomelog.vercel.app"
 *
 * [절대 룰]
 *   · 매수·매도 추천 X / 미래 예측 X — 고지 문구를 **템플릿에 박아** 빠질 수 없게 한다.
 *   · "역대"라고 쓰지 않는다. 적재 시작일(sinceDate)을 본문에 넣는다.
 *   · 값이 없으면 그 문장을 만들지 않는다(0·추정 금지). 재료가 없으면 초안도 없다.
 */
'use strict';

const logger = require('../logger');

const SITE = 'myhomelog.vercel.app';
const DISCLAIMER = '숫자만 전합니다. 시장 예측이나 매수·매도 권유가 아니에요.';
const CTA = `우리 동네는 어느 쪽인지 내집로그 브리핑에서 시군구를 골라 볼 수 있어요. 지금은 무료입니다.\n${SITE}`;

// 스레드 본문 상한(플랫폼 제한). 넘으면 그 초안은 내보내지 않고 사유를 남긴다 — 잘라내면 숫자가 깨진다.
const MAX_CHARS = 500;

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const comma = (v) => Number(v).toLocaleString('ko-KR');
const dot = (d) => String(d || '').replace(/-/g, '.');
const eok = (v) => (Number.isFinite(Number(v)) ? (Number(v) / 10000).toFixed(2) + '억' : null);

function srcLine(rec) {
  const parts = [];
  if (rec.latestDeal) parts.push(`최신 거래일 ${dot(rec.latestDeal)}`);
  if (rec.sinceDate) parts.push(`${dot(rec.sinceDate)} 이후 적재분 기준이라 '역대'는 아닙니다`);
  return `출처: 국토교통부 실거래가${parts.length ? ` (${parts.join(' · ')})` : ''}`;
}

/** 전국 요약 + 지역 대비 — 가장 기본이 되는 드랍 */
function draftNational(rec, regions) {
  const hi = n(rec.highCount), lo = n(rec.lowCount), cmp = n(rec.comparedCount);
  if (hi == null || lo == null || !cmp) return null;

  // 대비가 드러나는 지역을 고른다: 최고 편중 / 최저 편중 / 팽팽한 곳.
  const pool = (regions || []).filter(r => (r.highCount + r.lowCount) >= 5);
  const byHigh = pool.slice().sort((a, b) => b.highCount - a.highCount)[0];
  const byLow = pool.slice().sort((a, b) => b.lowCount - a.lowCount)[0];
  const even = pool.slice()
    .filter(r => r.highCount > 0 && r.lowCount > 0)
    .sort((a, b) => Math.abs(a.highCount - a.lowCount) - Math.abs(b.highCount - b.lowCount))[0];

  const picked = [];
  for (const r of [byHigh, byLow, even]) {
    if (r && !picked.some(p => p.lawdCd === r.lawdCd)) picked.push(r);
  }
  const lines = picked.map(r => `· ${r.name} ${r.highCount} / ${r.lowCount}`);

  const text = [
    `이번 주 전국 아파트 실거래에서 '최고가 경신'이 ${comma(hi)}건, '최저가 경신'이 ${comma(lo)}건 있었어요.`,
    `비교 가능한 거래 ${comma(cmp)}건을 같은 단지·같은 전용면적의 직전 거래와 대조한 결과입니다.`,
    '',
    ...(lines.length ? ['동네별로 방향이 갈려요 (최근 30일, 최고/최저)', ...lines, ''] : []),
    DISCLAIMER,
    srcLine(rec),
    '',
    CTA,
  ].join('\n');

  return { kind: 'national', title: '전국 주간 요약', text };
}

/** 한 지역 집중 — 사례 1건까지 붙인다(표본 수를 반드시 함께 적는다) */
function draftRegion(regionSlice) {
  const r = regionSlice;
  if (!r || !n(r.comparedCount)) return null;
  const top = (r.high || [])[0];
  const detail = (top && top.aptName && eok(top.dealAmount) && eok(top.prevMax))
    ? `${top.aptName} ${top.excluUseAr}㎡가 ${eok(top.dealAmount)}에 거래됐어요. 직전 최고가는 ${eok(top.prevMax)}, 비교에 쓴 직전 거래는 ${top.priorCount}건입니다.`
    : null;

  const text = [
    `${r.regionName}, 최근 ${n(r.windowDays) || 30}일 비교 가능 거래 ${comma(r.comparedCount)}건 중`,
    `최고가 경신 ${comma(r.highCount)}건 · 최저가 경신 ${comma(r.lowCount)}건이에요.`,
    ...(detail ? ['', detail] : []),
    '',
    DISCLAIMER,
    srcLine(r),
    '',
    CTA,
  ].join('\n');

  return { kind: 'region', title: `${r.regionName} 집중`, text, lawdCd: r.lawdCd };
}

/** 방법론 — 숫자가 없어도 언제나 성립하는 신뢰 포스트 */
function draftMethod(rec) {
  const text = [
    "저희가 '경신'을 세는 방법이에요.",
    '',
    '· 같은 단지, 같은 전용면적끼리만 비교해요 (평형이 다르면 비교가 성립하지 않으니까요)',
    `· 직전 거래가 ${n(rec && rec.minPrior) || 3}건 이상 쌓인 평형만 봐요 (1~2건짜리는 통계가 아니라 잡음이에요)`,
    '· 층·향·수리 상태는 보정하지 않아요. 보정하는 순간 사실이 아니라 추정이 되거든요',
    '',
    ...(rec && rec.sinceDate
      ? [`기준 구간은 ${dot(rec.sinceDate)} 이후 적재분이에요. 그 앞의 기록은 저희에게 없어서 '역대'라고는 안 씁니다.`, '']
      : []),
    DISCLAIMER,
    '출처: 국토교통부 실거래가',
  ].join('\n');
  return { kind: 'method', title: '방법론 공개', text };
}

/**
 * @param {number} regionCount 지역 집중 초안 개수
 * @returns {object|null} null 이면 재료 없음 — 초안을 지어내지 않는다
 */
async function buildDrafts({ regionCount = 3 } = {}) {
  const svc = require('./priceRecordsService');
  let rec = null, blob = null;
  try {
    rec = await svc.getPriceRecords();
    blob = await svc.getPriceRecordsByRegion();
  } catch (e) {
    logger.warn({ err: e.message }, 'content-draft: 재료 조회 실패');
    return null;
  }
  if (!rec) return null;

  const menu = svc.regionMenu(blob);
  const drafts = [];

  const nat = draftNational(rec, menu);
  if (nat) drafts.push(nat);
  drafts.push(draftMethod(rec));

  // 지역 집중은 **경신이 실제로 많은 곳**부터. 빈 지역으로 초안을 만들지 않는다.
  const top = menu.slice().sort((a, b) => (b.highCount + b.lowCount) - (a.highCount + a.lowCount)).slice(0, regionCount);
  for (const r of top) {
    const slice = svc.sliceRegion(blob, r.lawdCd);
    const d = slice && draftRegion(slice);
    if (d) drafts.push(d);
  }

  // 길이 초과는 잘라내지 않고 **표시만** 한다 — 자르면 숫자나 고지가 깨진다.
  const out = drafts.map(d => ({
    ...d,
    charCount: d.text.length,
    overLimit: d.text.length > MAX_CHARS,
  }));

  return {
    generatedAt: new Date().toISOString(),
    maxChars: MAX_CHARS,
    basis: {
      windowDaysNational: n(rec.windowDays),
      windowDaysRegion: blob ? n(blob.windowDays) : null,
      latestDeal: rec.latestDeal || null,
      sinceDate: rec.sinceDate || null,
    },
    drafts: out,
  };
}

module.exports = { buildDrafts, MAX_CHARS, _draftNational: draftNational, _draftRegion: draftRegion, _draftMethod: draftMethod };
