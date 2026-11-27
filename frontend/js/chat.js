// frontend/js/chat.js
// SPLIT-1127 (plans/202 4단계 넷째 묶음): 데이터 도우미(채팅) 화면의 함수를 본체에서 글자 그대로 옮겼다.
//   보내기(buildChatContext, qSend, sM), 대화 저장(_ensureChatSession, _genUuid, _persistChatMessage), 대화 이력 창, 빠른 질문(sQ, askP), 입력칸(hk, ah), 말풍선(_renderAIBadge, addMsg, sendAIFeedback, showTyp, rmTyp).
// 본체보다 먼저 부르는 일반 스크립트다. 함수 안에서만 본체의 값과 함수(CFG, chatH, chatLd, _chatSessionId, toast, gt, _escHtml 등)를 읽는다(실행 순간에는 아무것도 읽지 않는다).
// 본체에 남긴 것: 실행 순간 도는 줄(let _chatSessionId, 로그인 변화 등록, 이력 창 바깥 클릭), _toggleChatHistoryButtons, gt, toast.
// ── CHAT ─────────────────────────────────────────────────
// SYS-DEAD-2026-07-16 (Sprint SSSSS): BYOK 제거 후 참조 0이던 프론트 SYS 프롬프트 삭제 —
//   내용도 2025.10 기준으로 stale(백엔드 aiService 프롬프트가 단일 소스·2026 개정 반영 완료).

// 사용자 조건 + 추천 단지 컨텍스트 자동 주입 (P0-5)
function buildChatContext(){
  const ctx={};
  // 사용자 입력 조건
  ctx.userProfile={
    maxBudget:parseFloat(document.getElementById('bp')?.value)||null,
    myCash:parseFloat(document.getElementById('mc')?.value)||null,
    region:gct('ch-r')||null,
    houseStatus:gct('ch-h')||null,
    isFirstBuyer:gct('ch-f')==='예',
    firstBuyerKnown:gct('ch-f')!=='', // FIRST-UNKNOWN-2026-09-05: URL 기록·요약용(백엔드 추천은 무시)
    schoolNeeded:gct('ch-sc')==='학군 중요',
    workplaceArea:document.getElementById('wp')?.value?.trim()||null,
  };
  // 현재 상세 보고 있는 단지 (최우선)
  if(currentDetail){
    ctx.focusProperty={
      aptName:currentDetail.aptName, area:currentDetail.area,
      avgPrice:currentDetail.avgPrice, score:currentDetail.score, ltv:currentDetail.ltv,
      buildYear:currentDetail.buildYear,
    };
  }
  // 최근 추천 단지 상위 5
  if(props && props.length){
    ctx.recommendedProperties=props.slice(0,5).map(p=>({
      aptName:p.aptName, area:p.area, avgPrice:p.avgPrice, score:p.score, ltv:p.ltv,
    }));
  }
  // KKKKKKK-20 제안 B: 관심단지 이름 동봉 — 도우미 "관심단지 소식" 인텐트가 60일 거래로 대조
  try{
    const bks=getBookmarks();
    if(Array.isArray(bks)&&bks.length){
      ctx.bookmarks=bks.slice(0,5).map(b=>String(b&&b.aptName||'').trim().slice(0,40)).filter(s=>s.length>=2);
    }
  }catch(_){}
  return ctx;
}

