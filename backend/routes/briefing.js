/**
 * BRIEFING-ARCHIVE-2026-08-19 (Sprint NNNNNNN-6): GET /briefing/:date — 날짜별 영구 브리핑 페이지.
 *
 * 크롤러(검색엔진·카톡·X)와 사람 모두에게 **완전한 서버렌더 HTML** 을 반환한다 —
 * SPA(JS 렌더)는 크롤러에 안 보이므로, 여기가 SEO·공유의 실체다(/share OG 패턴의 확장).
 * 데이터는 briefingService 스냅샷(그날 실제 기록)만 사용 — 소급 생성 없음.
 */
'use strict';

const express = require('express');
const logger = require('../logger');
const { kstDayString, getOrCreateSnapshot } = require('../services/briefingService');
const router = express.Router();

const ORIGIN = 'https://myhomelog.vercel.app';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function dayNav(day, delta) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function pageShell(title, desc, day, body) {
  const canonical = `${ORIGIN}/briefing/${day}`;
  return `<!DOCTYPE html><html lang="ko"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${canonical}">
<meta property="og:type" content="article">
<style>
  /* ARCH-SKIN-2026-08-19 (Sprint NNNNNNN-14): 앱 시안 dark 팔레트와 1:1 정합(단일 테마 페이지 — 의도된 커미트먼트) */
  :root{--bg:#080E18;--card:#101B2B;--bd:#22334A;--tx:#E8EFFA;--sub:#93A4BD;--amb:#FFC93C;--acc:#4C8DFF}
  *{box-sizing:border-box;margin:0}
  body{background:var(--bg);color:var(--tx);font-family:Pretendard,-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;line-height:1.7;padding:28px 16px}
  main{max-width:640px;margin:0 auto}
  .eyebrow{color:var(--amb);font-size:11px;font-weight:800;letter-spacing:2px}
  h1{font-size:30px;margin:4px 0 2px;font-variant-numeric:tabular-nums}
  .tag{color:var(--sub);font-size:12px;margin-bottom:18px}
  .ticker{font-size:12px;color:var(--tx);border-top:1px solid var(--bd);border-bottom:1px solid var(--bd);padding:9px 2px;margin-bottom:20px;overflow-x:auto;white-space:nowrap}
  .ticker .src{color:var(--sub);font-size:10px}
  .card{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:14px 16px;margin-bottom:12px}
  .card h2{font-size:13px;color:var(--amb);margin-bottom:8px}
  .ln{display:flex;gap:10px;padding:6px 0;font-size:13.5px}
  .ln b.no{color:var(--amb);font-variant-numeric:tabular-nums}
  .pop{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px dashed var(--bd);font-size:12.5px}
  .pop:last-child{border-bottom:none}
  .nav{display:flex;justify-content:space-between;margin:18px 0;font-size:12px}
  a{color:var(--acc);text-decoration:none}
  .foot{color:var(--sub);font-size:10.5px;margin-top:20px;line-height:1.8}
  .cta{display:inline-block;margin-top:14px;padding:10px 18px;background:var(--amb);color:#1A2436;border-radius:9px;font-weight:700;font-size:13px}
</style></head><body><main>${body}
<div class="foot">⚠ 매수·매도 추천이 아닙니다 · 미래 가격 예측을 하지 않습니다 · 의사결정 책임은 본인에게 있습니다.<br>
출처: 국토교통부 실거래가 · 한국은행 ECOS · 국토부 KOSIS · © 내집로그</div>
</main></body></html>`;
}

// GET /briefing → 오늘로 리다이렉트
router.get('/', (req, res) => res.redirect(302, `/briefing/${kstDayString()}`));

