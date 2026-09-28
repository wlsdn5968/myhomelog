# 129 — 공개 키(publishable) 노출면 축소: 대형 데이터·백엔드 전용 함수를 공개 키로 직접 못 읽게

**작성 기준 커밋**: `620bf3b` (2026-09-28) · **출처**: 2026-09-28 후속표 5번 "공개 REST 우회 판단" — 운영자 "권고대로 진행해줘. 승인할게" 의 범위 안에서 **근거·SQL·되돌리기**를 확정한 결정 문서. **운영 DB 권한 변경이므로 아래 SQL 은 운영자가 이 문서를 보고 명시 승인한 뒤에만 적용한다**(CLAUDE.md 절대 룰 3).
**성격**: 1단계 = DB 권한만(코드 변경 0) · 2단계 = 코드 2곳 + DB 권한(절충 있음 — §4).

## 1. 사실 (계획자 실측 2026-09-28 — 추정 없음)
### 1-1. 누구나 읽을 수 있다
- 공개 키는 설계상 공개다: `frontend/index.html:156`·`frontend/billing.html:56` 메타 태그.
- 그 키만으로 REST 직접 조회가 된다(실측, 최소 크기 요청): `molit_transactions?select=id&limit=5000` → **1,000행 반환**(요청당 상한 1,000 — 페이지를 넘기면 전부 가져갈 수 있다) · `molit_transactions_hist`·`molit_apt_index`(MV)·`apt_master` 각 `limit=1` → 200.
- 운영 `pg_catalog` 실측: 아래 8개 객체 모두 `anon`·`authenticated` 에 전체 권한(`arwdDxtm`), 행 접근은 RLS 정책으로만 열려 있다. MV `molit_apt_index` 는 RLS 대상이 아니라 권한만으로 열려 있다.

| 객체 | 크기(행) | 공개 읽기 정책(운영) |
|---|---|---|
| `molit_transactions` | 222MB (44.5만) | `molit_tx_public_read` (public, true) |
| `molit_transactions_hist` | 85MB (129만) | `hist_read` (anon+authenticated, true) |
| `apt_master` | 28MB (1.5만) | `apt_master_public_read` (anon+authenticated, true) |
| `apt_geocache` | 10MB (2.0만) | `apt_geocache_public_read` (public, true) |
| `molit_apt_index` (MV) | 6.6MB (2.8만) | RLS 없음 — 권한으로 열림 |
| `building_register` | 6.2MB (0.9만) | `br_read` (public, true) |
| `apt_amenities` | 5.1MB (3.1만) | `apt_amenities_public_read` (anon+authenticated, true) |
| `apt_schools` | 3.8MB (0.6만) | `apt_schools_public_read` (anon+authenticated, true) |

- anon 이 실행할 수 있는 함수는 정확히 6개, 모두 SECURITY INVOKER(운영 실측): `active_lawd_codes(date)` · `geocache_backfill_candidates(integer, text)` · `get_table_health()` · `refresh_molit_apt_dim()`(쓰기) · `search_popular_apts(integer)` · `upsert_hist_peaks_for_month(text)`(쓰기). 쓰기는 대상 테이블 RLS(정책 0)가 막지만 **앞단의 무거운 조회는 anon 3초 한도까지 돈다**. SECURITY DEFINER 함수들은 이미 anon 실행 권한이 회수돼 있다. 6개 모두 `service_role` 에 **명시** 실행 권한이 있다(ACL `service_role=X/postgres`) — PUBLIC 을 회수해도 백엔드는 영향 없음.
### 1-2. 위험의 실체 — 기밀이 아니라 가용성
- 데이터는 공공 데이터(국토부 실거래)와 그 가공본이라 **기밀 유출은 아니다**. 위험은 **무료 플랜 전송량(월 5GB, 공식 문서 docs/guides/platform/manage-your-usage/egress) 소진**: 초과가 계속되면 Fair Use 로 **모든 API 가 402** 가 된다(공식 billing-faq) — 우리 백엔드도 같은 프로젝트라 서비스 전체가 멈춘다. 원본 거래 222MB 를 몇 번만 페이지 순회해도 GB 단위.
- 현재 악용 흔적은 없다: 최근 24시간 API 게이트웨이 로그 66,561건 **전부 우리 백엔드**(User-Agent `node`, AWS 서울/Amazon) — 브라우저·제3자 요청 0.
### 1-3. 누가 공개 키로 읽나 (세 방법 교차 확인: 클라이언트 도우미 기준 grep · 테이블 기준 전수(탐색 에이전트) · 24시간 게이트웨이 로그의 키 접두어)
- **프런트엔드**: 테이블·RPC 직접 조회 0 — 브라우저 Supabase 클라이언트는 로그인 API 만 쓴다(`frontend/index.html:204-287`). 데이터는 전부 `/api/*` 경유.
- **백엔드 공개 키 사용처**(`backend/db/client.js` 의 `getSupabaseReadonly`·`getSupabasePublic`):
  - `backend/routes/search.js:74` `adminClient = () => getSupabaseReadonly()` — 이름과 달리 공개 키. 자동완성(`molit_apt_index`·`apt_master`·`molit_transactions`) · 지도 `/in-bounds`(`apt_geocache`·`molit_transactions`·`apt_master`) · 시설 대체 후보(`molit_transactions`).
  - `backend/services/popularService.js:56·68` `buildPopularResults` 기본값 = 공개 키(사용자 `/popular` 라이브 폴백: RPC `search_popular_apts`·`molit_transactions`·`apt_geocache`). cron 은 service_role 을 넘긴다(`cron-observability.test.js` 가 고정).
  - 작은 테이블만: `popular_apts_snapshot`(popularService:228) · `regulations_snapshot`(regulationsService:132, regulationsCheck:58) · `billing_plans`(billing.js:138).
