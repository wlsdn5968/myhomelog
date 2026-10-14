# 139·140·141 — 구성요소 점검(2026-10-14) 후속: Redis 명령 절감 · cron 정리·지역 페이지 병렬화 · 패치 갱신

**작성 기준 커밋**: `ffad5d2` 후보 → `293cec3` 위에 적용(그 사이 master 변경은 문서 2개뿐, 패치와 파일 겹침 0) · **근거**: `plans/audit-components-2026-10-14.md`
**후보 작성**: 하위 에이전트(sonnet)가 저장소 밖 복제본에서 작성·`npm run verify` 통과 → 계획자가 diff 전문 검토·수정 요청 반영.

## 139 — Redis 명령 절감 (패치 `p139b/…Plan-.patch`, sha256 `2c7f70bc…`)
- 사실: Upstash 무료 한도(월 500,000) 초과로 2026-10-05 16:49Z 경부터 쓰기 실패(health 반복 호출 실측). health 1회 = Redis 8명령(공용 제한 1 + 사용량 2 + cron 기록 1 + 일 카운터 4).
- 변경: `/api/health`(메모리 제한 IP당 분당 60)·`/api/cron/*`(라우터 전체가 `authorizeCron` — `routes/cron.js:81`) 을 `generalLimiter` 앞에 마운트 · health 의 사용자별이 아닌 값(cron 기록·일 카운터 4)을 인스턴스 메모리 5분 캐시(`services/healthObserveCache.js`, 실패·null 은 캐시 안 함, 날짜 바뀌면 다시 읽음, 관리자 전용 챗 원문은 캐시 안 함) · 챗 관측 `expire` 는 그날 첫 증가 때만.
- 효과(코드 기준): 비로그인 health 8 → 평균 약 2. cron 요청마다 -1. 챗 메시지마다 -1.
- 유지: 유료 경로 fail-closed·일일 한도·무료 챗 리미터.
- 테스트: 신규 6(원래 코드에서 3건 실패), verify 627.
- 주의: health 의 `crons` 표시가 최대 5분 늦을 수 있음(프런트 `h.crons` 사용). `chatIntents`·`searchDegrade` 는 프런트 사용 0.

## 140 — cron 정리·지역 페이지 병렬화 (패치 `p140/…Plan-140.patch`, sha256 `6e26a78c…`)
- 이력 backfill 슬롯 10 → 2(19:20·21:20 UTC). 완료(reason complete)·이어지는 이름 복구도 remaining 0. slot 값은 잡이 쓰지 않음(실행 창일 뿐). stale 기준 9h → 50h(정상 최대 공백 약 23h, 1회 누락 약 25h — 다른 일간 잡과 동일 기준). 기존 계약 테스트(슬롯 ≥2·2h 간격·17~18시 회피) 통과.
- `/region/:code`: 대시보드·경신·주간 공개 건수(서로 독립, 입력은 region 하나)를 `Promise.all`, 그 결과와 주요 단지 목록도 `Promise.all`. 각 단계 try/catch·null 대체 그대로.
- `scripts/generate-sgg-upsert.js` 삭제(참조 0, 파일 스스로 "One-time script").
- 테스트: 신규 3(원래 코드에서 병렬 확인 1건 실패), verify 624. 배포 전 콜드 기준값: /region/11680 8.42s · /region/26350 1.20s.

## 141 — 패치 갱신 (패치 `p141b/…`, express 는 보류)
- dotenv 18.0.6 → 18.0.7(패치) · satori 0.44.0 → 0.44.3(같은 줄 패치 — OG 3종 PNG 바이트 동일) · index.html supabase-js CDN 2.117.2 → 2.117.3(npm tarball sha512 검증 → CDN 바이트 동일 → sha384 `BWcjm9Od…t60R`, CORS `*`).
- **express 5.3.0 보류**: 게시 5일째(2026-10-09) · 하위 content-type·content-disposition 이 메이저로 따라 오름 · 현재 설치판 운영 감사 0건 → 2주 관찰 뒤 재검토(10-29 예약 점검에 포함).
- billing.html 의 supabase-js 2.117.2·Sentry 10.69.0 은 결제 페이지라 보류(발견 사항).
