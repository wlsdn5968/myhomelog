# 112 — 읽는 코드가 0건인 캐시 컬럼 제거 (`apt_amenities` −0.77 MB · `apt_schools` −2.91 MB)

**작성 기준 커밋**: `d6e6206` (2026-09-20) · 근거: `plans/104-db-capacity-management.md` §8.2 · **운영자 승인 2026-09-20**("권고대로 진행해줘. 승인할게" — 후속표 4번)
**성격**: 코드 변경 → 배포 → **그 뒤에** 리뷰어가 DDL/DML 적용. **순서를 뒤집으면 캐시 쓰기가 깨진다.**

## 전제 확인 (계획자가 코드·프로덕션으로 직접 확인 — 2026-09-20)
- `apt_amenities` 의 `lat`·`lng`·`category`·`radius` 4컬럼 합 **793 KB**(`sum(pg_column_size(...))` 실측, 30,722행). 이 값들은 **`cache_key` 문자열에 이미 전부 들어 있다**(예: `'35.8663,128.693:MT1:1500'` = 위도,경도:카테고리:반경).
  - 읽는 곳: **0건**. `kakaoService.js:35` 은 `select('count, fetched_at')`, `naverDatalabService.js:196` 은 `select('count, fetched_at')`, `:229` 는 `select('cache_key, count, fetched_at')` 뿐이다. 저장소 전체에 `select('*')` 로 이 테이블을 읽는 곳도 없다.
  - 쓰는 곳: **2곳** — `kakaoService.js:_dbSetAmenityCount`(`:45-56`)와 `naverDatalabService.js:writeCache`(`:243-256`).
- `apt_schools.schools`(jsonb) 평균 **929.9 B**/행이 행 전체(≈1.03 KB)의 90%를 차지한다. 원소에서 `lat`·`lng`·`address` 를 뺀 슬림 형태는 평균 **421.0 B** — 5,988행 기준 **−2.91 MB**(계획자가 `jsonb_build_object` 로 직접 재계산해 확인).
  - 이 3개 필드를 **읽는 코드는 0건**이다. `schoolService.js:210` 은 `distance_m` 로만 정렬하고, `schoolNeisService.js` 는 `sigungu`·`lawdCd` 로 매칭하며 주소는 **NEIS 가 준 값**(`:132` `ORG_RDNMA`)을 따로 반환한다. 프론트 렌더(`index.html:7613-7624`·`8507-8516`)는 `name`·`type`·`distance_m` 만 쓴다.
  - 만드는 곳: `schoolService.js:135-142` 의 `all.push({ name, type, distance_m, lat, lng, address })` **한 곳**.
  - 저장하는 곳: `schoolService.js:saveToDb`(`:165-183`) — `schools` 를 그대로 upsert 하고 `cache.set('schools:'+key, schools, 3600)` 로 메모리에도 같은 객체를 넣는다.
- **TOAST 는 비어 있다**(`apt_schools` 의 `reltoastrelid` 크기 8,192 B = 빈 최소 페이지). 즉 `schools` 는 전부 인라인이라 **힙이 그대로 줄어든다**.

## 범위
**건드릴 파일**: `backend/services/kakaoService.js` · `backend/services/naverDatalabService.js` · `backend/services/schoolService.js` · `backend/test/unused-column-reclaim.test.js`(신규) · `supabase/schema.sql`
**건드리지 말 것**: `backend/routes/cron.js`·`backend/services/cronStats.js`(Plan 111 이 같은 시각에 고치고 있다) · `backend/routes/search.js` · `frontend/index.html` · 다른 캐시 테이블.

---

## Step 1 — `apt_amenities` 쓰기에서 4개 키를 뺀다 (함수 시그니처는 그대로 둔다)

### 1-1. `backend/services/kakaoService.js`
`_dbSetAmenityCount` 의 upsert payload 에서 `lat, lng, category, radius` **4개 키만** 제거한다. **함수 시그니처 `(cacheKey, lat, lng, category, radius, count)` 는 그대로 둬라** — 호출부를 건드리지 않기 위해서다.