// KKKKKKK-16: 퀵칩 → 챗 전송 헬퍼 (데이터 라우터가 즉답하는 주제용)
function qSend(t){const el=document.getElementById('cIn');if(!el)return;el.value=t;sM();}
async function sM(){
  if(chatLd)return;
  const el=document.getElementById('cIn'),txt=el.value.trim();if(!txt)return;
  // MOB-AUDIT-2026-05-03: funnel — 첫 채팅 송신 추적 (사용자 첫 5분 funnel)
  if (chatH.length === 0) { try { window.va && window.va('event', { name: 'chat_first_send', data: { msgLen: txt.length } }); } catch(_){} }
  el.value='';el.style.height='auto';addMsg('user',txt);chatH.push({role:'user',content:txt});chatLd=true;showTyp();
  let replied=false;
  const sessionContext=buildChatContext();

  // 로그인 상태면 메시지 persist (fire-and-forget — UX 블로킹 없음)
  _ensureChatSession(txt).then(sid => { if(sid) _persistChatMessage(sid,'user',txt); });

  // 백엔드 단일 경로 (BYOK 제거) — 단지·조건 컨텍스트 자동 첨부
  try{
    // MOB-AUDIT-2026-05-03: chat timeout 30s → 60s — Sonnet 4.5 가 1500 token 답변 시 25~30s 빈번
    const r=await fetch(`${CFG.api}/chat`,{method:'POST',headers:await _authHdr({'Content-Type':'application/json'}),body:JSON.stringify({message:txt,context:{history:chatH.slice(-18), session:sessionContext}}),signal:AbortSignal.timeout(60000)});
    _syncQuotaFromRes(r,'chat');   // QUOTA-REALTIME-2026-08-25: 종전엔 채팅 후 갱신이 없었다
    if(r.status===429){
      const j=await r.json().catch(()=>({}));
      rmTyp();
      // P1 (Phase 2 8-2): 비로그인 IP 한도 도달 시 → 모달 대신 inline 가입 유도 안내
      const reason = j.code === 'budget_exceeded' ? 'monthly' : 'daily';
      const resetAt = j.budget?.resetAt || null;
      // MOB-4 (2026-05-03): j.message (사용자 친화) 우선 — j.error 는 보통 코드 (DAILY_LIMIT_EXCEEDED 등)
      let aiMsg = j.message || j.error || '오늘 한도에 도달했어요.';
      if (j.canBoostByLogin) {
        // 비로그인 사용자 → 가입 유도 (Pro 강요 X)
        // STAB-AUDIT #67 + #72 (2026-05-03): 비로그인 챗 한도 도달 시 inline 로그인 버튼 + 이력 가치 강조
        // P2-4 (2026-05-04): drawer 가 열려 있으면 inline CTA click 차단 — drawer 자동 close
        if (typeof closeDrawer === 'function') closeDrawer();
        aiMsg += `\n\n로그인하면 ${j.bonusOnLogin}회를 더 쓸 수 있고, 대화 이력도 자동으로 저장돼요 (이메일 인증은 한 번만 하면 돼요)`;
        addMsg('ai', aiMsg);
        // STAB #72: 인라인 로그인 CTA 추가 — header 의 로그인 버튼은 작아서 attention 약함
        // P2-4: position:relative + z-index 100000 추가 (drawer 9990 보다 위)
        const _loginCtaHtml = `<button onclick="openLogin&&openLogin('search')" style="margin-top:8px;padding:9px 18px;background:var(--acc-bg);color:var(--acc-ink);border:none;border-radius:var(--radius-base);font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 2px 8px rgba(42,109,244,0.25);position:relative;z-index:100000">로그인하고 ${j.bonusOnLogin}회 더 받기</button>`;
        const _lastMsg = document.getElementById('cMsgs')?.lastChild?.querySelector('.bbl');
        if (_lastMsg) _lastMsg.insertAdjacentHTML('beforeend', '<br>' + _loginCtaHtml);
        // 헤더 로그인 버튼 강조 (기존)
        const lb = document.getElementById('loginBtn');
        if (lb) { lb.style.boxShadow='0 0 0 3px rgba(42,109,244,.35)'; setTimeout(()=>{lb.style.boxShadow='';},2500); }
      } else {
        // 로그인 사용자 또는 Pro 미설정: 기존 모달
        addMsg('ai', aiMsg + '\n\n내일 자정(한국 시간)에 한도가 초기화돼요.');
        openQuotaModal(reason, j.message || j.error, resetAt);
      }
      replied=true;
    } else if(r.status===503){
      // Phase 3 (2026-04-25): Anthropic 단일 의존 — 장애 시 친절 안내 + 대체 경로
      // AI-DEGRADE-2026-07-11 (Sprint HHHH): 크레딧 소진 등 실측 503 이 code!=='ai_upstream_down' 이라
      //   대안 안내가 안 붙던 것 — 503 이면 원인 무관하게 무료 기능 안내 (정직 + 이탈 방지).
      const j=await r.json().catch(()=>({}));
      rmTyp();
      addMsg('ai', '데이터 도우미가 일시 중단 상태예요.\n\n' +
        '지금 바로 쓸 수 있는 기능이에요.\n' +
        '· 아래 바로가기 버튼의 대출 계산, 규제 요약, 특약 초안(표준 양식)\n' +
        '· 목록 화면에서 "내 상황 입력"을 한 뒤 "조건에 맞는 단지 찾기"\n' +
        '· 상단 보고서 탭 (객관 데이터 버전)');
      // LEGAL-FALLBACK 제거(Plan 148): /api/legal 은 서버에서 삭제됨(server.js DEAD-ENDPOINT-REMOVED-2026-09-05) — 죽은 호출 삭제.
      replied=true;
    } else if(!r.ok){
      // CHAT-ERR-HONEST-2026-09-16 (Plan 098): 서버가 준 사유(error)를 그대로 보여준다 — 400(pii_blocked 등)을 "일시 오류"로 위장하지 않는다.
      const j=await r.json().catch(()=>({}));
      rmTyp();
      addMsg('ai', (j && typeof j.error === 'string' && j.error.trim()) ? j.error : `요청을 처리하지 못했어요 (HTTP ${r.status}). 잠시 뒤 다시 시도해 주세요.`);
      replied=true;
    } else {
      const d=await r.json();rmTyp();chatH.push({role:'assistant',content:d.reply});addMsg('ai',d.reply);
      // KKKKKKK-19: 서버가 문맥 맞는 후속 질문(suggestions)을 주면 응답 밑에 탭 칩으로 렌더 —
      //   "다음에 뭘 물어볼 수 있는지"를 답변마다 보여준다. DOM API(textContent)로만 붙여 XSS 안전
      //   (단지명에 따옴표·괄호가 있어 inline onclick 문자열 조립은 위험).
      try {
        if (Array.isArray(d.suggestions) && d.suggestions.length) {
          const last = document.getElementById('cMsgs')?.lastChild?.querySelector('.bbl');
          if (last) {
            const wrap = document.createElement('div');
            wrap.style.cssText = 'margin-top:8px;display:flex;flex-wrap:wrap;gap:6px';
            // KKKKKKK-20: 문자열=질문 전송 칩 · {label,view}=탭 이동 칩(고정 핸들러 맵 — 임의 코드 불가)
            const VIEW_ACTS = { report:()=>sv('report'), calc:()=>sv('calc'), clause:()=>sv('clause'), map:()=>sv('map'), list:()=>sv('list') };
            for (const s of d.suggestions.slice(0, 3)) {
              const isNav = s && typeof s === 'object' && typeof s.label === 'string' && VIEW_ACTS[s.view];
              const label = isNav ? s.label : s;
              if (typeof label !== 'string' || label.trim().length < 2) continue;
              const b = document.createElement('button');
              b.className = 'qb';
              b.style.cssText = 'font-size:12px;padding:5px 10px' + (isNav ? ';font-weight:700' : '');
              b.textContent = label.slice(0, 34);
              b.addEventListener('click', isNav
                ? () => { try{_closeAiPanel();}catch(_){ } if (s.view === 'list' && (s.budget || s.region)) _chatBudgetSearch(s.budget, s.region); else VIEW_ACTS[s.view](); }
                : () => qSend(label.slice(0, 100)));
              wrap.appendChild(b);
            }
            if (wrap.childNodes.length) last.appendChild(wrap);
          }
        }
      } catch(_) {}
      document.getElementById('cSt').textContent='● 온라인';document.getElementById('cSt').style.color='var(--grn)';
      replied=true;
      // 어시스턴트 응답도 persist
      if(_chatSessionId) _persistChatMessage(_chatSessionId,'assistant',d.reply);
    }
  }catch(e){
    // P2-1 (2026-05-04): silent catch → 에러 종류별 분기
    rmTyp();
    if (replied) return; // 이미 응답함 (post-render 에러)
    const msg = String(e?.name || '') + '|' + String(e?.message || '');
    let userMsg;
    if (/AbortError|timeout/i.test(msg)) {
      userMsg = '응답이 60초 넘게 오지 않았어요. 잠시 뒤 다시 시도해 주세요.';
    } else if (/Failed to fetch|NetworkError|network/i.test(msg)) {
      userMsg = '네트워크 연결을 확인한 뒤 다시 시도해 주세요.';
    } else if (/CORS/i.test(msg)) {
      userMsg = '잠시 접근이 제한됐어요. 잠시 뒤 다시 시도해 주세요.';
    } else {
      userMsg = '일시적인 오류가 생겼어요. 잠시 뒤 다시 시도해 주세요.';
    }
    addMsg('ai', userMsg);
    replied=true; // Plan 098: 아래 generic fallback 이 두 번째 말풍선을 붙이지 않게
  }

  // MOB-3 (2026-05-03): generic catch fallback — 더 구체적 안내 + 대체 경로 제시
  if(!replied){
    rmTyp();
    addMsg('ai','응답을 받지 못했어요.\n\n네트워크 또는 서버 일시 오류일 수 있어요. 잠시 뒤 다시 시도해 주세요.\n\n그동안 목록 화면 왼쪽의 "내 상황 입력"과 "단지 검색", 상단 "대출 계산"과 "보고서"는 그대로 쓸 수 있어요.');
  }
  chatLd=false;
}

