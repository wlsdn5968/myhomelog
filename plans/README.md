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
| **013** | **auth 미들웨어 계약 테스트 (JWT 만료 우회·삭제 유예 화이트리스트)** | P2 | S | — | DONE (e46f101, 2026-08-16) |
| **014** | **report.js 점수 엔진 계약 테스트 (지역판정·상대나이 실사고 2건 고정)** | **P1** | M | — | DONE (5b94815, 2026-08-16) |
| **015** | **cron.js `authorizeCron` 계약 테스트** | P2 | S | — | DONE (bbb1a61, 2026-08-16) |
| **016** | **규제 판정 두 경로 정합 — `isRegFront` lawdCd 게이트 (실결함 수정)** | **P1** | S | — | DONE (80d341b, 2026-08-16) |
| **017** | **KOSIS 미분양 Redis 2차 캐시 역이식 (+Map 직렬화 함정 차단)** | P2 | S | — | DONE (abbf772, 2026-08-16) |
| **018** | **서울 규제 해제 시 LTV 라벨이 스냅샷을 따라가게 (016 잔여)** | P2 | S | 016 | DONE (c755b38, 2026-08-16) |
| **019** | **마이그레이션 실적용 전수 대조 + advisor 경고 3건 해소** | **P1** | M | — | DONE (514352c, 2026-08-16) |
| **020** | **정확성 전용 최소 ESLint 도입 + 프론트 인라인 JS 커버 + CI Node 24 정합** | P2 | M | — | DONE (d6511c8·6399333, 2026-08-16) |
| **021** | **gitleaks v3 SHA 재고정(v2 EOL) + 의존성 상향/engines>=22 + RLS role 복원** | **P1** | M | — | DONE (2e6e38c·f3227f8·4f3f17b, 2026-08-16) |
| **022** | **서울 중구 규제판정 불일치 수정 + 계약 테스트를 25개 구 전수로** | **P1** | S | 016 | DONE (2097305, 2026-08-16) |

### 018~019 실행 결과 (2026-08-16)

- **018**: `_regLtvLabel` 의 서울 하드코딩을 스냅샷 조건부로. **오늘 동작 변화 0**
  (`seoulRegulated=true`), 해제되는 날에만 발동. **미로드 시엔 보수적 40% 유지** — 부팅 직후
  70% 로 찍으면 한도를 부풀리는 반대 방향 오표기가 되기 때문.
  기존 테스트가 즉시 깨졌다(하네스가 새 `window` 의존성을 안 넘겨줌) → 하네스 갱신.
- **019**: ⚠ **미감사로 남아 있던 "마이그레이션 실적용 여부"를 종결.** 27개 파일 선언 vs
  `pg_catalog` 전수 대조.
  · ✅ 함수 3종 하드닝·pg_trgm 스키마·dedup_key v2·인덱스 5종·pg_cron job 전부 **적용 확인**
  · ✅ **오탐 정정** — `billing_plans` 는 정책 0개가 아니라 `billing_plans_public_read` 존재
  · ❌ **`20260504000002`(regulations overlap GIST) 미적용 발견** → overlap 0건 선검증 후 적용,
    의도적 위반 INSERT 가 `exclusion_violation` 으로 막히는 것까지 실증(롤백, 데이터 변화 0)
  · advisor security 경고 **6 → 3**: btree_gist public→extensions, SECURITY DEFINER RPC 2종의
    anon/authenticated EXECUTE 회수(호출부가 service_role 전용임을 실측 후)

### 014~017 실행 결과 (2026-08-16)

- **014·015**: 프로덕션 코드 변경 **0**. 정규식 추출 패턴으로 8개 테스트(53→61).
  회귀 주입 **8건 전부** fail 확인.
