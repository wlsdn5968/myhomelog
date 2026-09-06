# Plan 053: `molit_aliases` 를 실제로 채운다 (14,661행 중 1행만 채워져 있고 문서는 "완료"라고 적혀 있다)

> **실행자 안내**: 이 계획은 **프로덕션 DB 쓰기**를 포함한다. 절대 룰 ③ 에 따라
> **운영자 명시 승인 없이 DB 를 수정하지 마라.** 승인 전까지는 산출물이 "검증 리포트 + SQL 초안"이다.
>
> **드리프트 점검(먼저)**:
> `git diff --stat ed8d658..HEAD -- backend/jobs/aptMasterSync.js CLAUDE.md`

## Status

- **Priority**: P1 · **Effort**: M · **Risk**: **HIGH**(오매칭이 전국 규모로 퍼진 이력 있음) ·
  **Depends on**: 없음(단, 051 이 먼저 머지되면 이 backfill 의 효과가 즉시 사용자에게 보인다)
- **Category**: data + doc-drift · **Planned at**: commit `ed8d658`, 2026-09-06
- **게이트**: DB 쓰기는 **운영자 승인 필수**

## 왜 중요한가

### ① 문서가 거짓이다 — 다음 세션에게 거짓 안심을 준다

`CLAUDE.md:119-122`:

```
### 완료되어 목록에서 제거 (이력)
- ~~regulations_snapshot 정책 SQL~~ (운영자 실행 완료 2026-06-27)
- ~~apt_master.molit_aliases 자동 backfill~~ (완료)
```

**실측(프로덕션 DB, 2026-09-06)**: `apt_master` 14,661행 전부 `molit_aliases IS NOT NULL` 이지만,
**비어 있지 않은(`[]` 이 아닌) 행은 정확히 1행**이다 — `공릉풍림아이원`(kapt_code `A13980513`).

### ② 그 결과 alias 를 소비하는 코드가 무동작이다

`backend/routes/search.js:695-700` 은 지도 viewport 집계에서 alias 병합을 한다:

```js
        const { data: _mp } = await admin
          .from('apt_master')
          .select('apt_name, sigungu, umd_nm, kapt_code, molit_aliases')
          .in('umd_nm', umds)
          .not('molit_aliases', 'is', null)
```

`.not('molit_aliases','is',null)` 은 **14,661행 전부를 통과시킨다**(전부 NOT NULL 이므로).
즉 이 필터는 아무것도 거르지 않고, 병합할 alias 도 사실상 없다.
바로 위 주석은 *"molit_aliases 보유 행이 14,901(사실상 전체)"* 라고 적어 두었는데,
그건 **NOT NULL 행 수**이지 **alias 를 가진 행 수**가 아니다. 주석 자체가 오독을 굳혔다.

### ③ 사용자에게 보이는 증상 — 운영자가 반복 지적한 것

> "공릉 풍림아파트 a,b 두개로 나눠서 유지하지말라고 몇번을 말했잖아. 같은 아파트라고."

MOLIT 은 `풍림아파트A`·`풍림아파트B` 로 나눠 신고하는데 KAPT 는 하나의 단지
(`공릉풍림아이원`, kapt_code `A13980513`, 1,601세대)로 등록한다. alias 가 있어야 합쳐진다.

**규모**: 챗은 정식명의 **76.6%(11,234곳)** 를 못 찾고, 그중 **4,888곳**은 같은 동에 유사한
MOLIT 이름이 실재한다(계획 051 의 실측표 참조).

## ⚠⚠ 가장 중요한 제약 — IDENTITY-GATE

이 저장소는 **이름 유사도 단독 매칭으로 전국 956건을 오매칭**한 이력이 있다
(3,169세대 단지에 104세대가 붙었다). 이번 조사에서도 실제 오매칭이 재현됐다:

