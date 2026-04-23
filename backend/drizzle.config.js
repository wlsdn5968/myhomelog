/**
 * drizzle-kit 설정
 *
 * 용도:
 *   1) `npx drizzle-kit generate` — schema.js → SQL 마이그레이션 생성
 *   2) `npx drizzle-kit introspect` — 기존 DB → 스키마 역생성 (SSOT 검증)
 *   3) `npx drizzle-kit studio` — 로컬 GUI 에서 DB 탐색
 *
 * ⚠️ 실제 적용은 Supabase Dashboard SQL Editor 또는 MCP apply_migration 으로.
 *    drizzle-kit push 는 프로덕션에서 쓰지 않음 (마이그레이션 이력 유실).
 */
require('dotenv').config();

/** @type {import('drizzle-kit').Config} */
module.exports = {
  schema: './db/schema.js',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || '',
  },
  // Supabase 관리 스키마 제외 (auth/storage/realtime/...)
  schemaFilter: ['public'],
  verbose: true,
  strict: true,
};
