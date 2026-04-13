#!/bin/bash
# ============================================================
#  내집로그(MyHomeLog) 자동 배포 스크립트
#  실행: chmod +x deploy.sh && ./deploy.sh
# ============================================================
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'
log(){ echo -e "${GREEN}[✓]${NC} $1"; }
warn(){ echo -e "${YELLOW}[!]${NC} $1"; }
err(){ echo -e "${RED}[✗]${NC} $1"; exit 1; }
info(){ echo -e "${BLUE}[→]${NC} $1"; }

echo ""
echo -e "${BOLD}╔══════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   내집로그(MyHomeLog) 자동 배포      ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════╝${NC}"
echo ""

# ── 0. 사전 확인 ──────────────────────────────────────────
command -v node &>/dev/null || err "Node.js가 없습니다. https://nodejs.org 에서 설치하세요."
command -v npm  &>/dev/null || err "npm이 없습니다."
log "Node.js $(node --version), npm $(npm --version)"

# ── 1. API 키 입력 ─────────────────────────────────────────
echo ""
echo -e "${BOLD}─── API 키 입력 ───────────────────────────${NC}"
warn "키는 이 스크립트 실행 중에만 사용되며 로컬에 저장됩니다."
echo ""

read -p "Anthropic API Key (sk-ant-...): " ANTHROPIC_KEY
[[ -z "$ANTHROPIC_KEY" ]] && err "Anthropic API 키는 필수입니다."

read -p "국토부 실거래가 API Key (data.go.kr, 없으면 Enter): " MOLIT_KEY
MOLIT_KEY=${MOLIT_KEY:-"your_molit_api_key"}

read -p "카카오 REST API Key (없으면 Enter): " KAKAO_KEY
KAKAO_KEY=${KAKAO_KEY:-"your_kakao_rest_key"}

# ── 2. 백엔드 .env 생성 ───────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"

cat > "$BACKEND_DIR/.env" << EOF
PORT=3001
NODE_ENV=production
ANTHROPIC_API_KEY=$ANTHROPIC_KEY
MOLIT_API_KEY=$MOLIT_KEY
KAKAO_REST_API_KEY=$KAKAO_KEY
ALLOWED_ORIGINS=http://localhost:3000,https://myhomelog.vercel.app
CACHE_TTL_SECONDS=3600
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=60
EOF
log ".env 파일 생성 완료"

# ── 3. 백엔드 의존성 설치 ─────────────────────────────────
echo ""
info "백엔드 패키지 설치 중..."
cd "$BACKEND_DIR"
npm install --silent 2>&1 | grep -E "added|error" || true
log "백엔드 패키지 설치 완료"

# ── 4. Railway CLI 설치 확인 ──────────────────────────────
echo ""
echo -e "${BOLD}─── 백엔드 배포 (Railway) ─────────────────${NC}"

if ! command -v railway &>/dev/null; then
  warn "Railway CLI가 없습니다. 설치합니다..."
  npm install -g @railway/cli 2>&1 | tail -2
fi

if ! command -v railway &>/dev/null; then
  warn "Railway CLI 설치 실패. 수동 배포 방법으로 안내합니다."
  MANUAL_RAILWAY=true
fi