| 정식명 | 최유사 MOLIT 이름 | trigram | 판정 |
|---|---|---|---|
| `강일리버파크11단지` | `강일리버파크1단지` | 0.750 | **다른 단지** |
| `벽산블루밍1단지,2단지` | `벽산블루밍1단지` | 0.750 | 부분만 덮음 |

**따라서 이름 유사도는 후보 생성에만 쓰고, 채택은 교차검증으로 결정한다.**

### 사용 가능한 교차검증 축 (실측으로 존재 확인)

| 축 | 출처 | 커버리지 | 용도 |
|---|---|---|---|
| **건축년도** | `apt_master.facility->>'kaptUsedate'` (YYYYMMDD) | **14,404 / 14,661 (98.2%)** | **거부 판정** |
| **지번** | `apt_master.facility->>'kaptAddr'` (예: `서울특별시 노원구 공릉동 725 공릉풍림아이원`) | 14,404 (98.2%) | **채택 강화만** |
| 지번(거래측) | `molit_transactions.jibun` | **224,811 / 460,358 (48.8%)** | 위와 같음 |

⚠ **지번으로 거부하지 마라.** 거래측 지번이 51.2% 비어 있고, 운영자 사례가 정확히 반례다 —
`공릉풍림아이원` 의 `kaptAddr` 지번은 **725** 인데 MOLIT `풍림아파트A`=725, **`풍림아파트B`=727** 이다.
지번으로 거부하면 **B 가 탈락해 운영자가 요구한 병합이 깨진다.**
이 저장소의 확립된 규칙 그대로다: **지번은 채택만, 거부는 연도로.**

### 검증된 정답 케이스 (회귀 기준으로 쓰라)

```
apt_master: 공릉풍림아이원 / kapt_code A13980513 / kaptUsedate 20010917 / kaptAddr … 공릉동 725 / 1601세대
molit     : 풍림아파트A (build_year 2001, jibun 725, 92건)
            풍림아파트B (build_year 2001, jibun 727, 22건)
기대       : aliases = ["풍림아파트A", "풍림아파트B"]
```

## 범위

**In scope**:
- 매칭 판정 스크립트(**읽기 전용**) — `scripts/` 아래에 두고, 산출물은 리포트 + SQL 초안
- `CLAUDE.md` 의 거짓 항목 정정
- `backend/routes/search.js:695-700` 의 **주석** 정정(코드 아님) 및 무의미한 `.not(...is null)` 필터를
  의미 있는 조건으로 교체할지 **판단해 보고**(고치려면 별도 승인 — 이 계획에서 임의 변경 금지)
- `backend/test/characterization.test.js`

**Out of scope**:
- **DB 쓰기 자체** — 운영자 승인 전까지 절대 금지. `execute_sql`·`apply_migration` 을 쓰지 마라.
- `backend/services/chatDataRouter.js` · `backend/routes/search.js` 의 **조회 로직** — 계획 051/052.
- `aptMasterSync` cron 에 자동 backfill 을 심는 것 — 1회 검증이 끝난 뒤 별도로 판단한다.

## 단계

### Step 1: 후보 생성 (읽기 전용)

각 `apt_master` 행에 대해 **같은 `(lawd_cd, umd_nm)`** 의 `molit_apt_index` 행만 후보로 본다.
(동을 벗어난 매칭은 만들지 마라 — 동명 단지 오매칭의 주 원인이다.)

후보 점수는 이름 정규화(공백 제거) 후의 유사도로 매긴다. **이 점수로 채택하지 않는다.**

### Step 2: 채택 판정 — 아래를 **전부** 만족할 때만 alias 로 인정

1. `apt_master.facility->>'kaptUsedate'` 의 **앞 4자리(연도)** 가 후보의 `build_year` 와 **같다**
   · `kaptUsedate` 가 없으면(257행) → **채택하지 않는다**(모름을 값으로 만들지 마라)
   · 연도 ±1 을 허용하고 싶으면 **먼저 그 완화가 몇 건을 더 붙이고 그중 몇 건이 오매칭인지
     표본 검수 결과를 보고**하라. 근거 없이 완화하지 마라.