- **그 외 모든 조회는 service_role**. 특히 `molit_transactions_hist`·`apt_amenities`·`apt_schools`·`building_register` 와 함수 5개(`search_popular_apts` 제외)는 **공개 키 사용처가 0** — 로그에서도 공개 키 접두어로 이 경로를 부른 기록 0.
- ⚠ **설계 이력**: 사용자 요청 경로가 공개 키를 쓰는 건 의도였다 — anon 의 DB 쪽 **3초 statement_timeout** 이 사용자 요청발 느린 쿼리를 끊는다(`popularService.js` `SNAPROLE-2026-08-16` 주석). service_role 요청은 authenticator 의 **8초**가 상한이다(`pg_roles` 실측: anon 3s · authenticated 8s · authenticator 8s · service_role 설정 없음).

## 2. 권고
**1단계는 지금 적용(코드 변경 0, 기능 영향 0 — 공개 키 사용처가 없다는 것이 세 방법으로 확인됨). 2단계는 절충(§4)을 보고 운영자가 결정.** 둘 다 되돌리기 SQL 이 있다(§5).
공개 유지: `popular_apts_snapshot`·`regulations_snapshot`·`billing_plans` — 수 KB 라 전송량 위험이 없고 공개 키 경로가 쓴다.

## 3. 1단계 — DB 권한만 (운영자 승인 후 계획자가 적용)
### 3-1. 적용 SQL (한 마이그레이션, 적재 창 17:00~19:00Z·월 20:00Z 밖)
```sql
-- (a) 백엔드 전용 invoker 함수 5개: 공개 실행 권한 회수 (service_role 은 명시 권한 유지)
revoke execute on function public.active_lawd_codes(date) from public, anon, authenticated;
revoke execute on function public.geocache_backfill_candidates(integer, text) from public, anon, authenticated;
revoke execute on function public.get_table_health() from public, anon, authenticated;
revoke execute on function public.refresh_molit_apt_dim() from public, anon, authenticated;
revoke execute on function public.upsert_hist_peaks_for_month(text) from public, anon, authenticated;
-- (b) 공개 키 사용처가 0 인 대형 테이블 4개: 공개 읽기 정책 제거 + anon/authenticated 권한 회수
drop policy if exists hist_read on public.molit_transactions_hist;
drop policy if exists apt_amenities_public_read on public.apt_amenities;
drop policy if exists apt_schools_public_read on public.apt_schools;
drop policy if exists br_read on public.building_register;
revoke all on public.molit_transactions_hist, public.apt_amenities, public.apt_schools, public.building_register from anon, authenticated;
```
정책만 지우면 공개 키 요청이 **빈 배열로 조용히** 성공한다(누락된 사용처를 못 찾는다). 권한까지 회수하면 `permission denied`(42501)로 **시끄럽게** 실패한다 — 그래서 둘 다 한다. RLS 는 켜 둔다(서비스 쓰기 정책 `*_service_write` 는 그대로).
### 3-2. 적용 전 점검 (읽기 전용 — 하나라도 다르면 STOP)
- 위 5개 함수 `has_function_privilege('service_role', …, 'EXECUTE')` = true (ACL 에 `service_role=X` 명시).
- 최근 24시간 게이트웨이 로그: 공개 키 접두어(`sb_publishable_`)로 `molit_transactions_hist`·`apt_amenities`·`apt_schools`·`building_register`·위 5개 RPC 를 부른 요청 0.
### 3-3. 적용 후 확인
- `has_function_privilege('anon', …)` 5개 모두 false · `has_table_privilege('anon', …, 'SELECT')` 4개 모두 false · service_role 은 true.
- 공개 키 REST: `molit_transactions_hist?select=deal_date&limit=1` → 401/403(42501) · `rpc/get_table_health` → 거부.
- 백엔드 정상: `/api/health` 200·deploy id·`dataCounts`(이력 건수 = service_role 경로) · `/apt/<표본>` 장기 이력 · 시설·학교 카드(단지 모달) · 다음 retention cron 의 `get_table_health` 정상(Sentry 신규 0) · 다음 molit-ingest cron 의 `refresh_molit_apt_dim` 정상.
- 기록: `supabase/migrations/2026MMDD_public_key_surface_stage1.sql`(적용 SQL·전후 실측) + `supabase/schema.sql` 정책 4줄 제거(실행자) + `get_advisors` 재실행(“RLS 켜짐·정책 없음” INFO 는 의도된 내부 전용 패턴).

