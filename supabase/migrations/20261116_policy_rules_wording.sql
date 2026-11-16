-- 2026-11-16 전면 감사 후속: 저장된 정책 안내 두 줄이 원문과 달랐다. 운영자가 SQL Editor 에서 실행한다.
--
-- 근거(2026-11-16 원문 직접 확인)
--   소득세법 제104조 제7항: 조정대상지역에 있는 주택의 1세대 2주택은 기본세율에 100분의 20, 3주택 이상은 100분의 30 을 더한다.
--   소득세법 시행령 제167조의3 제1항 제12호의2: 보유기간 2년 이상 주택으로서 2026년 5월 9일까지 양도하는 주택 등은 중과에서 빠진다.
--     (https://www.law.go.kr/법령/소득세법/제104조, https://www.law.go.kr/법령/소득세법시행령)
--   정책브리핑 2026.05.12 국토교통부 「토지거래허가구역 실거주 유예 확대…세입자 있는 주택 전체로」
--     (https://www.korea.kr/news/policyNewsView.do?newsId=148964215). 전에 적은 "매도 규제 일부 완화(이사 등 실수요 일부 허용)"는 이 발표의 내용이 아니었다.
--
-- 바꾸는 것: housing_loan_2025 의 additionalRules 배열에서 아래 두 줄만(2026-11-16 조회: 10번째와 11번째). 나머지 줄과 다른 값은 그대로 둔다.

update public.regulations_snapshot r
   set data = jsonb_set(r.data, '{additionalRules}', (
         select jsonb_agg(
                  case
                    when t.val like '2026.5.9~: 다주택자 양도세 중과 부활%'
                      then '2026.5.10~: 조정대상지역 다주택자 양도세 중과가 다시 적용돼요. 2주택은 기본세율에 20%p, 3주택 이상은 30%p를 더하고 장기보유특별공제를 받지 못해요. 2년 이상 보유한 주택을 5.9까지 팔았거나, 5.9까지 계약하거나 토지거래허가를 신청하고 정해진 기한 안에 판 경우는 빠져요'
                    when t.val like '2026.5.12: 보완책%'
                      then '2026.5.12: 토지거래허가구역에서 세입자가 있는 집을 사는 무주택자는 임대차 계약이 끝나는 날까지 입주를 미룰 수 있게 대상을 넓혔어요 (국토교통부 발표, 발표 당시 2026.12.31 신청분까지)'
                    else t.val
                  end
                  order by t.ord)
           from jsonb_array_elements_text(r.data->'additionalRules') with ordinality as t(val, ord)
       )),
       note = coalesce(r.note, '') || ' | 2026-11-16 양도세 중과와 5.12 발표 두 줄을 법령과 국토교통부 원문에 맞춤'
 where r.key = 'housing_loan_2025'
   and r.valid_to is null;

-- 실행 뒤 확인(조회만). 기대: 두 줄이 새 문장으로 나오고 전체 줄 수는 16 그대로다.
select jsonb_array_length(r.data->'additionalRules') as rules, t.ord, t.val
  from public.regulations_snapshot r, jsonb_array_elements_text(r.data->'additionalRules') with ordinality as t(val, ord)
 where r.key = 'housing_loan_2025' and r.valid_to is null and t.val like '2026.5.1%';