2. 이름 정규화 후 **한쪽이 다른 쪽의 접두**이거나, 유사도가 임계 이상이다
   · 임계값은 **네가 정하되, 서울 표본 30건을 손으로 검수한 결과를 보고에 표로 붙여라.**
     검수 없이 임계값을 고르면 **STOP 조건**이다.
3. **숫자 꼬리가 다르면 거부한다** — `강일리버파크11단지` ↔ `강일리버파크1단지` 를 막는 규칙이다.
   정규화 이름에서 끝의 숫자열을 뽑아 서로 다르면(둘 다 존재할 때) 채택하지 마라.

**채택 강화(선택)**: `kaptAddr` 에서 뽑은 지번과 그 후보의 MOLIT 지번 최빈값이 같으면
임계값을 낮춰도 좋다. **반대로 지번이 다르다고 거부하지는 마라**(위 반례).

### Step 3: A/B 형제는 **함께** 붙인다

한 `apt_master` 행이 여러 MOLIT 이름을 가리키는 것이 정상이다(운영자 사례).
Step 2 를 통과한 이름이 여러 개면 **전부** alias 에 넣어라. 하나만 고르지 마라.

계획 051 의 A/B 형제 규칙(같은 동·같은 `build_year`·stem 동일·접미문자 2종 이상)을 통과하는
집합은 **한 덩어리로** 취급하라.

### Step 4: 리포트 산출 (운영자 제출물)

다음을 포함한 리포트를 만들어라:

- 채택된 (kapt_code → alias 목록) 총 건수, 시도별 분포
- **거부된 사유별 집계**(연도 불일치 / 연도 없음 / 숫자꼬리 불일치 / 유사도 미달)
  ⚠ 사유 집계를 심지 않으면 원인을 추정만 하게 된다 — 이 저장소가 429 사고에서 배운 지점이다.
- **표본 검수표 30건**(서울) — 정식명 · MOLIT 이름 · 연도 · 지번 · 판정 · 사람이 본 정오
- 정답 케이스(`공릉풍림아이원`)가 기대대로 나오는지
- 적용 SQL 초안(`UPDATE apt_master SET molit_aliases = … WHERE kapt_code = …`)

⚠ 리포트는 **채팅 본문에 직접** 표로 실어라. 이 저장소는 파일·링크로 문서를 전달했다가
**4회 연속 실패**한 이력이 있다.

### Step 5: 문서 정정 (DB 승인과 무관하게 지금 한다)

- `CLAUDE.md:122` 의 `~~apt_master.molit_aliases 자동 backfill~~ (완료)` 를 **사실대로** 고쳐라
  (실측치 "14,661행 중 1행"과 측정 일자를 남겨라). 완료 목록에서 **미진행으로 되돌려라.**
- `backend/routes/search.js:689-693` 주석의 "molit_aliases 보유 행이 14,901(사실상 전체)" 를
  정정하라 — 그건 NOT NULL 행 수다. **코드는 건드리지 마라**(주석만).

**검증**: `git diff --stat` 에 `CLAUDE.md` 와 `search.js` 만, `search.js` 는 주석 줄만 바뀌었을 것

### Step 6: 테스트

`backend/test/characterization.test.js` 에 **판정 함수의 실행 테스트**를 넣어라
(판정 로직을 순수 함수로 분리해 두면 가능하다):

1. `공릉풍림아이원` + `풍림아파트A/B` → 둘 다 채택
2. `강일리버파크11단지` + `강일리버파크1단지` → **거부**(숫자 꼬리)
3. `kaptUsedate` 없음 → **거부**
4. 연도 불일치 → **거부**

**검증**: `cd backend && npm test` → `fail 0`

### Step 7: 운영자 승인 요청 후에만 DB 적용

