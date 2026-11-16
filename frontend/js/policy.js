// frontend/js/policy.js
// POLICY-CHANGES-1116 (plans/203): 정책 변화 한 장 요약 화면. 시안 https://claude.ai/design/p/630c0f3a-88f5-4245-aa88-9e7872eef676
// 일반 스크립트다(모듈 아님). index.html 이 본체보다 먼저 부른다. 자료는 policy-data.js 의 window.MHL_POLICY 이고
// 원본은 backend/data/policy-changes.json 이다. 이 파일은 본체의 함수와 값을 쓰지 않는다(본체가 _polOpen, _polRecent 를 부른다).
// 글은 자료 파일의 것만 보여 준다. 권하는 말과 전망은 쓰지 않는다.
const POL_CATS = [['all', '전체'], ['loan', '대출'], ['zone', '규제지역·토지거래허가'], ['tax', '세금'], ['supply', '청약·공급'], ['rent', '전월세']];
const POL_STATES = [['all', '전체'], ['on', '시행 중'], ['soon', '예정·정부안'], ['end', '끝난 것']];
const POL_STATUS_LABEL = { '시행': '시행', '예정': '예정', '안': '정부안', '계획': '계획', '종료': '끝남' };
const POL_STATUS_GROUP = { '시행': 'on', '예정': 'soon', '안': 'soon', '종료': 'end', '계획': 'plan' };
const POL_SRC_NAME = { 'www.korea.kr': '정책브리핑', 'www.fsc.go.kr': '금융위원회', 'www.law.go.kr': '국가법령정보센터', 'www.molit.go.kr': '국토교통부', 'www.mois.go.kr': '행정안전부', 'www.nts.go.kr': '국세청', 'www.mofe.go.kr': '재정경제부' };
let _polCat = 'all', _polState = 'all';
const _polOpenPlans = new Set(); // 펼친 계획 카드(자료의 순번)