async function _ensureChatSession(firstMsg){
  const A = window.MHL?.auth;
  if(!A?.user || !A?.session?.access_token) return null;
  if(_chatSessionId) return _chatSessionId;
  // 제목 = 첫 메시지 앞 30자
  const title = (firstMsg||'새 대화').trim().slice(0, 30);
  try {
    const r = await fetch('/api/chat/sessions', {
      method:'POST',
      headers: await _authHdr({ 'Content-Type':'application/json' }),
      body: JSON.stringify({ title }),
      signal: AbortSignal.timeout(10000),
    });
    if(!r.ok) throw new Error('HTTP ' + r.status);
    const s = await r.json();
    _chatSessionId = s.id;
    return _chatSessionId;
  } catch(e){
    console.warn('[chat session] 생성 실패', e);
    return null;
  }
}
// crypto.randomUUID 폴백 — 구형 사파리 (iOS <15.4) 대비
function _genUuid(){
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  // RFC 4122 v4 호환 폴백 (getRandomValues 사용)
  const b = new Uint8Array(16);
  (window.crypto || window.msCrypto).getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2,'0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

// Phase 4.3 멱등성: 클라이언트가 메시지마다 UUID 발급 → 더블탭/재시도에도 1행만 INSERT
async function _persistChatMessage(sid, role, content){
  const A = window.MHL?.auth;
  if(!A?.user || !A?.session?.access_token || !sid) return;
  const clientMsgId = _genUuid();
  fetch(`/api/chat/sessions/${sid}/messages`, {
    method:'POST',
    headers: await _authHdr({ 'Content-Type':'application/json' }),
    body: JSON.stringify({ role, content, clientMsgId }),
    signal: AbortSignal.timeout(10000),
  }).catch(e => console.warn('[chat message] 저장 실패', e));
}

// ── 대화 이력 UI ───────────────────────────────────────────
async function openChatHistory(){
  const A = window.MHL?.auth;
  if(!A?.user || !A?.session?.access_token){ toast('로그인하면 쓸 수 있어요.'); return; }
  document.getElementById('CH').classList.add('open');
  const box = document.getElementById('chList');
  box.textContent = '불러오는 중이에요';
  try {
    const r = await fetch('/api/chat/sessions', {
      headers: await _authHdr({}),
      signal: AbortSignal.timeout(10000),
    });
    if(!r.ok) throw new Error('HTTP ' + r.status);
    const { sessions } = await r.json();
    if(!sessions || !sessions.length){
      box.innerHTML = '<div style="color:var(--t3);padding:20px 4px;text-align:center">저장된 대화가 없어요.<br>질문을 보내면 자동으로 이력에 남아요.</div>';
      return;
    }
    box.innerHTML = sessions.map(s => {
      const title = _escHtml(s.title||'새 대화');
      const rel = _relTime(new Date(s.last_message_at));
      const active = s.id === _chatSessionId ? 'background:var(--bg2);' : '';
      return `<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;padding:9px 8px;border-bottom:1px solid var(--bd);${active}">
        <button onclick="loadChatSession('${s.id}')" style="flex:1;text-align:left;background:none;border:none;cursor:pointer;font-size:12px;color:var(--t1);padding:0">
          <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${title}</div>
          <div style="font-size:12px;color:var(--t3);margin-top:2px">${rel}</div>
        </button>
        <button onclick="deleteChatSession('${s.id}',event)" title="삭제" aria-label="이 대화 삭제" class="chat-del-btn" style="background:none;border:none;color:var(--t3);cursor:pointer;font-size:14px;padding:4px 6px"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
      </div>`;
    }).join('');
  } catch(e){
    console.warn('[chat history] 로드 실패', e);
    box.innerHTML = '<div style="color:var(--danger)">이력을 불러오지 못했어요</div>';
  }
}
function closeChatHistory(){ document.getElementById('CH').classList.remove('open'); }

// Phase 4 (2026-04-26): 챗 이력 검색 — title 부분 매칭 (case-insensitive)
function filterChatHistory(q) {
  const norm = String(q || '').toLowerCase().trim();
  const items = document.querySelectorAll('#chList > div');
  items.forEach(it => {
    const title = it.querySelector('div[style*="font-weight"]')?.textContent || '';
    it.style.display = (!norm || title.toLowerCase().includes(norm)) ? '' : 'none';
  });
}

async function loadChatSession(sid){
  const A = window.MHL?.auth;
  if(!A?.user || !A?.session?.access_token) return;
  try {
    const r = await fetch(`/api/chat/sessions/${sid}/messages`, {
      headers: await _authHdr({}),
      signal: AbortSignal.timeout(10000),
    });
    if(!r.ok) throw new Error('HTTP ' + r.status);
    const { messages } = await r.json();
    // 채팅창 리셋 + 재렌더
    const container = document.getElementById('cMsgs');
    container.innerHTML = '';
    chatH = [];
    _chatSessionId = sid;
    for(const m of (messages||[])){
      if(m.role === 'system') continue; // 컨텍스트 주입용 시스템성 메시지는 숨김
      chatH.push({ role: m.role, content: m.content });
      addMsg(m.role === 'assistant' ? 'ai' : 'user', m.content);
    }
    closeChatHistory();
    toast('대화를 불러왔어요');
  } catch(e){
    console.warn('[chat history] 세션 로드 실패', e);
    toast('불러오지 못했어요');
  }
}

async function deleteChatSession(sid, ev){
  ev?.stopPropagation();
  if(!confirm('이 대화를 삭제할까요? 되돌릴 수 없어요.')) return;
  const A = window.MHL?.auth;
  if(!A?.user || !A?.session?.access_token) return;
  try {
    const r = await fetch(`/api/chat/sessions/${sid}`, {
      method:'DELETE',
      headers: await _authHdr({}),
      signal: AbortSignal.timeout(10000),
    });
    if(!r.ok && r.status !== 204) throw new Error('HTTP ' + r.status);
    if(_chatSessionId === sid){
      _chatSessionId = null;
      // 현재 열려있던 세션이면 채팅창 리셋
      document.getElementById('cMsgs').innerHTML = '';
      chatH = [];
    }
    openChatHistory(); // 재로드
    toast('삭제했어요');
  } catch(e){
    console.warn('[chat history] 삭제 실패', e);
    toast('삭제하지 못했어요');
  }
}

function newChatSession(skipConfirm){
  // 대화창 리셋 — 다음 메시지부터 새 세션 lazy 생성
  if(!skipConfirm && chatH.length && !confirm('현재 대화를 종료하고 새로 시작할까요? (기존 대화는 이력에 저장돼요)')) return;
  _chatSessionId = null;
  chatH = [];
  const container = document.getElementById('cMsgs');
  container.innerHTML = `<div class="msg ai"><div class="ava ai"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg></div><div><!-- BADGE-TRUTH-2026-08-16 (Sprint QQQQQQQ): 정적 환영(1917행)·addMsg 와 동일 아바타 -->
    <div class="bbl">새 대화를 시작해요. 궁금한 것을 물어보세요.</div>
    <div class="mt">${gt()}</div>
  </div></div>`;
  // STAB-AUDIT #66 (2026-05-03): "이전 대화는 이력에 저장됨 (🕘 클릭)" 안내 — 사용자 컨텍스트 잃은 인지 부족 fix
  const _hasHist = window.MHL?.auth?.user;
  toast(_hasHist ? '새 대화를 시작했어요 (이전 대화는 이력에 저장돼요)' : '새 대화를 시작했어요 (로그인하면 이력이 저장돼요)');
}

function sQ(t){document.getElementById('cIn').value=t;sM();}
function askP(n,pr,a){
  const apt=decodeURIComponent(n);
  // 호출부에서 area 도 encodeURIComponent 로 안전 삽입(inline onclick raw 제거) → 여기서 decode
  let area=''; try{ area=decodeURIComponent(a||''); }catch(_){ area=String(a||''); }
  // AI 에 단지 분석 요청 = 강한 관심 신호 → kapt 검색으로 기록
  _logSearch('kapt', apt, 1);
  // ASKP-FIX-2026-08-20 (루프 회차 5 실측): ① 패널을 열지 않아 전송·응답이 닫힌 패널에 쌓였다(사용자에겐 무반응).
  //   ② 질문이 LLM 시절 문구("매수 전략과 리스크 상세 분석")라 룰베이스 라우터가 100% 폴백("답하기 어려워요") —
  //   라우터가 실제로 답하는 검증된 형태("{단지} 시세", 빠른 질문 칩과 동일 패턴)로 교체. area·pr 은 하위호환 유지.
  try{ if(!_rpOverlay) toggleRpOverlay(); }catch(_){}
  sQ(`${apt} 시세`);
}
function hk(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sM();}}
function ah(el){el.style.height='auto';el.style.height=Math.min(el.scrollHeight,90)+'px';}