승인이 오면 SQL 을 적용하고, 적용 **후** 다음을 실측해 보고하라:
- 비어 있지 않은 `molit_aliases` 행 수 (1 → N)
- 챗 도달률 재측정(계획 051 의 실측 쿼리를 재사용)
- `get_advisors` 재실행(이 저장소는 DDL/DML 후 재실행이 관례)

## 완료 기준

- [ ] 리포트가 **채팅 본문에** 표로 제출됐다(사유별 거부 집계 포함)
- [ ] 서울 표본 30건 손검수표가 있다
- [ ] `공릉풍림아이원` → `["풍림아파트A","풍림아파트B"]` 가 재현된다
- [ ] `강일리버파크11단지` 오매칭이 **거부**된다
- [ ] `CLAUDE.md` 의 거짓 항목이 정정됐다
- [ ] `cd backend && npm test` `fail 0` · `npm run verify` exit 0
- [ ] **운영자 승인 없이 DB 를 쓰지 않았다**

## STOP 조건

- 표본 검수 없이 임계값을 정하고 싶어진다 → **STOP.** 검수표가 이 계획의 핵심 산출물이다.
- 지번 불일치로 거부하는 규칙을 넣고 싶어진다 → **STOP.** 운영자 사례가 반례다(725 vs 727).
- 채택 건수가 4,888(같은 동 유사 후보 수)을 **크게 넘는다** → 과매칭 신호다. 멈추고 표본을 늘려라.
- DB 를 지금 고치고 싶어진다 → **STOP.** 절대 룰 ③.

## 유지보수 메모

- **이 계획이 끝나면 계획 051 의 "동 조회 + 유사도 후보" 경로 상당수가 alias 히트로 대체된다** —
  왕복이 줄고 답변이 확정적이 된다. 051 의 코드를 지우지는 마라(alias 가 없는 단지가 남는다).
- **`aptMasterSync` 가 새 단지를 넣을 때 alias 는 비어 있다.** 1회 backfill 로 끝나지 않는다 —
  cron 에 심을지는 1회 검증 결과를 보고 운영자가 결정한다.
- **리뷰에서 볼 것**: 거부 사유 집계가 있는지, 표본 검수표가 실제로 사람 판정을 담고 있는지.
  숫자만 있고 검수가 없으면 이 저장소가 956건 오매칭을 냈을 때와 같은 상태다.

---

# 부록 A — 판정 규칙 확정 + 표본 검수 결과 (계획자 직접 수행, 2026-09-06)

> Step 1~4 를 계획자가 **읽기 전용 DB 조회**로 직접 수행했다. 실행자는 이 부록의 SQL 을
> 그대로 쓰되, **운영자 승인 없이는 적용하지 마라**(절대 룰 ③).

## A-1. 확정된 판정 규칙

**공통 필수 (전부 만족)**
1. 같은 `(lawd_cd, umd_nm)`
2. `apt_master.facility->>'kaptUsedate'` 의 **연도** == `molit_apt_index.build_year`
   · `kaptUsedate` 없으면 채택하지 않는다(모름을 값으로 만들지 않는다)

**채택 경로 (둘 중 하나)**
- **경로 A (지번)**: `kaptAddr` 에서 뽑은 지번 == 그 MOLIT 이름의 **최빈 jibun**
- **경로 B (이름)**: 정규화(공백·괄호 제거) 후 완전일치 또는 접두 포함, **그리고** 숫자열 일치

**거부 (전부 적용)**
- MOLIT 이름이 `상가|근린|근생|판매시설|오피스텔` 을 포함
- 한 MOLIT 이름이 **2개 이상 kapt_code** 에 매칭(어느 단지 것인지 모름)

**확장**
- **A/B 형제**: 채택된 이름과 같은 동·같은 `build_year`·stem 동일·**끝 1글자만 다른** 이름을 함께 넣는다

