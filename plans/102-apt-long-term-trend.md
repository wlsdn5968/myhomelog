# 102 — 단지 상세 "📈 실거래가" 탭에 장기(2020.09~) 월별 추세: `/api/transactions/history` + "최근 | 장기" 전환

**작성 기준 커밋**: `a2ebf5e` (2026-09-20) · 우선순위 P1(모아 둔 이력 129만 건의 첫 사용처) · 작업량 M · 의존: 없음(DDL 없음 — 101 의 인덱스 교체 전후 모두 동작)

## 전제 확인 (계획자가 DB·코드로 확인 — 추측 아님)
- DB: `molit_transactions_hist(apt_seq text, deal_date date, exclu_use_ar smallint = ㎡×100, deal_amount int = 만원, floor smallint)` 1,290,112행, 2020-09-01 ~ 2025-04-30, 해제 거래 제외(`fetchRegionMonth` 의 `isCanceled` 필터), 단지 27,137개(현재 검색 색인 23,017개 중 21,991개가 이력 보유 = 95.5%). `apt_seq` 전부 `^\d{5}-\d+$`. 단지당 행수 중앙값 16 · p99 358 · **최대 1,230**(1000 초과 단지 3개 → PostgREST 1000행 캡 때문에 페이징 필수). 인천 개편 구(제물포·영종·서해·검단)는 `apt_seq` 접두가 옛 코드(28110/28140/28260) 그대로라 `apt_seq` 로 과거가 이어진다.
- 원본 `molit_transactions`(2025-05-01~, `exclu_use_ar numeric` ㎡, `id` PK)는 `backend/services/transactionService.js` 의 `getTransactionsByAptSeq` 가 `.eq('apt_seq', seq)` 로 읽는다(서비스 롤 클라이언트 `getSupabaseAdmin()`, `cache.set(ck, v, 21600)`).
- 라우트 `backend/routes/transactions.js`: `/`(validateTransactionQuery)·`/codes`·`/records`. `/records` 는 핸들러 안에서 `require('../services/priceRecordsService')` 하고 성공 시 `Cache-Control: public, max-age=0, s-maxage=21600, stale-while-revalidate=86400`, 열화 시 `no-store`. `vercel.json` 은 `/api/(.*)` → `/api/index.js` 라 새 하위 경로에 라우트 추가가 필요 없다.
- 프론트 `frontend/index.html`: 현재 차트는 **최근 6개월** 거래(`/api/transactions?…` 기본 6개월)로 그린다. `buildPriceTrend(txHistory, areaSqm)`(`:7464`)가 `Math.round(excluUseAr)` 가 칩 면적 ±2㎡ 인 거래를 월별 단순평균해 `{label:'YY.MM', sortKey, avgAuk, count}` 로 만들고 `renderPriceChart(rows)`(`:7489`, 직접 SVG, 점 반지름 2.5)가 그린다. `showDetail` 안 `:7877~7878` 에서 `window._curTrendApt = p.txHistory || []; window._curTrendArea = 0;`, 중첩 함수 `_trendHtml(area)`(`:7880`), t1 템플릿 `:7984~7985` 에 `📈 월별 시세 추이` 제목과 `<div id="trendChartBox">${_trendHtml(0)}</div>`. 칩 클릭은 최상위 `_selectTrendArea(sqm, btn)`(`:7427`) — `if (!chartBox) return;` 다음에 `if (!sqm) { …안내…; return; }` 가 온다. 거래 항목에는 `aptSeq` 가 있다(`/api/transactions` 매핑). `openAptDetail` 의 `const p = {` (`:12309`)에는 `aptSeq` 필드가 없다(`r.aptSeq` 는 검색 행에만 있음).

## 범위
- 신규: `backend/services/aptHistoryService.js`, `backend/test/apt-history.test.js`.
- 수정: `backend/routes/transactions.js`(라우트 1개), `frontend/index.html`, `backend/test/frontend-contracts.test.js`(test 1개).
- 금지: `transactionService.js`·DDL·`vercel.json`·기존 최근 차트의 동작 변경(장기 모드가 아닐 때 화면은 지금과 같아야 한다).

