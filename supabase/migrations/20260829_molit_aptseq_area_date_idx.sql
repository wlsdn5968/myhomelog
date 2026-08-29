-- PRICE-RECORDS-PERF-2026-08-29 (Sprint NNNNNNN-30): 경신 계산용 복합 인덱스.
--
-- [왜] get_price_records / get_price_records_by_region 의 핫스팟은
--   `where apt_seq = ? and exclu_use_ar = ? and deal_date <= ?` 를 단지·평형 쌍마다 도는 LATERAL 이다.
--   기존 idx_molit_apt_seq 는 apt_seq 단독이라 매 루프에서 exclu_use_ar 를 필터로 버렸다
--   (EXPLAIN: "Rows Removed by Filter: 36" / loop).
--
-- [실측 — 워밍 후]
--   전국(7일):  2,509ms → **112ms**   (약 22배)
--   지역(30일): 1,240ms → **1,030ms**
--   ⚠ 인덱스 생성 **직후 첫 측정은 9,122ms** 였다 — 빌드로 버퍼가 날아간 콜드 상태다.
--     그 한 번만 보고 "인덱스가 느리게 만들었다"고 판단할 뻔했다. 성능 판정은 반드시 반복 측정.
--
-- [왜 중요] PostgREST 의 실효 statement_timeout 은 **8초**다
--   (authenticator 롤에 8s, service_role 은 rolconfig null 이라 그 값을 물려받는다).
--   2.5초는 여유 3.2배뿐이라 부하 시 타임아웃 → RPC 실패 → 카드가 통째로 빈다.
--   112ms 면 여유가 70배가 된다.
--
-- [비용] 인덱스 17MB. DB 282MB → 299MB. Supabase 무료 한도 500MB 기준 **60% 사용** — 감시 대상.
create index if not exists idx_molit_aptseq_area_date
  on public.molit_transactions (apt_seq, exclu_use_ar, deal_date)
  where apt_seq is not null;
