# Implementation Plans

- 001~007: improve 스킬 2026-08-09 생성 (기준 커밋 `b63da64`) — **전부 완료**
- 008~011: improve 스킬 2026-08-16 생성 (기준 커밋 `9031f65`)

각 실행자는 계획 파일을 끝까지 읽고 STOP 조건을 준수하며, 완료 시 자기 행의 Status 를 갱신하라.
⚠ 이 레포의 운영 절대 룰: **공유 production DB 직접 수정 금지**(운영자 명시 승인 후만)·
**push 는 운영자 승인 후**.

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 001 | 실거래 DB 조회 1000행 페이징 (고거래 월 최대 47% 누락 실측) | P1 | S | — | DONE (4983974, 2026-08-09) |
| 002 | 공개 geocode 라우트 일일 총량 캡 (Kakao 쿼터 고갈 증폭 차단) | P1 | M | — | DONE (0e0f982, 2026-08-09) |
| 003 | AI 비용 카운터·좌표 저장 await (서버리스 동결 유실 차단) | P1 | S | — | DONE (5e6190a, 2026-08-09) |
| 004 | 결제 이월·규제 판정 계약 테스트 (실사고 이력 경로 고정) | P1 | S~M | — | DONE (d50ed75, 2026-08-09) |
| 005 | README·.env.example·engines 실동작 정합 | P2 | S | — | DONE (b91fda1, 2026-08-09) |
| 006 | MOLIT 파싱 공통 헬퍼 (5곳 복붙 제거 + 숫자금액 TypeError 종결) | P1 | S~M | — | DONE (d72a35e, 2026-08-09) |
| 007 | Supabase 클라이언트 SSOT (24파일 자체 createClient 제거) | P1 | M | 006 먼저 커밋(파일 겹침) | DONE (acfd032, 2026-08-09) |
| **008** | **프론트 취득세 6억 경계 '이하' 정정 + 프론트↔백엔드 계약 테스트** | **P1** | S | — | DONE (02f4a26, 2026-08-16) |
| **009** | **`molit_transactions.deal_date` 인덱스 (2.2초 조회 제거)** | **P1** | S | — | DONE (DDL only, 2026-08-16) |
| **010** | **프론트 정적 결함 2건 (XSS 싱크 escape, 중복 키로 죽은 타임아웃)** | **P1** | S | — | DONE (fcad495, 2026-08-16) |
| **011** | **백엔드 일관성 3건 (미대기 저장·상한 없는 RPC·사실과 다른 주석)** | P2 | S | — | DONE (5b1b5bc, 2026-08-16) |
| **012** | **billing/confirm 금전 상태 전이 계약 테스트 (백로그 1번 착수)** | **P1** | M | — | DONE (2026-08-16) |

### 008~011 실행 결과 (2026-08-16, 운영자 승인 후 실행)

- **008**: 프론트 `_pickTierRate` `<` → `<=`. 계약 테스트 추가(41→42). **회귀 주입 검증**:
  연산자를 되돌리면 fail 1 → 원복 후 42 pass.
- **009**: `CREATE INDEX CONCURRENTLY idx_molit_deal_date (deal_date DESC)`.
  **2,236ms → 0.119ms**(`Sort` 노드 소멸, `Heap Fetches: 0`, `indisvalid: true`). 코드 변경 0.
- **010**: `_escHtml(d.apt||'')` 적용 + 중복 `signal` 키 제거(90s 유지). 가드 13→14패턴.
  **가드 회귀 주입 검증**: escape 되돌리면 `frontend/index.html:8267` 지목하며 exit 1.
- **011**: `await storePopularSnapshot`, `MV_REFRESH_ABORT_MS=60000`(실측 11,451ms 근거),
  degraded 주석 정정.

⚠ **실행 방식 메모**: `execute` 의 worktree 격리를 쓰지 못했다 — 이 저장소는 상위 디렉터리가
git repo 가 아니라(`myhomelog_deploy_1/myhomelog` 가 repo) worktree 생성이 실패한다.
격리 없는 실행자를 붙이는 대신 계획서의 단계·검증을 그대로 따라 직접 실행했다.

