// frontend/js/swap-checklist.js
// 거래 체크리스트(_dcl*)와 갈아타기 계산(_swp*). 2026-11-16 에 frontend/index.html 본체 스크립트에서 글자 그대로 옮겼다(plans/202 1단계).
// 일반 스크립트다(모듈 아님). index.html 이 본체 스크립트보다 먼저 불러 전역 이름이 그대로 남는다. HTML 의 onclick 과 본체가 이 이름을 부른다.
// 본체의 함수(toast, sv, calcLTV, isRegFront 등)는 실행 시점에만 부른다. 이 파일 맨 위에서 본체의 값을 읽지 말 것(아직 없다).
// ── 거래 체크리스트 ─────────────────────────────────────────
// DEAL-CHECKLIST-2026-10-30 (Plan 154, Claude Design 시안 p/f9e2563d 승인): 가계약부터 입주까지 할 일.
//   항목·숫자는 plans/154-deal-checklist-content.md 에서 법령 원문(law.go.kr)·공식 기관 페이지로 확인한 것만 쓴다.
//   라벨: dl=법정 기한(마감일 계산) · law=법령(날짜 없음) · off=공식 안내 · gen=일반 안내(근거 없음, 펼치기 없음).
//   날짜는 계약 타임라인(#deal-contract/#deal-balance)과 공유, 체크 상태는 이 기기(localStorage)에만 저장.
function _dclData(){
  const L=(law,jo,name)=>({n:name,l:'국가법령정보센터에서 보기',u:'https://www.law.go.kr/법령/'+encodeURIComponent(law)+'/'+encodeURIComponent(jo)});
  const A={n:"찾기쉬운 생활법령정보(법제처) '부동산 매매'",l:'생활법령정보에서 보기',u:'https://www.easylaw.go.kr'};
  const B={n:'대법원 인터넷등기소',l:'인터넷등기소 열기',u:'https://www.iros.go.kr'};
  const E={n:"찾기쉬운 생활법령정보(법제처) '소유권이전등기'",l:'생활법령정보에서 보기',u:'https://www.easylaw.go.kr'};
  const F={n:'금융위원회 가계대출 관리 강화 FAQ(2025.6.27) 7번',l:'금융위원회에서 보기',u:'https://www.fsc.go.kr/po020201/84825'};
  const G={n:'국세청 양도소득세 안내',l:'국세청에서 보기',u:'https://www.nts.go.kr'};
  const H={n:'정부24',l:'정부24 열기',u:'https://www.gov.kr'};
  const I={n:'국세청 안내',l:'홈택스 열기',u:'https://www.hometax.go.kr'};
  const RPT=L('부동산거래신고등에관한법률','제3조','부동산 거래신고 등에 관한 법률 제3조');
  const RESC=L('민법','제565조','민법 제565조');
  const SEAL=[E,L('부동산등기규칙','제60조','부동산등기규칙 제60조'),L('부동산등기규칙','제62조','부동산등기규칙 제62조')];
  const FEE=L('공동주택관리법','제30조','공동주택관리법 제30조');
  // 중개보수: 지급 시기(약정 없으면 거래대금 지급 완료일, 공인중개사법 §32③) — 생활법령정보 '부동산 중개보수 산정' 본문,
  //   상한 요율 안에서 협의(시행규칙 §20①) — law.go.kr 원문. 둘 다 2026-10-30 계획자 확인(2차 소비자 점검 후속).
  const COMM=[{n:"찾기쉬운 생활법령정보(법제처) '부동산 중개보수 산정'",l:'생활법령정보에서 보기',u:'https://www.easylaw.go.kr/CSP/CnpClsMain.laf?popMenu=ov&csmSeq=649&ccfNo=2&cciNo=2&cnpClsNo=2'},L('공인중개사법시행규칙','제20조','공인중개사법 시행규칙 제20조')];
  const COMM_D='약정이 없으면 거래대금을 다 치른 날에 줘요. 상한 요율 안에서 중개사와 협의해 정해요.';
  return {
    b:[
      {k:'pre',n:'가계약·계약 전',items:[
        {id:'b_loan',t:'대출 가능 금액 미리 확인',lb:'gen',btn:{t:'대출 계산',v:'calc'}},
        {id:'b_reg',t:'등기부로 매도인이 소유자인지 확인',d:'근저당이 있는지도 함께 확인해요.',lb:'off',src:[A,B]},
        {id:'b_land',t:'토지거래허가구역이면 허가 먼저 받기',d:'주거용은 취득일부터 2년 동안 이용 의무가 있어요.',lb:'law',src:[L('부동산거래신고등에관한법률시행령','제14조','부동산 거래신고 등에 관한 법률 시행령 제14조')]},
        {id:'b_fund',t:'자금조달·입주계획서 제출 대상인지 확인',d:'개인은 실거래가 6억 원 이상이거나, 투기과열지구·조정대상지역 주택이면 금액과 관계없이 내요. 기준은 바뀔 수 있어 중개사·시군구청에 확인해요.',lb:'off',src:[{n:"찾기쉬운 생활법령정보(법제처) '부동산거래 신고'",l:'생활법령정보에서 보기',u:'https://www.easylaw.go.kr/CSP/CnpClsMain.laf?csmSeq=649&ccfNo=4&cciNo=2&cnpClsNo=1'},L('부동산거래신고등에관한법률시행령','제3조','부동산 거래신고 등에 관한 법률 시행령 제3조')]},
        {id:'b_disp',t:'처분조건부 대출이면 기존 집 처분 기한 확인',d:'대출 실행일부터 6개월 안에 기존 집을 처분해야 해요. 어기면 대출이 회수돼요. 대출 은행과 확인해요.',lb:'off',src:[F]},
      ]},
      {k:'day',n:'계약 당일',items:[
        {id:'b_id',t:'신분증으로 매도인 본인 확인',d:'대리인이면 위임장과 인감증명서를 확인해요.',lb:'off',src:[A]},
        {id:'b_match',t:'계약서 부동산 표시가 등기부와 같은지 확인',lb:'off',src:[A,B]},
        {id:'b_expl',t:'중개대상물 확인·설명서 받기',lb:'off',src:[L('공인중개사법','제25조','공인중개사법 제25조')]},
        {id:'b_resc',t:'계약금 해제 규칙 알아두기',d:'상대가 이행에 착수하기 전까지는 계약금을 포기하고 해제할 수 있어요.',lb:'law',src:[RESC]},
        {id:'b_rpt',t:'부동산 거래신고',d:'계약일부터 30일 이내예요. 중개 거래는 중개사가 신고해요.',lb:'dl',due:{f:'c',n:30},src:[RPT]},
      ]},
      {k:'mid',n:'중도금',items:[
        {id:'b_mid',t:'중도금 내기 전 해제 규칙 다시 보기',d:'중도금을 내면 계약금만으로 해제하기 어려워질 수 있어요.',lb:'law',src:[RESC]},
      ]},
      {k:'bal',n:'잔금일',items:[
        {id:'b_reg2',t:'잔금 직전 등기부 다시 보기',lb:'gen'},
        {id:'b_seal',t:'매도인에게 등기필정보·인감증명서 받기',d:'인감증명서는 3개월 이내 발급분이어야 해요.',lb:'off',src:SEAL},
        {id:'b_fee',t:'관리비·장기수선충당금 정산',d:'장기수선충당금은 소유자가 부담해요.',lb:'off',src:[FEE]},
        {id:'b_comm',t:'중개보수 주기',d:COMM_D,lb:'off',src:COMM,btn:{t:'중개보수 계산',v:'biz'}},
      ]},
      {k:'reg',n:'등기·세금',items:[
        {id:'b_xfer',t:'소유권이전등기 신청',d:'잔금일부터 60일 이내에 해야 해요.',lb:'dl',due:{f:'b',n:60},src:[L('부동산등기특별조치법','제2조','부동산등기 특별조치법 제2조')]},
        {id:'b_acq',t:'취득세 신고·납부',d:'취득일(보통 잔금일)부터 60일 이내에 신고하고 내야 해요.',lb:'dl',due:{f:'b',n:60},src:[L('지방세법','제20조','지방세법 제20조')]},
        {id:'b_first',t:'생애최초 취득세 감면 확인',d:'12억 원 이하 주택이 대상이고 아파트는 200만 원 한도예요. 3년 안에 팔거나 임대하면 추징돼요.\n아파트도 인구감소지역이면 300만 원이에요.',lb:'law',src:[L('지방세특례제한법','제36조의3','지방세특례제한법 제36조의3')]},
        {id:'b_bond',t:'등기할 때 국민주택채권 매입',lb:'off',src:[L('주택도시기금법','제8조','주택도시기금법 제8조')]},
      ]},
      {k:'move',n:'입주',items:[
        {id:'b_move',t:'전입신고',d:'전입한 날부터 14일 이내예요. 정부24에서 온라인으로도 할 수 있어요.',lb:'dl',due:{f:'b',n:14},as:'잔금일에 전입한다고 보고 계산했어요',src:[L('주민등록법','제16조','주민등록법 제16조'),H]},
        {id:'b_disp2',t:'처분조건부면 기존 집 처분 증빙',lb:'off',src:[F]},
      ]},
    ],
    s:[
      {k:'pre',n:'가계약·계약 전',items:[
        {id:'s_one',t:'1주택 비과세 요건 확인',d:'2년 이상 보유해야 해요. 살 때 조정대상지역이었다면 보유 기간 중 2년 이상 살아야 해요. 12억 원 초과분은 과세돼요.',lb:'off',src:[L('소득세법시행령','제154조','소득세법 시행령 제154조'),G]},
        {id:'s_tmp',t:'일시적 2주택이면 처분 기한 확인',d:'새 집 취득일부터 3년 안에 기존 집을 팔아야 해요. 두 집이 모두 조정대상지역이고 새 집을 2026년 8월 4일 이후에 샀다면 2년이에요(2026년 10월 1일 시행). 8월 3일 이전에 사거나 계약금을 냈다면 3년이에요. 적용 시점은 세무서와 확인해요.',lb:'law',src:[L('소득세법시행령','제155조','소득세법 시행령 제155조')]},
        {id:'s_loan',t:'남은 대출 상환액 은행에 확인',lb:'gen'},
      ]},
      {k:'day',n:'계약 당일',items:[
        {id:'s_id',t:'매수인 본인 확인',lb:'off',src:[A]},
        {id:'s_resc',t:'계약금 해제 규칙 알아두기',d:'상대가 이행에 착수하기 전까지는 매도인은 받은 계약금의 두 배를 돌려주고 해제할 수 있어요.',lb:'law',src:[RESC]},
        {id:'s_rpt',t:'부동산 거래신고',d:'계약일부터 30일 이내예요. 중개 거래는 중개사가 신고해요.',lb:'dl',due:{f:'c',n:30},src:[RPT]},
      ]},
      {k:'bal',n:'잔금일',items:[
        {id:'s_seal',t:'등기필정보·인감증명서 준비',d:'인감증명서는 3개월 이내 발급분으로 준비해요.',lb:'off',src:SEAL},
        {id:'s_lien',t:'근저당 말소',lb:'gen'},
        {id:'s_fee',t:'관리비·장기수선충당금 정산',d:'장기수선충당금은 소유자가 부담해요.',lb:'off',src:[FEE]},
        {id:'s_comm',t:'중개보수 주기',d:COMM_D,lb:'off',src:COMM,btn:{t:'중개보수 계산',v:'biz'}},
      ]},
      {k:'tax',n:'세금 신고',items:[
        {id:'s_cgt',t:'양도소득세 예정신고',d:'양도일이 속한 달 말일부터 2개월 이내예요. 양도일은 잔금일과 등기접수일 중 빠른 날이에요.',lb:'dl',due:{f:'cgt'},as:'잔금일을 양도일로 보고 계산했어요',src:[L('소득세법','제105조','소득세법 제105조')]},
        {id:'s_sim',t:'홈택스 양도소득세 모의계산',d:'홈택스에서 세금신고, 양도소득세 신고, 모의계산, 양도소득세 자동계산 순서로 들어가요.',lb:'off',src:[I]},
      ]},
    ],
  };
}
const DCL_KEY='mhl_deal_cl';
const DCL_LB={dl:'법정 기한',law:'법령',off:'공식 안내',gen:'일반 안내'};
const DCL_ST={done:'완료',now:'진행 중',late:'남은 항목 있음',todo:'예정'};
// 'YYYY-MM-DD' → 로컬 자정(DDAY-TZ-FIX 와 같은 이유로 'T00:00:00'). 잘못된 값은 null.
function _dclParse(s){
  if(!s||!/^\d{4}-\d{2}-\d{2}$/.test(s))return null;
  const y=+s.slice(0,4);if(y<2000||y>2100)return null; // 연도를 치는 중('0002-…')인 값은 계산하지 않는다
  const d=new Date(s+'T00:00:00');return isNaN(d)?null:d;
}
function _dclAdd(d,n){const x=new Date(d.getFullYear(),d.getMonth(),d.getDate());x.setDate(x.getDate()+n);return x;}
function _dclDiff(d,today){
  const a=Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()),b=Date.UTC(today.getFullYear(),today.getMonth(),today.getDate());
  return Math.round((a-b)/86400000);
}
// 마감일: 기준일 + N일(초일 불산입과 같은 결과). 양도세는 양도일(=잔금일 가정)이 속한 달 말일부터 2개월 → 두 달 뒤 달의 말일.
//   민법 제161조(말일이 토요일·공휴일이면 다음 날)는 화면 안내로만 — 공휴일 달력을 만들지 않는다.
function _dclDue(it,c,b){
  if(!it||!it.due)return null;
  if(it.due.f==='c')return c?_dclAdd(c,it.due.n):null;
  if(it.due.f==='b')return b?_dclAdd(b,it.due.n):null;
  if(it.due.f==='cgt')return b?new Date(b.getFullYear(),b.getMonth()+3,0):null;
  return null;
}
function _dclFmt(d,today){
  const md=`${d.getMonth()+1}월 ${d.getDate()}일`;
  return d.getFullYear()===today.getFullYear()?md:`${d.getFullYear()}년 ${md}`;
}
function _dclWd(d){return '('+'일월화수목금토'[d.getDay()]+')';}
function _dclDd(n){return n>0?`D-${n}`:n===0?'D-day':`D+${-n}`;}
// 단계 머리(날짜 문구·배지)와 상태. 상태: 다 체크=완료 / 기간이 지났는데 남음=남은 항목 있음 / 기간 안=진행 중 / 그 전=예정.
function _dclStage(sg,c,b,today,done){
  const m=sg.items.length,n=sg.items.filter(it=>done[it.id]).length;
  const dues=sg.items.map(it=>_dclDue(it,c,b)).filter(Boolean);
  const maxDue=dues.length?new Date(Math.max(...dues.map(d=>d.getTime()))):null;
  let start=null,end=null,txt='',badge=null;
  const bd=(lbl,d)=>{const x=_dclDiff(d,today);return {t:`${lbl} ${_dclDd(x)}`,past:x<0};};
  if(sg.k==='pre'){ if(c){end=_dclAdd(c,-1);txt=`${_dclFmt(end,today)}까지`;badge=bd('계약',c);} }
  else if(sg.k==='day'){ if(c){start=end=c;txt=`${_dclFmt(c,today)} ${_dclWd(c)}`;badge=bd('계약',c);} }
  else if(sg.k==='mid'){ txt='계약일과 잔금일 사이'; if(c&&b){start=_dclAdd(c,1);end=_dclAdd(b,-1);} if(b)badge=bd('잔금',b); }
  else if(sg.k==='bal'){ if(b){start=end=b;txt=`${_dclFmt(b,today)} ${_dclWd(b)}`;badge=bd('잔금',b);} }
  else if(sg.k==='reg'||sg.k==='tax'){ if(b&&maxDue){start=b;end=maxDue;txt=`${_dclFmt(maxDue,today)}까지`;badge=bd('마감',maxDue);} }
  else if(sg.k==='move'){ txt='잔금일 이후'; if(b){start=b;end=maxDue||b;badge=bd('잔금',b);} }
  let st;
  if(n===m)st='done';
  else if(!end)st=n>0?'now':'todo';
  else if(_dclDiff(end,today)<0)st='late';
  else if(!start||_dclDiff(start,today)<=0)st='now';
  else st='todo';
  return {txt,badge,st,n,m};
}
function _dclLoad(){
  try{const o=JSON.parse(localStorage.getItem(DCL_KEY)||'{}');return {r:o.r==='s'?'s':'b',c:typeof o.c==='string'?o.c:'',b:typeof o.b==='string'?o.b:'',done:(o.done&&typeof o.done==='object')?o.done:{}};}
  catch(_){return {r:'b',c:'',b:'',done:{}};}
}
function _dclSave(s){try{localStorage.setItem(DCL_KEY,JSON.stringify(s));}catch(_){}}
let _dclOpenSet=null; // 모바일 단계 펼침 — 사용자가 누른 상태를 렌더 사이에 유지(역할을 바꾸면 초기화)
const _dclSrcOpen=new Set(); // 펼친 근거 패널 — 체크로 다시 그려도 접히지 않게
const _DCL_CHEV='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
function _dclRender(){
  const box=document.getElementById('dclList');if(!box)return;
  const s=_dclLoad(),data=_dclData(),stages=data[s.r],today=new Date();
  const c=_dclParse(s.c),b=_dclParse(s.b);
  const ic=document.getElementById('dcl-contract'),ib=document.getElementById('dcl-balance');
  if(ic&&ic.value!==s.c)ic.value=s.c;
  if(ib&&ib.value!==s.b)ib.value=s.b;
  document.querySelectorAll('#view-deal .dcl-seg button').forEach(x=>x.setAttribute('aria-pressed',x.dataset.role===s.r?'true':'false'));
  const all=stages.flatMap(sg=>sg.items),nd=all.filter(it=>s.done[it.id]).length,pct=all.length?Math.round(nd/all.length*100):0;
  const pn=document.getElementById('dclProgN');if(pn)pn.textContent=`${nd}/${all.length}`;
  const bar=document.getElementById('dclBar');if(bar){bar.setAttribute('aria-valuenow',String(pct));const i=bar.querySelector('i');if(i)i.style.width=pct+'%';}
  const infos=stages.map(sg=>_dclStage(sg,c,b,today,s.done));
  if(!_dclOpenSet){
    _dclOpenSet=new Set(stages.filter((sg,i)=>infos[i].st==='now'||infos[i].st==='late').map(sg=>sg.k));
    if(!_dclOpenSet.size){const f=stages.find((sg,i)=>infos[i].st!=='done');if(f)_dclOpenSet.add(f.k);}
  }
  const E=_escHtml,mob=_dclMob();_dclMobLast=mob;
  box.innerHTML=stages.map((sg,i)=>{
    const inf=infos[i],open=_dclOpenSet.has(sg.k);
    const items=sg.items.map(it=>{
      const on=!!s.done[it.id],due=_dclDue(it,c,b);
      let right=`<span class="dcl-lb ${it.lb}">${DCL_LB[it.lb]}</span>`;
      if(it.due){
        if(due){const x=_dclDiff(due,today);right+=`<span class="dcl-due">${E(_dclFmt(due,today))}까지</span><span class="dcl-dd${!on&&x<=30?' near':''}">${on?'완료':_dclDd(x)}</span>`;}
        else right+=`<span class="dcl-dd">${it.due.f==='c'?'계약일':'잔금일'}을 넣으면 계산해요</span>`;
        if(it.as&&due)right+=`<span class="dcl-as">${E(it.as)}</span>`;
      }
      const has=!!(it.src&&it.src.length),sid='dcls-'+it.id,so=has&&_dclSrcOpen.has(it.id);
      return `<li class="dcl-it${on?' on':''}">
        <div class="dcl-row">
          <label class="dcl-cbw"><input type="checkbox" class="dcl-cb" data-id="${it.id}" aria-label="${E(it.t)}"${on?' checked':''} onchange="_dclToggle('${it.id}',this.checked)"></label>
          <div class="dcl-txt"><div class="dcl-t">${E(it.t)}</div>${it.d?`<div class="dcl-d">${E(it.d)}</div>`:''}${it.btn?`<div class="dcl-act"><button type="button" class="dcl-btn2" onclick="sv('${it.btn.v}')">${E(it.btn.t)}</button></div>`:''}</div>
          <div class="dcl-right">${right}</div>
          <button type="button" class="dcl-more${has?'':' none'}"${has?` aria-expanded="${so?'true':'false'}" aria-controls="${sid}" aria-label="${E(it.t)} 근거 보기" onclick="_dclMore(this)"`:' tabindex="-1" aria-hidden="true"'}>${_DCL_CHEV}</button>
        </div>
        ${has?`<div class="dcl-src" id="${sid}"${so?'':' hidden'}>${it.src.map(x=>`<div class="dcl-srow"><span>${E(x.n)}<i> · 2026-10-30 확인</i></span><a class="dcl-lnk" href="${E(x.u)}" target="_blank" rel="noopener noreferrer">${E(x.l)}</a></div>`).join('')}</div>`:''}
      </li>`;
    }).join('');
    const bdg=inf.badge?`<span class="dcl-badge${inf.badge.past?' past':''}">${E(inf.badge.t)}</span>`:'';
    return `<section class="dcl-stage${open?' open':''}" data-st="${inf.st}" data-k="${sg.k}">
      <div class="dcl-rail"><span class="dcl-dot"></span></div>
      <div>
        <${mob?'button':'div'} class="dcl-sh"${mob?` type="button" aria-expanded="${open?'true':'false'}" aria-controls="dclb-${sg.k}" onclick="_dclStageToggle('${sg.k}')"`:''}>
          <span class="dcl-shm"><span class="dcl-sn">${E(sg.n)}</span><span>${inf.txt?`<span class="dcl-sd">${E(inf.txt)}</span> `:''}${bdg}</span></span>
          <span class="dcl-ss"><span class="dcl-sw">${DCL_ST[inf.st]} · </span>${inf.n}/${inf.m}</span>
          <span class="dcl-chev">${_DCL_CHEV}</span>
        </${mob?'button':'div'}>
        <ul class="dcl-items dcl-body dcl-card" id="dclb-${sg.k}">${items}</ul>
      </div>
    </section>`;
  }).join('');
}
// 단계 접기는 좁은 화면(≤700px, 시안 1c)에서만 — 데스크톱은 늘 펼친 타임라인이라 버튼으로 만들지 않는다.
function _dclMob(){try{return window.matchMedia('(max-width:700px)').matches;}catch(_){return false;}}
// 폭이 기준선을 넘나들면 다시 그린다. MediaQueryList 를 변수로 잡아 둔다(참조가 없으면 감지기가 정리될 수 있다 — 실측: 모바일로
//   줄인 뒤 단계 머리가 div 로 남아 펼칠 수 없었다). resize 도 함께 — 직전 상태와 다를 때만.
let _dclMobLast=null;
function _dclMobSync(){const m=_dclMob();if(m===_dclMobLast)return;_dclMobLast=m;if(_dclVisible())_dclRender();}
const _dclMq=(()=>{try{return window.matchMedia('(max-width:700px)');}catch(_){return null;}})();
try{if(_dclMq)_dclMq.addEventListener('change',_dclMobSync);}catch(_){}
window.addEventListener('resize',_dclMobSync,{passive:true});
function _dclVisible(){const v=document.getElementById('view-deal');return !!v&&getComputedStyle(v).display!=='none';}
function _dclSetRole(r){const s=_dclLoad();if(s.r===r)return;s.r=r==='s'?'s':'b';_dclSave(s);_dclOpenSet=null;_dclRender();}
function _dclToggle(id,on){
  const s=_dclLoad();if(on)s.done[id]=true;else delete s.done[id];_dclSave(s);_dclRender();
  // 다시 그리면 DOM 이 바뀌어 키보드 포커스가 사라진다 — 같은 체크박스로 돌려놓는다
  const cb=document.querySelector(`#dclList .dcl-cb[data-id="${id}"]`);if(cb)try{cb.focus({preventScroll:true});}catch(_){cb.focus();}
}
function _dclMore(btn){
  const id=btn.getAttribute('aria-controls'),el=id&&document.getElementById(id);if(!el)return;
  const open=btn.getAttribute('aria-expanded')!=='true';btn.setAttribute('aria-expanded',open?'true':'false');el.hidden=!open;
  const iid=id.replace(/^dcls-/,'');if(open)_dclSrcOpen.add(iid);else _dclSrcOpen.delete(iid);
}
function _dclStageToggle(k){
  if(!_dclOpenSet)_dclOpenSet=new Set();
  if(_dclOpenSet.has(k))_dclOpenSet.delete(k);else _dclOpenSet.add(k);
  const sec=document.querySelector(`#dclList .dcl-stage[data-k="${k}"]`);
  if(sec){const o=_dclOpenSet.has(k);sec.classList.toggle('open',o);const h=sec.querySelector('.dcl-sh');if(h)h.setAttribute('aria-expanded',o?'true':'false');}
}
// 여기서 바꾼 날짜는 계약 타임라인 입력칸에도 넣는다(시안: "여기서 바꾸면 타임라인에도 반영돼요").
function _dclDateChange(){
  const s=_dclLoad();
  s.c=(document.getElementById('dcl-contract')||{}).value||'';
  s.b=(document.getElementById('dcl-balance')||{}).value||'';
  _dclSave(s);_dclOpenSet=null;
  const tc=document.getElementById('deal-contract'),tb=document.getElementById('deal-balance');
  if(tc)tc.value=s.c;if(tb)tb.value=s.b;
  try{renderDealDays();}catch(_){}
  _dclRender();
}
// 계약 타임라인에서 날짜를 바꾸면(지운 것 포함) 체크리스트도 같은 날짜를 쓴다(renderDealDays 끝에서 호출).
//   두 곳이 같은 값에서 출발하도록 페이지를 열 때 _dclInitTimeline 이 타임라인 칸을 저장값으로 먼저 채운다
//   — 그렇지 않으면 빈 타임라인에서 한쪽만 바꿀 때 체크리스트의 다른 쪽 날짜가 지워진다.
function _dclFromTimeline(){
  const ic=document.getElementById('deal-contract'),ib=document.getElementById('deal-balance');
  if(!ic||!ib)return;
  const s=_dclLoad();
  if(ic.value===s.c&&ib.value===s.b)return;
  s.c=ic.value||'';s.b=ib.value||'';
  _dclSave(s);_dclOpenSet=null;
  if(_dclVisible())_dclRender();
}
function _dclInitTimeline(){
  const s=_dclLoad(),ic=document.getElementById('deal-contract'),ib=document.getElementById('deal-balance');
  if(!ic||!ib||(!s.c&&!s.b)||ic.value||ib.value)return;
  ic.value=s.c;ib.value=s.b;
  try{renderDealDays();}catch(_){}
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{try{_dclInitTimeline();}catch(_){}});else{try{_dclInitTimeline();}catch(_){}}
// 화면을 열 때: 체크리스트에 날짜가 없으면 타임라인 입력칸, 그다음 저장된 최근 계약 일정에서 가져온다.
function _dclOpen(){
  const s=_dclLoad();
  if(!s.c&&!s.b){
    const tc=(document.getElementById('deal-contract')||{}).value||'',tb=(document.getElementById('deal-balance')||{}).value||'';
    const d0=getDeals()[0];
    const src=(tc||tb)?{contract:tc,balance:tb}:((d0&&typeof d0==='object')?d0:null);
    if(src){s.c=src.contract||'';s.b=src.balance||'';_dclSave(s);}
  }
  _dclOpenSet=null;
  _dclRender();
}

