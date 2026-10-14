# 142 — 신고가 경신 계산 결과를 DB 스냅샷에도 저장·우선 조회 (Redis 장애 시 콜드 4~5초 재계산 제거)

**작성 기준 커밋**: `307a60b` (2026-10-14) · **근거**: 140 배포 뒤에도 `/region/11680` 콜드 7.5s(전 8.4s) — 병렬화로 안 풀림
**후보 작성**: 하위 에이전트(sonnet) 복제본 작성, 계획자 diff 전문 검토.

## 1. 사실 (계획자 실측 2026-10-14)
- `get_price_records_by_region(30,3,3)` 직접 실행: **첫 호출 4,571ms · 두 번째 408ms**(121개 지역 블롭) — DB 버퍼가 식은 상태의 비용.
- 결과는 원본이 매일 1회 바뀌는 같은 값인데, 저장소가 Redis(공유)와 인스턴스 메모리뿐이라 Redis 쓰기 실패(2026-10-05~) 동안 콜드 인스턴스마다 다시 계산했다(소비: `/region/:code`·`/api/transactions/records`·OG 지역 카드).
- 테이블 `public.computed_snapshots(key pk, payload jsonb, computed_at)` 는 계획자가 `apply_migration 20261014_computed_snapshots` 로 생성(성공) — RLS on·정책 0·anon SELECT false·service INSERT true 실측.

## 2. 변경 (패치 `scratchpad/p142/0001-perf-DB-Redis-4-5-Plan-142.patch`, sha256 `4214332e…`)
- 신규 `backend/services/snapshotStore.js`: `getSnapshot(key, maxAgeMs)`·`getLastSnapshot(key)`·`putSnapshot(key, payload)` — 절대 throw 하지 않음.
- `priceRecordsService.js` 두 함수: 메모리 → Redis → **DB 스냅샷(30h 이내)** → RPC. 계산 성공 시 기존 Redis 저장 + `putSnapshot`. 실패·백오프·admin 없음의 "마지막 성공(stale)" 경로에서 Redis LAST 가 없으면 DB 마지막 값. 키는 기존 Redis 키(`records:price:v2`·`records:priceByRegion:v2`)와 같다. 응답 모양 불변.
- 기록 파일 `supabase/migrations/20261014_computed_snapshots.sql`(적용 기록).
- 테스트 신규 8(원래 코드에서 7 실패), verify 638.

## 3. 배포 뒤 확인
- 스냅샷 행이 생기는지(첫 계산 또는 retention cron 18:00Z), `/region/<code>?cb=` 콜드 응답 시간(전 7.5s 기준), `/api/transactions/records` 정상.