## Step 1 — `backend/services/aptHistoryService.js`
```js
'use strict';
// APT-HISTORY-2026-09-20 (Plan 102): 단지(apt_seq) 장기 월별 집계 — 협폭 이력(molit_transactions_hist, ~2025-04) + 원본(molit_transactions, 2025-05~).
//   응답은 (월, 반올림 전용㎡)별 합계·건수 — 프론트가 기존 칩 규칙(±2㎡)으로 평균을 낸다(buildPriceTrend 와 같은 의미).
const { getSupabaseAdmin } = require('../db/client');
const cache = require('../cache');
const logger = require('../logger');
const SEQ_RE = /^\d{5}-\d+$/;
const PAGE = 1000, MAX_PAGES = 5; // 단지 최대 1,230행 실측 — 5,000 에 닿으면 경고

function parseSeqs(raw) {
  const list = String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length || list.length > 3 || !list.every(s => SEQ_RE.test(s))) return null;
  return [...new Set(list)].sort();
}
async function pageAll(build) {
  const out = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const { data, error } = await build(i * PAGE, i * PAGE + PAGE - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < PAGE) return { rows: out, capped: false };
  }
  return { rows: out, capped: true };
}
// 순수 함수. hist.exclu_use_ar = ㎡×100(정수), recent.exclu_use_ar = ㎡(numeric — 문자열로 올 수 있다).
function aggregateMonthly(histRows, recentRows) {
  const ymOf = d => String(d || '').slice(0, 7);
  const rec = (recentRows || []).filter(r => /^\d{4}-\d{2}/.test(String(r.deal_date || '')) && Number(r.deal_amount) > 0);
  const recentMinYm = rec.length ? rec.map(r => ymOf(r.deal_date)).sort()[0] : null;
  // 겹침 방지: 원본이 있는 달부터는 원본만 쓴다(앞으로 원본의 오래된 달을 이력으로 옮길 때 같은 달이 양쪽에 있어도 두 번 세지 않게).
  const hist = (histRows || []).filter(r => /^\d{4}-\d{2}/.test(String(r.deal_date || '')) && Number(r.deal_amount) > 0
    && (!recentMinYm || ymOf(r.deal_date) < recentMinYm));
  const b = new Map();
  const add = (ym, sqm, amt) => { if (!(sqm > 0)) return; const k = `${ym}|${sqm}`; const c = b.get(k) || { ym, sqm, sum: 0, n: 0 }; c.sum += amt; c.n += 1; b.set(k, c); };
  for (const r of hist) add(ymOf(r.deal_date), Math.round(Number(r.exclu_use_ar) / 100), Number(r.deal_amount));
  for (const r of rec) add(ymOf(r.deal_date), Math.round(Number(r.exclu_use_ar)), Number(r.deal_amount));
  const rows = [...b.values()].sort((x, y) => (x.ym < y.ym ? -1 : x.ym > y.ym ? 1 : x.sqm - y.sqm));
  return { rows, since: rows.length ? rows[0].ym : null, until: rows.length ? rows[rows.length - 1].ym : null, counts: { hist: hist.length, recent: rec.length } };
}
async function getAptHistoryMonthly(seqs) {
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const ck = `txhist:v1:${seqs.join(',')}`;
  const hit = cache.get(ck);
  if (hit !== undefined) return hit;
  try {
    const h = await pageAll((from, to) => admin.from('molit_transactions_hist').select('deal_date, exclu_use_ar, deal_amount')
      .in('apt_seq', seqs).order('deal_date', { ascending: true }).order('exclu_use_ar', { ascending: true })
      .order('deal_amount', { ascending: true }).order('floor', { ascending: true }).range(from, to));
    const w = await pageAll((from, to) => admin.from('molit_transactions').select('deal_date, exclu_use_ar, deal_amount')
      .in('apt_seq', seqs).order('deal_date', { ascending: true }).order('id', { ascending: true }).range(from, to));
    if (h.capped || w.capped) logger.warn({ seqs, hist: h.rows.length, recent: w.rows.length }, 'apt history 페이지 상한 도달 — 일부 거래 미집계');
    const out = { aptSeqs: seqs, ...aggregateMonthly(h.rows, w.rows), capped: h.capped || w.capped };
    cache.set(ck, out, 21600);
    return out;
  } catch (e) {
    logger.warn({ err: e.message, seqs }, 'apt history 조회 실패');
    return null; // 실패는 캐시하지 않는다
  }
}
module.exports = { parseSeqs, aggregateMonthly, getAptHistoryMonthly };
```

