# 177 별칭 갱신 함수 실행 시간 단축 (2026-10-30)

**운영자 승인**: 2026-10-30 "권고대로 진행해줘. 승인할게".

## 문제
- 매주 aptMasterSync 가 upsert 뒤 `refresh_molit_aliases()` 를 부르는데, 30초에 끊는다(`ALIAS_REFRESH_ABORT_MS`). 함수는 v8 99.1초, v7 도 pg_stat_statements 실측 35~102초라 기록이 TimeoutError 로 남았다(DB 쪽 UPDATE 는 끝까지 완료 — 09-07·14 기록). CLAUDE.md 의 "9.9초" 는 시간 측정을 끈 실행 계획 값이었다.
- 원인: 거래 원본(약 46만 행)을 두 CTE(mj·jn)가 각자 읽고, 큰 중간 결과끼리 인덱스 없이 조인.

## 수정
1. `public._refresh_molit_aliases_core(p_apply boolean)` (v9): 원본을 한 번만 집계(`_ma_g`) → 중간 결과를 임시 표(ON COMMIT DROP)로 만들고 인덱스·ANALYZE. 규칙 문장은 v8 마이그레이션에서 스크립트로 옮겨 손으로 바꾸지 않았다. `p_apply=false` 는 바뀔 단지 수만 센다(건조 실행). SECURITY DEFINER · search_path public,pg_temp · statement_timeout 300s · 실행 권한 service_role 만.
2. `refresh_molit_aliases()` 는 시그니처·권한·호출 코드 그대로, 본문만 `RETURN public._refresh_molit_aliases_core(true);`.
3. `backend/jobs/aptMasterSync.js`: 끊기 시간 = 함수 전체 예산 295초에서 지난 시간을 뺀 값, 최대 120초·최소 5초(`aliasRefreshAbortMs`). 지역 루프가 마감(250초)까지 썼으면 45초만 준다(300초 넘김 방지).
4. 기록: `supabase/migrations/20261030_refresh_molit_aliases_v9_temp.sql`, `supabase/schema.sql` 끝에 덧붙임.

## 운영 실측
- 운영 본체 본문 = 저장소 본문(주석 제외 md5 일치 8197ffb5…).
- 건조 실행: 바뀔 단지 0 · 17.2초 / 11.1초.
- 적용 실행(`refresh_molit_aliases()`): 바뀐 단지 0 · 14.8초. 연결 11,496쌍(단지 11,153) 그대로 · 보정표 34건 · 권한 {postgres, service_role} 유지.

## 검증
- `npm run verify` 990 통과. 새 테스트 `backend/test/alias-refresh-v9-177.test.js`(본체 구조·권한, v8 과 같은 규칙 문장, 끊기 시간 계산).
- 남은 확인: 다음 주간 회차(11-02 월 20:00 UTC)의 `aliasRefreshed` 기록에 TimeoutError 가 없는지.
