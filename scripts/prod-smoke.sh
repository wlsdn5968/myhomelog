#!/usr/bin/env bash
# 프로덕션 스모크 테스트 — Vercel 배포가 함수 부팅에 실패하면 즉시 알람.
#
# master 머지 직후 CI 에서 실행. Vercel 프리뷰 배포는 시간 변동성이 커서
# 프로덕션(myhomelog.vercel.app) 에 대해 최대 5분간 10초 간격으로 /api/health
# 를 폴링. 한 번이라도 200 + status=ok 면 성공, 타임아웃·5xx 지속 시 실패.
#
# 2026-04-23 사고 (@supabase/supabase-js 누락으로 /api/* 전체 500) 같은
# FUNCTION_INVOCATION_FAILED 를 자동 감지하는 게 목적.
#
# Phase 2 후속 (2026-04-25): /api/health 부팅 확인 후 Phase 2 핵심 endpoint
# 4종 회귀 추가 (search/apt, search/popular, regulations, cron auth gate).
set -euo pipefail

HOST="${SMOKE_HOST:-https://myhomelog.vercel.app}"
DEADLINE=$((SECONDS + 300))  # 5분

echo "[smoke] host=$HOST deadline=${DEADLINE}s"

booted=0
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  code=$(curl -sS -o /tmp/smoke.json -w "%{http_code}" --max-time 8 "$HOST/api/health" || echo 000)
  if [ "$code" = "200" ] && grep -q '"status":"ok"' /tmp/smoke.json; then
    echo "[smoke] /api/health PASS"
    cat /tmp/smoke.json
    booted=1
    break
  fi
  echo "[smoke] /api/health still=$code, retrying in 10s..."
  sleep 10
done

if [ "$booted" != "1" ]; then
  echo "[smoke] FAIL — /api/health 가 5분 내에 200 응답하지 않음 (마지막 status=$code)"
  cat /tmp/smoke.json || true
  exit 1
fi

# Phase 2 후속: 핵심 endpoint 회귀 — 한 번씩만 (cold start 후 부팅 검증)
fail=0

echo "[smoke] /api/search/apt?q=래미안 회귀..."
sa_code=$(curl -sS -o /tmp/sa.json -w "%{http_code}" --max-time 12 "$HOST/api/search/apt?q=%EB%9E%98%EB%AF%B8%EC%95%88&limit=3" || echo 000)
if [ "$sa_code" = "200" ] && grep -q '"results"' /tmp/sa.json; then
  echo "[smoke] /api/search/apt PASS"
else
  echo "[smoke] /api/search/apt FAIL ($sa_code)"; cat /tmp/sa.json; fail=1
fi

echo "[smoke] /api/search/popular 회귀..."
sp_code=$(curl -sS -o /tmp/sp.json -w "%{http_code}" --max-time 30 "$HOST/api/search/popular?limit=5" || echo 000)
if [ "$sp_code" = "200" ] && grep -q '"results"' /tmp/sp.json; then
  echo "[smoke] /api/search/popular PASS"
else
  echo "[smoke] /api/search/popular FAIL ($sp_code)"; cat /tmp/sp.json; fail=1
fi

echo "[smoke] /api/regulations?key=ltv 회귀..."
rg_code=$(curl -sS -o /tmp/rg.json -w "%{http_code}" --max-time 8 "$HOST/api/regulations?key=ltv" || echo 000)
if [ "$rg_code" = "200" ]; then
  echo "[smoke] /api/regulations PASS"
else
  echo "[smoke] /api/regulations FAIL ($rg_code)"; cat /tmp/rg.json; fail=1
fi

# /api/cron/* 는 인증 필수 — Bearer 없이 호출 시 401/403 이어야 정상 (auth gate 정상 동작)
echo "[smoke] /api/cron/molit-ingest 인증 게이트 회귀 (401/403 기대)..."
cr_code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 -X POST "$HOST/api/cron/molit-ingest" || echo 000)
if [ "$cr_code" = "401" ] || [ "$cr_code" = "403" ]; then
  echo "[smoke] /api/cron auth gate PASS ($cr_code)"
else
  echo "[smoke] /api/cron auth gate FAIL — expected 401/403 got $cr_code (보안 회귀!)"; fail=1
fi

if [ "$fail" = "1" ]; then
  echo "[smoke] FAIL — 핵심 endpoint 회귀 실패"
  exit 1
fi
echo "[smoke] ALL PASS"
exit 0
