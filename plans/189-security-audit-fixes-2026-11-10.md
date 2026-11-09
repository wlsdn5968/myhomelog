# 189 보안 점검 run-1 후속 수정 (2026-11-10)

점검 결과: C:/Users/Woo/security-audit-skill/myhomelog/run-1 (cloudflare/security-audit-skill, quick, 커밋 cdddf7f). confirmed 0, needs_validation 8.
이번에 고친 것은 우선순위 1~4번이다.

## 고친 것
| 지문 | 수정 | 확인 |
|---|---|---|
| billing/refund-status-check-constraint-mismatch-keeps-entitlement | 운영 DB 두 CHECK 제약에 refunded 추가(migrations/20261110_billing_refunded_status.sql, 운영 적용 완료). 환불과 웹훅 정합의 user_billing 갱신 오류를 로그와 Sentry 로 드러내고 환불은 500 refund_billing_failed | 운영 pg_constraint 재조회로 refunded 포함, convalidated true. 적용 전 payments 0행, user_billing 0행 |
| billing/cancel-overwrites-refunded-restores-entitlement | /billing/cancel 은 status=active 만 canceled, 없으면 409 no_active_subscription. billing.html 은 서버 오류 문구 표시 | 회귀 검사 |
| billing/confirm-cas-loser-repair-double-extension | CAS 패자는 payments 를 다시 읽어 실제 approved_at 으로 보정, captured 가 아니면 409. 보정 함수는 승인 30초 안이면 이긴 쪽 기록을 최대 5초(BILLING_REPAIR_WAIT_MS) 기다린 뒤 없을 때만 보정 | 회귀 검사. user_billing 에 updated_at 갱신 트리거가 있음을 운영에서 확인 |
| frontend/index.html:onclick-single-quote-escHtml-openRegionSummary-sigungu | 지역 요약 버튼 인자를 _jsonAttr 로 | 화면 함수를 그대로 꺼내 따옴표 든 이름으로 실행한 회귀 검사 |

## 반증 검토에서 나와 함께 고친 것
- confirm 의 Toss 시간 초과가 failed 로 기록된 뒤 실제로는 승인된 경우, 재시도 승인 성공을 CAS(requested 만)가 놓쳐 이용권이 비었다. confirm 과 웹훅 DONE 의 CAS 를 requested 또는 failed 로 넓혔다.
- 금액 불일치와 Toss 실패 분기는 requested 인 주문만 failed 로 바꾼다(captured 를 덮지 않음).

## 남은 것
1. 환불 뒤 user_billing 회수가 실패하면 다음 환불 재시도는 already refunded 로 끝나 자동 복구가 없다. 로그와 Sentry 로 수동 정합한다. 재구독 뒤 옛 환불 재시도가 새 구독을 내리는 위험 때문에 자동 회수는 넣지 않았다.
2. 웹훅 CANCELED 정합 실패는 로그만 남기고 200 이라 Toss 재전송이 없다.
3. 이긴 쪽 기록이 5초 넘게 늦으면 30일 중복이 남을 수 있다(정상 처리는 1초 안).
4. 점검 5~8번(Kakao 상한 2건, AI 전역 예산, 익명 표 총량)과 보류 4단위(채팅, 공개 읽기 API, 예약 작업 본문, CI)는 다음 작업.