- **016**: ⚠ **교차검증에서 나온 실결함**. `_regLtvLabel`(lawdCd 우선)과 `isRegFront`(문자열 전용)가
  독립 구현이라 **부산 강서구(26440)** 에서 갈렸다(`LAWD_CODES` 전수 대조 — 어긋나는 곳은 이 1곳뿐).
  같은 모달에서 "LTV 70% 비규제" ↔ "취득세 2주택 8% 조정 중과" ↔ "6개월 전입 의무"가 동시 표시.
  → `isRegFront(regionStr, lawdCd)` 로 동일 게이트 적용 + 호출부 4곳 전파.
  **두 함수가 서로 같은지를 단언하는 계약 테스트** 추가(한쪽만 고치면 걸린다).
- **017**: Map 은 JSON 왕복을 못 견딘다(`all.map.get is not a function`, Node 실측) →
  pack/unpack + fail-safe. 함정 자체를 테스트로 고정.

⚠ **주입 실험 프로토콜 정정**: `git checkout` 원복은 파일 단위라 **미커밋 수정까지 날린다**
(오늘 실제로 Plan 016 수정이 통째로 사라졌고 `grep -c` 로 발견해 재적용했다).
→ **회귀 주입은 실제 수정을 커밋한 뒤에만** 실행하고, 주입 전 `git status --short` 가 비었는지 확인할 것.

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
  **→ 012-2(2026-08-16)로 webhook·환불까지 완료.** 총 **9건**(41→51 테스트):
  · webhook: Toss 재조회 orderId 불일치 → 400(위조 차단) · 정적 시크릿 불일치 → 401 ·
    금액 불일치라도 **terminal(captured)은 failed 로 덮지 않고 200**(Toss 재시도 중단)
  · 환불: **7일 창 경계 양쪽**(8일 → 400 + Toss 미호출 / 6일 → Toss 호출 도달) ·
    captured 아니면 409 · 이미 refunded 면 멱등 200
  · axios 는 `require.cache` 스텁, 7일 경계는 `approved_at` 조작으로 **타이머 제어 없이** 검증.
  **회귀 주입 4건 전부 확인**(금액비교·멱등분기·7일창·orderId검증 각각 무력화 시 fail 1).
  ⚠ **이 과정에서 실제 결함 1건 발견·수정**: confirm 은 P2-5(2026-05-04)로 실패 기록에서 정확한
  결제 금액을 뺐는데 **webhook 만 그대로**였다(로그·failure_reason 양쪽). 같은 방어선인데 서로 다른
  개인정보 정책을 갖고 있던 셈 — 오늘 취득세와 같은 "한쪽만 고침" 패턴이라 confirm 과 맞추고
  계약 테스트로 묶었다.
- ~~**`middleware/auth.js` 테스트 0**~~ → **013 으로 완료(e46f101)**. 다만 `_jwtExpMs` 의
  base64url 복원 두 줄은 Node 에서 no-op 이라 **어떤 테스트로도 고정 불가**(주입해도 안 잡힘).
- ~~**`report.js` 점수 엔진 export·테스트 0**~~ → **014 로 완료(5b94815)**.
  export 조차 추가하지 않았다 — 정규식 추출로 **프로덕션 코드 변경 0**.
- ~~**KOSIS 미분양 로더 Redis 2차 캐시 누락**~~ → **017 로 완료(abbf772)**.
  단순 역이식이 아니었다: 반환값의 `map` 이 Map 인스턴스라 그대로 실으면 복원 시 TypeError.
- ~~**`cron.js` `authorizeCron` 테스트 0**~~ → **015 로 완료(bbb1a61)**.
- ~~**린트 도입**~~ → **020 으로 완료(d6511c8, 2026-08-16).** ⚠ **아래 미착수 판단은 틀렸다.**
  스크래치패드에 eslint 를 설치해 실측하니 **backend 에러 0 · 프론트 인라인 에러 1**(그것도 의도된
  게이트)이었다 — "위반이 대량으로 나올 것"이라는 전제가 사실이 아니어서 baseline 전략 자체가
  불필요했다. **측정 가능한 것을 추정으로 판단해 '안 한다'를 정당화한 사례**로 남긴다.
  (원문 보존 ↓)
