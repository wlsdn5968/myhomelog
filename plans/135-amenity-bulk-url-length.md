# 135 — 관심도 캐시 일괄 조회: 요청 주소 길이 초과로 400 → 전부 캐시 미스로 처리되던 결함

**작성 기준 커밋**: `03a3031` (2026-10-14) · **발견**: 2026-10-14 게이트웨이(edge) 로그 점검
**성격**: `backend/services/naverDatalabService.js` 의 `readCacheBulk` 묶음 방식 교체 + 오류 읽기 + 헬퍼 export + 신규 테스트 1. DB·프런트·의존성·환경변수 변경 0.
**계획자 사전 검증**(저장소 밖 사본, 03a3031 코드 기준): 신규 테스트 2/2 · **원래 코드에서는 2건 모두 실패**(음성 대조) · `npm run verify` 전체 통과(620/620) · 원본 파일에 적용 스크립트를 돌린 결과와 해시 일치.

## 1. 사실 (계획자 실측 2026-10-14)
- `readCacheBulk`(`naverDatalabService.js:214-245`)는 키를 200개씩 `admin.from('apt_amenities').select(…).in('cache_key', chunk)` 로 묻는다. 키는 `ni:<단지명>|<시군구>|<동>`(한글) — URL 인코딩 뒤 요청 주소가 **27,597~29,574자**.
- edge 로그: `GET /rest/v1/apt_amenities` 400 이 `warm-interest` 회차(19:0xZ)마다 10건 — 10-08·10-11·10-13 확인. 같은 기간 GET 중 성공한 가장 긴 주소는 **14,043자**(10-13~14 24시간).
- 코드는 `const { data } = …` 로 `error` 를 읽지 않아, 400 인 묶음은 조용히 "캐시 없음" 이 된다. 결과: `warmInterest`(`:294-316`)가 이미 캐시된 단지를 다시 데이터랩에 묻느라 하루 호출 상한을 쓰고, `getCachedInterest`(`:266`, 요청 경로)도 목록이 크면 관심도 값이 빠진다.

## 2. 변경 (실행자)
`node <scratchpad>/p135_apply.js <워크트리 루트>` (앵커 불일치 시 아무것도 쓰지 않고 중단):
1. `readCacheBulk` 문서 주석 앞에 `BULK_URL_BUDGET = 8000` 과 `_chunkByEncodedLength(keys, budget)` 추가 — 키마다 `encodeURIComponent(k).length + 9`(쉼표·따옴표 여유)를 더해 예산을 넘기 직전에 묶음을 끊는다(키 하나가 예산보다 길어도 단독 묶음으로 보낸다).
2. 조회 루프를 `for (const chunk of _chunkByEncodedLength(miss))` 로 바꾸고 `error` 가 오면 warn 로그 후 그 묶음만 건너뛴다(나머지 묶음 결과는 쓴다).
3. `module.exports` 에 `_chunkByEncodedLength, BULK_URL_BUDGET` 추가(테스트용).
4. 신규 테스트 `backend/test/amenity-bulk-url.test.js` = `<scratchpad>/p135/amenity-bulk-url.test.js` 바이트 그대로 복사.

기대 해시(SHA-256): `backend/services/naverDatalabService.js` = `efd651212e541d8941bf6e4701134ed80e00efbc6fb4c7dde9e96a70f8cffaeb` · 테스트 = `a31f6447b41f22d8027ea30ec50c9e8c6b7dcfb6c0e81d33b317d97865f33369`.

## 3. 테스트가 고정하는 것
- 2,000개 긴 한글 키 → 모든 묶음 인코딩 길이 ≤ 8,000 · 순서·누락 없음 · 음성 대조(종전 200개 묶음 > 14,043자).
- `getCachedInterest` 600건 → 실제 `in()` 묶음마다 ≤ 8,000 · 전부 한 번씩 조회 · 첫 묶음이 400 이어도 나머지 결과는 반환.

## 4. 하지 않는 것
- 키 형식·캐시 유효기간·데이터랩 호출 상한 변경 · POST(RPC) 전환.

## 5. 배포 뒤 확인
- 다음 `warm-interest` 회차(19:0xZ) edge 로그에 `apt_amenities` GET 400 이 0건이고 200 묶음이 여러 개 생기는지.