## Step 2 — `backend/routes/transactions.js` (`/records` 라우트 위에 추가)
```js
// GET /api/transactions/history?aptSeq=11500-10189[,11500-10190]  (최대 3개 — A/B 병합 단지)
// APT-HISTORY-2026-09-20 (Plan 102): (월, 전용㎡)별 합계·건수. 원자료는 하루 1회만 바뀐다 → 엣지 6시간. 실패는 no-store(열화 캐시 금지).
router.get('/history', async (req, res) => {
  const svc = require('../services/aptHistoryService');
  const seqs = svc.parseSeqs(req.query.aptSeq);
  if (!seqs) return res.status(400).json({ error: 'aptSeq 형식 오류 (예: 11500-10189, 최대 3개)' });
  const data = await svc.getAptHistoryMonthly(seqs);
  if (!data) { res.set('Cache-Control', 'no-store'); return res.status(503).json({ error: '장기 실거래 이력 조회 실패' }); }
  res.set('Cache-Control', data.capped ? 'no-store' : 'public, max-age=0, s-maxage=21600, stale-while-revalidate=86400');
  res.json({ ...data, source: '국토교통부 실거래가 공개시스템 (적재분)' });
});
```

## Step 3 — `frontend/index.html`
1. `openAptDetail` 의 `const p = {` 객체(`:12309`)에 `lawdCd: r.lawdCd,` 다음 줄로 `aptSeq: r.aptSeq || null, // Plan 102: 최근 거래가 0건인 단지도 장기 이력을 열 수 있게` 추가.
2. `showDetail` 안 `window._curTrendArea = 0;`(`:7878`) 다음 줄에 `window._trendMode = 'recent'; window._curTrendLong = null; window._curTrendSeqHint = p.aptSeq || null; // Plan 102` 추가. 중첩 함수 `_trendHtml(area)` 의 **첫 줄**에 `if (window._trendMode === 'long') return _longTrendHtml(area);` 를 넣고, 함수 정의 바로 뒤에 `window._trendHtml = _trendHtml;` 추가.
3. t1 템플릿의 제목 줄(`:7984`, `<div style="font-size:11px;font-weight:700;color:var(--t2);margin:14px 0 4px">📈 월별 시세 추이</div>`)을 아래로 교체(`trendChartBox` 줄은 그대로):
   ```html
   <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin:14px 0 4px">
     <div style="font-size:11px;font-weight:700;color:var(--t2)">📈 월별 시세 추이</div>
     <div role="group" aria-label="추이 기간" style="display:flex;gap:4px">
       <button type="button" class="trend-mode-btn" data-mode="recent" aria-pressed="true" onclick="_setTrendMode('recent')" style="font-size:10.5px;padding:3px 9px;border-radius:999px;border:1px solid var(--acc);background:var(--acc);color:#fff;cursor:pointer">최근</button>
       <button type="button" class="trend-mode-btn" data-mode="long" aria-pressed="false" onclick="_setTrendMode('long')" style="font-size:10.5px;padding:3px 9px;border-radius:999px;border:1px solid var(--bd);background:var(--bg-base);color:var(--t2);cursor:pointer">장기</button>
     </div>
   </div>
   ```
4. `_selectTrendArea` 에서 `if (!chartBox) return;` **바로 다음**에:
   ```js
   if (window._trendMode === 'long') { // Plan 102
     chartBox.innerHTML = _longTrendHtml(sqm);
     const _pk = document.getElementById('peakTrendBox');
     if (_pk && typeof window._peakTrendHtml === 'function') _pk.innerHTML = window._peakTrendHtml(sqm);
     return;
   }
   ```