## 4. 2단계 — 나머지 대형 객체 (코드 2곳 + DB, 운영자 결정)
- 코드(실행자): `backend/routes/search.js:74` `getSupabaseReadonly()` → `getSupabaseAdmin()` · `backend/services/popularService.js:68` 기본값 `anonClient()` → `serviceClient()`(스냅샷 읽기 `readPopularSnapshot` 은 공개 키 유지). 두 파일의 `SNAPROLE`·키 체인 주석을 사실대로 갱신, 기존 테스트(`cron-observability`·`popular`·`popular-snapshot-shortfall`) 통과 확인.
- 배포 뒤 24시간 게이트웨이 로그에서 공개 키로 아래 4개를 부른 요청 0 확인 → DB:
```sql
drop policy if exists molit_tx_public_read on public.molit_transactions;
drop policy if exists apt_master_public_read on public.apt_master;
drop policy if exists apt_geocache_public_read on public.apt_geocache;
revoke all on public.molit_transactions, public.apt_master, public.apt_geocache, public.molit_apt_index from anon, authenticated;
revoke execute on function public.search_popular_apts(integer) from public, anon, authenticated;
```
- **절충**: 자동완성·지도·인기 라이브 폴백의 DB 쪽 상한이 **3초 → 8초**가 된다(최소 권한 대신 service_role). 코드 쪽 소프트 타임아웃(`_softQuery` 1~2.5초, `rpcTimeoutMs`)은 그대로라 사용자 응답 시간은 같고, 달라지는 건 "요청을 포기한 뒤에도 DB 가 최대 몇 초 더 일하나"다. 현재 트래픽(24시간 백엔드 요청 6.6만, 대부분 cron)에서는 영향이 작다고 판단하나, 결정은 운영자.
- 이득: 가장 큰 원본 거래 222MB·단지·좌표·검색 색인까지 닫혀 전송량 소진 경로가 사라진다.

## 5. 되돌리기 (운영 실측 정의 그대로)
1단계:
```sql
grant execute on function public.active_lawd_codes(date) to public;
grant execute on function public.geocache_backfill_candidates(integer, text) to anon, authenticated;
grant execute on function public.get_table_health() to public, anon, authenticated;
grant execute on function public.refresh_molit_apt_dim() to public, anon, authenticated;
grant execute on function public.upsert_hist_peaks_for_month(text) to public, anon, authenticated;
grant all on public.molit_transactions_hist, public.apt_amenities, public.apt_schools, public.building_register to anon, authenticated;
create policy hist_read on public.molit_transactions_hist for select to anon, authenticated using (true);
create policy apt_amenities_public_read on public.apt_amenities for select to anon, authenticated using (true);
create policy apt_schools_public_read on public.apt_schools for select to anon, authenticated using (true);
create policy br_read on public.building_register for select to public using (true);
```
2단계:
```sql
grant all on public.molit_transactions, public.apt_master, public.apt_geocache, public.molit_apt_index to anon, authenticated;
grant execute on function public.search_popular_apts(integer) to anon, authenticated;
create policy molit_tx_public_read on public.molit_transactions for select to public using (true);
create policy apt_master_public_read on public.apt_master for select to anon, authenticated using (true);
create policy apt_geocache_public_read on public.apt_geocache for select to public using (true);
```

## 6. 하지 않는 것
- 작은 공개 테이블 3개(스냅샷·규제·요금제)는 닫지 않는다. 사용자 소유 행 테이블(북마크 등, `auth.uid()` 정책)은 건드리지 않는다.
- Supabase 의 새 테이블 기본 권한(default privileges) 변경은 이번 범위 밖(새 테이블은 CLAUDE.md 의 "RLS on" 규칙으로 막는다).
- 적용은 한 번에 한 단계, 각 단계 뒤 24시간 관찰.
