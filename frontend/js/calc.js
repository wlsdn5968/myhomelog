// frontend/js/calc.js
// SPLIT-1117 (plans/202 2단계): 화면을 읽지 않는 계산 함수. frontend/index.html 본체에서 글자 그대로 옮겼다(동작 변경 없음).
//   본체보다 먼저 부르는 일반 스크립트다. 모듈이나 defer 로 바꾸지 않는다(HTML 속성 호출과 본체가 전역 이름으로 부른다).
//   본체에 남은 것: calcLTV(금리와 규제 판정을 인자로 받게 바꾼 뒤 옮긴다), _polRate(공시 금리 보관값을 읽는다).

// ⚠⚠ TIER-BOUNDARY-SPLIT-2026-08-16 (Plan 023) — **경계 의미가 표마다 반대다. 헬퍼를 공유하지 마라.**
//   같은 `underAuk` 필드를 쓰는 두 tier 표가 법령상 서로 다른 경계를 갖는다:
//     · 취득세      지방세법 §11①8호        — "6억원 **이하** 1%"   → `<=` (아래 _pickTierRate)
//     · 중개보수    공인중개사법 시행규칙 별표1 — "2억~9억원 **미만** 0.4%" → `<`  (아래 _pickTierRateUnder)
//   [실사고] 계획 008(02f4a26)이 취득세 경계를 `<`→`<=` 로 고쳤는데, 그 한 줄이 **같은 헬퍼를 쓰던
//     중개보수까지 바꿔** 0.5·2·9·12·15억 정확히 5개 지점에서 법정 요율과 어긋났다
//     (라이브 실측: 9억 −90만 · 12억 −120만 · 15억 −150만 **과소**, 0.5억 +5만 · 2억 +20만 과대).
//     커밋 메시지엔 "경계값 하나만 바뀌고 회귀 위험 낮음"이라 적혀 있었다 — **공유 헬퍼의 두 번째
//     소비처를 확인하지 않은 것**이 근본 원인이다.
//   [설계 원칙] 경계 의미가 다르면 **함수를 나눈다**. 기본값 인자로 구분하면 새 호출부가 조용히
//     틀린 쪽을 고른다. 이름에 경계를 박아 호출부에서 법령이 보이게 한다.
/** "N억 **이하**" 경계 (취득세 — 지방세법 §11①8호) */
function _pickTierRate(tiers, priceAuk, fallbackRate){
  for (const t of (tiers||[])) {
    if (priceAuk <= (t.underAuk||0)) return t.rate ?? fallbackRate;
  }
  return fallbackRate;
}
/** "N억 **미만**" 경계 (중개보수 — 공인중개사법 시행규칙 별표1). 필드명 `underAuk` 의 문자 그대로. */
function _pickTierRateUnder(tiers, priceAuk, fallbackRate){
  for (const t of (tiers||[])) {
    if (priceAuk < (t.underAuk||0)) return t.rate ?? fallbackRate;
  }
  return fallbackRate;
}