5. `renderPriceChart` 의 점 반지름을 개수에 따라: `const dots=pts.map(` 줄 **위**에 `const _dotR = rows.length > 30 ? 1.3 : 2.5; // Plan 102: 장기(수십 개월)에서 점이 겹치지 않게` 를 넣고 그 줄의 `r="2.5"` 를 `r="${_dotR}"` 로.
6. `function buildPriceTrend` **바로 위**에 최상위 함수 4개 추가:
   ```js
   // LONG-TREND-2026-09-20 (Plan 102): 장기(2020.09~) 월별 추세 — /api/transactions/history 의 (월, ㎡)별 합계를 칩 규칙(±2㎡)으로 평균.
   function buildLongTrend(rows, areaSqm){
     if(!Array.isArray(rows)||!rows.length||!areaSqm)return[];
     const b={};
     for(const r of rows){
       const k=String((r&&r.ym)||'');
       if(!/^\d{4}-\d{2}$/.test(k))continue;
       if(Math.abs(Number(r.sqm)-areaSqm)>2)continue;
       if(!b[k])b[k]={sum:0,n:0};
       b[k].sum+=Number(r.sum)||0; b[k].n+=Number(r.n)||0;
     }
     return Object.keys(b).sort().filter(k=>b[k].n>0).map(k=>({label:k.slice(2,4)+'.'+k.slice(5,7),sortKey:Number(k.slice(0,4))*12+Number(k.slice(5,7)),avgAuk:(b[k].sum/b[k].n)/10000,count:b[k].n}));
   }
   function _longTrendSeqs(){
     const c={};
     for(const t of (window._curTrendApt||[])){ const s=String((t&&t.aptSeq)||''); if(/^\d{5}-\d+$/.test(s)) c[s]=(c[s]||0)+1; }
     const seqs=Object.keys(c).sort((a,b)=>c[b]-c[a]).slice(0,3);
     const hint=String(window._curTrendSeqHint||'');
     if(!seqs.length && /^\d{5}-\d+$/.test(hint)) seqs.push(hint);
     return seqs.sort();
   }
   function _longTrendHtml(area){
     const box=(t)=>`<div style="font-size:11px;color:var(--t3);padding:14px 8px;text-align:center;background:var(--bg2);border:1px dashed var(--bd);border-radius:var(--radius-base)">${t}</div>`;
     const L=window._curTrendLong;
     if(!L||L.state==='loading')return box('장기 이력을 불러오는 중…');
     if(L.state==='error')return box('장기 이력을 불러오지 못했어요 — "장기" 버튼을 다시 눌러 주세요.');
     if(!Array.isArray(L.rows)||!L.rows.length)return box('이 단지는 2020.09 이후 적재분에 거래 이력이 없어요.');
     if(!area){
       // 평형 칩이 있으면 고르게 안내. 최근 거래가 없어 칩이 없는 단지는 장기 이력에서 거래가 가장 많은 면적을 자동 선택한다.
       if(document.querySelector('.trend-area-chip[data-sqm]:not([data-sqm="0"])'))return box('📊 위 평형 chip 을 클릭하면 그 평형의 장기 추이를 보여드려요.');
       const tot={}; for(const r of L.rows){ tot[r.sqm]=(tot[r.sqm]||0)+(Number(r.n)||0); }
       area=Number(Object.keys(tot).sort((a,b)=>tot[b]-tot[a])[0]);
       if(!(area>0))return box('이 단지는 2020.09 이후 적재분에 거래 이력이 없어요.');
     }
     const td=buildLongTrend(L.rows,area);
     if(td.length<2)return `<div style="font-size:11px;color:var(--t3);padding:10px 0">${area}㎡(${Math.round(area/3.3058)}평) 장기 시세 추이 데이터 부족 (거래 2개월 이상)</div>`;
     const since=String(L.since||'').replace('-','.');
     return renderPriceChart(td)+`<div style="font-size:10px;color:var(--t3);margin-top:4px;line-height:1.5">국토교통부 실거래 · ${_escHtml(since)} 이후 적재분 · 전용 ${area}㎡(±2㎡) 월별 단순평균 · 거래 없는 달은 건너뜀 · 해제 거래 제외 · 매수·매도 추천 아님</div>`;
   }
   async function _setTrendMode(mode){
     window._trendMode = mode==='long' ? 'long' : 'recent';
     document.querySelectorAll('.trend-mode-btn').forEach(b=>{ const on=b.dataset.mode===window._trendMode; b.style.background=on?'var(--acc)':'var(--bg-base)'; b.style.color=on?'#fff':'var(--t2)'; b.style.borderColor=on?'var(--acc)':'var(--bd)'; b.setAttribute('aria-pressed',on?'true':'false'); });
     const paint=()=>{ const el=document.getElementById('trendChartBox'); if(el && typeof window._trendHtml==='function') el.innerHTML=window._trendHtml(window._curTrendArea||0); };
     if(window._trendMode==='long' && !(window._curTrendLong && window._curTrendLong.state==='ok')){
       const key=_longTrendSeqs().join(',');
       if(!key){ window._curTrendLong={state:'error',key:''}; paint(); return; }
       window._curTrendLong={state:'loading',key}; paint();
       try{
         const r=await fetch(`${CFG.api}/transactions/history?aptSeq=${encodeURIComponent(key)}`,{signal:AbortSignal.timeout(12000)});
         if(!r.ok)throw new Error('HTTP '+r.status);
         const j=await r.json();
         if(!window._curTrendLong||window._curTrendLong.key!==key)return; // 그 사이 다른 단지를 열었다
         window._curTrendLong={state:'ok',key,rows:Array.isArray(j.rows)?j.rows:[],since:j.since||null,until:j.until||null};
       }catch(_){ if(window._curTrendLong&&window._curTrendLong.key===key) window._curTrendLong={state:'error',key}; }
     }
     paint();
   }
   ```
   (`_escHtml`·`CFG`·`renderPriceChart` 는 같은 파일의 기존 전역이다. 인라인 JS 는 `npm run verify` 의 lint(no-undef)가 검사한다.)