if [[ "$MANUAL_RAILWAY" != "true" ]]; then
  info "Railway 로그인..."
  railway login

  info "Railway 프로젝트 생성 및 배포..."
  cd "$BACKEND_DIR"

  # railway.json 생성
  cat > railway.json << 'RAILEOF'
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": { "builder": "NIXPACKS" },
  "deploy": {
    "startCommand": "node server.js",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
RAILEOF

  railway init --name myhomelog-backend 2>/dev/null || true

  # 환경변수 설정
  railway variables set \
    ANTHROPIC_API_KEY="$ANTHROPIC_KEY" \
    MOLIT_API_KEY="$MOLIT_KEY" \
    KAKAO_REST_API_KEY="$KAKAO_KEY" \
    NODE_ENV="production" \
    ALLOWED_ORIGINS="https://myhomelog.vercel.app" \
    PORT="3001"

  railway up --detach

  # Railway URL 가져오기
  sleep 5
  BACKEND_URL=$(railway status --json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('url',''))" 2>/dev/null || echo "")

  if [[ -n "$BACKEND_URL" ]]; then
    log "백엔드 배포 완료: https://$BACKEND_URL"
    FINAL_BACKEND_URL="https://$BACKEND_URL"
  else
    warn "Railway URL 자동 감지 실패. Railway 대시보드에서 URL을 확인하세요."
    read -p "Railway 백엔드 URL 입력 (예: https://myhomelog.railway.app): " FINAL_BACKEND_URL
  fi
else
  echo ""
  echo -e "${YELLOW}═══ Railway 수동 배포 방법 ════════════════════${NC}"
  echo "1. https://railway.app 접속 → GitHub 로그인"
  echo "2. New Project → Deploy from Local Directory"
  echo "3. 이 폴더의 backend/ 디렉토리 선택"
  echo "4. Variables 탭에서 아래 값 입력:"
  echo "   ANTHROPIC_API_KEY = $ANTHROPIC_KEY"
  echo "   MOLIT_API_KEY     = $MOLIT_KEY"
  echo "   KAKAO_REST_API_KEY= $KAKAO_KEY"
  echo "   NODE_ENV          = production"
  echo ""
  read -p "Railway에서 배포 후 URL 입력 (예: https://myhomelog.up.railway.app): " FINAL_BACKEND_URL
fi

# ── 5. 프론트엔드에 백엔드 URL 주입 ──────────────────────
echo ""
info "프론트엔드에 API URL 설정 중..."
FRONTEND_DIR="$SCRIPT_DIR/frontend"

# API URL을 Railway URL로 교체
sed -i.bak "s|http://localhost:3001/api|${FINAL_BACKEND_URL}/api|g" "$FRONTEND_DIR/index.html"

# ALLOWED_ORIGINS도 업데이트
sed -i "s|https://myhomelog.vercel.app|*|g" "$BACKEND_DIR/.env" 2>/dev/null || true
log "프론트엔드 API URL 설정 완료: ${FINAL_BACKEND_URL}/api"

# ── 6. Vercel 배포 ────────────────────────────────────────
echo ""
echo -e "${BOLD}─── 프론트엔드 배포 (Vercel) ──────────────${NC}"

if ! command -v vercel &>/dev/null; then
  warn "Vercel CLI가 없습니다. 설치합니다..."
  npm install -g vercel 2>&1 | tail -2
fi

if command -v vercel &>/dev/null; then
  cd "$SCRIPT_DIR"

  # vercel.json 업데이트
  cat > vercel.json << VERCELEOF
{
  "version": 2,
  "name": "myhomelog",
  "builds": [{ "src": "frontend/index.html", "use": "@vercel/static" }],
  "routes": [{ "src": "/(.*)", "dest": "/frontend/index.html" }],
  "headers": [{
    "source": "/(.*)",
    "headers": [
      { "key": "X-Content-Type-Options", "value": "nosniff" },
      { "key": "X-Frame-Options", "value": "DENY" },
      { "key": "Cache-Control", "value": "public, max-age=3600" }
    ]
  }]
}
VERCELEOF

  info "Vercel 로그인 및 배포..."
  vercel login
  vercel --prod --yes

  FRONTEND_URL=$(vercel ls 2>/dev/null | grep myhomelog | head -1 | awk '{print $2}' || echo "myhomelog.vercel.app")
  log "프론트엔드 배포 완료"
else
  warn "Vercel CLI 설치 실패. 수동 배포 방법으로 안내합니다."
  echo ""
  echo -e "${YELLOW}═══ Vercel 수동 배포 방법 ════════════════════${NC}"
  echo "1. https://vercel.com 접속 → GitHub 로그인"
  echo "2. Add New Project → import your GitHub repo"
  echo "   (또는) drag & drop 방식으로 frontend/ 폴더 업로드"
  echo "3. Framework: Other (Static)"
  echo "4. Root Directory: . (루트)"
  echo "5. Deploy 클릭"
  echo ""
  FRONTEND_URL="myhomelog.vercel.app (배포 후 확인)"
fi

# ── 7. CORS 업데이트 ──────────────────────────────────────
if [[ "$MANUAL_RAILWAY" != "true" ]] && command -v railway &>/dev/null; then
  REAL_FRONTEND="https://$FRONTEND_URL"
  railway variables set ALLOWED_ORIGINS="$REAL_FRONTEND,http://localhost:3000" 2>/dev/null || true
  log "CORS 업데이트 완료"
fi

# ── 8. 결과 요약 ──────────────────────────────────────────
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║              배포 완료 🎉                    ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${GREEN}프론트엔드:${NC} https://$FRONTEND_URL"
echo -e "  ${GREEN}백엔드 API:${NC} $FINAL_BACKEND_URL"
echo ""
echo -e "  ${BLUE}접속 후 ⚙ API 설정${NC}에서 네이버 지도 키, 카카오 키 입력 가능"
echo ""
echo -e "${YELLOW}  ※ 국토부/카카오 API 키 발급:${NC}"
echo "    - 국토부: data.go.kr → '아파트매매 실거래가 상세자료' 검색"
echo "    - 카카오: developers.kakao.com → 내 애플리케이션 → REST API 키"
echo "    - 네이버 지도: console.ncloud.com → Maps"
echo ""

# backup 파일 정리
rm -f "$FRONTEND_DIR/index.html.bak" 2>/dev/null || true