- ~~**린트 도입** (S~M) — 2026-08-16 판단: 지금은 하지 않는다. 운영자 결정 대기.~~
  전제(=`no-dupe-keys` 같은 표준 규칙이면 계획 010 의 결함 B 를 잡았다)는 **사실**이다.
  그러나 지금 착수하면 다음이 전부 딸려온다:
  · `eslint`/`acorn`/`espree`/`typescript` 중 **로컬에 설치된 파서가 하나도 없다**(실측).
    즉 네트워크 설치 없이는 시범 측정조차 불가능하다.
  · devDependency 추가는 `scripts/check-deps-sync.js` 게이트 때문에 **루트+backend 양쪽
    package.json 동기 수정**이 필요하다(이 게이트는 실제로 CI 를 막은 이력이 있다).
  · 11,070행 단일 파일 프론트에서 기존 위반이 대량으로 나올 것이라 **baseline 전략**
    (신규/변경 파일만 검사 or 규칙 최소 집합부터)이 선행돼야 한다.
  ⚠ **파서 없이 정규식으로 흉내 내는 가드는 만들지 말 것** — 중복 키는 문법적으로 합법이라
    `node -c`·`new Function()` 로는 절대 안 잡히고, 정규식 스캐너는 오탐/누락을 검증할 방법이
    없어 "가드가 지켜준다"는 잘못된 확신만 만든다.
  권고: 규칙을 `no-dupe-keys`·`no-unreachable`·`no-dupe-args` 정도로 좁힌 최소 설정 +
  **변경된 파일만** 검사하는 CI 스텝으로 시작.
- ~~**`gitleaks-action@v2` 가변 태그 → 커밋 SHA 고정**~~ → **완료(b94d995, 2026-08-16)**.
  `ff98106`(= v2 annotated tag 가 가리키는 commit)로 고정. dependabot 이 SHA 핀도 갱신한다.
  `actions/checkout`·`setup-node` 는 1st-party 라 미고정 — 필요 시 같은 방식으로.

### 2026-08-16 라운드에서 새로 올라온 항목 (운영자 판단 필요)

- ~~⚠ **`_regLtvLabel` 의 서울 하드코딩**~~ → **018 로 완료(c755b38)**. 다만 **부분 해제**
  (예: 강남3구만 규제 유지)는 스냅샷의 `seoul` 이 문자열 + `!!` 로 boolean 화되는 구조라
  **표현 자체가 불가능**하다. 그 경우 두 판정 함수는 서로 일치하되 **둘 다 부정확**하다.
  프론트에서 못 고친다 — `regulationsService` 의 `regulatedRegions` 스키마부터 손봐야 한다.
- ⚠ **Supabase `auth_leaked_password_protection` 비활성** (XS, **운영자 Dashboard 조치**):
  advisor WARN. HaveIBeenPwned 대조로 유출된 비밀번호 사용을 막는 기능인데 꺼져 있다.
  SQL 이 아니라 Dashboard → Authentication 설정이라 코드/MCP 로 켤 수 없다.
- ~~**RLS 정책 role 드리프트**~~ → **021 로 완료(4f3f17b)**. `ALTER POLICY … TO authenticated` 5건.
  안전성 근거: `fieldNotes.js` 가 사용자 JWT 클라이언트(`getUserScopedClient`)를 쓰므로 role 이
  `authenticated` 로 해석되고, 나머지 경로는 service_role(RLS 우회), 프론트 직접 접근은 0건(실측).
  (원문 ↓)
- ~~**RLS 정책 role 드리프트** (S, 심층방어): `field_notes_*` 4개 + `ai_feedback_select_own` 의~~
  role 이 `authenticated` 가 아니라 **PUBLIC** 이다(20260504000003 이 DROP+CREATE 하며 `TO` 절
  누락, 20260531000001 이 `insert_own` 만 복원). **기능 영향은 0** — USING/WITH CHECK 가
  `(SELECT auth.uid()) = user_id` 라 anon 은 `auth.uid()` 가 NULL 이어서 통과 못 한다(실측).
  뚫린 구멍이 아니라 **의도와 실제의 불일치**라 019 에서 건드리지 않았다.