## Step 4 — 테스트
- `backend/test/apt-history.test.js`(신규, `node:test`): ① `parseSeqs` — `'11500-10189'`→`['11500-10189']`, `'b,a'` 형식 오류→`null`, 4개→`null`, 중복 제거·정렬. ② `aggregateMonthly` — hist `{deal_date:'2021-03-05', exclu_use_ar:8499, deal_amount:100000}` 2건 + `{…'2021-03-20', 5998, 70000}` + recent `{deal_date:'2025-06-01', exclu_use_ar:'84.99', deal_amount:120000}` → rows 에 `{ym:'2021-03',sqm:85,sum:200000,n:2}`·`{ym:'2021-03',sqm:60,…}`·`{ym:'2025-06',sqm:85,sum:120000,n:1}`, `since:'2021-03'`, `until:'2025-06'`, `counts:{hist:3,recent:1}`. ③ 겹침: hist 에 `2025-06-10` 행이 있어도 recent 최소월이 `2025-06` 이면 그 hist 행은 버려진다(두 번 세지 않음). ④ `getAptHistoryMonthly` — `../db/client`·`../cache` 를 `require.cache` 스텁(패턴: `backend/test/popular-snapshot-shortfall.test.js` 의 `_withSnapshot`)으로 바꿔, hist 가 1000행+230행 두 페이지일 때 `range` 가 (0,999)·(1000,1999) 로 두 번 불리고 `counts.hist===1230`; DB 오류면 `null` 이고 캐시에 아무것도 안 넣는다. ⑤ 라우트: `express5-migration.test.js:98~125` 방식(express 앱에 `/api/transactions` 마운트 + `fetch`)으로 `aptSeq=abc` → 400, 서비스 스텁이 `null` → 503 + `no-store`, 정상 → 200 + `s-maxage=21600` + `source` 필드.
- `backend/test/frontend-contracts.test.js` 파일 끝: `frontend/index.html` 에서 `function buildLongTrend(rows, areaSqm){ … }` 소스를 정규식으로 잘라 `new Function` 으로 실행(이 파일의 `_assignMarkerStack` 테스트 `:242~250` 방식) → `[{ym:'2021-03',sqm:85,sum:200000,n:2},{ym:'2021-03',sqm:84,sum:90000,n:1},{ym:'2021-04',sqm:60,sum:70000,n:1}]`, area 84 → 1행 `{label:'21.03', avgAuk: (290000/3)/10000, count:3}`(±2㎡ 병합, 60㎡ 제외). 그리고 소스 계약: `_setTrendMode('long')` 버튼·`if (window._trendMode === 'long') return _longTrendHtml(area);`·`r="${_dotR}"` 포함, 캡션에 `매수·매도 추천 아님` 포함.

## 검증·완료 기준
- `npm run verify` → `fail 0`(424 + 신규 ≥ 6).
- 회귀 주입(수행 후 원복): (1) `aggregateMonthly` 의 겹침 필터(`ymOf(r.deal_date) < recentMinYm`) 제거 → ③ fail. (2) `pageAll` 의 `if (!data || data.length < PAGE)` 를 `return` 없이 1페이지만 읽게 바꾸면 ④ fail. (3) 프론트 `Math.abs(Number(r.sqm)-areaSqm)>2` 를 `>0` 으로 바꾸면 프론트 test fail.
- 리뷰어 라이브(배포 후): `/api/transactions/history?aptSeq=41550-29`(이력 1,230행 단지) → `counts.hist ≥ 1230`; 앱에서 충무주공 상세 → 실거래가 탭 → 평형 칩 → "장기" → 차트 기간이 `20.09 ~` 로 시작, "최근" 으로 되돌리면 기존 차트.
- 커밋 2개: `feat(실거래): 단지 장기 월별 이력 API — 협폭 이력+원본 합산, 1000행 페이징 (Plan 102)` · `feat(단지상세): 실거래가 탭 "최근|장기" 추이 전환 — 2020.09 이후 적재분 (Plan 102)`.

## STOP 조건
- `:7984` 제목 줄·`_selectTrendArea`·`_trendHtml` 의 현재 코드가 위 설명과 다르다 → 그 부분을 보고하고 STOP.
- `_escHtml` 이 최상위 전역이 아니다(lint no-undef) → 보고.