## A-2. 왜 이 규칙인가 — 실측 근거

| 사실 | 값 | 규칙에 준 영향 |
|---|---|---|
| `similarity('공릉풍림아이원','풍림아파트A')` | **0.071** | **이름 유사도로는 운영자 사례를 원리적으로 못 잡는다** → 지번 경로 필수 |
| `강일리버파크11단지`(KAPT 2015) ↔ `강일리버파크1단지`(MOLIT 2009) | 유사도 0.750 | **연도 게이트만으로 이미 거부됨** |
| `molit_transactions.jibun` 채움률 | **48.8%** | 지번은 **채택만**, 거부 근거로 쓰지 않는다 |
| `공릉풍림아이원` 지번 725 ↔ `풍림아파트B` 지번 **727** | 불일치 | 지번으로 거부했다면 **B 가 탈락**했다 — 형제 확장이 필요한 이유 |
| 상가류 이름이 붙는 페어 | 11,747 중 **5** | 배제 비용이 사실상 0 |

## A-3. 표본 30건 적대 검증 (3렌즈 × 90표)

**ok 26 · reject 1 · partial 3** — 그런데 **partial 3 중 2건은 검증 방식의 artifact** 였다
(검증자에게 쌍을 하나씩만 보여줬다). 계획자가 DB 로 실제 채택 집합을 재확인한 결과:

| # | 후보 | 검증자 판정 | **실제 채택 집합(DB 확인)** | 최종 |
|---|---|---|---|---|
| 5 | 올림픽선수기자촌아파트 → 3단지 | partial(1·2단지 누락) | **1단지(33) + 2단지(52) + 3단지(29) 전부** | ✅ ok |
| 7 | 가락3차쌍용스윗닷홈 → 104동 | partial | **103동 + 104동 둘 다** | ✅ ok |
| 26 | 위례중앙푸르지오아파트 → 2단지 | partial | 2단지만 | ⚠ partial 유지 |
| 2 | 풍납대아아파트 → **대아(제101상가동)** | **reject** | 거래 2건·전용 60.00㎡ 단일·이름이 상가동 | ❌ **규칙으로 배제** |

⚠ **교훈**: 적대 검증에 후보를 **낱개로** 주면 "부분 매칭" 오탐이 난다. 다음에 같은 검증을 할 때는
**kapt_code 단위로 채택 집합 전체**를 보여줘라.

## A-4. 최종 규모

| | 값 |
|---|---|
| 최종 페어 | **10,682** |
| 최종 단지 | **10,405** (전체 14,661 의 71.0%) |
| 형제 확장으로 추가된 페어 | 2 |
| 운영자 사례 결과 | `공릉풍림아이원` → **`풍림아파트A, 풍림아파트B`** ✅ |

## A-5. 적용 SQL (⚠ 운영자 승인 후에만 실행)