### dependabot PR 처리 결과 (2026-08-16) — ⚠ **#58 은 머지하지 말 것**

- **#65** minor-and-patch 4종 → **직접 적용 완료(f3227f8)**. PR 을 머지하지 않은 이유: PR 생성 이후
  루트 package.json 이 갈라졌고(eslint devDep·scripts), 무엇보다 **`engines` 상향이 PR 에 빠져 있어**
  그대로 머지하면 supabase-js 요구(>=22)와 선언(">=20")이 어긋난 채 남는다. dependabot 이 곧 자동 종료한다.
- ⚠ **#58** `gitleaks-action 2→3` → **머지 금지.** v3 로 가는 것 자체는 맞고 **이미 갔다(2e6e38c)**.
  다만 그 PR 은 `uses` 를 **가변 태그 `@v3`** 으로 되돌리므로 머지하면 오늘 한 SHA 고정이 풀린다.
  우리는 `@e0c47f4…  # v3.0.0` 으로 고정돼 있다. PR 은 닫으면 된다.
- **#62** `setup-node 6→7` · **#61** `checkout 6→7` — GitHub 1st-party 액션 메이저. 머지는 운영자 결정.

#### v2 를 SHA 로 고정한 것이 왜 위험했나 (재발 방지)
`gitleaks-action@v2` 는 node20 런타임이고 업스트림이 명시한 일정이 있다:
**2026-06-02** 러너 기본이 Node 24 로 전환(우회 env 필요) → **2026-09-16 Node 20 제거로 v2 완전 중단**.
즉 v2 에 SHA 를 고정하는 것은 한 달 뒤 Secret Scan job 을 죽이는 선택이었다.
→ **버전 고정 대상은 "지금 도는 것"이 아니라 "앞으로도 도는 것"이다. 고정 전에 그 버전의 수명을 확인할 것.**

<!-- 아래는 처리 전 시점의 기록 -->
- **dependabot PR 4건 대기 — 머지는 운영자 결정** (2026-08-16 실측):
  · **#65** minor-and-patch 4종(`supabase-js` 2.105→2.112 · `anthropic-sdk` · `upstash/redis` · `axios`).
    ⚠ 신규 `supabase-js` 가 `engines.node ">=22"` 를 요구한다. CI 는 이번에 24 로 올렸으니 정합이지만
    **`package.json` 의 `engines` 는 아직 `">=20"`** 이라 함께 올리는 것이 맞다.
  · **#62** `setup-node 6→7` · **#61** `checkout 6→7` — GitHub 1st-party 액션 메이저.
  · **#58** `gitleaks-action 2→3` — ⚠ 오늘 v2 를 **커밋 SHA 로 고정**했으므로 이 PR 과 충돌한다.
    3 으로 갈 거면 **v3 의 SHA 로 다시 고정**할 것(태그로 되돌리면 오늘 한 공급망 조치가 무효화된다).
- ⚠ **카카오 로그인 게이트 — 전제조건은 이미 충족됨** (S, **운영자 확인 필요**):
  `frontend/index.html` 의 `loginKakao()` 는 `return;` 으로 막혀 있고 주석은 "사업자등록 후 활성화"
  라고 적혀 있다. **사업자등록은 2026-08-09 완료**됐다. 그런데도 해제하지 않은 이유는 KOE205 가
  카카오 개발자 콘솔의 앱/비즈앱 설정 문제라 사업자등록만으로 풀리지 않고, 콘솔 상태를 코드에서
  확인할 방법이 없기 때문이다. 콘솔 확인 후 해제 여부를 결정할 것.
- **`kosisService.KOSIS_CACHE_KEY` 는 죽은 export** (XS): 저장소 전체에 소비처가 0건.
  017 작업 중 확인했으나 범위 밖이라 그대로 뒀다.
- **`/search/history` 헤더 주석이 부정확** (XS): `search.js:9` 가 "fire-and-forget"이라고
  적었지만 실제로는 `await` insert 후 응답한다. 계획 011 에서 발견, 범위 밖이라 미수정.

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
