# 168 — DB 백업 절차(운영자 PC, 주 1회) · 읽기 전용 모드 복구 런북 (2026-10-19)

출처: plans/167 §3 — Supabase 무료 요금제는 **자동 백업이 없다**. 500MB 초과 시 읽기 전용. 이 둘은 지금까지 절차가 없었다.

## 1. 백업 — 무엇을, 왜
| 데이터 | 다시 만들 수 있나 | 백업 |
|---|---|---|
| 스키마(테이블·함수·RLS 정책·인덱스) | `supabase/schema.sql` 이 있지만 운영과 드리프트 가능 | **매주** |
| apt_master(단지 목록·별칭 10,660행)·apt_geocache·apt_schools·apt_amenities·규제·인기 스냅샷·bookmarks·알림 구독 | 외부 API 재수집에 며칠, 사용자 데이터는 불가 | **매주** |
| molit_transactions(원본, 45만 행) | 국토교통부 API 재적재 가능(적재기 그대로) | 기본 제외 |
| molit_transactions_hist(이력 136만 행) | 2020-09 이후 재적재에 수 주 | **월 1회** `-WithHist` |
| audit_log·molit_ingest_runs | 운영 기록 | 제외 |

## 2. 절차(운영자 PC — 계획자는 비밀 키가 없어 실행 불가)
> **2026-10-21 정정**: 처음 적었던 `npx supabase db dump` 방식은 공식 문서상 Docker 안에서 pg_dump 를 돌리는데, 운영자 PC 에는 Docker·psql 이 없다(실측). 그래서 이미 깔린 Node 로 표 데이터를 내보내는 `scripts/backup-db.js` 로 바꿨다(옛 `backup-db.ps1` 삭제). 표 구조는 저장소 `supabase/schema.sql`·`migrations/` 가 원본.

1. Supabase 대시보드 → 프로젝트 `brxorvxdfrbxcavufspe` → 왼쪽 아래 톱니(**Project Settings**) → **API Keys** → *Secret keys* 의 키 옆 복사 버튼(없으면 "Legacy API Keys" 탭의 `service_role` → Reveal → 복사). **채팅·파일에 붙여 넣지 않는다.**
2. PowerShell 을 저장소 루트(`C:\Users\Woo\Downloads\myhomelog_deploy_1\myhomelog`)에서 열고:
   ```powershell
   $env:SUPABASE_URL = "https://brxorvxdfrbxcavufspe.supabase.co"
   $env:SUPABASE_SECRET_KEY = "(1번에서 복사한 키)"
   node scripts/backup-db.js
   ```
   월 첫 주에는 `node scripts/backup-db.js --with-hist`(이력 136만 행 추가, 수 분~10여 분).
3. 결과: `.local-backups/YYYYMMDD/표이름.ndjson.gz` 31개 + `manifest.json`(gitignore). 마지막 줄이 **"완료 — 모든 표 행 수 일치"** 면 성공, ✖ 가 있으면 그 줄을 계획자에게 전달. 90일 지난 폴더는 스크립트가 지운다.
4. 그 폴더를 다른 장치에 1부(USB·OneDrive 개인 폴더 등 무료 범위). 키는 PowerShell 창을 닫으면 사라진다.
- 제외: `molit_transactions`(원본 45만 행 — 국토부 API 로 다시 받을 수 있음).
- 적재 창(17:00~19:00 UTC = 02:00~04:00 KST)·apt-master-sync(월 20:00 UTC = 화 05:00 KST)와 겹치지 않게(권장 주말 낮 KST).

## 3. 복구(읽기 전용 모드 — 500MB 초과 시)
증상: 쓰기가 전부 실패(적재·북마크 저장·감사 로그), 읽기는 됨. health `db.pct` ≥ 100.
1. **멈추기**: Vercel 크론은 쓰기가 실패해도 다음 회차에 재시도만 한다 — 별도 중단 불필요. 사용자에겐 데이터 상태 띠에 "지연" 표시.
2. **비우기(운영자 SQL Editor, 한 문장씩, 전후 합계 측정)**: `plans/104` 순서 — ① `molit_ingest_runs` ok 행 정리(최신 1건/지역·월 보존) ② 원본 창 자르기 1개월(`plans/107c-2` 절차, d 단계 건수 대조 필수) ③ `REINDEX INDEX CONCURRENTLY`(3개월 이상 옮긴 뒤). 측정: `select sum(pg_database_size(datname)) from pg_database`.
3. **확인**: health `db.pct` 가 93% 아래로, 적재 cron 다음 회차 `ok` 회복, Sentry `monitor:db-capacity` 경보 해제.
- 복원이 필요할 때(데이터 손상 등): 스키마는 `supabase/schema.sql`+`migrations/` 로, 데이터는 `.ndjson.gz` 를 표별로 upsert — 복원 스크립트는 필요해지면 그때 만든다(아직 없음). **운영자 승인 뒤, 빈 프로젝트에서 먼저 검증**.

## 4. 점검표(월요일 5분)
health 의 `db.usedMb/pct` · `crons.*.at` · Sentry 신규 · Vercel 배포 수(하루 20회 이하) · 최신 백업 파일 날짜(7일 이내).