```js
async function _dbSetAmenityCount(cacheKey, lat, lng, category, radius, count) {
  const a = _dbClient();
  if (!a) return;
  try {
    // UNUSED-COL-2026-09-20 (Plan 112): lat/lng/category/radius 는 cache_key
    //   ('35.8663,128.693:MT1:1500') 에 이미 들어 있고 읽는 코드가 0건이라 저장하지 않는다.
    //   시그니처는 유지한다 — 호출부를 건드리지 않기 위해서다(값은 cache_key 를 만들 때 이미 쓰였다).
    await a.from('apt_amenities').upsert(
      { cache_key: cacheKey, count, fetched_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { onConflict: 'cache_key' }
    );
  } catch (e) {
    // silent fail — DB 미설정 또는 migration 미적용
  }
}
```

### 1-2. `backend/services/naverDatalabService.js`
`writeCache(key, ratio, lat, lng)` 에서 payload 의 `lat, lng, category: 'naver_interest', radius: 0` 을 제거한다.
**⚠ `if (!admin || lat == null || lng == null) return;` 가드는 절대 지우지 마라.** 좌표 없는 항목을 거르는 **동작상의 조건**이라 지우면 캐시에 쓰레기가 들어간다.

```js
    if (!admin || lat == null || lng == null) return;   // ← 이 줄은 그대로 둔다
    // UNUSED-COL-2026-09-20 (Plan 112): 좌표는 key 에 이미 들어 있다 — 위 가드로만 쓰고 저장은 안 한다.
    await admin.from('apt_amenities').upsert({
      cache_key: key,
      count: Math.round(ratio * 10000),
      fetched_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }, { onConflict: 'cache_key' });
```
**⚠ 주의**: 종전엔 `category: 'naver_interest'` 로 네이버 관심도 캐시를 구분할 수 있었다. 이제 구분은 **`cache_key` 접두사**로만 가능하다. `readCache`/`readCacheBulk` 는 이미 `cache_key` 로만 조회하므로 동작은 같다 — 다만 **운영자가 SQL 로 직접 캐시를 들여다볼 때 카테고리 필터를 못 쓴다**는 점을 커밋 본문에 적어라.

---

## Step 2 — `apt_schools` 는 애초에 만들지 않는다
`backend/services/schoolService.js:135-142` 의 `all.push({...})` 에서 `lat`·`lng`·`address` **3줄을 삭제**한다. (저장 시점이 아니라 **생성 시점**에 빼야 한다 — 저장 때만 빼면 그 단지의 첫 요청은 3필드가 있고 두 번째 요청부터는 없어, 같은 화면이 경로에 따라 달라진다.)

```js
        all.push({
          name: baseName,  // 부속 (지성관/청원관/교무실 등) 제거된 정식명
          type,
          distance_m: distanceM(lat, lng, sLat, sLng),
          // UNUSED-COL-2026-09-20 (Plan 112): lat/lng/address 는 읽는 코드가 0건인데
          //   schools jsonb 평균 929.9B 의 절반 이상을 먹었다(슬림 421.0B). 거리는 여기서
          //   이미 distance_m 으로 환산되고, NEIS 풍부화는 sigungu·lawdCd 로 매칭하며
          //   주소는 NEIS 가 따로 준다(schoolNeisService.js:132). 만들지 않는다.
        });
```
`sLat`/`sLng` 는 바로 윗줄 `distanceM(lat, lng, sLat, sLng)` 에서 계속 쓰이므로 **그 변수 자체는 지우지 마라**.

