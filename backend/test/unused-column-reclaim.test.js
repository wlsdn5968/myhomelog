/**
 * UNUSED-COL-2026-09-20 (Plan 112) — 읽는 코드가 0건인 캐시 컬럼 제거 회귀 고정.
 *
 * [배경] apt_amenities 의 lat/lng/category/radius(4컬럼, 793KB)는 cache_key 문자열
 *   ('35.8663,128.693:MT1:1500')에 이미 들어 있고, 저장소 전체에 읽는 곳이 0건이었다.
 *   apt_schools.schools jsonb 원소의 lat/lng/address 도 마찬가지로 읽는 코드가 0건인데
 *   행 평균의 절반 이상(929.9B → 421.0B)을 차지했다. kakaoService._dbSetAmenityCount /
 *   naverDatalabService.writeCache 의 upsert payload 와 schoolService 가 만드는 학교
 *   객체에서 이 필드들을 뺐다 — 이 파일은 "다음 사람이 실수로 다시 넣지 않는지"를 고정한다.
 *
 * [파일 분리 이유] backend/test/retention-observability.test.js 의 admin 스텁 방식을
 *   패턴으로 삼되 그 파일(Plan 110 소유)과 ingest-runs-retention.test.js(Plan 106 이 만들고 110 이 고침)는
 *   건드리지 않는다. db/client 를 require.cache 로 끊는 방식은 apt-master-skip-unchanged.test.js
 *   와 같은 방식이다.
 *
 * 실행: cd backend && npm test   (node:test 내장 러너)
 */
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const KAKAO_SVC_PATH = path.join(__dirname, '../services/kakaoService.js');
const NAVER_SVC_PATH = path.join(__dirname, '../services/naverDatalabService.js');
const SCHOOL_SVC_PATH = path.join(__dirname, '../services/schoolService.js');
const AMENITY_SELECT_FILES = [KAKAO_SVC_PATH, NAVER_SVC_PATH];

/**
 * kakaoService 는 module 최상단에서 `const { getSupabaseAdmin, hasAdminEnv } = require('../db/client')`
 * 로 값을 한 번 destructure 해 DB_ENABLED 를 고정한다 — 그래서 db/client 를 스텁하려면
 * kakaoService.js 자체를 require.cache 에서 지우고 **db/client 스텁이 걸린 상태에서 다시** 불러야 한다
 * (apt-master-skip-unchanged.test.js 의 dataGoKrClient 스텁과 같은 방식).
 */
function _withFakeAdminKakao(fakeAdmin, fn) {
  const dbPath = require.resolve('../db/client');
  const svcPath = require.resolve('../services/kakaoService');
  const saved = { db: require.cache[dbPath], svc: require.cache[svcPath] };
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: { hasAdminEnv: () => true, getSupabaseAdmin: () => fakeAdmin },
  };
  delete require.cache[svcPath];
  const svc = require('../services/kakaoService');
  return Promise.resolve().then(() => fn(svc)).finally(() => {
    if (saved.db) require.cache[dbPath] = saved.db; else delete require.cache[dbPath];
    if (saved.svc) require.cache[svcPath] = saved.svc; else delete require.cache[svcPath];
  });
}

/**
 * naverDatalabService.writeCache 는 `require('../db/client')` 를 **함수 본문 안에서** 매 호출마다
 * 부른다 — 그래서 naverDatalabService.js 자체는 다시 불러올 필요 없이 db/client 의 require.cache 만
 * 이 스코프 동안 바꿔치면 된다.
 */
function _withFakeAdminNaver(fakeAdmin, fn) {
  const dbPath = require.resolve('../db/client');
  const saved = require.cache[dbPath];
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: { getSupabaseAdmin: () => fakeAdmin },
  };
  return Promise.resolve().then(fn).finally(() => {
    if (saved) require.cache[dbPath] = saved; else delete require.cache[dbPath];
  });
}