router.get('/:date', async (req, res) => {
  const day = String(req.params.date || '').trim();
  // 형식·실존·범위 검증 (서비스 데이터 시작 이전·미래는 404)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day + 'T00:00:00Z'))
      || day < '2026-01-01' || day > kstDayString()) {
    return res.status(404).type('html').send(pageShell(
      '내집로그 브리핑', '요청한 날짜의 브리핑이 없습니다.', kstDayString(),
      `<div class="eyebrow">MYHOMELOG BRIEFING</div><h1>브리핑 없음</h1>
       <p style="font-size:13px;color:var(--sub)">요청한 날짜의 브리핑이 없어요.</p>
       <a class="cta" href="/briefing/${kstDayString()}">오늘 브리핑 보기 →</a>`));
  }

  let snap = null;
  try { snap = await getOrCreateSnapshot(day); } catch (e) {
    logger.warn({ err: e.message, day }, '/briefing 스냅샷 실패');
  }
  if (!snap) {
    return res.status(404).type('html').send(pageShell(
      `내집로그 브리핑 ${day}`, '해당 일자의 브리핑 기록이 없습니다.', day,
      `<div class="eyebrow">MYHOMELOG BRIEFING</div><h1>${esc(day)}</h1>
       <p style="font-size:13px;color:var(--sub)">이 날짜의 브리핑 기록이 없어요. 아카이브는 서비스가 기록을 시작한 날부터 쌓입니다.</p>
       <div class="nav"><a href="/briefing/${dayNav(day, -1)}">← 전날</a><a href="/briefing/${kstDayString()}">오늘 →</a></div>
       <a class="cta" href="/?briefing=${esc(day)}">앱에서 열기 →</a>`));
  }

  // 티커 — 값 있는 항목만 (미확인 원칙)
  const tk = [];
  if (snap.ecos && snap.ecos.baseRate != null) tk.push(`기준금리 <b>${esc(String(snap.ecos.baseRate))}%</b> <span class="src">한국은행</span>`);
  if (snap.ecos && snap.ecos.mortgageRate != null) tk.push(`주담대 평균 <b>${esc(String(snap.ecos.mortgageRate))}%</b> <span class="src">ECOS ${esc(String(snap.ecos.mortgageRateMonth || '').replace(/^(\d{4})(\d{2})$/, '$1.$2'))}</span>`);
  if (snap.txTotal) tk.push(`실거래 누적 <b>${Number(snap.txTotal).toLocaleString()}건</b> <span class="src">국토부${snap.syncedAt ? ' · ' + String(snap.syncedAt).slice(5, 10).replace('-', '.') + ' 동기화' : ''}</span>`);
  // REG-LOG (Sprint NNNNNNN-14): 현행 대출·규제 기준 시행일 — 스냅샷 사실값
  const _rl = (snap.regLog || []).find(x => x.key === 'housing_loan_2025' && !x.supersededAt);
  if (_rl && _rl.effectiveFrom) tk.push(`대출·규제 기준 <b>${esc(String(_rl.effectiveFrom).replace(/-/g, '.'))} 시행</b> <span class="src">금융위</span>`);

  // REG-STRUCT-2026-08-19 (Sprint NNNNNNN-15): 구조화 스냅샷(lines2)이면 출처·기준일 캡션 분리 — 구 스냅샷은 기존 렌더.
  const _l2 = Array.isArray(snap.lines2) && snap.lines2.length ? snap.lines2 : null;
  const lines = _l2
    ? _l2.map((it, i) =>
      `<div class="ln"><b class="no">${String(i + 1).padStart(2, '0')}</b><span>${esc(it.text || '')}<span style="display:block;margin-top:4px;font-size:10px;color:var(--sub)">출처 ${esc(it.src || '')}${it.date ? ` · 기준 ${esc(String(it.date))}` : ''}</span></span></div>`).join('')
    : (snap.lines || []).map((l, i) =>
      `<div class="ln"><b class="no">${String(i + 1).padStart(2, '0')}</b><span>${esc(l)}</span></div>`).join('');
  const pops = (snap.popular || []).filter(p => p && p.aptName).map((p, i) =>
    `<div class="pop"><span><b style="color:var(--amb)">${i + 1}</b> ${esc(p.aptName)}${p.sigungu ? ` <span style="color:var(--sub);font-size:10.5px">${esc(p.sigungu)}</span>` : ''}</span><span style="color:var(--sub)">${p.dealCount60d != null ? p.dealCount60d + '건' : ''}</span></div>`).join('');

  // REG-LOG (Sprint NNNNNNN-14): 규제·금융 변동 로그 카드(있을 때만 — 과거 스냅샷은 필드 없음)
  const regs = (snap.regLog || []).slice(0, 4).map(it =>
    `<div class="ln" style="align-items:baseline"><b class="no" style="font-size:11px;min-width:86px">${esc(String(it.effectiveFrom || '').replace(/-/g, '.'))} 시행</b><span><span style="color:var(--amb);font-size:10.5px;font-weight:700">${esc(it.tag || '')}</span> ${esc(it.note || '')}${it.verifiedAt ? ` <span style="color:var(--sub);font-size:10px">· 확인 ${esc(String(it.verifiedAt).replace(/-/g, '.'))}</span>` : ''}</span></div>`).join('');

  // PRICE-RECORDS-2026-08-29 (Sprint NNNNNNN-30): 최근 실거래 최고·최저 경신 카드.
  //   ⚠ '역대'가 아니라 **적재 시작일(sinceDate) 이후** 기록이다 — 문구에 그 날짜를 반드시 박는다.
  //   최고가만 싣지 않고 최저가도 같이 싣는다 — 한쪽만 보이면 그 자체가 매수 신호로 읽힌다(절대 룰 ①).
  const _eok = v => (Number.isFinite(Number(v)) ? (Number(v) / 10000).toFixed(2) + '억' : '');
  const _rec = snap.records;
  const _recRow = (it, kind) => `<div class="pop"><span>${esc(it.aptName || '')} <span style="color:var(--sub);font-size:10.5px">${esc(it.region || '')}${it.excluUseAr ? ' · 전용 ' + esc(String(it.excluUseAr)) + '㎡' : ''}</span></span><span style="color:var(--sub);white-space:nowrap"><b style="color:var(--amb)">${_eok(it.dealAmount)}</b> <span style="font-size:10px">직전 ${kind === 'high' ? '최고' : '최저'} ${_eok(kind === 'high' ? it.prevMax : it.prevMin)} · ${Number(it.priorCount) || 0}건</span></span></div>`;
  const recs = (_rec && (Number(_rec.highCount) || Number(_rec.lowCount))) ? `<div class="card">
      <h2>최근 ${Number(_rec.windowDays)}일 최고·최저 경신 <span style="font-weight:500;color:var(--sub);font-size:10px">같은 단지·같은 전용면적 기준 · ${esc(String(_rec.sinceDate || '').replace(/-/g, '.'))} 이후 적재분 안에서</span></h2>
      <div style="font-size:12px;color:var(--sub);margin-bottom:8px">비교 가능 거래 ${Number(_rec.comparedCount).toLocaleString()}건 중 최고가 경신 <b style="color:var(--tx)">${Number(_rec.highCount)}건</b> · 최저가 경신 <b style="color:var(--tx)">${Number(_rec.lowCount)}건</b></div>
      ${(_rec.high || []).slice(0, 3).map(it => _recRow(it, 'high')).join('')}
      ${(_rec.low || []).slice(0, 3).map(it => _recRow(it, 'low')).join('')}
      <div style="font-size:10px;color:var(--sub);margin-top:8px">직전 거래 ${Number(_rec.minPrior)}건 이상인 평형만 비교 · 층·향 차이는 보정하지 않음 · 매수·매도 추천이 아닙니다</div>
    </div>` : '';

  const yo = '일월화수목금토'[new Date(day + 'T00:00:00Z').getUTCDay()];
  const title = `내집로그 브리핑 ${day.replace(/-/g, '.')}(${yo}) — 실거래·금리·시장 데이터`;
  const desc = (snap.lines && snap.lines[0]) ? String(snap.lines[0]).slice(0, 120) : '국토부 실거래·한국은행 금리 기반 일일 부동산 데이터 브리핑';

  const isToday = day === kstDayString();
  // 과거 날짜는 불변 기록 — 엣지 캐시 길게. 오늘은 30분.
  res.set('Cache-Control', isToday ? 'public, max-age=0, s-maxage=1800' : 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800');
  res.type('html').send(pageShell(title, desc, day, `
    <div class="eyebrow">MYHOMELOG BRIEFING</div>
    <h1>${esc(day.replace(/-/g, '.'))}(${yo})</h1>
    <div class="tag">추천을 팔지 않습니다. 데이터를 팝니다.</div>
    ${tk.length ? `<div class="ticker">${tk.join('<span style="color:var(--bd);margin:0 9px">|</span>')}</div>` : ''}
    <div class="card"><h2>오늘의 시장</h2>${lines || '<div style="font-size:12px;color:var(--sub)">기록된 시황이 없습니다.</div>'}</div>
    ${recs}
    ${pops ? `<div class="card"><h2>인기 단지 TOP5 <span style="font-weight:500;color:var(--sub);font-size:10px">최근 60일 실거래 많은 순 · 매물 광고 아님</span></h2>${pops}</div>` : ''}
    ${regs ? `<div class="card"><h2>규제·금융 변동 로그 <span style="font-weight:500;color:var(--sub);font-size:10px">금융위·국토부 고시 · 검증된 이벤트만</span></h2>${regs}</div>` : ''}
    <div class="nav"><a href="/briefing/${dayNav(day, -1)}">← 전날 브리핑</a>${isToday ? '' : `<a href="/briefing/${dayNav(day, 1)}">다음날 →</a>`}</div>
    <a class="cta" href="/?briefing=${esc(day)}">앱에서 지도·계산기와 함께 보기 →</a>`));
});

module.exports = router;