### ⚠ 실행자가 반드시 먼저 확인할 것 (STOP 조건)
**찾는 것은 "학교 객체의 `lat`/`lng`/`address` 를 읽는 코드" 하나뿐이다.** 아래를 실행해 **출력이 비어 있는지** 확인하라. 한 건이라도 나오면 **코드를 고치지 말고 멈춰서 그 줄을 보고하라**.
```
grep -rnE "\b(s|sc|school|sch|item|e)\.(lat|lng|address)\b" backend/services/schoolService.js backend/services/schoolNeisService.js
grep -rnE "\b(s|sc|school|sch)\.(lat|lng|address)\b" frontend/index.html
grep -rn "nearbySchools" backend/routes/search.js
```
세 번째 grep 은 학교 배열이 응답으로 나가기까지의 경로만 확인하는 용도다 — `nearbySchools` 에 `lat`/`lng`/`address` 를 **덧붙이거나 읽는** 줄이 있으면 멈춰라. 단순 대입·전달(`nearbySchools = enriched`, `res.json({ ..., nearbySchools, ... })`)은 정상이다.

> **⚠ 계획자 오류 기록(2026-09-20, 실행자가 STOP 으로 잡아냄)**: 이 자리의 첫 grep 은 `backend/routes/search.js` 를 통째로 훑고 `.lat`/`.lng` 를 파일 단위로 잡았다. 그 파일은 **단지 좌표**(`apt_geocache` 의 `c.lat`·`c.lng`, `CANON-COORD-FIX-2026-06-03` 지도 마커 보정)도 다루기 때문에 **학교와 무관한 5건이 걸렸다**(`search.js:868,894,911,930,931`). 계획자가 다섯 줄을 전부 열어 오탐임을 확인했다. 교훈: **"이 필드를 읽는가" 를 확인하는 grep 은 필드명이 아니라 그 필드를 담은 변수까지 함께 묶어라.** 파일 전체를 훑는 grep 은 같은 이름의 다른 개념을 반드시 데려온다.

---

## Step 3 — 테스트 (신규 `backend/test/unused-column-reclaim.test.js`)
`backend/test/retention-observability.test.js` 의 스텁 방식을 패턴으로 삼되 **그 파일은 수정하지 마라**. 고정할 것:
1. `kakaoService._dbSetAmenityCount` 가 만드는 upsert payload 의 **키 집합이 정확히** `['cache_key','count','fetched_at','updated_at']` 이다(`lat`·`lng`·`category`·`radius` 가 **없다**). 스텁 `upsert` 로 payload 를 가로채 `Object.keys(payload).sort()` 를 단언하라.
2. `naverDatalabService.writeCache` 도 같은 키 집합이며, **`lat` 이나 `lng` 가 `null` 이면 upsert 를 아예 호출하지 않는다**(가드 회귀 고정 — 이 단언이 없으면 다음 사람이 가드를 지운다).
3. `schoolService` 가 만드는 학교 객체에 `lat`·`lng`·`address` 키가 **없다**. 함수를 직접 부를 수 없으면 **소스 정적 단언**으로 대체하라: `schoolService.js` 소스에 `all.push({` 블록이 있고 그 블록 안에 `lat:`·`lng:`·`address:` 가 없다.
4. 회귀 방지: `apt_amenities` 를 읽는 `select(...)` 문자열에 `lat`/`lng`/`category`/`radius` 가 **등장하지 않는다**(소스 정적 단언).

각 테스트에 **왜 이 단언이 필요한지** 한국어 주석을 달아라. 이 저장소의 관례다.

## Step 4 — `supabase/schema.sql` 정합
`apt_amenities` 의 `create table` 선언에서 `lat`·`lng`·`category`·`radius` 4줄을 제거하고, 바로 위에 한 줄 주석을 남겨라:
```sql
-- UNUSED-COL-2026-09-20 (Plan 112): lat/lng/category/radius 제거 — 값이 cache_key 에 이미 있고 읽는 코드가 0건이었다(−0.77MB).
```
**`apt_schools` 의 `schools` 컬럼 타입은 그대로다**(jsonb 내용만 얇아지므로 스키마 변경 없음).