// P1 D4: 정책자금 4종 계산 — 일반 주담대보다 한도·금리 유리
//   - 보금자리:    소득 7천↓, 주택 6억↓, LTV 70%, 한도 일반 3.6억/생초 4.2억(특례보금자리 5억 종료), 금리 ~4%
//   - 디딤돌:      소득 6천↓ (생초 7천), 주택 5억↓, LTV 일반70/생초80(수도권·규제70), 한도 일반 2억/생초 2.4억(2025.6.28~), 금리 ~3%
//   - 신혼 디딤돌: 소득 8.5천↓ (혼인 7년↓), 주택 6억↓, 한도 3.2억(2025.6.27~ 계약), 금리 ~2.8%
//   - 신생아 특례: 소득 1.3억↓ (2년 내 출산), 주택 9억↓, 한도 4억, 금리 ~1.6~3.3%
// Sprint PP-3 (2026-05-19): 신생아 특례 정확화
//   - 2026년 기준 정정: 대출 한도 5억 → 4억, LTV 수도권 70%/비수도권 80% 차등
//   - DSR 아닌 DTI 60% 기준 심사 (디딤돌 특성)
//   - 출처: 정부 공식 가이드 (younju 이미지 참조, 2026년 기준)
// 모두 무주택 + 본인 거주 의무. 입력은 만원 단위 income.
function computePolicyLoan({ buy, income, isFirstBuyer, isNewlywed, hasNewborn, houseStatus, region }) {
  if (houseStatus !== '무주택') return { eligible: [], maxLoan: 0, bestName: null, note: '정책자금은 무주택자만 신청 가능' };
  const eligible = [];
  // Sprint PP-3: 수도권 (서울/경기/인천) vs 비수도권 LTV 차등
  const isMetro = ['서울', '경기', '인천'].some(k => String(region || '').includes(k));  // 부분일치(getRegionForSearch가 '서울 강남구' 형태로 넘김 — calcLTV의 isRegFront와 동일 정책)
  // 신생아 특례 LTV: 생애최초 80%(수도권·규제 70%) / 비생애최초 70% — 출처 myhome.go.kr (2026-06-21 재검증)
  const newbornLtv = isFirstBuyer ? (isMetro ? 0.70 : 0.80) : 0.70;
  const NEWBORN_REGION_HINT = !isFirstBuyer ? '비생애최초 LTV 70%' : (isMetro ? '수도권·규제 LTV 70%' : '비수도권 LTV 80%');

  // 1) 신생아 특례 (가장 유리 — 1순위)
  if (hasNewborn && income > 0 && income <= 13000 && buy <= 9) {
    eligible.push({
      name: '신생아 특례',
      maxLoan: Math.min(4, buy * newbornLtv), // 4억 한도 (이전 5억은 잘못된 값)
      ltv: Math.round(newbornLtv * 100),
      rate: '1.6~3.3%',
      note: `2년 내 출산 부부, 부부합산 1.3억 이하 (맞벌이 2억). 주택가 9억 이하·전용 85㎡ 이하·자산 5.11억 이하. ${NEWBORN_REGION_HINT}. 한도 4억. DSR 아닌 DTI 60% 기준 심사.`,
    });
  }
  // 2) 신혼 디딤돌
  if (isNewlywed && income > 0 && income <= 8500 && buy <= 6) {
    eligible.push({
      name: '신혼 디딤돌',
      maxLoan: Math.min(3.2, buy * 0.7),
      ltv: 70, rate: '1.8~3.1%',
      note: '혼인 7년 이내, 부부합산 8,500만원 이하, 주택가격 6억 이하. 한도 3.2억(2025.6.27~ 계약).',
    });
  }
  // 3) 디딤돌 — 일반 vs 생애최초 한도·LTV 차등 (공식 myhome·hf·금융위 2025.6.28~: 일반 2억/LTV70, 생애최초 2.4억/LTV80(수도권·규제 70))
  const dimdolIncomeCap = isFirstBuyer ? 7000 : 6000;
  if (income > 0 && income <= dimdolIncomeCap && buy <= 5) {
    const dimdolCap = isFirstBuyer ? 2.4 : 2.0;
    const dimdolLtv = isFirstBuyer ? (isMetro ? 0.70 : 0.80) : 0.70;
    eligible.push({
      name: '디딤돌',
      maxLoan: Math.min(dimdolCap, buy * dimdolLtv),
      ltv: Math.round(dimdolLtv * 100), rate: _polRate('didimdol', '2.85~4.15%'), // 2026.7 공시
      note: `부부합산 ${dimdolIncomeCap}만원 이하, 주택가격 5억 이하. 한도 ${dimdolCap}억${isFirstBuyer ? '(생애최초)' : ''}.`,
    });
  }
  // 4) 보금자리론 — 일반 3.6억 / 생애최초 4.2억 (공식 hf.go.kr 2026-06-21 재검증; 특례보금자리 5억은 2024.1 종료)
  if (income > 0 && income <= 7000 && buy <= 6) {
    const bogeumCap = isFirstBuyer ? 4.2 : 3.6;
    eligible.push({
      name: '보금자리론',
      maxLoan: Math.min(bogeumCap, buy * 0.7),
      ltv: 70, rate: _polRate('bogeum', '4.9~5.3%'), // 2026.7 공시 (예전 3.6~4.2% 는 stale — 한도 3.6/4.2억 과 숫자가 겹쳐 혼동을 키웠다)
      note: `부부합산 7천만원 이하, 주택가격 6억 이하. 한도 ${bogeumCap}억${isFirstBuyer ? '(생애최초)' : ''}.`,
    });
  }

  const maxItem = eligible.reduce((best, x) => (!best || x.maxLoan > best.maxLoan) ? x : best, null);
  return {
    eligible,
    maxLoan: maxItem ? maxItem.maxLoan : 0,
    bestName: maxItem ? maxItem.name : null,
    note: eligible.length === 0 ? '정책자금 자격이 없어요 (소득·주택가격 기준을 넘거나 무주택이 아니에요)' : null,
  };
}
// 대출 계산들이 함께 쓰는 기준 금리: 시중 평균 주담대(한국은행, 받았을 때) 없으면 4% — dc() 의 기본값과 같은 규칙
function _loanBaseRate(){ const r=Number(window._ecosMortgageRate); return (r>0&&r<20)?r/100:0.04; }