// Phase 2.14: 도우미 응답에 항상 부착되는 공통 정보 배지 — 표시광고법·자본시장법 안전장치
// BADGE-TRUTH-2026-08-16 (Sprint NNNNNNN): 문구가 **사실과 반대**였다 —
//   "AI는 환각(hallucination)이 발생할 수 있어 사실 확인이 필요합니다".
//   챗은 CHAT-ZERO-COST-2026-08-12 로 LLM 호출이 구조적으로 제거돼(CI 가드로 강제) 지금은
//   룰베이스 라우터가 DB·공식 API 조회 결과만 반환한다. 환각이 원리적으로 발생하지 않는데
//   발생한다고 고지하면 (a) 사실이 아니고 (b) 우리 신뢰도를 근거 없이 깎는다.
//   같은 화면 환영 메시지는 이미 "공식 데이터 기반(환각 없음)" 이라 **자기모순**이기도 했다
//   (KKKKKKK-16 이 패널 제목만 'AI 채팅'→'데이터 도우미'로 고치고 이 배지를 놓쳤다).
//   대신 실제로 남아 있는 리스크(출처 데이터의 정정·지연)를 명시한다 — 면책 강도는 낮추지 않는다.
//   ⚠ 호출처는 addMsg 한 곳(챗 전용)뿐이다 — 보고서·특약·뉴스와 공유하지 않음(grep 확인).
//   AI 를 다시 붙이면 이 문구를 원복해야 한다.
function _renderAIBadge(){
  return `<div style="background:#FFF6E3;border:1px solid #F0D998;border-radius:var(--radius-sm);padding:6px 8px;margin-top:6px;font-size:12px;color:#7a5500;line-height:1.5">
    이 답변은 <b>참고 정보</b>이며 매수·매도 추천이 아니에요. 국토교통부 실거래, 한국은행 등 <b>공식 데이터를 그대로 조회</b>해 보여 드려요(AI가 만든 내용이 아니에요). 다만 출처 데이터가 나중에 정정되거나 늦게 반영될 수 있어요. 대출·세금·계약 사항은 금융기관·세무사·공인중개사에게 꼭 확인하세요.
  </div>`;
}
function addMsg(role,text){
  const c=document.getElementById('cMsgs'),d=document.createElement('div');d.className='msg '+role;
  // XSS 방어: 먼저 escape → 그 다음 \n→<br>, **bold** 변환, ## 헤더 변환 (이스케이프된 ** ## 는 안전)
  // MOB-AUDIT-2026-05-03: AI 답변에 `## 핵심 결론` 노출 시 plain text → <b> 변환
  const safe=_escHtml(text).replace(/\n/g,'<br>').replace(/\*\*(.*?)\*\*/g,'<b>$1</b>').replace(/(?:^|<br>)#{1,4}\s+(\S.*?)(?=<br>|$)/g, (m,$1)=>(m.startsWith('<br>')?'<br>':'')+'<b>'+$1+'</b>');
  // AI 응답에는 매번 안내 배지 부착 (Phase 2.14)
  const badge = role === 'ai' ? _renderAIBadge() : '';
  // Phase 3 (2026-04-25): AI 답변 👍/👎 피드백 (사용자/세션 페어 추적용)
  // chatH 의 마지막 user 메시지가 있을 때만 (인사 메시지·에러 메시지 제외)
  let fb = '';
  if (role === 'ai' && Array.isArray(chatH) && chatH.length > 0) {
    const lastUser = [...chatH].reverse().find(m => m.role === 'user');
    if (lastUser?.content) {
      const fid = 'fb_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
      fb = `<div class="ai-fb" data-fid="${fid}" style="margin-top:6px;font-size:12px;color:var(--t3)">
        <span style="margin-right:6px">이 답변이 도움됐나요?</span>
        <button class="ai-fb-btn" onclick="sendAIFeedback(this,1,'${fid}')" title="도움됐어요" aria-label="답변이 도움됐어요" style="background:none;border:1px solid var(--bd);border-radius:var(--radius-xs);padding:2px 8px;cursor:pointer;margin-right:3px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/><path d="M7 10v12"/></svg></button>
        <button class="ai-fb-btn" onclick="sendAIFeedback(this,-1,'${fid}')" title="아니에요" aria-label="답변이 도움되지 않았어요" style="background:none;border:1px solid var(--bd);border-radius:var(--radius-xs);padding:2px 8px;cursor:pointer"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/><path d="M17 14V2"/></svg></button>
        <span class="ai-fb-thx" style="display:none;margin-left:8px;color:var(--grn)">감사해요. 더 나은 답변에 참고할게요</span>
      </div>`;
      // dataset 으로 원본 메시지 보존 (XSS 방어 — innerHTML 인젝션 차단)
      setTimeout(() => {
        const el = document.querySelector(`[data-fid="${fid}"]`);
        if (el) {
          el.dataset.userMsg = lastUser.content;
          el.dataset.replyPreview = String(text).slice(0, 200);
        }
      }, 0);
    }
  }
  // BADGE-TRUTH-2026-08-16: 아바타도 'AI' → '📊' (룰베이스 전환 후 남아 있던 표기).
  //   패널 제목은 KKKKKKK-16 에서 이미 '데이터 도우미'로 바뀌었는데 아바타만 'AI' 라 어긋나 있었다.
  //   .ava 는 28px 원형·font-size 10px 라 짧은 라벨만 들어간다(한글 3자는 넘침) → 이모지 1자.
  d.innerHTML=`<div class="ava ${role}">${role==='ai'?'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>':'나'}</div><div><div class="bbl">${safe}</div>${badge}${fb}<div class="mt">${gt()}</div></div>`;
  c.appendChild(d);c.scrollTop=c.scrollHeight;
}

// Phase 3: AI 피드백 전송 — fire-and-forget, UI 즉시 thanks
async function sendAIFeedback(btn, rating, fid) {
  const wrap = document.querySelector(`[data-fid="${fid}"]`);
  if (!wrap) return;
  const userMsg = wrap.dataset.userMsg || '';
  const replyPreview = wrap.dataset.replyPreview || '';
  wrap.querySelectorAll('.ai-fb-btn').forEach(b => { b.disabled = true; b.style.opacity = '0.4'; });
  btn.style.background = rating === 1 ? '#E8F5EE' : '#FCEAEA';
  const thx = wrap.querySelector('.ai-fb-thx');
  if (thx) thx.style.display = 'inline';
  try {
    // STAB-A P1#16 (2026-05-03): timeout 5초 — fire-and-forget hang 누적 차단
    const r = await fetch(`${CFG.api}/feedback/ai`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ rating, messageText: userMsg, replyPreview, source: 'chat' }),
      signal: AbortSignal.timeout(5000),
    });
    // STAB-AUDIT #74 (2026-05-03): 실패 시 사용자 인지 — 피드백 누락 안내
    if (!r.ok) throw new Error('HTTP ' + r.status);
  } catch (_) {
    // 사용자에게 silent — UX 흐름 끊지 않되 thanks 메시지를 fail 안내로 교체
    if (thx) thx.textContent = '의견을 보내지 못했어요. 잠시 뒤 다시 시도해 주세요';
  }
}
// BADGE-TRUTH-2026-08-16 (Sprint QQQQQQQ): 타이핑 인디케이터 아바타도 '📊' — 종전엔 여기만 'AI' 라
//   메시지 전송 직후엔 'AI', 응답이 오면 '📊' 로 **같은 대화창 안에서 표기가 뒤바뀌었다.**
function showTyp(){const c=document.getElementById('cMsgs'),d=document.createElement('div');d.className='msg ai';d.id='ty';d.innerHTML=`<div class="ava ai"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg></div><div><div class="typing"><div class="tdot"></div><div class="tdot"></div><div class="tdot"></div></div></div>`;c.appendChild(d);c.scrollTop=c.scrollHeight;}
function rmTyp(){document.getElementById('ty')?.remove();}
