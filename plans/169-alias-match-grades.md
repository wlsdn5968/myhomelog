# 169 — 단지 별칭 매칭 신뢰도 등급 (SQL 초안, 운영자 결정 대기 · 2026-10-19)

출처: plans/167 §2(deal-locator-mcp 의 매칭 신뢰도 등급에서 착안). 조사(2026-10-19, 읽기 전용) 결과를 먼저 적는다 — **생각보다 효용이 작아 결정이 필요하다.**

## 1. 조사로 확인한 사실
- `refresh_molit_aliases()`(`supabase/migrations/20260910_refresh_molit_aliases_materialized.sql`)의 `cand` CTE 가 이미 `by_jibun`·`by_name`·`digits_ok` 를 계산하고, 형제 확장은 별도 `sib` CTE 다. 즉 등급 재료는 있고 지금은 `acc0` 의 `OR` 에서 버려진다.
- `molit_aliases` 는 jsonb 문자열 배열이고 읽는 곳 6곳(transactionService 2·search in-bounds·aptPage·chatDataRouter·aptMasterSync)이 전부 `string[]` 을 전제한다 → **배열 모양은 바꾸면 안 되고 등급은 새 열**에 둬야 한다.
- **화면의 별칭 거래 병합(`openAptDetail`)은 `molit_aliases` 를 쓰지 않는다** — `/search/facility` 의 `altCandidates`(같은 동 이름을 토큰 부분일치로 즉석 점수화, `search.js _fetchAltCandidates`)로 병합하고, `_aliasUsed` 는 계산만 하고 표시하는 곳이 없다(2026-04 "alias 토스트 제거 — 사용자 혼란").
- 등급별 오매칭률 실측은 없다(053 부록 A 서울 30건 검수: ok 26·reject 1·partial 3 이 전부).

## 2. 등급 정의(코드 대응)
| 등급 | 조건 | CTE |
|---|---|---|
| A | 동+건축년도 일치 + 지번 일치 | `cand.by_jibun` |
| B | 동+건축년도 일치 + 이름 완전/접두 일치 + 숫자열 통과 | `cand.by_name AND digits_ok` (지번 불일치/없음) |
| C | A/B 형제 확장으로만 들어온 이름 | `sib` 에만 존재 |
중복이면 높은 등급(`min(grade)`, 'A'<'B'<'C').

## 3. SQL 초안(적용 금지 — 운영자 승인 뒤 SQL Editor, 적재 창·월요일 20:00 UTC 회피, 전후 합계 측정)
```sql
-- 1) 등급 열(내부 전용 — 공개 키 노출면 변화 없음: apt_master 공개 select 정책에 포함되는지 적용 전 확인)
ALTER TABLE public.apt_master ADD COLUMN IF NOT EXISTS molit_alias_grades jsonb;
COMMENT ON COLUMN public.apt_master.molit_alias_grades IS '별칭→등급 {"풍림아파트A":"A"} · A 지번 일치 / B 이름 일치 / C 형제 확장 (Plan 169)';

-- 2) refresh_molit_aliases() — acc 이후만 변경(mj·m·i MATERIALIZED 와 cand JOIN 은 그대로)
--    acc:  SELECT ..., CASE WHEN by_jibun THEN 'A' ELSE 'B' END AS grade
--    sib:  SELECT ..., 'C' AS grade
--    fin:  UNION ALL 뒤 (kapt_code, molit) 별 min(grade)
--    agg:  jsonb_agg(DISTINCT molit) AS aliases, jsonb_object_agg(molit, grade) AS grades
--    UPDATE apt_master a SET molit_aliases = agg.aliases, molit_alias_grades = agg.grades, updated_at = now()
--      WHERE a.molit_aliases IS DISTINCT FROM agg.aliases OR a.molit_alias_grades IS DISTINCT FROM agg.grades;
--    (함수 본문 전체는 적용 직전 pg_get_functiondef 원문을 기준으로 작성 — 여기서는 변경 범위만 고정)

-- 3) 적용 후 확인
-- select grade, count(*) from apt_master, jsonb_each_text(molit_alias_grades) g(alias, grade) group by 1;
-- select apt_name, molit_alias_grades from apt_master where apt_name = '공릉풍림아이원';
-- explain analyze select refresh_molit_aliases();  -- 9.9초 안팎 유지(30초 cron 중단 한도)
```

## 4. 효용과 결정
- 등급을 만들어도 **지금 화면에 보이는 병합(altCandidates)에는 적용되지 않는다.** 등급이 쓰이는 곳은 지도 마커 합치기·추천/보고서 단지명 정규화·가격 신호 거래 병합·공개 단지 페이지 — 사용자가 "추정 매칭" 표기를 볼 자리는 새로 만들어야 한다.
- 따라서 순서를 바꿔 제안: ① 등급별 건수·표본 검수(읽기 전용 조회, DB 변경 없음) → ② 오매칭이 실제로 보이면 함수 변경 + 열 추가(위 SQL) → ③ `_fetchAltCandidates` 를 별칭·등급 기반으로 바꾸고 상세 실거래 탭에 한 줄("신고 이름이 달라 추정으로 묶은 거래가 있어요") 표기.
- **운영자 결정**: ①만 먼저 할지(권고), 보류할지.
