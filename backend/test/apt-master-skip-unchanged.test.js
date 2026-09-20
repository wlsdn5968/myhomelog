/**
 * SKIP-UNCHANGED-2026-09-20 (Plan 106) — apt_master 주간 동기화는 바뀐 행·새 행만 upsert.
 *
 * [배경] apt_master 는 facility jsonb(평균 1.4KB)가 같은 튜플에 있어, 이름이 안 바뀌어도
 *   upsert 하면 2.9KB 튜플 전체가 새로 쓰인다. 매주 14,678행 전부를 다시 써 힙의 47%(19MB)가
 *   빈 공간이었다(2026-09-20 실측). syncOneSgg(backend/jobs/aptMasterSync.js) 가 개명 감지용으로
 *   이미 조회하던 기존 행에 lawd_cd·sigungu·umd_nm·source 를 더 실어 "바뀐 값이 있는 행만" upsert 로
 *   보낸다.
 *
 * [파일 분리 이유] 기존 테스트 파일은 병렬 작업 중이라 건드리지 않는다 — 신규 파일에 최소 헬퍼를
 *   자체적으로 둔다(다른 파일에서 import 하지 않음). 외부 의존은 dataGoKrClient 만 require.cache
 *   스텁으로 끊는다(aliases-cron.test.js 와 같은 방식) — syncOneSgg 는 admin 을 인자로 직접 받으므로
 *   db/client 스텁은 불필요하다(adminClient()/requireSupabaseAdmin 경로를 타지 않는다).
 *
 * 실행: cd backend && npm test   (node:test 내장 러너)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const LAWD_CD = '00000'; // LAWD_CODE_TO_NAME 에 없는 코드 → sigunguShort 는 항상 null (양쪽 비교가 결정적)

// AptInfo getSigunguAptList4 응답 형태 (aptMasterSync.js:65~76 헤더 주석 참조)
function _kaptListResponse(items) {
  return {
    data: {
      response: {
        header: { resultCode: '00' },
        body: { items, totalCount: items.length },
      },
    },
  };
}

/** _syncOneSgg 가 기대하는 admin 체인만 구현한 최소 스텁. */
function _makeFakeAdmin({ existingRows, existingError } = {}) {
  const upsertCalls = [];
  const updateCalls = [];
  const from = (table) => {
    assert.equal(table, 'apt_master', `예상 밖 테이블 조회: ${table}`);
    return {
      select() {
        return {
          eq() {
            return {
              order() {
                return {
                  range(fromIdx) {
                    if (existingError) return Promise.resolve({ data: null, error: existingError });
                    if (fromIdx === 0) return Promise.resolve({ data: existingRows || [], error: null });
                    return Promise.resolve({ data: [], error: null }); // 페이징 종료
                  },
                };
              },
            };
          },
        };
      },
      upsert(rows) {
        const chunk = Array.isArray(rows) ? rows.slice() : [rows];
        upsertCalls.push(chunk);
        return Promise.resolve({ error: null, count: chunk.length });
      },
      update(patch) {
        return {
          in(_col, vals) {
            updateCalls.push({ patch, vals: (vals || []).slice() });
            return Promise.resolve({ error: null });
          },
        };
      },
    };
  };
  return { from, upsertCalls, updateCalls };
}

/** dataGoKrClient 만 require.cache 스텁으로 끊고 aptMasterSync 를 새로 로드해 _syncOneSgg 를 얻는다. */
function _withSyncOneSgg(items, fn) {
  const dgkPath = require.resolve('../services/dataGoKrClient');
  const jobPath = require.resolve('../jobs/aptMasterSync');
  const saved = { dgk: require.cache[dgkPath], job: require.cache[jobPath] };
  require.cache[dgkPath] = {
    id: dgkPath, filename: dgkPath, loaded: true,
    exports: { get: async () => _kaptListResponse(items) },
  };
  delete require.cache[jobPath];
  const { _syncOneSgg } = require('../jobs/aptMasterSync');
  return Promise.resolve().then(() => fn(_syncOneSgg)).finally(() => {
    if (saved.dgk) require.cache[dgkPath] = saved.dgk; else delete require.cache[dgkPath];
    if (saved.job) require.cache[jobPath] = saved.job; else delete require.cache[jobPath];
  });
}

const KAPT_ITEMS = [
  { kaptCode: 'A1', kaptName: '아파트A', as3: '동1' },
  { kaptCode: 'B1', kaptName: '아파트B_신규명', as3: '동2' }, // DB 의 옛 이름과 다르다 → 개명
  { kaptCode: 'C1', kaptName: '아파트C', as3: '동3' }, // DB 에 없다 → 신규
];

test('apt_master upsert — 안 바뀐 A 는 건너뛰고 개명된 B·신규 C 만 upsert 된다 (unchanged=1, renamed=1)', async () => {
  const existingRows = [
    { kapt_code: 'A1', apt_name: '아파트A', lawd_cd: LAWD_CD, sigungu: null, umd_nm: '동1', source: 'aptinfo' },
    { kapt_code: 'B1', apt_name: '아파트B_구명', lawd_cd: LAWD_CD, sigungu: null, umd_nm: '동2', source: 'aptinfo' },
  ];
  await _withSyncOneSgg(KAPT_ITEMS, async (_syncOneSgg) => {
    const admin = _makeFakeAdmin({ existingRows });
    const result = await _syncOneSgg(admin, LAWD_CD);

    assert.equal(admin.upsertCalls.length, 1, 'upsert 는 500개 이하라 chunk 1회여야 한다');
    const upserted = admin.upsertCalls[0].map((r) => r.kapt_code).sort();
    assert.deepEqual(upserted, ['B1', 'C1'], 'A(안 바뀜)는 upsert 대상에서 빠지고 B·C 만 가야 한다');

    assert.equal(result.unchanged, 1, 'unchanged 는 A 1건이어야 한다');
    assert.equal(result.renamed, 1, 'renamed 는 B 1건이어야 한다(이름이 달라짐)');
    assert.equal(result.fetched, 3);
    assert.equal(result.inserted, 2, 'inserted(count) 는 실제 upsert 된 2건과 같아야 한다');
  });
});

test('apt_master upsert — 기존 행 조회가 실패하면 fail-open 으로 3행 전부 upsert 된다', async () => {
  await _withSyncOneSgg(KAPT_ITEMS, async (_syncOneSgg) => {
    const admin = _makeFakeAdmin({ existingError: { message: 'connection reset' } });
    const result = await _syncOneSgg(admin, LAWD_CD);

    assert.equal(admin.upsertCalls.length, 1);
    const upserted = admin.upsertCalls[0].map((r) => r.kapt_code).sort();
    assert.deepEqual(upserted, ['A1', 'B1', 'C1'], '기존 행 조회 실패 시 감지를 생략하고 전 행을 upsert 해야 한다(fail-open)');
    assert.equal(result.unchanged, 0, '조회 실패로 비교 기준이 없으므로 unchanged 는 0 이어야 한다');
  });
});
