/**
 * SNAPSHOT-STORE-2026-10-14 (Plan 142): 계산 결과를 DB 테이블 computed_snapshots 에 보관하는 얇은 저장소.
 *
 * [왜] Upstash Redis 쓰기가 막힌 동안 공유 캐시가 비어, 콜드 인스턴스마다 무거운 RPC(첫 호출 4~5초)를 다시 계산했다.
 *   DB 는 어차피 쓰는 저장소라 Redis 장애와 무관하게 "마지막 계산 결과"를 둘 수 있다.
 * [테이블] public.computed_snapshots(key text pk, payload jsonb, computed_at timestamptz) — RLS on·정책 0 = 서비스 키 전용.
 * [계약] 읽기·쓰기 모두 **절대 throw 하지 않는다**. 읽기 실패·admin 없음은 null, 쓰기 실패는 삼키고 warn.
 */
'use strict';

const logger = require('../logger');
const { getSupabaseAdmin } = require('../db/client');

const TABLE = 'computed_snapshots';

async function _read(key) {
  try {
    const admin = getSupabaseAdmin();
    if (!admin) return null;
    const { data, error } = await admin.from(TABLE).select('payload, computed_at').eq('key', key).maybeSingle();
    if (error) throw error;
    if (!data || data.payload == null) return null;
    const ms = Date.parse(data.computed_at);
    if (!Number.isFinite(ms)) return null;
    return { payload: data.payload, computedAt: new Date(ms).toISOString(), _ms: ms };
  } catch (e) {
    logger.warn({ err: e && e.message, key }, 'snapshot 조회 실패');
    return null;
  }
}

/** computed_at 이 maxAgeMs 이내인 스냅샷만. 없거나 오래됐거나 오류면 null. */
async function getSnapshot(key, maxAgeMs) {
  const s = await _read(key);
  if (!s) return null;
  if (Date.now() - s._ms > maxAgeMs) return null;
  return { payload: s.payload, computedAt: s.computedAt };
}

/** 기간 무관 마지막 성공 값(stale 대체용). */
async function getLastSnapshot(key) {
  const s = await _read(key);
  return s ? { payload: s.payload, computedAt: s.computedAt } : null;
}

async function putSnapshot(key, payload) {
  try {
    const admin = getSupabaseAdmin();
    if (!admin) return;
    const { error } = await admin.from(TABLE).upsert(
      { key, payload, computed_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
    if (error) throw error;
  } catch (e) {
    logger.warn({ err: e && e.message, key }, 'snapshot 저장 실패');
  }
}

module.exports = { getSnapshot, getLastSnapshot, putSnapshot };