## 완료 기준 (실행자)
```
npm run verify        → tests 449 이상 / fail 0     (기준선 445, 신규 4건)
grep -c "lat, lng, category, radius" backend/services/kakaoService.js   → 1   (시그니처만 남고 payload 에서는 사라짐)
grep -c "category: 'naver_interest'" backend/services/naverDatalabService.js → 0
grep -cE "^\s+(lat|lng|address):" backend/services/schoolService.js     → 0
```
⚠ 위 숫자는 계획 시점 기준이다. 다르면 **맞추려 들지 말고 실제 값을 보고하라**.

---

## Step 5 — 리뷰어 전용: 배포 **확인 후** DB 에 적용 (실행자는 절대 실행 금지)
**순서가 핵심이다.** 코드가 프로덕션에 올라간 것을 `/api/health` 의 deploy id 로 확인한 **뒤에** 아래를 적용한다. 순서를 뒤집으면 배포 전 인스턴스가 없는 컬럼에 upsert 해 **캐시 쓰기가 전부 실패**한다.

```sql
-- ① 적용 전 측정
select round(pg_total_relation_size('public.apt_amenities')/1048576.0,2) as amen_mb,
       round(pg_total_relation_size('public.apt_schools')/1048576.0,2)   as schools_mb,
       (select round(sum(pg_database_size(datname))/1048576.0,1) from pg_database) as db_mb;

-- ② apt_amenities 컬럼 제거 (카탈로그만 바뀐다 — 파일은 VACUUM FULL 전까지 안 줄어든다)
alter table public.apt_amenities drop column lat, drop column lng, drop column category, drop column radius;

-- ③ apt_schools 기존 5,988행 슬림화 (한 번에. jsonb 배열이 아닌 행은 건드리지 않는다)
update public.apt_schools
   set schools = (select jsonb_agg(jsonb_build_object('name', e->>'name', 'type', e->>'type', 'distance_m', e->'distance_m'))
                    from jsonb_array_elements(schools) e)
 where jsonb_typeof(schools) = 'array'
   and schools::text like '%"lat"%';

-- ④ 공간을 실제로 돌려받는다 (ACCESS EXCLUSIVE — 적재 창 17:00~19:00 UTC 밖에서. 두 테이블 합쳐 16MB 대라 수 초)
vacuum full public.apt_amenities;
vacuum full public.apt_schools;

-- ⑤ 검증
select count(*) as rows, count(*) filter (where schools::text like '%"lat"%') as still_fat,
       round(avg(pg_column_size(schools))::numeric,1) as avg_b from public.apt_schools;
--   기대: rows 5,988 · still_fat 0 · avg_b ≈ 421
select count(*) as amen_rows from public.apt_amenities;   -- 기대: 30,722 (행 수 불변)
```
- **`VACUUM FULL` 을 빠뜨리지 마라.** `DROP COLUMN` 은 카탈로그만 바꾼다 — §8 에서 `source` 컬럼 제거를 기각한 이유와 같은 성질이다. 이 두 테이블은 합쳐 16 MB 대라 재작성 비용이 작아서 할 수 있는 것이다(`molit_transactions` 221 MB 와 다르다).
- 적용 기록은 `supabase/migrations/20260920_unused_column_reclaim.sql` 에 **되돌리기 SQL 과 함께** 남긴다(Plan 026 관례). 되돌리기: 컬럼 4개 재추가(값은 `cache_key` 에서 파생 가능) · `schools` 의 3필드는 **재조회로만 복원**(카카오 무료 한도 내, 90일 TTL 이라 자연 갱신되기도 한다).

## STOP 조건 (실행자)
1. Step 2 의 grep 이 **한 건이라도 나오면** 멈춰라 — 읽는 코드가 있다는 뜻이고, 그러면 이 계획의 전제가 무너진다.
2. `npm run verify` 가 **기존 테스트**를 깨뜨리면 멈춰라. 특히 Plan 110·111 이 만든 테스트 파일은 범위 밖이다.
3. **DDL/DML 을 직접 실행하지 마라.** Step 5 는 리뷰어 몫이다. 공유 프로덕션 DB다.
4. `naverDatalabService.js` 의 `lat == null || lng == null` 가드를 지우고 싶어지면 멈춰라 — 그건 저장용이 아니라 **필터**다.