/** upsert 호출을 가로채 payload 만 모으는 최소 admin 스텁. */
function _makeFakeAdmin() {
  const upsertCalls = [];
  const admin = {
    from(table) {
      assert.equal(table, 'apt_amenities', `예상 밖 테이블 조회: ${table}`);
      return {
        upsert(payload) {
          upsertCalls.push(payload);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { admin, upsertCalls };
}

test('kakaoService._dbSetAmenityCount — upsert payload 에 lat/lng/category/radius 가 없다 (cache_key 에 이미 있다)', async () => {
  const { admin, upsertCalls } = _makeFakeAdmin();
  await _withFakeAdminKakao(admin, async (svc) => {
    await svc._dbSetAmenityCount('35.8663,128.693:MT1:1500', 35.8663, 128.693, 'MT1', 1500, 7);
  });
  assert.equal(upsertCalls.length, 1, 'upsert 가 정확히 1회 호출돼야 한다');
  assert.deepEqual(
    Object.keys(upsertCalls[0]).sort(),
    ['cache_key', 'count', 'fetched_at', 'updated_at'],
    'lat/lng/category/radius 는 cache_key 에 이미 있는 값이라 payload 에 다시 실으면 안 된다'
  );
});

test("naverDatalabService.writeCache — upsert payload 키 집합이 같고, lat 이나 lng 가 null 이면 upsert 를 아예 호출하지 않는다(가드 회귀 고정)", async () => {
  const { admin, upsertCalls } = _makeFakeAdmin();
  const dl = require('../services/naverDatalabService');
  await _withFakeAdminNaver(admin, async () => {
    // 정상 좌표 — upsert 가 호출돼야 한다.
    await dl.writeCache('naver:공릉풍림아이원|노원구', 0.42, 37.6183, 127.0731);
    // 가드 회귀 고정: 좌표가 없는(lat==null) 항목은 caller 가 걸러야 정상이지만, 혹시라도
    //   넘어오면 writeCache 자체가 저장을 막아야 한다 — 이 가드를 지우면 캐시에 쓰레기가 들어간다.
    await dl.writeCache('naver:좌표없음단지|노원구', 0.1, null, 127.0731);
    await dl.writeCache('naver:좌표없음단지2|노원구', 0.1, 37.6183, null);
  });
  assert.equal(upsertCalls.length, 1, 'lat 또는 lng 가 null 인 2건은 upsert 를 호출하면 안 된다');
  assert.deepEqual(
    Object.keys(upsertCalls[0]).sort(),
    ['cache_key', 'count', 'fetched_at', 'updated_at'],
    'writeCache 도 kakaoService 와 같은 키 집합이어야 한다(category:"naver_interest" 도 더 이상 없다)'
  );
});

test('schoolService — 학교 객체 생성 지점(all.push)에 lat/lng/address 키가 없다 (소스 정적 단언)', () => {
  // 함수(_fetchFromKakao 계열)가 export 되어 있지 않고 카카오 keyword API 호출까지 필요해
  //   직접 호출로 고정하기 어렵다 — 소스에서 그 블록을 직접 잘라 확인한다.
  //   저장 시점이 아니라 "생성 시점"에 필드를 빼야 한다는 것이 이 계획의 핵심이라(saveToDb 에서만
  //   빼면 같은 단지의 첫 요청과 재요청 결과가 달라진다), 생성 지점(all.push) 자체를 본다.
  const src = fs.readFileSync(SCHOOL_SVC_PATH, 'utf8');
  const idx = src.indexOf('all.push({');
  assert.ok(idx >= 0, 'schoolService.js 에 all.push({ 블록이 있어야 한다 — 소스 구조가 바뀌었다');
  const closeIdx = src.indexOf('});', idx);
  assert.ok(closeIdx >= 0, 'all.push({ 블록의 닫는 }); 를 못 찾았다');
  const block = src.slice(idx, closeIdx);
  assert.ok(!/\blat:/.test(block), 'all.push 블록에 lat: 키가 남아 있다 — 읽는 코드가 없는데 저장하면 안 된다');
  assert.ok(!/\blng:/.test(block), 'all.push 블록에 lng: 키가 남아 있다 — 읽는 코드가 없는데 저장하면 안 된다');
  assert.ok(!/\baddress:/.test(block), 'all.push 블록에 address: 키가 남아 있다 — 읽는 코드가 없는데 저장하면 안 된다');
  // distanceM 계산에 쓰는 sLat/sLng 변수 자체는 지우면 안 된다는 계획 조건도 같이 고정한다.
  assert.ok(/distanceM\(lat, lng, sLat, sLng\)/.test(block), 'sLat/sLng 는 distance_m 계산에 계속 쓰여야 한다');
});

test('회귀 방지: apt_amenities 를 읽는 select(...) 문자열에 lat/lng/category/radius 가 등장하지 않는다 (소스 정적 단언)', () => {
  // 저장은 이 테스트 파일의 다른 케이스로 이미 고정했다 — 여기서는 "누군가 나중에 select 를
  //   select('*') 나 select('lat, lng, ...') 로 넓혀서 삭제 예정 컬럼에 다시 의존하지 않는지" 만 본다.
  const selectRe = /\.select\(\s*(['"`])((?:(?!\1).)*)\1/g;
  for (const f of AMENITY_SELECT_FILES) {
    const src = fs.readFileSync(f, 'utf8');
    let m;
    let checked = 0;
    while ((m = selectRe.exec(src))) {
      const cols = m[2];
      if (!/apt_amenities/.test(src.slice(Math.max(0, m.index - 200), m.index + 200))) continue;
      checked++;
      assert.ok(!/\blat\b/.test(cols), `${path.basename(f)} 의 select("${cols}") 에 lat 이 등장한다 — 삭제된 컬럼이다`);
      assert.ok(!/\blng\b/.test(cols), `${path.basename(f)} 의 select("${cols}") 에 lng 이 등장한다 — 삭제된 컬럼이다`);
      assert.ok(!/\bcategory\b/.test(cols), `${path.basename(f)} 의 select("${cols}") 에 category 가 등장한다 — 삭제된 컬럼이다`);
      assert.ok(!/\bradius\b/.test(cols), `${path.basename(f)} 의 select("${cols}") 에 radius 가 등장한다 — 삭제된 컬럼이다`);
    }
    assert.ok(checked > 0, `${path.basename(f)} 에서 apt_amenities 관련 select(...) 를 하나도 못 찾았다 — 정규식이 소스 변경을 못 따라갔다`);
  }
});
