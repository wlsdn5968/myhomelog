# 172 적재 뒤 해제된 거래 정리 — 2026-10-30

## 발견 (코드 원문)
- `backend/jobs/molitIngest.js` 는 매일 최근 3개월(이번 달 포함, `recentYearMonths(3)`)을 국토부에서 다시 받아 `molit_transactions` 에 upsert(onConflict dedup_key)한다.
- 해제 거래(`cdealType` 있음, `utils/molitParse.isCanceled`)는 가져올 때 걸러 넣지 않을 뿐, **이미 넣은 거래가 나중에 해제돼도 지우는 코드가 없었다**. 화면은 '해제 거래 제외'라고 적는다.
- 상계주공7 26.01.29 3.60억이 이 경우인지는 확인하지 못했다(DB 에 해제·거래유형 칸 없음, 이 PC 에 국토부 키 없음, 연결된 시세 도구는 한 달 10건만 돌려줌).

## 변경
- `fetchRegionMonth` 가 해제 행을 같은 모양으로 배열의 열거되지 않는 속성 `canceled` 로 함께 돌려준다(다른 호출처의 반복·길이 불변).
- `ingestOne` → `_removeCanceled`: apt_seq 가 있고, 같은 응답에 같은 키(단지·면적·계약일·층)의 유효 거래가 없을 때, 단지·면적·계약일·층·금액이 모두 같은 원본 행만 지운다. 실패는 경고만(적재 결과 불변).
- 호출 수: (지역, 월)마다 후보 조회 1회(apt_seq 100개씩 · 계약일 범위) + 지울 행이 있을 때만 id 삭제 1회. 이미 지운 건은 후보가 0 이라 삭제를 부르지 않는다.
- 응답이 페이지 상한(10쪽)에서 잘렸으면 해제 정리를 하지 않는다(같은 키의 유효 거래를 못 받았을 수 있다).
- 적재 키 식은 `_rowKey` 한 곳(전에는 ingestOne 안에 같은 식이 따로 있었다).
- 교차 검토(2026-10-30, 별도 에이전트): 정상 거래를 지우는 입력 없음 · dedup_key(20260425000005) 구성 일치 · 다른 호출처(aptDimNameRecovery·molitHistBackfill) 동작 불변 확인. 지적 중 호출 수·페이지 상한·키 중복 3건 반영. 갭 재적재 경로의 지운 수가 합계에 안 잡히는 점은 동작 영향이 없어 남겼다.
- 지운 수 `canceledRemoved` → cron 요약 최상위 키 + `cronStats` NUM 등록(Plan 110 규칙) → `/api/health` `crons['molit-ingest'].canceledRemoved`.

## 범위와 한계
- 다시 받는 3개월 안에서만 정리된다. 계약한 달부터 3개월이 지난 뒤의 해제, 이미 그 범위를 벗어난 과거 행, 이력 테이블(`molit_transactions_hist`)은 그대로다.
- 차트 출처 문구를 이 범위대로 고쳤다(Plan 171).

## 테스트
- `backend/test/molit-cancel-sync.test.js`(3): 해제 행 분리·열거 안 됨, 되살아난 거래·단지 번호 없는 행 건너뜀, 필터 5개, health 배선.

## 배포 뒤 확인
- 다음 적재(17:00 UTC 경) 뒤 health `canceledRemoved` 값이 숫자로 보이는지(필드 부재 = 미실행·실패). 런타임 로그 '적재 뒤 해제된 거래 정리'.
