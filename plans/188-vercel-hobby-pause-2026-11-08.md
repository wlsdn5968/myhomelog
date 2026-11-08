# 188 Vercel Hobby 팀 정지 (2026-11-08)

## 사실 (사용량 화면과 공식 문서 원문, 2026-11-08 확인)
- 대시보드 안내: "Paused since Nov 8, 2026 for Fluid Active CPU. Your team exceeded the Hobby fair use limits. This pause ends on Dec 8, 2026." 버튼은 Pro 전환뿐.
- 운영 응답: 모든 주소가 402 DEPLOYMENT_DISABLED. 마지막 적재 11-06 17:45 UTC, 인기 스냅샷 11-06 18:56 UTC.
- 공식 문서(https://vercel.com/docs/plans/hobby): Active CPU "4 CPU-hrs". "if you exceed your usage limits on the Hobby plan, you will have to wait until 30 days have passed". Hobby 는 "non-commercial, personal use only".
- 팀 합계(10-09~11-08): Active CPU 8시간 50분. 프로젝트별: portai 3시간 14분, myhomelog 3시간 1분, salon 1시간 36분, wellness-platform 표시 없음, 나머지 0.
- myhomelog: 함수 호출 6.9만, 전송량 58.79GB(한도 100GB), CDN 요청 14.5만.
- 0d8f522 는 GitHub 에 올라갔지만 정지로 배포가 만들어지지 않았다.
- 경로별 CPU 는 알 수 없다(Hobby 관측 보관 1시간).

## 한 일
- 지도 영역 조회 5분 공유 캐시(결과 있을 때만), 요청 주소를 소수 셋째 자리로 바깥쪽 맞춤. 쿼리 없는 /share 공유 캐시.
- 107c-3 완료: 원본 448,193행(2025-08-01부터), 이력 1,385,165행(2025-07-31까지), 인덱스 8개 회수로 원본 232MB에서 193MB, DB 합계 446.7MB에서 407.5MB.

## 해제 요청 글 (운영자가 대시보드 Support, New Case 에서 직접 보낸다)
아래 내용은 사실만 적었다. 상업 이용 여부는 운영자가 확인해 고친다(Hobby 는 비상업 전용).

Subject: Request to review the Fluid Active CPU pause on team Gyeol Lab

Hello,
Our Hobby team "Gyeol Lab" was paused on Nov 8, 2026 for Fluid Active CPU (8h 50m against the 4 CPU-hrs guideline, Oct 9 to Nov 8). We were not aware we were close to the limit until the pause.
We have started reducing usage: we added CDN caching to our most frequent API route and are reviewing scheduled jobs. We would appreciate it if you could lift the pause early or tell us what usage level you would like us to stay under. If lifting is not possible, could you confirm whether projects can be unpaused one at a time once usage is reduced?
Thank you.

## 남은 일
1. 팀 합계를 4시간 아래로: portai(3시간 14분)와 salon(1시간 36분)은 이 저장소 밖이라 각 프로젝트에서 줄이거나 옮겨야 한다. myhomelog 를 0으로 해도 portai 와 salon 만으로 4시간 50분이다.
2. myhomelog 추가 후보(효과 미측정): 동결된 과거 이력 작업 2회(할 일 0: 이름 복구 대기열 2,748건 모두 완료, 이름 없는 단지 0), 단지 페이지와 공유 이미지의 봇 호출, health 호출.
3. 다른 무료 호스팅 후보(공식 문서 기준): 정적 화면은 Cloudflare Pages, Express 는 Render 무료(15분 유휴 시 잠듦, 월 750시간), 예약 작업은 GitHub Actions(최소 5분 간격, 지연 가능). 이전은 운영자 결정 뒤.
