// frontend/js/subs.js
// SPLIT-1119 (plans/202 4단계 둘째 묶음): 청약 화면(청약 일정 목록, 가점 계산)의 함수를 본체에서 글자 그대로 옮겼다.
// 본체보다 먼저 부르는 일반 스크립트다. 함수 안에서만 본체의 CFG, _escHtml, fmtSubsDate, dDayLabel 을 읽는다(실행 순간에는 아무것도 읽지 않는다).
// fmtSubsDate 와 dDayLabel 은 브리핑 화면도 쓰므로 본체에 남겼다.

// ── 청약 캘린더 ────────────────────────────────────────────
function cpSubs(el, kind){
  const parent = el.parentElement;
  parent.querySelectorAll('.chip').forEach(c=>c.classList.remove('on'));
  el.classList.add('on');
  loadSubs();
}

function fmtMoveIn(s){
  // YYYYMM
  if(!s) return '-';
  const t = String(s).replace(/[^0-9]/g,'');
  if(t.length<6) return s;
  return `${t.slice(0,4)}.${t.slice(4,6)}`;
}

async function loadSubs(){
  const sido = document.querySelector('#subs-sido .chip.on')?.dataset.sido || '';
  const days = document.querySelector('#subs-days .chip.on')?.dataset.days || '60';
  const box = document.getElementById('subsList');
  box.innerHTML = `<div style="padding:30px 0;text-align:center;color:var(--t3)">청약 일정을 불러오는 중이에요</div>`;
  try{
    const url = `${CFG.api}/subscription?sido=${encodeURIComponent(sido)}&days=${days}`;
    const r = await fetch(url, {signal: AbortSignal.timeout(10000)});
    const d = await r.json();
    if(!r.ok){
      box.innerHTML = `<div style="padding:30px 20px;text-align:center;color:var(--t3);line-height:1.7;background:linear-gradient(135deg,var(--accent-50),var(--bg-base));border:1px solid var(--accent-100);border-radius:var(--radius-lg)">
        <div style="font-size:14px;font-weight:700;color:var(--t1);margin-bottom:6px">청약 일정을 불러오지 못했어요</div>
        <div style="font-size:12px;color:var(--t2);margin-bottom:14px;line-height:1.6">일시적인 오류일 수 있어요. 잠시 후 다시 시도하거나<br>청약Home에서 직접 확인해 주세요.</div>
        <a href="https://www.applyhome.co.kr" target="_blank" rel="noopener" style="display:inline-block;padding:9px 18px;background:var(--acc-bg);color:var(--acc-ink);border-radius:var(--radius-base);font-size:12px;font-weight:600;text-decoration:none;box-shadow:var(--sh)">청약Home 바로가기 ↗</a>
        <button class="abtn a2" style="display:inline-block;margin-left:8px;padding:9px 18px;font-size:12px;width:auto;vertical-align:top" onclick="loadSubs()">다시 시도</button>
      </div>`;
      box.dataset.loaded = '1';
      return;
    }
    if(!d.items || !d.items.length){
      box.innerHTML = `<div style="padding:24px;text-align:center;color:var(--t3)">${_escHtml(d.sido)} 앞으로 ${d.days}일 안에 분양 일정이 없어요.</div>`;
      box.dataset.loaded = '1';
      return;
    }
    const cards = d.items.map(it=>`
      <div style="background:var(--bg-base);border:1px solid var(--bd);border-radius:var(--radius-md);padding:13px 14px;margin-bottom:8px;box-shadow:var(--sh)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px">
          <div style="font-size:14px;font-weight:700;color:var(--t1);flex:1;line-height:1.3">${_escHtml(it.name)}</div>
          <div style="font-size:12px;white-space:nowrap">${dDayLabel(it.receiveStart)}</div>
        </div>
        <div style="font-size:12px;color:var(--t3);margin-bottom:6px">${_escHtml(it.area || '')} · ${_escHtml(it.address || '')}</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;font-size:12px;color:var(--t2)">
          <div><span style="color:var(--t3)">접수</span> ${fmtSubsDate(it.receiveStart)}~${fmtSubsDate(it.receiveEnd)}</div>
          <div><span style="color:var(--t3)">당첨발표</span> ${fmtSubsDate(it.announceDate)}</div>
          <div><span style="color:var(--t3)">입주예정</span> ${fmtMoveIn(it.moveInPlanned)}</div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:7px;padding-top:7px;border-top:1px solid var(--bdL,var(--bd))">
          <span style="font-size:12px;color:var(--t3)">사업주체: ${_escHtml(it.builder || '미상')} · 공급 ${it.sales || '-'}세대</span>
          ${it.detailUrl && /^https?:\/\//i.test(it.detailUrl) ? `<a href="${_escHtml(it.detailUrl)}" target="_blank" rel="noopener" style="font-size:12px;color:var(--acc);text-decoration:none;white-space:nowrap">공고 ↗</a>` : ''}
        </div>
      </div>
    `).join('');
    const head = `<div style="font-size:12px;color:var(--t3);margin-bottom:9px">${_escHtml(d.sido)} · 향후 ${d.days}일 · 총 <strong style="color:var(--acc)">${d.count}건</strong>${d.fromCache?' · 저장된 자료':''}</div>`;
    box.innerHTML = head + cards;
    box.dataset.loaded = '1';
  }catch(e){
    box.innerHTML = `<div style="padding:24px;text-align:center;color:var(--t3)">청약 일정을 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요</div>`;
  }
}