⚠ **계획서 criteria 결함 1건(011)**: `grep -c "fire-and-forget" backend/routes/search.js → 0`
을 파일 전체 대상으로 썼는데, 9행의 **다른 라우트**(`/search/history`) 헤더 설명에도 같은 표현이
있어 문자 그대로는 만족 불가였다. 범위 밖 코드를 건드리지 않았다.
(참고: 그 헤더 설명은 **부정확**하다 — `/search/history` 는 실제로 `await` insert 후 결과를
응답한다. 별건이라 이번에 고치지 않았다.)

Status values: TODO | IN PROGRESS | DONE | BLOCKED (한 줄 사유) | REJECTED (한 줄 근거)

## Dependency notes

- **008~011 은 상호 의존이 없다 — 병렬 실행 가능.** 단 008 과 010 은 둘 다 `frontend/index.html`
  을 수정하므로 **동시에 돌리지 마라**(같은 파일 충돌). 순차로 하되 순서는 무관하다.
- 009 는 코드 변경이 0 이고 DB 만 바꾸므로 다른 계획과 완전히 독립이다. 단 **운영자 승인 없이는
  Step 2 를 실행할 수 없다**(계획 안의 "실행 게이트" 참조).
- 검증 공통 게이트: `cd backend && npm test`(현재 41 pass 가 baseline) +
  `node scripts/security-regression-check.js`(현재 13패턴). 008 은 42 pass, 010 은 14패턴이 된다.

## 2026-08-16 감사에서 발견했으나 이번에 계획화하지 않음 (백로그)

운영자가 이번 라운드에서 008~011 만 선택했다. 아래는 **유효한 발견이지만 미착수** —
재감사할 필요 없이 여기서 바로 계획으로 승격할 수 있다.

- ~~**`billing.js` 결제 로직 테스트 0**~~ → **012 로 부분 착수 완료(2026-08-16)**.
  confirm 경로 3건 고정: 키 미설정 시 501 차단 · 금액 불일치 → 400 + `failed` 전이(동일 orderId
  재사용 차단) + 실패 기록에 금액 미포함(PIPA) · 이미 captured 면 Toss 재호출 없이 멱등.
  **프로덕션 코드 변경 0** — express 라우터 스택에서 핸들러만 꺼내 req/res 목으로 호출했다
  (결제 로직을 테스트 편의로 리팩터링하는 것이 더 위험하다는 판단).
  **회귀 주입 2건 검증**: 금액 비교 무력화 → fail 1, captured 멱등 분기 제거 → fail 1.
  ⚠ **남은 것**: `webhook` 상태별 분기(DONE/CANCELED/EXPIRED/ABORTED)와 **환불 7일 창 경계**는
  미착수다. webhook 은 axios 스텁이 추가로 필요하고, 환불은 시간 경계라 타이머 제어가 필요하다.
  **결제를 켜기 전에 이 둘도 덮는 것을 권장한다.**
- **`middleware/auth.js` 테스트 0** (S): `_jwtExpMs`(JWT 만료 후 캐시 재사용 차단)·
  `isDeletionAllowed` 가 순수 함수인데 미노출·미검증. export 추가만으로 착수 가능.
- **`report.js` 점수 엔진 export·테스트 0** (M): `computeAptScore`·`getDistrictTier` 등이
  파일 스코프에 갇혀 있다. 절대룰①("추천 아님")과 직결된 로직인데 기울어짐을 잡을 테스트가 없다.
  ⚠ 이전에 기각된 "report.js 서비스 분리" 와 다른 작업이다 — **export 추가만** 하는 것이라 저위험.
- **KOSIS 미분양 로더 Redis 2차 캐시 누락** (S): `kosisService.js:18-53`(`_fetchAll`).
  같은 파일 `_fetchNetMigrationAll`(:108-115)에는 이미 적용돼 있어 **역이식만 하면 된다.**
- **린트 도입** (S~M): 설정이 전무해 `no-dupe-keys` 같은 표준 규칙으로 잡히는 결함(계획 010 의
  결함 B)이 CI 를 통과했다. 도입 시 11,070행 프론트에서 기존 위반이 대량으로 나올 수 있으니
  **신규 파일부터 점진 적용** 전략이 필요하다.