// DSR-STATE-2026-09-05: 상세 대출계산의 순수 산식. DOM 을 만지지 않으므로 테스트가 입력→출력으로 직접 실행한다.
//   단위: buy·cash·lL·dL·fin 억 / inc 만원(연) / exAdded 만원(월) / rate 소수(0.04) / mo 만원(월) / dsr %.
//   dsrState — 'none': 소득 미입력(DSR 미반영, LTV 한도만) · 'zero': 소득 입력·신규 여력 없음(한도 0) · 'ok': 양수 한도.
function calcLoanLimitsPure({buy,inc,rate,yrs,exAdded,cash,ltv,cap,isLoc}){
  const n=Math.max(1,Math.round((yrs||30)*12)),mr=(rate||0)/12,smr=((rate||0)+(isLoc?.0075:.03))/12;
  const lL=Math.min(buy*ltv,cap);
  const annuity=(monthly,r)=>(r>0?monthly*(1-Math.pow(1+r,-n))/r:monthly*n);             // 월 납입액 → 원금(원)
  const payment=(principalEok,r)=>(principalEok>0?(r>0?principalEok*1e8*r/(1-Math.pow(1+r,-n)):principalEok*1e8/n)/10000:0); // 원금(억) → 월 납입(만원)
  let dsrState='none',dL=0,headroom=null;
  if(inc>0){
    headroom=inc*10000*.4/12-exAdded*10000;                                               // 신규 여력(원/월)
    if(headroom>0){dL=Math.round(annuity(headroom,smr)/1e8*100)/100;dsrState=dL>0?'ok':'zero';}
    else dsrState='zero';
  }
  const fin=ltv===0?0:(dsrState==='ok'?Math.min(lL,dL):dsrState==='zero'?0:lL);
  const mo=Math.round(payment(fin,mr));
  const need=Math.max(0,buy-cash-fin);
  const dsr=inc>0?Math.round((mo+exAdded)*12/inc*100):0;
  return {lL,dL,dsrState,headroom,fin,mo,need,dsr,dsrExceed:dsr>40};
}
// CALC-INPUT-1114 (감사 7번, 운영 재현): 음수를 넣으면 "LTV 한도 -2.00억", 금리 "-1.0%" 가 그대로 나왔고
//   매수가 99,999,999억, 금리 500% 도 계산됐다. 계산 전에 입력 범위를 본다. 문제가 없으면 '' 를 돌려준다.
//   값은 입력 칸 숫자 그대로다(매수가와 현금은 억, 소득과 잔액은 만원, 금리는 %, 기간은 년). 빈 칸은 NaN 으로 온다.
function calcInputProblem(v){
  const vals=[v.buy,v.inc,v.ratePct,v.yrs,v.ex,v.cash,v.cl,v.jl];
  if(vals.some(x=>typeof x==='number'&&x<0))return '0보다 작은 값은 계산할 수 없어요. 입력한 숫자를 확인해 주세요';
  if(v.buy>1000)return '매수가는 1,000억 이하로 입력해 주세요';
  if(v.ratePct>30)return '금리는 30% 이하로 입력해 주세요';
  if(v.yrs>50)return '기간은 50년 이하로 입력해 주세요';
  return '';
}