// ── 갈아타기 계산 ─────────────────────────────────────────
// SWAP-HELPER-2026-10-30 (Plan 155, Claude Design 시안 p/07b5c734 승인): 지금 집을 둔 채 새 집을 먼저 사는 경우.
//   가격 예측 없음 — 팔 가격은 사용자가 넣고, 최근 실거래는 대표 평형(_repAreaOf)의 최저·평균·최고를 함께 참고로만.
//   계산은 기존 규칙 재사용: 대출 = calcLTV(…,'1주택 (처분조건부)',…) · 파는 쪽 중개보수 = 복비 계산기와 같은 매매 상한요율표.
//   사는 비용(취득세 등)은 여기서 계산하지 않는다(일시적 2주택 세율 처리 원문 미확인) — '빼기 전'이라고 밝히고 대출 계산으로 넘긴다.
const SWP_KEY='mhl_swap';
// 공인중개사법 시행규칙 제20조 ①·별표 1 매매·교환 상한요율(구간 '이상~미만', 한도액 만 원) — calcComm 의 매매 표와 같은 값
//   (2026-10-30 생활법령정보 '부동산 중개보수 산정' 본문으로 6구간 대조). 반환: 억.
function _swpComm(eok){
  const w=(Number(eok)||0)*10000; if(!(w>0))return 0;
  const T=[[5000,0.006,25],[20000,0.005,80],[90000,0.004,null],[120000,0.005,null],[150000,0.006,null],[Infinity,0.007,null]];
  const t=T.find(x=>w<x[0]);let c=w*t[1];if(t[2])c=Math.min(c,t[2]);
  return Math.round(c)/10000;
}
// 억 → '8억 5,000만' · '5,240만' · '6억'. 만 원 단위 반올림.
function _swpWon(eok){
  const m=Math.round(Math.abs(Number(eok)||0)*10000),a=Math.floor(m/10000),r=m%10000;
  if(!m)return '0';
  if(!a)return `${r.toLocaleString('ko-KR')}만`;
  return r?`${a}억 ${r.toLocaleString('ko-KR')}만`:`${a}억`;
}
// 월 더하기. 그 달에 같은 날이 없으면 그 달 말일(예: 8월 31일 + 6개월 = 2월 말일).
function _swpAddMonths(d,n){
  const y=d.getFullYear(),m=d.getMonth()+n,last=new Date(y,m+1,0).getDate();
  return new Date(y,m,Math.min(d.getDate(),last));
}
function _swpFmtFull(d){return `${d.getFullYear()}년 ${d.getMonth()+1}월 ${d.getDate()}일`;}
// 계산 본체(입력 → 숫자). region 은 '서울 마포구' 형식, lawd 는 시군구 코드(있으면 규제 판정에 우선).
function _swpCalc(s){
  const num=v=>{const x=parseFloat(v);return Number.isFinite(x)&&x>0?x:0;};
  const sell=num(s.sell),debt=num(s.debt),cgt=num(s.cgt)/10000,cash=num(s.cash),buy=num(s.buy),inc=num(s.inc);
  const comm=_swpComm(sell),use=s.use!=='n';
  const avail=+(use?(sell-debt-comm-cgt+cash):cash).toFixed(4);
  const region=[s.wide,s.sgg].filter(Boolean).join(' ');
  if(!buy)return {sell,debt,comm,cgt,cash,use,avail,buy:0,region};
  const r=calcLTV(buy,avail,inc,0,'1주택 (처분조건부)',false,region,s.lawd||'');
  const lL=+(buy*r.ltv).toFixed(4),capOn=Number.isFinite(r.cap);
  const by=(r.dL>0&&r.dL<Math.min(lL,r.cap))?'inc':(capOn&&r.cap<lL)?'cap':'ltv';
  return {sell,debt,comm,cgt,cash,use,avail,buy,inc,region,isR:r.isR,isMetro:r.isMetro,ltv:r.ltv,lL,cap:capOn?r.cap:null,dL:r.dL,fin:r.fin,mo:r.mo,by,gap:+(buy-avail-r.fin).toFixed(4)};
}
// 기한: 처분조건부 = 대출 실행일(새 집 잔금일 가정) + 6개월(금융위 2025.6.27 FAQ 7번),
//   일시적 2주택 = 새 집 취득일(잔금일 가정) + 3년, 두 집 모두 조정대상지역이면 2년(소득세법 시행령 제155조 ①, 2026-10-01 시행).
function _swpDeadlines(bal){
  const b=_dclParse(bal);if(!b)return null;
  return {dispose:_swpAddMonths(b,6),tmp3:_swpAddMonths(b,36),tmp2:_swpAddMonths(b,24)};
}
function _swpLoad(){
  try{const o=JSON.parse(localStorage.getItem(SWP_KEY)||'{}');return (o&&typeof o==='object'&&!Array.isArray(o))?o:{};}catch(_){return {};}
}
function _swpSave(s){try{localStorage.setItem(SWP_KEY,JSON.stringify(s));}catch(_){}}
const _SWP_FIELDS=['sell','debt','cgt','buy','inc','cash','bal'];
let _swpSrcOpen={d:false,t:false};
function _swpFillRegion(s){
  const w=document.getElementById('swp-wide'),g=document.getElementById('swp-sgg');if(!w||!g)return;
  const wides=Object.keys(REGION_MENU||{});
  if(!s.wide||!wides.includes(s.wide))s.wide=wides[0]||'';
  w.innerHTML=wides.map(x=>`<option value="${_escHtml(x)}"${x===s.wide?' selected':''}>${_escHtml(x)}</option>`).join('');
  const items=(REGION_MENU[s.wide]||[]);
  if(!items.some(it=>it.label===s.sgg))s.sgg=items[0]?items[0].label:'';
  const it=items.find(x=>x.label===s.sgg);s.lawd=it&&it.lawdCd?it.lawdCd:'';
  g.innerHTML=items.map(x=>`<option value="${_escHtml(x.label)}"${x.label===s.sgg?' selected':''}>${_escHtml(x.label)}</option>`).join('');
}
function _swpRender(){
  const out=document.getElementById('swpOut');if(!out)return;
  const s=_swpLoad();if(s.use!=='n')s.use='y';
  _SWP_FIELDS.forEach(k=>{const el=document.getElementById('swp-'+k);if(el&&document.activeElement!==el)el.value=s[k]!=null?s[k]:'';});
  _swpFillRegion(s);_swpSave(s);
  document.querySelectorAll('#view-swap .swp-seg button').forEach(b=>b.setAttribute('aria-pressed',b.dataset.use===s.use?'true':'false'));
  const E=_escHtml,a=s.apt&&typeof s.apt==='object'&&!Array.isArray(s.apt)?s.apt:null;
  const ref=a&&a.ref&&['min','avg','max','n'].every(k=>Number.isFinite(a.ref[k]))?a.ref:null; // 손상된 저장값이면 참고 줄을 그리지 않는다
  document.getElementById('swpApt').innerHTML=a
    ?`<div class="swp-apt"><span>${E(a.name||'')}</span><button type="button" class="swp-tbtn" onclick="_swpPickApt()">단지 바꾸기</button></div>`
    :`<div class="swp-apt none"><span>고르지 않아도 계산돼요</span><button type="button" class="swp-tbtn" onclick="_swpPickApt()">단지 고르기</button></div>`;
  document.getElementById('swpRef').innerHTML=ref
    ?`<div class="swp-ref"><b>참고</b>${Number(ref.sqm)>0?`${Math.round(ref.sqm)}㎡(전용 ${Math.round(Number(ref.py)||0)}평) `:''}최근 ${Math.round(ref.n)}건 실거래 · 최저 ${ref.min.toFixed(2).replace(/\.?0+$/,'')}억 · 평균 ${ref.avg.toFixed(2).replace(/\.?0+$/,'')}억 · 최고 ${ref.max.toFixed(2).replace(/\.?0+$/,'')}억</div>`:'';
  const fb=document.getElementById('swpFillAvg');if(fb)fb.setAttribute('aria-disabled',String(!(ref&&ref.avg>0))); // SWAP-FILL-1115: disabled 면 눌러도 안내가 안 떠서 aria-disabled 로 바꿨다
  const c=_swpCalc(s);
  const chip=document.getElementById('swpRegChip');if(chip)chip.textContent=c.region?(isRegFront(c.region,s.lawd)?'규제지역':'비규제지역'):'';
  const dim=c.use?'':' dim';
  let h=`<section class="swp-card" aria-labelledby="swpR1"><h2 class="swp-ct" id="swpR1">쓸 수 있는 돈</h2>`
    +(c.use?'':`<p class="swp-help">흐린 줄은 새 집 잔금 때 반영하지 않아요.</p>`)
    +`<div class="swp-tbl">`
    +`<div class="swp-tr${dim}"><span>팔 가격</span><span class="v">${_swpWon(c.sell)}</span></div>`
    +`<div class="swp-tr${dim}"><span>남은 대출 갚기</span><span class="v">−${_swpWon(c.debt)}</span></div>`
    +`<div class="swp-tr${dim}"><span>파는 쪽 중개보수(법정 상한${c.sell?' '+_swpCommPct(c.sell):''})</span><span class="v">−${_swpWon(c.comm)}</span></div>`
    +`<div class="swp-tr${dim}"><span>양도소득세${c.cgt?'':' · 입력 안 함'}</span><span class="v">−${_swpWon(c.cgt)}</span></div>`
    +`<div class="swp-tr cash"><span>가진 현금</span><span class="v">+${_swpWon(c.cash)}</span></div>`
    +`<div class="swp-tr sum"><span>쓸 수 있는 돈</span><span class="v">${c.avail<0?'−':''}${_swpWon(c.avail)}</span></div></div></section>`;
  if(!c.buy){
    h+=`<section class="swp-card"><p class="swp-gd">새 집 매수가를 넣으면 대출과 부족한 돈을 계산해요.</p></section>`;
  } else {
    const st=c.isMetro?'3.0':'0.75';
    h+=`<section class="swp-card" aria-labelledby="swpR2"><h2 class="swp-ct" id="swpR2">새 집 대출 · 처분조건부 기준</h2>`
      +`<div class="swp-ln${c.by==='ltv'?' on':''}"><span>담보 기준(LTV ${Math.round(c.ltv*100)}%)</span><span class="v">${_swpWon(c.lL)}</span></div>`
      +`<div class="swp-ln${c.by==='cap'?' on':''}"><span>고가주택 한도</span><span class="v">${c.cap!=null?_swpWon(c.cap):'해당 없음'}</span></div>`
      +`<div class="swp-ln${c.by==='inc'?' on':''}"><span>소득 기준(스트레스 DSR, 금리 +${st}%p 가정)</span><span class="v">${c.inc?_swpWon(c.dL):'연소득을 넣으면 계산해요'}</span></div>`
      +`<div class="swp-ln fin"><span>최종 대출<small>${c.by==='inc'?'소득 기준으로 정해졌어요':c.by==='cap'?'고가주택 한도로 정해졌어요':'담보 기준으로 정해졌어요'}</small></span><span class="v">${_swpWon(c.fin)}</span></div>`
      +`<div class="swp-ln"><span>월 상환 · 금리 ${(_loanBaseRate()*100).toFixed(1)}%, 30년 가정</span><span class="v">약 ${Math.round(c.mo).toLocaleString('ko-KR')}만</span></div></section>`;
    const short=c.gap>0;
    h+=`<section class="swp-card swp-gap${short?'':' ok'}" aria-labelledby="swpR3"><span class="swp-gl" id="swpR3">${short?'부족해요':'남아요'}</span><span class="swp-gn">${_swpWon(c.gap)}</span>`
      +`<p class="swp-gd">${c.use?`매수가 ${_swpWon(c.buy)}에서 쓸 수 있는 돈 ${c.avail<0?'−':''}${_swpWon(c.avail)}과 대출 ${_swpWon(c.fin)}을 뺀 금액이에요.`:'지금 집이 팔리기 전 잔금이면 그만큼 다른 자금이 필요해요.'}</p>`
      +`<p class="swp-help">사는 비용(취득세·중개보수 등)은 빼기 전이에요.</p>`
      +`<div><button type="button" class="swp-btn2" onclick="_swpToCalc()">대출 계산에서 사는 비용까지 보기</button></div></section>`;
  }
  const dl=_swpDeadlines(s.bal),today=new Date();
  if(dl){
    const dd=d=>_dclDd(_dclDiff(d,today));
    const law=(n,jo)=>'https://www.law.go.kr/법령/'+encodeURIComponent(n)+'/'+encodeURIComponent(jo);
    const src=(k,rows)=>`<button type="button" class="swp-more" aria-expanded="${_swpSrcOpen[k]?'true':'false'}" aria-controls="swpSrc${k}" onclick="_swpMore('${k}')">근거 보기</button>`
      +`<div class="swp-src" id="swpSrc${k}"${_swpSrcOpen[k]?'':' hidden'}>${rows.map(([name,url])=>`<div><span>${E(name)} <i>· 2026-10-30 확인</i></span> <a href="${E(url)}" target="_blank" rel="noopener noreferrer">원문 보기</a></div>`).join('')}</div>`;
    h+=`<section class="swp-card" aria-labelledby="swpR4"><h2 class="swp-ct" id="swpR4">기한</h2>`
      +`<div class="swp-dl"><div class="swp-dh"><span>처분조건부 대출</span><span class="swp-lb off">공식 안내</span><span class="dd">${dd(dl.dispose)}</span></div>`
      +`<div class="swp-dt">${_swpFmtFull(dl.dispose)}까지 지금 집 처분</div>`
      +`<p class="swp-gd">대출 실행일(새 집 잔금일로 가정)부터 6개월. 어기면 대출이 회수돼요.</p>`
      +src('d',[['금융위원회 가계대출 관리 강화 FAQ(2025.6.27) 7번','https://www.fsc.go.kr/po020201/84825']])+`</div>`
      +`<div class="swp-dl"><div class="swp-dh"><span>일시적 2주택 비과세</span><span class="swp-lb law">법령</span></div>`
      +`<div class="swp-dt">${_swpFmtFull(dl.tmp3)}까지 팔면 비과세 특례 대상</div>`
      +`<p class="swp-gd">새 집 취득일부터 3년. 두 집 모두 조정대상지역이고 새 집을 2026년 8월 4일 이후에 샀다면 2년(${_swpFmtFull(dl.tmp2)})이에요. 2026년 10월 1일 시행 기준이고, 적용 시점은 세무서와 확인해요.</p>`
      +`<p class="swp-gd">새 집 취득세도 같은 기간 안에 지금 집을 팔면 2주택 중과 대신 기본세율이에요.</p>`
      +src('t',[['소득세법 시행령 제155조',law('소득세법시행령','제155조')],['지방세법 제13조의2',law('지방세법','제13조의2')],['지방세법 시행령 제28조의5',law('지방세법시행령','제28조의5')]])+`</div>`
      +`<div><button type="button" class="swp-btn2" onclick="_swpToDeal()">거래 체크리스트 매도인 보기</button></div></section>`;
  } else {
    h+=`<section class="swp-card"><h2 class="swp-ct">기한</h2><p class="swp-gd">새 집 잔금일을 넣으면 지금 집 처분 기한을 계산해요.</p></section>`;
  }
  out.innerHTML=h;
  const lv=document.getElementById('swpLive');
  if(lv){const t=c.buy?`${c.gap>0?'부족해요':'남아요'} ${_swpWon(c.gap)}`:'';clearTimeout(_swpLiveT);_swpLiveT=setTimeout(()=>{lv.textContent=t;},600);}
}
let _swpLiveT=0;
function _swpCommPct(eok){const w=eok*10000;const r=w<5000?0.6:w<20000?0.5:w<90000?0.4:w<120000?0.5:w<150000?0.6:0.7;return r+'%';}
function _swpInput(){
  const s=_swpLoad();
  _SWP_FIELDS.forEach(k=>{const el=document.getElementById('swp-'+k);if(el)s[k]=el.value;});
  const w=document.getElementById('swp-wide'),g=document.getElementById('swp-sgg');
  if(w&&w.value)s.wide=w.value;if(g&&g.value)s.sgg=g.value;
  _swpSave(s);_swpRender();
}
function _swpWide(){const s=_swpLoad();const w=document.getElementById('swp-wide');s.wide=w?w.value:s.wide;s.sgg='';_swpSave(s);_swpRender();}
function _swpUse(v){const s=_swpLoad();s.use=v==='n'?'n':'y';_swpSave(s);_swpRender();}
function _swpMore(k){_swpSrcOpen[k]=!_swpSrcOpen[k];_swpRender();const b=document.querySelector(`#swpOut [aria-controls="swpSrc${k}"]`);if(b)b.focus();}
function _swpFillAvg(){
  const s=_swpLoad(),ref=s.apt&&s.apt.ref;if(!(ref&&Number.isFinite(ref.avg)&&ref.avg>0)){toast('먼저 단지를 골라 주세요. 위의 단지 고르기를 누르면 돼요');return;} // SWAP-FILL-1115 (전면 감사 8번): 무반응이었다
  s.sell=String(+ref.avg.toFixed(2));_swpSave(s);_swpRender();
  toast('최근 평균 실거래가를 넣었어요. 실제 팔 가격과 다를 수 있어요');
}
function _swpPickApt(){
  sv('map');
  toast('단지를 검색해 상세에서 \'지금 집으로 갈아타기 계산\'을 눌러 주세요');
}
// 대출 계산으로: 매수가·쓸 수 있는 돈(보유 현금)·연소득과 주택 보유 '무주택'(처분조건부는 무주택과 같은 한도 — 금융위 10·15 FAQ),
//   지역 칩은 규제 판정대로. 사는 비용(취득세·중개보수)은 그 화면이 계산한다.
function _swpToCalc(){
  const s=_swpLoad(),c=_swpCalc(s);if(!c.buy)return;
  sv('calc');
  setTimeout(()=>{
    const set=(id,v)=>{const el=document.getElementById(id);if(el)el.value=v;};
    set('c_b',c.buy.toFixed(2));set('c_c',Math.max(0,c.avail).toFixed(2));set('c_i',c.inc?String(c.inc):'');
    const pick=(gid,label)=>{const ch=[...document.querySelectorAll(`#${gid} .chip`)].find(x=>x.textContent.trim()===label);if(ch)cp(ch,gid);};
    pick('cc-h','무주택');
    pick('cc-r',isRegFront(c.region,s.lawd)?'서울규제':(s.wide==='지방'?'지방':'비규제'));
    if(typeof dc==='function')dc();
    toast('처분조건부는 무주택과 같은 한도로 계산해요');
  },180);
}
function _swpToDeal(){
  const d=_dclLoad();d.r='s';_dclSave(d);_dclOpenSet=null;
  sv('deal');
}
// 단지 상세 → '지금 집으로 갈아타기 계산': 상세의 최근 거래에서 대표 평형(_repAreaOf)만 골라 최저·평균·최고를 참고값으로 넘긴다.
//   거래 이력이 없으면 참고값 없이 단지 이름만(가격을 지어내지 않는다).
function goSwapFromCurrentDetail(){
  const p=currentDetail;if(!p)return;
  const tx=Array.isArray(p.txHistory)?p.txHistory:[];
  const rep=_repAreaOf(tx);
  const prices=tx.filter(t=>!rep||Math.round(Number(t.excluUseAr)||0)===rep.sqm).map(t=>Number(t.dealAmount)/10000).filter(x=>x>0);
  const ref=prices.length?{sqm:rep?rep.sqm:0,py:rep?rep.py:0,n:prices.length,min:Math.min(...prices),max:Math.max(...prices),avg:prices.reduce((a,b)=>a+b,0)/prices.length}:null;
  const s=_swpLoad(),same=s.apt&&s.apt.name===p.aptName;s.apt={name:String(p.aptName||''),area:p.area||'',ref};if(!same)s.sell='';_swpSave(s); // 다른 단지면 이전 팔 가격을 지운다
  try{cDM();}catch(_){}
  sv('swap');
}
