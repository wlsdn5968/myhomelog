# scripts/backup-db.ps1 — Supabase 무료 요금제는 자동 백업이 없다(plans/167 §3). 운영자 PC 에서 주 1회 실행.
#
# 사용법(PowerShell, 저장소 루트에서):
#   $env:SUPABASE_DB_URL = "<Supabase 대시보드 Connect > Session pooler 연결 문자열, 비밀번호는 퍼센트 인코딩>"
#   .\scripts\backup-db.ps1              # 스키마 + 작은 테이블 데이터 (기본)
#   .\scripts\backup-db.ps1 -WithHist    # + 이력 거래(molit_transactions_hist, 136만 행) 월 1회
#
# 원칙: 원본 거래(molit_transactions)는 국토교통부에서 다시 받을 수 있어 기본 제외. 결과는 .local-backups/ (gitignore).
# 도구: Supabase CLI 를 설치하지 않고 npx 로 실행한다(공식 `supabase db dump`; 테이블 "포함" 플래그는 없고 -x 제외만 있다 — 2026-10-19 공식 문서 확인).
param([switch]$WithHist)

$ErrorActionPreference = 'Stop'
if (-not $env:SUPABASE_DB_URL) { Write-Host '환경변수 SUPABASE_DB_URL 이 비어 있어요. Supabase 대시보드 > Connect > Session pooler 의 연결 문자열을 넣어 주세요.'; exit 1 }

$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $root '.local-backups'
New-Item -ItemType Directory -Force $dir | Out-Null
$day = Get-Date -Format 'yyyyMMdd'

# 1) 스키마(테이블·함수·정책·인덱스) — 작다
$schemaFile = Join-Path $dir "schema_$day.sql"
Write-Host "① 스키마 → $schemaFile"
npx --yes supabase@latest db dump --db-url $env:SUPABASE_DB_URL -f $schemaFile
if ($LASTEXITCODE -ne 0) { Write-Host '스키마 덤프 실패'; exit $LASTEXITCODE }

# 2) 데이터 — 큰 테이블 제외(원본 거래·이력·감사 로그·적재 기록). 나머지(단지 목록·별칭·관심 단지·규제 스냅샷 등)만.
$exclude = @('public.molit_transactions', 'public.audit_log', 'public.molit_ingest_runs', 'public.molit_hist_runs')
if (-not $WithHist) { $exclude += 'public.molit_transactions_hist' }
$dataFile = Join-Path $dir ("data_{0}{1}.sql" -f $day, $(if ($WithHist) { '_with_hist' } else { '' }))
Write-Host "② 데이터(제외: $($exclude -join ', ')) → $dataFile"
npx --yes supabase@latest db dump --db-url $env:SUPABASE_DB_URL --data-only --use-copy -s public -x ($exclude -join ',') -f $dataFile
if ($LASTEXITCODE -ne 0) { Write-Host '데이터 덤프 실패'; exit $LASTEXITCODE }

# 3) 압축 + 90일 지난 백업 정리
foreach ($f in @($schemaFile, $dataFile)) {
  Compress-Archive -Path $f -DestinationPath "$f.zip" -Force
  Remove-Item $f
}
Get-ChildItem $dir -Filter '*.zip' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-90) } | Remove-Item
Write-Host "완료: $(Get-ChildItem $dir -Filter "*_$day*.zip" | ForEach-Object { "$($_.Name) ($([math]::Round($_.Length/1MB,1))MB)" })"
