# 내집로그 인계 문서

작성: 2026-11-14 KST (정기 점검 끝). 2026-11-15 낮에 2절과 3절을 갱신했다. 새 세션은 이 파일을 먼저 읽고, 규칙은 `CLAUDE.md`, 날짜별 기록은 `docs/ops/` 를 본다.
이 문서의 수치는 모두 2026-11-14 에 명령이나 조회로 잰 값이다. 재지 못한 것은 "미확인"으로 적었다.

## 1. 작업 위치와 배포 방법

- 작업 폴더: `C:\Users\Woo\Downloads\myhomelog_deploy_1\myhomelog\.claude\worktrees\p144` (브랜치 `ui-155`)
- 배포: 이 폴더에서 `git push origin HEAD:master`. KST 하루 3회 이하. 운영자가 배포를 가리킨 한 줄이 있어야 한다.
- 메인 폴더(`...\myhomelog`)는 master 이고 2026-11-14 에 origin/master(b1cc128)로 맞췄다. 미커밋 1건은 `.claude/launch.json`(미리보기 설정 추가, 운영자 것이라 그대로 둠).
- 운영 ID: Vercel projectId `prj_eYOJDb65wMQqbL5dAKo1pwaitiwW`(team gyeollab), Supabase `brxorvxdfrbxcavufspe`.
- 검증: 루트에서 `npm run verify`. 마지막 통과는 4374b53 기준 1155건. 그 뒤 커밋은 문서만 바꿨다.

## 2. 지금 상태 (2026-11-15 낮 갱신)

- 운영 배포본: d2fd864 (2026-11-15 첫 번째 배포). 11-14 에는 f75338c 까지 네 번 배포했다(네 번째는 운영자가 알고 지시).
- d2fd864 에 들어간 것: 11-14 정기 점검분 15커밋, 제3자 방식 감사 수정(대출 계산 입력 범위, 현장 메모 검증, 추천과 예측으로 읽히는 문구, 평 표기에 전용 명시), 도우미의 시군구 조회 건너뛰기, 보고서 단계별 소요 기록, 단지 페이지 구조화 데이터, 첫 화면 지도 위치 고정.
- 미배포: `ui-155` 의 11-15 수정분(도우미 구 이름 질문을 지역 코드로 조회, 보고서 계측 한 칸 추가, 문서). 이 문서를 고친 커밋이 그 끝이다.
- 감사 기록: `AUDIT_REPORT.md` 1~15절. 남은 감사 항목과 근거가 거기 있다.
- 고유 브랜치: `privacy-1117`(c0fd32f, 폴더 `.claude/worktrees/privacy-1117`). 개인정보처리방침 시행본이다. 지우지 말 것.
- 복구 표식(로컬 태그): `backup/pre-cleanup-1114-ui155`(4374b53), `backup/pre-cleanup-1114-main`(b53c6e5).
- 검증: 미배포분 포함 `npm run verify` 1,169건 통과(11-15).

## 3. 다음에 할 일 (순서대로)

1. 미배포분 배포 뒤: 도우미에 구 이름으로 물어 응답 시간을 잰다("노원구 시세"가 11-15 배포본에서 5,943ms 였다). 보고서를 한 번 생성해 Vercel 기록의 `report-stages` 에서 `alias` 와 `group` 이 각각 얼마인지 본다(11-15 실측은 둘이 합쳐 2,805ms, 후보 조회 pool 5,150ms, 전체 11.6초).
2. 2026-11-16 20:00 UTC: apt-master-sync 회차의 `fetched`, `errors`, `throttleHits`.
3. 2026-11-17 KST: `privacy-1117` 을 master 에 합쳐 배포(시행일 전 배포 금지, 운영자가 그날 다시 지시).
4. 결제를 다시 열기 전에 정할 것 4건: 결제 행 CASCADE, 등급 전환 기간, 환불 뒤 기간, 환불 조건과 문구(`docs/ops/security.md` run-6 절).
5. 시안 승인이 먼저인 감사 항목: 단지 페이지 차트와 테마, 내 거래 계획, 화면 파일 분할.

끝난 확인(다시 하지 않아도 됨)
- health 의 `crons.retention.fakePushPruned` 는 11-15 03:56 KST 실행분에서 0 이었다.
- `/api/analysis`, `/api/transactions` 정상 응답은 Vercel 캐시 적중, 열화 응답은 no-store. 거래 0건 단지 OG 는 정적 이미지로 간다.
- 첫 화면 지도는 운영 네이버 지도에서 데스크톱과 모바일 폭 모두 서울 25개 구가 들어온다.

배포 규칙: 이 폴더에서 `git push origin HEAD:master`. KST 하루 3회 이하. 운영자가 배포를 가리킨 한 줄("배포해")이 있어야 자동 권한 검사를 통과한다. "권고대로 진행"으로는 막힌다(11-15 확인).

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