```sql
WITH mj AS (
  SELECT lawd_cd, umd_nm, apt_name, build_year, jibun,
         row_number() OVER (PARTITION BY lawd_cd,umd_nm,apt_name,build_year ORDER BY cnt DESC, jibun) AS rn
  FROM (SELECT lawd_cd,umd_nm,apt_name,build_year,jibun,count(*) cnt FROM molit_transactions
        WHERE jibun IS NOT NULL AND jibun<>'' GROUP BY 1,2,3,4,5) t
), m AS (
  SELECT kapt_code, apt_name, lawd_cd, umd_nm,
         left(facility->>'kaptUsedate',4)::int AS yr,
         (regexp_match(facility->>'kaptAddr','(?:^|\s)([0-9]+(?:-[0-9]+)?)(?:\s|$)'))[1] AS jb,
         regexp_replace(replace(apt_name,' ',''),'\([^)]*\)','','g') AS n
  FROM apt_master WHERE facility->>'kaptUsedate' ~ '^[0-9]{8}'
), i AS (
  SELECT apt_name, lawd_cd, umd_nm, build_year,
         regexp_replace(replace(apt_name,' ',''),'\([^)]*\)','','g') AS n
  FROM molit_apt_index
), cand AS (
  SELECT m.kapt_code, m.lawd_cd, m.umd_nm, i.apt_name AS molit,
         (mj.jibun IS NOT NULL) AS by_jibun,
         (m.n=i.n OR starts_with(i.n,m.n) OR starts_with(m.n,i.n)) AS by_name,
         (regexp_replace(m.n,'[^0-9]','','g')=regexp_replace(i.n,'[^0-9]','','g')
          OR regexp_replace(m.n,'[^0-9]','','g')='' OR regexp_replace(i.n,'[^0-9]','','g')='') AS digits_ok
  FROM m JOIN i ON i.lawd_cd=m.lawd_cd AND i.umd_nm=m.umd_nm AND i.build_year=m.yr
  LEFT JOIN mj ON mj.rn=1 AND mj.lawd_cd=m.lawd_cd AND mj.umd_nm=m.umd_nm
              AND mj.build_year=m.yr AND mj.apt_name=i.apt_name AND mj.jibun=m.jb
), acc0 AS (
  SELECT * FROM cand
  WHERE (by_jibun OR (by_name AND digits_ok))
    AND molit !~ '상가|근린|근생|판매시설|오피스텔'
), acc AS (
  SELECT * FROM acc0 WHERE (molit,lawd_cd,umd_nm) NOT IN
    (SELECT molit,lawd_cd,umd_nm FROM acc0 GROUP BY 1,2,3 HAVING count(DISTINCT kapt_code)>1)
), sib AS (
  SELECT DISTINCT a.kapt_code, s.apt_name AS molit
  FROM acc a
  JOIN molit_apt_index base ON base.lawd_cd=a.lawd_cd AND base.umd_nm=a.umd_nm AND base.apt_name=a.molit
  JOIN molit_apt_index s ON s.lawd_cd=a.lawd_cd AND s.umd_nm=a.umd_nm AND s.build_year=base.build_year
  WHERE base.apt_name ~ '[A-Za-z가나다라]$' AND s.apt_name ~ '[A-Za-z가나다라]$'
    AND length(regexp_replace(base.apt_name,'[A-Za-z가나다라]$','')) >= 2
    AND regexp_replace(base.apt_name,'[A-Za-z가나다라]$','') = regexp_replace(s.apt_name,'[A-Za-z가나다라]$','')
    AND right(base.apt_name,1) <> right(s.apt_name,1)
    AND s.apt_name !~ '상가|근린|근생|판매시설|오피스텔'
), fin AS (
  SELECT kapt_code, molit FROM acc
  UNION SELECT kapt_code, molit FROM sib
), agg AS (
  SELECT kapt_code, jsonb_agg(DISTINCT molit) AS aliases FROM fin GROUP BY kapt_code
)
UPDATE apt_master a
SET molit_aliases = agg.aliases, updated_at = now()
FROM agg
WHERE a.kapt_code = agg.kapt_code
  AND a.molit_aliases IS DISTINCT FROM agg.aliases;
```

**적용 후 반드시 실측할 것**
1. `SELECT count(*) FROM apt_master WHERE molit_aliases::text NOT IN ('[]','{}','null');` → **10,405 기대**(적용 전 1)
2. `SELECT molit_aliases FROM apt_master WHERE apt_name='공릉풍림아이원';` → `["풍림아파트A","풍림아파트B"]`
3. 챗 도달률 재측정(본문 실측 쿼리 재사용) — 적용 전 23.4%
4. `get_advisors` 재실행

⚠ **되돌리기**: 적용 전 `SELECT kapt_code, molit_aliases FROM apt_master WHERE molit_aliases::text <> '[]'`
결과를 백업해 두면 원복할 수 있다(적용 전엔 1행뿐이라 백업이 사실상 공짜다).