// ── 청약 가점 계산기 (P1 D 감사 4) ────────────────────────
// 일반공급 가점제 84점 만점 = 무주택 32 + 부양가족 35 + 청약통장 17
// SUBS-SOURCE-2026-08-16 (Sprint OOOOOOO-4): 종전 주석·UI 는 이 수치를 "한국부동산원 2024-2025 평균"
//   이라고 **기관 공표 통계처럼** 귀속했으나, 공식 확인 결과 그렇게 단정할 근거를 찾지 못했다.
//   · 한국부동산원 청약업무 페이지는 "지역·면적·유형별 청약경쟁률·계약률·청약가점 **모니터링**"만 기술하고
//     지역별 평균 커트라인의 **정기 공표 여부는 명시하지 않는다**(2026-08-16 확인).
//   · 게다가 아래 지역 구분("경기 인기(분당·판교·과천)"·"인천 송도·청라" 등)은 **공식 통계의 분류 체계가
//     아니다** — 어떤 공표 통계를 가져와도 이 표를 그대로 채울 수 없다. 즉 편집된 개략 안내다.
//   → 수치는 **바꾸지 않고**(추측 갱신 금지) 귀속 표현만 "청약Home 공고 참고 개략 범위"로 낮췄다.
//   ⚠ 수치 자체를 갱신하려면 청약Home 단지별 공고를 실제로 집계해야 한다(외부 작업).
// 청약 커트라인 개략 범위 (청약Home 단지별 공고 참고, 2024~2025):
//   - 서울 인기 분양: 65점+ (평균)
//   - 수도권 일반: 50~60점
//   - 지방 일반: 30~50점
function calcSubsScore(){
  const noHome = parseInt(document.getElementById('cs_noHome')?.value) || 0;
  const dep    = parseInt(document.getElementById('cs_dep')?.value) || 5;
  const bank   = parseInt(document.getElementById('cs_bank')?.value) || 1;
  const total = noHome + dep + bank;
  const totalEl = document.getElementById('cs_total');
  if (totalEl) totalEl.textContent = total;
  const tierEl = document.getElementById('cs_tier');
  if (!tierEl) return;
  let tier;
  // CUTLINE-2026-08-17 (Sprint MMMMMMM-13): 여기 상위권 문구에 당락을 단정하는 표현과
  //   커트라인 점수 범위가 **출처 없이** 박혀 있었다. 당첨 커트라인은 단지·공급유형·평형마다 다르고
  //   공고 후에야 확정된다 — 우리가 인용할 수 있는 공시값이 존재하지 않는다.
  //   절대 룰 ②(공식 출처만 인용)에 따라 근거 없는 수치와 단정을 걷어내고 아래 청약Home 안내만 남긴다.
  //   (옛 문구는 계약 테스트의 금지 문자열이라 여기 적지 않는다.)
  if (total >= 70) tier = '<b style="color:var(--grn)">상위권</b>: 서울 인기 단지 일반공급 지원 가능 구간';
  else if (total >= 60) tier = '<b style="color:var(--grn)">중상위권</b>: 서울 일반 단지, 수도권 인기 분양 도전 가능';
  else if (total >= 50) tier = '<b style="color:var(--amb)">중위권</b>: 수도권 일반, 지방 인기 분양 도전 가능. 서울은 어려워요';
  else if (total >= 35) tier = '<b style="color:var(--amb)">중하위권</b>: 지방 일반 분양에 도전해 보세요. 특별공급(생애최초·신혼·신생아)을 꼭 활용하세요';
  else tier = '<b style="color:var(--red)">하위권</b>: 일반공급은 어려워요. <b>특별공급(생애최초·신혼·다자녀·신생아)</b>이나 <b>추첨제 단지</b>를 노려 보세요';
  tierEl.innerHTML = `예상 당첨 가능 분양: ${tier}<br><span style="font-size:12px;color:var(--t3)">※ 실제 커트라인은 단지·시점·평형마다 달라요. <a href="https://www.applyhome.co.kr" target="_blank" rel="noopener" style="color:var(--acc)">청약Home</a> 공고를 꼭 확인하세요.</span>`;
}
