# 내집로그 인계 문서

작성: 2026-11-14 KST (정기 점검 끝). 새 세션은 이 파일을 먼저 읽고, 규칙은 `CLAUDE.md`, 날짜별 기록은 `docs/ops/` 를 본다.
이 문서의 수치는 모두 2026-11-14 에 명령이나 조회로 잰 값이다. 재지 못한 것은 "미확인"으로 적었다.

## 1. 작업 위치와 배포 방법

- 작업 폴더: `C:\Users\Woo\Downloads\myhomelog_deploy_1\myhomelog\.claude\worktrees\p144` (브랜치 `ui-155`)
- 배포: 이 폴더에서 `git push origin HEAD:master`. KST 하루 3회 이하. 운영자가 배포를 가리킨 한 줄이 있어야 한다.
- 메인 폴더(`...\myhomelog`)는 master 이고 2026-11-14 에 origin/master(b1cc128)로 맞췄다. 미커밋 1건은 `.claude/launch.json`(미리보기 설정 추가, 운영자 것이라 그대로 둠).
- 운영 ID: Vercel projectId `prj_eYOJDb65wMQqbL5dAKo1pwaitiwW`(team gyeollab), Supabase `brxorvxdfrbxcavufspe`.
- 검증: 루트에서 `npm run verify`. 마지막 통과는 4374b53 기준 1155건. 그 뒤 커밋은 문서만 바꿨다.

## 2. 지금 상태

- 운영 배포본: b1cc128 (2026-11-14 세 번째 배포).
- 미배포: `ui-155` 가 origin/master 보다 앞서 있다. 코드 커밋은 4374b53 까지 14개, 그 위에 이 정기 점검의 문서 커밋이 있다. 내용은 /improve 계획 196~200, 백로그 정리, 죽은 AI 코드 삭제, OG 정적 이미지, CLAUDE.md 분할, 보안 점검 run-6 수정이다.
- 고유 브랜치: `privacy-1117`(c0fd32f, 폴더 `.claude/worktrees/privacy-1117`). 개인정보처리방침 시행본이다. 지우지 말 것.
- 복구 표식(로컬 태그): `backup/pre-cleanup-1114-ui155`(4374b53), `backup/pre-cleanup-1114-main`(b53c6e5).

## 3. 다음에 할 일 (순서대로)

1. 2026-11-15 KST: 운영자가 "배포는 내일 그대로 진행해"라고 지시했다(11-14). 그래도 새 세션에서는 배포 전에 운영자에게 한 줄로 다시 확인한다. 배포 뒤 확인할 것:
   - `/api/health` 의 deploy 값이 올린 커밋과 같은지
   - 런타임 오류, CI(공개 저장소라 GitHub API 로 조회)
   - `/api/analysis`, `/api/transactions` 응답의 `s-maxage=1800` 과 열화 응답의 no-store
   - 거래 0건 단지의 OG 이미지가 정적 이미지로 가는지
   - 하루 뒤 함수 CPU 사용량(Vercel 사용량 화면)
2. 2026-11-15 03시 KST 뒤: health 의 `crons.retention.fakePushPruned` 가 0 인지.
3. 2026-11-16 20:00 UTC: apt-master-sync 회차의 `fetched`, `errors`, `throttleHits`.
4. 2026-11-17 KST: `privacy-1117` 을 master 에 합쳐 배포(시행일 전 배포 금지).
5. 결제를 다시 열기 전에 정할 것 4건: 결제 행 CASCADE, 등급 전환 기간, 환불 뒤 기간, 환불 조건과 문구(`docs/ops/security.md` run-6 절).

## 4. 2026-11-14 정기 점검에서 한 일

- 에이전트 작업 트리 22개 폴더 제거. 지우기 전 모두 미커밋 0, `git cherry ui-155 <브랜치>` 0 을 확인했다. 브랜치는 남겼다. 디스크 남은 공간이 5,532,952KB 늘었다.
- 빈 폴더 `p142`, `p143` 제거(파일 0개 확인).
- 메인 폴더를 origin/master 로 맞춤(낡은 CLAUDE.md 가 읽히던 문제 해소).
- CLAUDE.md: 작업 종료 절차 3번과 Sprint 이름 규칙을 운영자 승인으로 고침(고치기 전 문장을 그 자리에 남김), 제목과 꼬리 날짜 정정, 이 문서 위치 추가.
- `plans/README.md` 맨 위에 "지금 열려 있는 것" 절 추가. 계획 파일은 옮기지 않았다.

## 5. 하지 않고 제안으로만 남긴 것

- `backend/services/legalService.js`(92줄)는 저장소 어디서도 부르지 않는다(`git grep legalService` 0건, plans 제외). 삭제는 코드 변경이라 하지 않았다.
- 누적 실행 시간 상위 조회 7개 중 6개가 apt_master 조회다(평균 1.2~1.8초, 각 3,500~6,500회, 통계 시작 2026-05-21). 출처는 `backend/services/healthCounts.js` 123~134줄의 건수 집계로 보이나 조회 전문을 뽑지 못해 추정이다.
- 죽은 행: apt_master 2,705/14,706, molit_hist_peaks 11,007/82,843. 수동 청소를 한다면 운영자가 SQL Editor 에서 적재 시간(UTC 17~19시)을 피해 `VACUUM (ANALYZE) public.apt_master;` 와 `VACUUM (ANALYZE) public.molit_hist_peaks;` 를 실행한다.
- 프런트 60초 상태 확인(`frontend/index.html` 15749줄 부근)이 숨은 탭에서도 도는지 미확인.
- `.local-notes`(48개, 약 18MB, 깃 추적 밖)는 복사본이 메인 폴더 하나뿐이다. 백업 여부 미확인.
- 안 쓰는 인덱스 8개는 합계 128KB 라 그대로 둔다.

## 6. DB 실측 (2026-11-14, 조회만)

- 클러스터 합계 433,279,153바이트(약 413MB, 한도 500MB 의 82.6%). 경보선은 85%.
- 큰 표: molit_transactions 약 194MB, molit_transactions_hist 약 91MB, apt_master 약 32MB.
- RLS 꺼진 public 표 0개. 연결 19개(최대 60).
- 실거래 원본 최소 날짜 2025-08-01.

## 7. 미확인으로 남은 것

- Vercel 환경 변수 목록(MCP 403, 이 PC 에 Vercel CLI 없음).
- 방화벽 Traffic 화면 수치(크롬에서 불러오기 멈춤).
- Supabase `datagokr-proxy` 의 Verify JWT 설정, Auth 가입 제한(운영자 화면에서만 확인 가능).
- Supabase 보안 점검 항목(이번에는 성능 항목만 조회).
- 함수 CPU 사용량(이번 점검에서 재지 않음).

## 8. 운영자 몫

Vercel 2단계 인증, GitHub 2단계 인증 확인, 저장소 공개 여부 결정, NCP 지도 과금 확인, DB 백업(주 1회, `plans/168-backup-runbook.md`).
