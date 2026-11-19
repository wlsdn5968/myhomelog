# 보관한 코드 (실행되지 않음)

2026-11-19 정기 점검에서 운영자 승인("권고대로 진행")으로 옮겼다. 저장소 안에서 부르는 곳이 0건이었다(`git grep` 로 확인). 지우지 않고 보관한다.

| 파일 | 원래 자리 | 옮긴 이유 |
|---|---|---|
| `legalService.js` | `backend/services/legalService.js` | 이슈 낱말과 법령 조문 정적 대응표. 2026-11-16 감사부터 "어디서도 부르지 않음"으로 기록돼 있었다 |
| `make-kakao-icon.js` | `scripts/make-kakao-icon.js` | 카카오 앱 아이콘 그림을 만드는 일회성 스크립트. 만든 그림 `frontend/kakao-app-icon-128.png` 은 카카오 개발자 콘솔에서 쓰는지 확인할 수 없어 제자리에 둔다 |

되살리려면 `git mv` 로 원래 자리에 옮긴다. `legalService.js` 는 다른 모듈을 불러오지 않는다. `make-kakao-icon.js` 는 `sharp` 를 불러오는데 `sharp` 는 의존성 목록에 없다(실행하려면 따로 설치해야 한다).

`backend/services/budgetService.js` 도 부르는 곳이 0건이지만 옮기지 않았다. `backend/.env.example` 주석이 이 파일 줄 번호를 가리키는데, 이 작업 규칙상 `.env` 로 시작하는 파일은 열거나 고치지 않기 때문이다.