function _polEsc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function _polDot(d){ return String(d || '').replace(/-/g, '.'); }
function _polData(){ const d = window.MHL_POLICY; return d && Array.isArray(d.items) && d.items.length ? d : null; }
// 최신이 위. 같은 날은 자료에 적힌 순서를 지킨다.
function _polSorted(d){ return d.items.map((it, i) => ({ it, i })).sort((a, b) => (a.it.date < b.it.date ? 1 : a.it.date > b.it.date ? -1 : a.i - b.i)); }
function _polMatch(it){
  if (_polCat !== 'all' && it.cat !== _polCat) return false;
  if (_polState === 'all') return true;
  return POL_STATUS_GROUP[it.status] === _polState;
}
function _polCatLabel(c){ const f = POL_CATS.find((x) => x[0] === c); return f ? f[1] : ''; }
function _polSrcLinks(it){
  const many = it.src.length > 1;
  return it.src.map((u) => {
    let host = ''; try { host = new URL(u).host; } catch (_) { host = ''; }
    const name = POL_SRC_NAME[host] || '';
    return `<a class="pol-src" href="${_polEsc(u)}" target="_blank" rel="noopener">원문 보기${many && name ? ' · ' + _polEsc(name) : ''} <span aria-hidden="true">↗</span></a>`;
  }).join('');
}
function _polCard(it, idx, checked){
  const st = it.status, ended = st === '종료', plan = st === '계획';
  const chips = `<span class="pol-chip">${_polEsc(_polCatLabel(it.cat))}</span><span class="pol-chip pol-st pol-st-${_polEsc(POL_STATUS_GROUP[st] || 'on')}">${_polEsc(POL_STATUS_LABEL[st] || st)}</span>`;
  const meta = `<span class="pol-date">${_polEsc(_polDot(it.date))}</span><span class="pol-sep" aria-hidden="true">·</span><span class="pol-org">${_polEsc(it.org)}</span>${chips}`;
  if (plan && !_polOpenPlans.has(idx)) {
    return `<article class="pol-card pol-fold"><div class="pol-meta">${meta}<span class="pol-fold-t">${_polEsc(it.title)}</span><button type="button" class="pol-tog" aria-expanded="false" onclick="_polToggle(${idx})">펼치기</button></div></article>`;
  }
  const ba = it.before
    ? `<div class="pol-ba"><div class="pol-box pol-before"><div class="pol-lb">지금까지</div><div class="pol-tx">${_polEsc(it.before)}</div></div><div class="pol-arrow" aria-hidden="true"></div><div class="pol-box pol-after"><div class="pol-lb">바뀐 뒤</div><div class="pol-tx">${_polEsc(it.after)}</div></div></div>`
    : `<div class="pol-ba pol-one"><div class="pol-box pol-after"><div class="pol-lb">바뀐 뒤</div><div class="pol-tx">${_polEsc(it.after)}</div></div></div>`;
  const rows = `<dl class="pol-rows"><div><dt>누구에게</dt><dd>${_polEsc(it.who)}</dd></div>${it.effective ? `<div><dt>시행</dt><dd>${_polEsc(_polDot(it.effective))}</dd></div>` : ''}</dl>`;
  return `<article class="pol-card${ended ? ' pol-ended' : ''}">`
    + `<div class="pol-meta">${meta}${plan ? `<button type="button" class="pol-tog" aria-expanded="true" onclick="_polToggle(${idx})">접기</button>` : ''}</div>`
    + `<h3 class="pol-title">${_polEsc(it.title)}</h3>`
    + (st === '안' ? '<div class="pol-draft">아직 확정되지 않았어요</div>' : '')
    + ba + rows
    + (it.note ? `<p class="pol-note">${_polEsc(it.note)}</p>` : '')
    + `<div class="pol-foot"><span class="pol-srcs">${_polSrcLinks(it)}</span><span class="pol-chk">확인 ${_polEsc(_polDot(checked))}</span></div>`
    + '</article>';
}
function _polBtns(list, cur, fn){
  return list.map(([k, label]) => `<button type="button" class="pol-btn${k === cur ? ' on' : ''}" aria-pressed="${k === cur}" onclick="${fn}('${k}')">${_polEsc(label)}</button>`).join('');
}
function _polRender(){
  const root = document.getElementById('polRoot'); if (!root) return;
  const d = _polData();
  const head = (n) => `<div class="pol-head"><div><h1 class="pol-h1">정책 변화</h1><p class="pol-sub">정부 발표로 무엇이 어떻게 바뀌었는지 날짜순으로 모았어요</p></div>${d ? `<div class="pol-info">원문 확인 ${_polEsc(_polDot(d.checked))} · ${n}건</div>` : ''}</div>`;
  if (!d) {
    root.innerHTML = head(0) + '<div class="pol-empty" role="status"><p>정책 변화를 불러오지 못했어요. 새로 고침해 주세요</p><button type="button" class="pol-ghost" onclick="location.reload()">새로 고침</button></div>';
    return;
  }
  const all = _polSorted(d), hit = all.filter((x) => _polMatch(x.it));
  const filtered = _polCat !== 'all' || _polState !== 'all';
  let body = '';
  if (!hit.length) {
    body = '<div class="pol-empty" role="status"><p>고른 조건에 맞는 변화가 없어요</p><button type="button" class="pol-solid" onclick="_polReset()">전체 보기</button></div>';
  } else {
    let year = '';
    for (const x of hit) {
      const y = x.it.date.slice(0, 4);
      if (y !== year) { body += `${year ? '</div>' : ''}<div class="pol-year"><h2>${_polEsc(y)}</h2></div><div class="pol-list">`; year = y; }
      body += `<div class="pol-row"><div class="pol-day" aria-hidden="true">${_polEsc(x.it.date.slice(5).replace('-', '.'))}</div>${_polCard(x.it, x.i, d.checked)}</div>`;
    }
    body += '</div>';
  }
  const sum = filtered
    ? `<div class="pol-sum" role="status"><b>${[_polCat !== 'all' ? _polCatLabel(_polCat) : '', _polState !== 'all' ? POL_STATES.find((s) => s[0] === _polState)[1] : ''].filter(Boolean).map(_polEsc).join(' · ')} ${hit.length}건</b><button type="button" class="pol-link" onclick="_polReset()">조건 지우기</button></div>`
    : '';
  root.innerHTML = head(d.items.length)
    + `<div class="pol-cats" role="group" aria-label="분류">${_polBtns(POL_CATS, _polCat, '_polSetCat')}</div>`
    + `<div class="pol-states" role="group" aria-label="상태"><span class="pol-states-lb">상태</span>${_polBtns(POL_STATES, _polState, '_polSetState')}</div>`
    + sum + body
    + '<p class="pol-disc">참고용 정리예요. 실제 적용은 원문과 담당 기관에서 꼭 확인하세요. 매수·매도 추천이 아니에요.</p>';
}
function _polSetCat(c){ if (POL_CATS.some((x) => x[0] === c)) { _polCat = c; _polRender(); } }
function _polSetState(s){ if (POL_STATES.some((x) => x[0] === s)) { _polState = s; _polRender(); } }
function _polReset(){ _polCat = 'all'; _polState = 'all'; _polRender(); }
function _polToggle(i){ if (_polOpenPlans.has(i)) _polOpenPlans.delete(i); else _polOpenPlans.add(i); _polRender(); }
function _polOpen(){ _polRender(); }
// 대출 계산 화면의 줄인 상자용: 계획을 뺀 최근 n건. 자료가 없으면 빈 배열(부르는 쪽이 옛 타임라인으로 돌아간다).
function _polRecent(n){
  const d = _polData(); if (!d) return [];
  return _polSorted(d).map((x) => x.it).filter((it) => it.status !== '계획').slice(0, n).map((it) => ({ date: _polDot(it.date), title: it.title }));
}