- **`gitleaks-action@v2` 가변 태그 → 커밋 SHA 고정** (S): 공급망. 다만 워크플로가
  `permissions: contents: read` 로 최소화돼 있어 블라스트 반경은 제한적.
- **`cron.js` `authorizeCron` 테스트 0** (S): `timingSafeEqual` 기반 게이트인데 헤더 조합별
  검증이 없다. export 후 4~5 케이스면 충분.

## Findings considered and rejected (재감사 방지)

2026-08-09 라운드:

- **report.js 1,358줄 서비스 분리**: 실이득 대비 이관 리스크(클로저 컨텍스트) 큼 — 순수 함수
  테스트(백로그)부터 선행하는 게 순서. 보류.
- **cache 전역 single-flight**: 40+ 호출부 공유 유틸이라 범위 과대 — 핫스팟 국소 적용만 검토(백로그).
- **청약 피드 ↔ 북마크 지역 연동**: odcloud 지역 필드가 시군구 미제공이라 주소 문자열 매칭 필요 —
  이 레포가 반복 겪은 동명 오배치 함정과 동일 계열, L급. 비권장.
- ~~**Sentry v8→v10**~~ — **2026-08-16 정정: 이미 완료됐다.** `@sentry/node`가 `^10.69.0`
  (루트·backend 양쪽 package.json 실측). 이 항목은 stale 이므로 백로그에서 제거한다.
- **Kakao 호출부 통합·페이징 유틸**: 유효한 부채나 M급 리팩터라 운영자 선택 시 후속 계획으로.
- **PERF-01 report in-flight dedup**: 유효하나 현재 트래픽에서 실발생 빈도 낮음(로그인+크레딧
  게이트 뒤) — 트래픽 성장 시 재평가.
- **PERF-03 report jeonse 병렬화**: 유효(S급)나 사용자 체감 낮음 — 백로그.
  **2026-08-16 재보고됐으나 기각 유지**(같은 근거).
- **관심단지 인앱 피드 / 상세모달 객관정보 노출 (direction)**: 운영자 방향 결정 대기.

2026-08-16 라운드 추가:

- **`search.js` 의 apt_master 쿼리에 abort 상한 부재**: 구조적으로는 비일관이나 실측상 해당
  쿼리는 4.76ms·23ms 로 이미 충분히 빠르다. `master-*-partial` 강등 카운터가 늘어나는 정황이
  관측되면 그때 재검토.
- **`geocodeCacheService` 의 Kakao 쿼터 리셋이 UTC 자정 기준**: `dailyLimit.js` 의 KST 자정
  수정과 같은 클래스지만, 사용자 노출 한도가 아니라 내부 경고 임계치(60K/100K)라 영향이 낮다.
- **`getDataBasis()` Redis 2차 캐시 누락**: 계획 009(인덱스)가 들어가면 이 조회가 2.2초 → 1ms
  미만이 되므로 **Redis 캐시의 이득이 거의 사라진다.** 009 이후 재평가.

## 감사 범위 밖(미감사) 고지

2026-08-16 라운드는 이전에 미감사로 남았던 영역을 우선 다뤘다(프론트 전체 XSS 싱크·Supabase
RLS 정책 전문·워크플로). 그럼에도 아래는 여전히 미검증이다:

- **Supabase 마이그레이션의 실적용 여부**: `supabase/migrations/` 의 SECURITY DEFINER 권한 회수·
  `search_path` 하드닝이 **파일로는 확인**됐으나 프로덕션 DB 에 실제 적용됐는지는 대조하지 않았다.
  (`molit_transactions`·`apt_master`·`molit_apt_index` 3개만 실측 확인함.)
- **결제 실거래 경로**: `TOSS_*` 키 미설정 상태라 런타임 검증 불가 — 코드 리딩만 수행.
- **모바일 실기기 동작**, **프론트 런타임 성능 프로파일링**.
- 정확성 감사에서 제기된 두 건의 **실발생 이력**(Sentry/로그): 코드상 위험 메커니즘만 확인했고
  프로덕션에서 실제로 발생했는지는 확인하지 못했다(계획 011 의 A·B 항목).
