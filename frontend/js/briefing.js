// frontend/js/briefing.js
// SPLIT-1120 (plans/202 4단계 셋째 묶음): 오늘의 브리핑 화면(뉴스, 요약, 기록 경신 카드, 브리핑 머리, 어제 브리핑, 링크 복사)의 함수를 본체에서 글자 그대로 옮겼다.
// 본체보다 먼저 부르는 일반 스크립트다. 함수 안에서만 본체의 값과 함수(CFG, _escHtml, toast, healthJson, fmtSubsDate, dDayLabel 등)를 읽는다(실행 순간에는 아무것도 읽지 않는다).
// ── 부동산 뉴스 ───────────────────────────────────────
async function loadNews(btn){
  let cat='hot';
  if(btn){
    document.querySelectorAll('#news-cat .chip').forEach(c=>c.classList.remove('on'));
    btn.classList.add('on');
    cat=btn.dataset.cat||'hot';
  }
  const list=document.getElementById('newsList');
  list.innerHTML='<div style="padding:30px 0;text-align:center;color:var(--t3)">뉴스를 불러오는 중이에요</div>';
  try{
    const r=await fetch(`${CFG.api}/news?cat=${cat}`,{signal:AbortSignal.timeout(8000)});
    const d=await r.json();
    if(!d.items||!d.items.length){list.innerHTML='<div style="padding:30px 0;text-align:center;color:var(--t3)">표시할 뉴스가 없어요.</div>';return;}
    const fmtDate=(s)=>{try{const dt=new Date(s);if(!s||isNaN(dt.getTime()))return '';return `${dt.getMonth()+1}/${dt.getDate()} ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;}catch{return '';}};
    // XSS 방어: 백엔드 stripHtml 이 entity 를 디코드하므로 프론트에서 반드시 재-escape 필요
    // link 도 javascript:/data: 스킴 차단 (http/https 만 허용)
    const safeLink = (u) => {
      try { const url = new URL(u); return /^https?:$/.test(url.protocol) ? url.href : '#'; }
      catch { return '#'; }
    };
    list.innerHTML=d.items.map(n=>`
      <a href="${_escHtml(safeLink(n.link))}" target="_blank" rel="noopener noreferrer nofollow" style="display:block;padding:11px 14px;border:1px solid var(--bd);border-radius:var(--radius-base);margin-bottom:8px;text-decoration:none;color:var(--t1);background:var(--s0);transition:all .15s" onmouseover="this.style.borderColor='var(--acc)';this.style.background='var(--s1)'" onmouseout="this.style.borderColor='var(--bd)';this.style.background='var(--s0)'">
        <div style="font-size:14px;font-weight:600;line-height:1.5;margin-bottom:6px">${_escHtml(n.title)}</div>
        <div style="font-size:12px;color:var(--t3)">${_escHtml(n.source||'언론사')} · ${_escHtml(fmtDate(n.pubDate))} · 원문 보기 ↗</div>
      </a>
    `).join('') + `<div style="margin-top:10px;padding:8px;background:var(--s1);border-radius:var(--radius-sm);font-size:12px;color:var(--t3);text-align:center">출처: ${_escHtml(d.source||'')} · ${Number(d.count)||0}건 · 30분마다 새로 불러와요</div>`;
    list.dataset.loaded='1';
    // 핫 카테고리일 때만 3줄 시황 자동 로드 (첫 로드 시 1회)
    if(cat==='hot' && !document.getElementById('newsSummary').dataset.loaded){
      loadNewsSummary();
    }
  }catch(e){
    // UX-RETRY-2026-07-10 (Sprint DDDD): 일시 오류 시 새로고침 없이 복구 — 재시도 버튼(현재 카테고리 유지)
    list.innerHTML=`<div style="padding:30px 0;text-align:center;color:var(--red);font-size:12px">뉴스를 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.<br>
      <button class="abtn a2" style="margin:12px auto 0;padding:7px 18px;font-size:12px;width:auto" onclick="loadNews(document.querySelector('#news-cat .chip.on'))">다시 시도</button></div>`;
  }
}

// 3줄 시황 (핫 뉴스 로드 후 호출) — 공식 통계 기반, AI 생성 아님
async function loadNewsSummary(){
  const box=document.getElementById('newsSummary');
  if(!box) return;
  try{
    const r=await fetch(`${CFG.api}/news/summary`,{signal:AbortSignal.timeout(15000)});
    const d=await r.json();
    if(!d.summary || !d.summary.length) return;
    const lines = Array.isArray(d.summary) ? d.summary : [d.summary];
    // XSS 방어: 외부 API(ECOS·KOSIS) 유래 문자열이 섞이므로 출처와 무관하게 반드시 escape
    // REG-STRUCT-2026-08-19 (Sprint NNNNNNN-15): 구조화 응답(items)이면 시안처럼 출처·기준일 캡션 분리(전부 escape)
    const its = Array.isArray(d.items) && d.items.length ? d.items : null;
    document.getElementById('newsSummaryLines').innerHTML = its
      ? its.map((it,i)=>`<div class="brf-row"><div style="font-size:12px;font-weight:800;color:var(--brf-ink);background:var(--brf-ac);border-radius:var(--radius-sm);padding:2px 6px;line-height:1.5;align-self:flex-start;font-variant-numeric:tabular-nums;flex-shrink:0">${String(i+1).padStart(2,'0')}</div><div style="min-width:0"><div style="font-size:14px;line-height:1.55;font-weight:600;color:var(--brf-tx)">${_escHtml(it.text||'')}</div><div style="margin-top:5px;font-size:12px;color:var(--brf-tx3)">출처 ${_escHtml(it.src||'')}${it.date?` · 기준 ${_escHtml(String(it.date))}`:''}</div></div></div>`).join('')
      : lines.map((l,i)=>`<div class="brf-row"><div style="font-size:12px;font-weight:800;color:var(--brf-ink);background:var(--brf-ac);border-radius:var(--radius-sm);padding:2px 6px;line-height:1.5;align-self:flex-start;font-variant-numeric:tabular-nums;flex-shrink:0">${String(i+1).padStart(2,'0')}</div><div style="min-width:0;font-size:14px;line-height:1.55;font-weight:600;color:var(--brf-tx)">${_escHtml(l)}</div></div>`).join('');
    // NEWS-ZERO-COST-2026-08-16 (Sprint PPPPPPP): 시황은 이제 공식 통계 전용이다(AI 생성 아님).
    //   mode 가 없으면 통계 3종이 모두 실패한 안내 문구이므로 출처 줄 자체를 감춘다 —
    //   종전엔 이 자리에 'AI가 헤드라인을 정리' 가 들어갔는데, AI 경로가 사라진 지금은 거짓 문구가 된다.
    const srcEl=document.getElementById('newsSummarySrc');
    if(srcEl){
      const isData = d.mode==='data';
      srcEl.textContent = isData ? '공식 통계(한국은행, KOSIS 국가통계포털, 국토교통부 실거래가)를 자동으로 정리했어요. 매수·매도 추천이 아니에요.' : '';
      srcEl.style.display = isData ? '' : 'none';
    }
    const t=d.updatedAt?new Date(d.updatedAt):new Date();
    document.getElementById('newsSummaryTime').textContent = `· ${t.getMonth()+1}/${t.getDate()} ${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')} 기준`;
    box.style.display='block';
    box.dataset.loaded='1';
  }catch(e){
    // 요약 실패는 조용히 숨김 (뉴스 본체는 정상)
  }
}

// ── BRIEFING-HOME-2026-08-19 (Sprint NNNNNNN-5): 오늘의 브리핑 ──
//   전부 기존 공식 데이터 재조합 — 새 수집·AI 호출 0. 값 없는 항목은 항목채 생략(미확인 원칙).
//   3줄 시황은 기존 loadNewsSummary(#newsSummary)가 그린다 — 이 함수는 티커·날짜·위젯만.
/* PRICE-RECORDS-2026-08-29 (Sprint NNNNNNN-30): 최고·최저 경신 카드 렌더.
   전국 응답과 지역 응답이 **같은 모양**이라 한 함수로 그린다(백엔드 sliceRegion 이 모양을 맞춘다).
   ⚠ 창(windowDays)이 전국 7일 / 지역 30일로 다르다 — 지역별을 7일로 쪼개면 표본이 없어서다
     (실측: 7일이면 107개 지역 중 54곳이 경신 0~2건 / 30일이면 118곳 중 110곳이 3건 이상).
     그래서 창을 **제목에 그대로 적는다** — 두 수치를 나란히 비교하는 오독을 막는 유일한 장치다. */
function _renderRecordsCard(recs){
  const rc=document.getElementById('brfRecords'); if(!rc) return;
  const list=window._recRegions||[];
  const cur=(recs&&recs.scope==='region')?String(recs.lawdCd||''):'';
  window._recSel=cur;
  const eok=v=>Number.isFinite(Number(v))?(Number(v)/10000).toFixed(2)+'억':'';
  const selHtml=list.length?`<select id="brfRecRegion" class="brf-recsel" onchange="_recPickRegion(this.value)" aria-label="지역 선택">
      <option value=""${cur?'':' selected'}>전국</option>${list.map(r=>
        `<option value="${_escHtml(r.lawdCd)}"${cur===String(r.lawdCd)?' selected':''}>${_escHtml(r.name)}</option>`).join('')}
    </select>`:'';
  // 조회 실패·자료 없음도 카드를 지우지 않는다 — 선택기가 사라지면 전국으로 돌아갈 길이 없다.
  const hasAny=recs&&(Number(recs.highCount)||Number(recs.lowCount));
  if(!recs||(!hasAny&&!cur)){ rc.style.display='none'; return; }
  const scopeName=cur?(recs.regionName||(list.find(x=>String(x.lawdCd)===cur)||{}).name||''):'전국';
  const row=(it,kind)=>`<button class="brf-rec" onclick='goSearchResult(${_jsonAttr({aptName:it.aptName,sigungu:it.sigungu,umdNm:it.umdNm,lawdCd:it.lawdCd,buildYear:it.buildYear,recentDealDate:it.dealDate})})'>
      <span style="flex:1;min-width:0">
        <span class="brf-ell" style="display:block;font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_escHtml(it.aptName||'')}</span>
        <span style="display:block;margin-top:2px;font-size:12px;color:var(--brf-tx3)">${_escHtml(it.region||'')}${it.excluUseAr?' · 전용 '+_escHtml(String(it.excluUseAr))+'㎡':''}${it.floor!=null?' · '+Number(it.floor)+'층':''}</span>
      </span>
      <span style="text-align:right;flex-shrink:0">
        <span style="display:block;font-size:12px;font-weight:800;font-variant-numeric:tabular-nums">${eok(it.dealAmount)}</span>
        <span style="display:block;margin-top:2px;font-size:12px;color:var(--brf-tx3);font-variant-numeric:tabular-nums">직전 ${kind==='high'?'최고':'최저'} ${eok(kind==='high'?it.prevMax:it.prevMin)} · ${Number(it.priorCount)||0}건</span>
      </span>
    </button>`;
  const col=(title,arr,kind,cnt)=>`<div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
        <b style="font-size:12px;font-weight:800;color:var(--brf-tx)">${title}</b>
        <span style="font-size:12px;font-weight:700;color:var(--brf-tx2);font-variant-numeric:tabular-nums">${Number(cnt)||0}건</span>
      </div>
      ${arr&&arr.length?arr.map(it=>row(it,kind)).join(''):'<div style="font-size:12px;color:var(--brf-tx3);padding:8px 0">해당 거래 없음</div>'}
    </div>`;
  const body=recs._err
    ? `<div style="font-size:12px;color:var(--brf-tx3);padding:14px 0">${_escHtml(recs._err)}</div>`
    : `<div style="font-size:12px;color:var(--brf-tx2);margin-bottom:10px">비교 가능 거래 ${(Number(recs.comparedCount)||0).toLocaleString()}건${recs.latestDeal?` · 최신 거래일 ${_escHtml(String(recs.latestDeal).replace(/-/g,'.'))}`:''}</div>
       <div class="brf-rec2">${col('최고가 경신',recs.high,'high',recs.highCount)}${col('최저가 경신',recs.low,'low',recs.lowCount)}</div>`;
  rc.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:4px">
      <b class="brf-h2">최근 ${Number(recs.windowDays)||7}일 최고·최저 경신 <span style="font-weight:600;font-size:12px;color:var(--brf-tx2)">· ${_escHtml(scopeName)}</span></b>
      ${selHtml}
    </div>
    <div style="font-size:12px;color:var(--brf-tx3);margin-bottom:8px">같은 단지·같은 전용면적 기준 · ${_escHtml(String(recs.sinceDate||'').replace(/-/g,'.'))} 이후 쌓인 데이터 안에서${cur?' · 지역별은 거래가 적어 30일 기준으로 봐요':''}</div>
    ${body}
    <div style="font-size:12px;color:var(--brf-tx3);margin-top:10px;line-height:1.6">국토교통부 실거래 기준이에요. 직전 거래가 ${Number(recs.minPrior)||3}건 이상인 평형만 비교하고, 단지마다 1건만 보여 줘요. 층, 향, 수리 상태는 반영하지 않아요. 매수·매도 추천이 아니며 미래 가격을 예측하지 않아요.</div>`;
  rc.style.display='block';
}

async function _recPickRegion(lawdCd){
  const set=(d)=>{ try{ _renderRecordsCard(d); }catch(_e){} };
  const nameOf=c=>((window._recRegions||[]).find(x=>String(x.lawdCd)===String(c))||{}).name||'';
  const sel=document.getElementById('brfRecRegion'); if(sel) sel.disabled=true;
  try{
    const url=lawdCd
      ? `${CFG.api}/transactions/records?lawdCd=${encodeURIComponent(lawdCd)}`
      : `${CFG.api}/transactions/records?withRegions=1`;
    const r=await fetch(url,{signal:AbortSignal.timeout(9000)});
    if(!r.ok){
      // 404 = 그 지역엔 비교 가능한 거래가 없다. 0 으로 지어내지 않고 그 사실을 적는다.
      set({scope:lawdCd?'region':'national',lawdCd,regionName:nameOf(lawdCd),windowDays:lawdCd?30:7,
        minPrior:3,comparedCount:0,highCount:0,lowCount:0,high:[],low:[],
        _err:r.status===404?'이 지역은 최근 30일 안에 비교할 수 있는 거래가 없어요.':'조회에 실패했어요. 잠시 후 다시 시도해 주세요.'});
      return;
    }
    const d=await r.json();
    if(Array.isArray(d.regions)&&d.regions.length) window._recRegions=d.regions;
    set(d);
  }catch(_e){
    set({scope:lawdCd?'region':'national',lawdCd,regionName:nameOf(lawdCd),windowDays:lawdCd?30:7,
      minPrior:3,comparedCount:0,highCount:0,lowCount:0,high:[],low:[],_err:'조회에 실패했어요. 잠시 후 다시 시도해 주세요.'});
  }finally{
    const s2=document.getElementById('brfRecRegion'); if(s2) s2.disabled=false;
  }
}

async function renderBriefing(){
  try{
    const dEl=document.getElementById('briefDate');
    const now=new Date();
    if(dEl){ const yo='일월화수목금토'[now.getDay()];
      dEl.textContent=`${now.getFullYear()}.${String(now.getMonth()+1).padStart(2,'0')}.${String(now.getDate()).padStart(2,'0')}(${yo})`; }
    const [h,subs,pop,reglog,recs]=await Promise.all([
      healthJson(6000),   // PERF-HEALTH-DEDUP-2026-08-28
      fetch(`${CFG.api}/subscription?sido=&days=30`,{signal:AbortSignal.timeout(9000)}).then(r=>r.ok?r.json():null).catch(()=>null),
      fetch(`${CFG.api}/search/popular`,{signal:AbortSignal.timeout(9000)}).then(r=>r.ok?r.json():null).catch(()=>null),
      fetch(`${CFG.api}/regulations/log`,{signal:AbortSignal.timeout(9000)}).then(r=>r.ok?r.json():null).catch(()=>null),
      // PRICE-RECORDS-2026-08-29: 최고·최저 경신. 서버가 하루 1회만 계산해 캐시하므로 여기선 캐시 읽기다.
      //   withRegions=1 — 드롭다운용 지역 목록 동봉(랜딩은 숫자만 쓰므로 거기선 빼고 부른다).
      fetch(`${CFG.api}/transactions/records?withRegions=1`,{signal:AbortSignal.timeout(9000)}).then(r=>r.ok?r.json():null).catch(()=>null),
    ]);
    // BRF-DESIGN-2026-08-19 (Sprint NNNNNNN-8): 시안 코드화 — 티커=무한 테이프(라벨/값/출처 구조).
    //   전 항목 실데이터, 값 없으면 항목째 생략. 델타(전월 대비)는 원자료에 이전 값이 없어 표시하지 않는다(추정 금지).
    const er=h&&h.ecosRates; const dc=h&&h.dataCounts;
    const items=(subs&&subs.items)||[];
    const ps=_popRows(pop); // DEGRADED-LABEL-2026-10-18: 대체 경로면 평균가·건수를 비운다(티커·TOP5·랭킹 카드가 이 배열을 쓴다)
    window._lastPopular=ps; // RANKCARD: 랭킹 카드 재료(재조회 없이 재사용)
    const tk=[];
    if(er&&er.baseRate!=null) tk.push({l:'기준금리',v:_escHtml(String(er.baseRate))+'%',s:'한국은행'});
    if(er&&er.mortgageRate!=null) tk.push({l:'주담대 평균',v:_escHtml(String(er.mortgageRate))+'%',s:'한국은행 '+_escHtml(String(er.mortgageRateMonth||'').replace(/^(\d{4})(\d{2})$/,'$1.$2'))});
    if(dc&&dc.tx) tk.push({l:'실거래 누적',v:Number(dc.tx).toLocaleString()+'건',s:'국토부'+(dc.lastIngestedAt?' · '+_kstMD(dc.lastIngestedAt)+' 동기화':'')});
    if(ps.length&&ps[0].dealCount60d) tk.push({l:'실거래 최다·60일',v:_escHtml((ps[0].displayName||_dispAptName(ps[0].aptName, ps[0].umdNm))||'')+' '+ps[0].dealCount60d+'건',s:'국토부'});
    if(items.length&&items[0].name) tk.push({l:'청약 임박',v:_escHtml(items[0].name||''),s:'청약홈'});
    // REG-LOG: 현행 대출·규제 기준의 시행일(valid_from)·확인일 — 전부 스냅샷 사실값
    const _rh=(reglog&&Array.isArray(reglog.items))?reglog.items.find(x=>x.key==='housing_loan_2025'&&!x.supersededAt):null;
    if(_rh&&_rh.effectiveFrom) tk.push({l:'대출·규제 기준',v:String(_rh.effectiveFrom).replace(/-/g,'.')+' 시행',s:'금융위'+(_rh.verifiedAt?' · 확인 '+String(_rh.verifiedAt).slice(5,10).replace('-','.'):'')});
    const tEl=document.getElementById('briefTicker');
    const tape=document.getElementById('briefTape');
    if(tEl&&tape&&tk.length){
      const base=tk.map(t=>`<div class="brf-tk"><span style="font-size:12px;color:var(--brf-tx3);font-weight:600">${t.l}</span><span style="font-size:14px;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:-.01em;color:var(--brf-tx)">${t.v}</span><span style="font-size:12px;color:var(--brf-tx3)">${t.s}</span></div>`).join('');
      // translateX(-50%) 무한 루프가 이음새 없이 돌려면 내용이 짝수 반복이어야 한다 — 항목이 적으면 반복 수를 늘린다.
      const rep=Math.max(2,Math.ceil(6/tk.length)*2);
      tape.innerHTML=Array(rep).fill(base).join('');
      tEl.style.display='block';
    }
    const w=document.getElementById('briefWidgets'); if(!w) return;
    // 청약 D-day — 시안 카드(대형 D-n + 접수 기간). dDayLabel 의 긴급도 색상(red/amb)은 정보라 유지.
    let subsHtml='';
    if(items.length){
      subsHtml=items.slice(0,3).map(it=>`<div class="brf-row" style="align-items:center;gap:12px;padding:11px 13px;margin-bottom:8px">
        <div style="flex:0 0 56px;text-align:center"><div style="font-size:16px;font-weight:800;font-variant-numeric:tabular-nums">${dDayLabel(it.receiveStart)}</div><div style="font-size:12px;color:var(--brf-tx3)">접수</div></div>
        <div style="min-width:0;flex:1"><div class="brf-ell" style="font-size:12px;font-weight:700;color:var(--brf-tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_escHtml(it.name||'')}</div><div style="margin-top:2px;font-size:12px;color:var(--brf-tx2);font-variant-numeric:tabular-nums">접수 ${fmtSubsDate(it.receiveStart)}${it.receiveEnd?'~'+fmtSubsDate(it.receiveEnd):''}</div></div>
      </div>`).join('');
    } else { subsHtml=`<div style="font-size:12px;color:var(--brf-tx3);padding:6px 0">30일 안에 일정이 없거나 불러오지 못했어요</div>`; }
    // 인기 단지 TOP5 — 시안 카드(rank·단지·구 + 60일 평균가·건수). 평균가는 popular avgDealAmount(만원) 실데이터.
    let popHtml='';
    if(ps.length){
      popHtml=ps.slice(0,5).map((p2,i)=>`<button class="brf-top" onclick='goSearchResult(${_jsonAttr({aptName:p2.aptName,sigungu:p2.sigungu,umdNm:p2.umdNm,lawdCd:p2.lawdCd,buildYear:p2.buildYear,recentDealDate:p2.recentDealDate})})'>
        <span style="flex:0 0 18px;font-size:12px;font-weight:800;color:var(--brf-tx3);font-variant-numeric:tabular-nums">${i+1}</span>
        <span style="flex:1;min-width:0"><span class="brf-ell" style="display:block;font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_escHtml(p2.displayName || _dispAptName(p2.aptName, p2.umdNm) || '')}</span><span style="display:block;margin-top:2px;font-size:12px;color:var(--brf-tx3)">${_escHtml(_fmtSgg(p2.sigungu))}</span></span>
        <span style="text-align:right;flex-shrink:0">${Number.isFinite(Number(p2.avgDealAmount))&&Number(p2.avgDealAmount)>0?`<span style="display:block;font-size:12px;font-weight:800;font-variant-numeric:tabular-nums">${(Number(p2.avgDealAmount)/10000).toFixed(2)}억</span>`:''}<span style="display:block;margin-top:2px;font-size:12px;font-weight:700;color:var(--brf-tx2);font-variant-numeric:tabular-nums">${p2.repArea?Number(p2.repArea.sqm)+'㎡ 평균 · ':''}${p2.dealCount60d?p2.dealCount60d+'건':''}</span></span>
      </button>`).join('');
    } else { popHtml=`<div style="font-size:12px;color:var(--brf-tx3);padding:6px 0">불러오지 못했어요</div>`; }
    w.innerHTML=`
      <div class="brf-card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><b class="brf-h2">청약 D-day</b><a href="javascript:void(0)" onclick="sv('subs')" style="font-size:12px;color:var(--brf-tx3);text-decoration:none">전체 ›</a></div>
        ${subsHtml}
        <div style="font-size:12px;color:var(--brf-tx3);margin-top:6px">청약홈 · 신청하기 전에 applyhome.co.kr에서 다시 확인해 주세요</div>
      </div>
      <div class="brf-card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><b class="brf-h2">인기 단지 TOP 5</b><span style="display:flex;gap:10px"><a href="javascript:void(0)" onclick="openRankCard()" style="font-size:12px;color:var(--brf-ac-tx);text-decoration:none;font-weight:700">카드</a><a href="javascript:void(0)" onclick="sv('map')" style="font-size:12px;color:var(--brf-tx3);text-decoration:none">지도 ›</a></span></div>
        ${popHtml}
        <div style="font-size:12px;color:var(--brf-tx3);margin-top:8px">${ps.length&&ps[0]._degraded?'지금은 집계가 늦어져 최근 거래 표본으로 골랐어요. 평균가와 건수는 잠시 비워 둬요. 매물 광고가 아니에요.':'최근 60일 국토교통부 실거래 건수가 많은 순이에요. 평균가는 60일 기준이고 매물 광고가 아니에요.'}</div>
      </div>`;
    // PRICE-RECORDS-2026-08-29 (Sprint NNNNNNN-30): 최근 실거래 최고·최저 경신 카드.
    //   [왜 양쪽을 같이 싣는가] 최고가만 보여주면 카드 자체가 매수 신호로 읽힌다 — 절대 룰 ①.
    //     최저가 경신도 같은 비중으로 싣고, 색으로 좋고 나쁨을 암시하지 않는다(둘 다 같은 토큰).
    //   [왜 '역대'가 아닌가] 우리 적재는 sinceDate(2020-09-01 — 과거 이력 포함, Plan 103)부터다. 그 앞은 우리에게 없다.
    //     캡션에 그 날짜를 그대로 박아 "역대 신고가"로 읽히지 않게 한다.
    //   [왜 직전 거래 건수를 노출하는가] 표본 3건짜리 경신과 35건짜리 경신은 무게가 다르다.
    //     점수로 뭉개지 않고 원자료를 그대로 보여 사용자가 판단하게 한다.
    try{
      window._recRegions = (recs && Array.isArray(recs.regions)) ? recs.regions : [];
      _renderRecordsCard(recs);
    }catch(_e){}
    // 집킴이 코너 — 실제 동기화 기준일만 문장에 사용(추정 금지)
    // REG-LOG-2026-08-19 (Sprint NNNNNNN-12): 규제·금융 변동 로그 카드 — regulations_snapshot 버전 체인
    //   (운영자 검증 후에만 행이 추가되는 구조 = 전 행이 검증된 이벤트). valid_from=시행일. 감시 cron 실행
    //   시각(RSS 대조·스냅샷 점검)을 함께 표기 — "변동 없음"을 단정하지 않고 감시 사실만 적는다.
    try{
      const lg=document.getElementById('brfRegLog');
      if(lg&&reglog&&Array.isArray(reglog.items)&&reglog.items.length){
        const fm=d=>d?String(d).slice(0,10).replace(/-/g,'.'):'';
        const rows=reglog.items.slice(0,4).map(it=>`<div class="brf-row" style="align-items:baseline;gap:12px;flex-wrap:wrap;padding:10px 13px;margin-bottom:8px">
          <span style="font-size:12px;font-weight:700;color:var(--brf-tx3);font-variant-numeric:tabular-nums;flex:0 0 88px">${fm(it.effectiveFrom)} 시행</span>
          <span style="font-size:12px;font-weight:800;padding:3px 7px;border-radius:var(--radius-sm);background:var(--brf-panel);border:1px solid var(--brf-line);color:var(--brf-ac-tx)">${_escHtml(it.tag||'')}</span>
          <span style="flex:1;min-width:150px;font-size:12px;font-weight:600;color:var(--brf-tx);line-height:1.5">${_escHtml(it.note||'')}${it.supersededAt?` <span style="color:var(--brf-tx3);font-weight:500">(${fm(it.supersededAt)} 대체)</span>`:''}</span>
          ${it.verifiedAt?`<span style="font-size:12px;color:var(--brf-tx3)">확인 ${fm(it.verifiedAt)}</span>`:''}
        </div>`).join('');
        const cr=(h&&h.crons)||{};
        const _ago=at=>{const t=new Date(at);return isNaN(t)?null:Math.round((Date.now()-t.getTime())/3600000);};
        const watch=[];
        if(cr['regulations-auto-fetch']&&cr['regulations-auto-fetch'].at){const g=_ago(cr['regulations-auto-fetch'].at);if(g!=null)watch.push(`정부 공지 대조 ${g}시간 전`);}
        if(cr['regulations-check']&&cr['regulations-check'].at){const g=_ago(cr['regulations-check'].at);if(g!=null)watch.push(`저장해 둔 규제 정보 점검 ${g}시간 전`);}
        lg.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px"><b class="brf-h2">규제·금융 변동 로그</b><span style="font-size:12px;color:var(--brf-tx3)">금융위·국토부 고시 기준이고 확인된 변동만 기록해요</span></div>
          ${rows}
          ${watch.length?`<div style="font-size:12px;color:var(--brf-tx3);margin-top:2px">점검 내역: ${watch.join(', ')}. 새 고시는 확인을 거쳐 이 로그에 추가돼요.</div>`:''}`;
        lg.style.display='block';
      }
    }catch(_e){}
    const mm=document.getElementById('brfMascotMsg');
    // VERIFY-FIX-2026-08-19: 성공한 원자료만 '기준'으로 명시 — 조회 실패 시에도 3개 기관을 단정하던
    //   모순(적대 검증 적발, 절대룰 '값 없으면 생략'). subs/er/dc 가 null 이면 그 기관은 문장에서 뺀다.
    const _srcs=[];
    if(er) _srcs.push('한국은행');
    if(dc) _srcs.push('국토부 실거래');
    if(subs) _srcs.push('청약홈');
    if(mm) mm.textContent=(_srcs.length?`오늘 브리핑은 ${_srcs.join(', ')} 원자료를 기준으로 했어요.`:'오늘 브리핑 원자료를 잠시 불러오지 못했어요. 확인된 값만 보여줘요.')+(dc&&dc.lastIngestedAt?' 실거래 동기화 '+_kstMD(dc.lastIngestedAt)+'.':'')+' 값이 없는 항목은 추정하지 않고 비워 둬요.';
  }catch(_e){ /* 브리핑 실패는 조용히 — 뉴스 본체는 정상 */ }
}

function openYesterdayBrief(){
  try{
    const n=new Date(Date.now()-86400000);
    const day=`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
    window.open(`/briefing/${day}`,'_blank','noopener');
  }catch(_e){}
}

function copyBriefLink(){
  try{
    const n=new Date();
    const day=`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
    // BRIEFING-ARCHIVE-2026-08-19: 공유 링크 = 서버렌더 영구 URL(/briefing/날짜) — 카톡·X 미리보기·SEO 실체.
    //   복사 직전 fetch 로 오늘자 스냅샷 생성 보장(멱등 — 실패해도 복사는 진행, retention cron 이 보증).
    const url=`${location.origin}/briefing/${day}`;
    try{ fetch(url,{method:'GET'}).catch(()=>{}); }catch(_){ }
    navigator.clipboard.writeText(url).then(()=>toast('오늘 브리핑 링크를 복사했어요'),()=>toast('복사하지 못했어요'));
  }catch(_e){ toast('복사하지 못했어요'); }
}
