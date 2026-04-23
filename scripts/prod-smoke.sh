#!/usr/bin/env bash
# 프로덕션 스모크 테스트 — Vercel 배포가 함수 부팅에 실패하면 즉시 알람.
#
# master 머지 직후 CI 에서 실행. Vercel 프리뷰 배포는 시간 변동성이 커서
# 프로덕션(myhomelog.vercel.app) 에 대해 최대 5분간 10초 간격으로 /api/health
# 를 폴링. 한 번이라도 200 + status=ok 면 성공, 타임아웃·5xx 지속 시 실패.
#
# 2026-04-23 사고 (@supabase/supabase-js 누락으로 /api/* 전체 500) 같은
# FUNCTION_INVOCATION_FAILED 를 자동 감지하는 게 목적.
set -euo pipefail

HOST="${SMOKE_HOST:-https://myhomelog.vercel.app}"
DEADLINE=$((SECONDS + 300))  # 5분

echo "[smoke] host=$HOST deadline=${DEADLINE}s"

while [ "$SECONDS" -lt "$DEADLINE" ]; do
  code=$(curl -sS -o /tmp/smoke.json -w "%{http_code}" --max-time 8 "$HOST/api/health" || echo 000)
  if [ "$code" = "200" ] && grep -q '"status":"ok"' /tmp/smoke.json; then
    echo "[smoke] PASS — /api/health 200 + status=ok"
    cat /tmp/smoke.json
    exit 0
  fi
  echo "[smoke] still=$code, retrying in 10s..."
  sleep 10
done

echo "[smoke] FAIL — /api/health 가 5분 내에 200 응답하지 않음 (마지막 status=$code)"
cat /tmp/smoke.json || true
exit 1
