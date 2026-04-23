/**
 * Drizzle ORM 스키마 — Supabase Postgres
 *
 * ⚠️ 이 파일은 Supabase 에 이미 적용된 SQL 마이그레이션
 *   (supabase/migrations/phase1a_foundation_bookmarks_search_chat)
 *   과 일치해야 함. SQL 을 단일 진실 원천(SSOT)으로 두고,
 *   Drizzle 은 타입 안전 쿼리 레이어로만 사용.
 *
 *   새 테이블 추가 시:
 *   1) Supabase MCP apply_migration 으로 SQL 적용
 *   2) 이 파일에 대응 스키마 추가
 *   3) (선택) drizzle-kit introspect 로 SQL → 스키마 역생성 검증
 */
const { pgTable, uuid, text, timestamp, integer, jsonb, index, uniqueIndex } = require('drizzle-orm/pg-core');

// auth.users 는 Supabase 가 관리하는 스키마 — FK 용으로만 참조 (쿼리 X)
// Drizzle 은 public 스키마 외 테이블 참조 시 authSchema 로 분리 가능하지만
// 우리는 SQL FK 로 이미 걸었으므로 어플리케이션 레이어에선 users 타입만 있으면 됨.

const bookmarks = pgTable('bookmarks', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  kaptCode: text('kapt_code').notNull(),
  displayName: text('display_name').notNull(),
  address: text('address'),
  memo: text('memo'),
  tags: text('tags').array().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userCreatedIdx: index('idx_bookmarks_user').on(t.userId, t.createdAt),
  userKaptUnique: uniqueIndex('bookmarks_user_id_kapt_code_key').on(t.userId, t.kaptCode),
}));

const searchHistory = pgTable('search_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  query: text('query').notNull(),
  queryType: text('query_type').notNull(), // 'address' | 'kapt' | 'keyword'
  resultCount: integer('result_count'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userCreatedIdx: index('idx_search_history_user').on(t.userId, t.createdAt),
}));

const chatSessions = pgTable('chat_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  title: text('title').notNull().default('새 대화'),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userLastMsgIdx: index('idx_chat_sessions_user').on(t.userId, t.lastMessageAt),
}));

const chatMessages = pgTable('chat_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull(),
  role: text('role').notNull(), // 'user' | 'assistant' | 'system'
  content: text('content').notNull(),
  meta: jsonb('meta').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sessionCreatedIdx: index('idx_chat_messages_session').on(t.sessionId, t.createdAt),
}));

module.exports = { bookmarks, searchHistory, chatSessions, chatMessages };
