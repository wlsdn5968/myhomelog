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
const { pgTable, uuid, text, timestamp, integer, jsonb, numeric, index, uniqueIndex } = require('drizzle-orm/pg-core');

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
  avgPrice: numeric('avg_price'), // 억 단위, nullable
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

// ── Phase 3: 결제/구독 ────────────────────────────────────
const userBilling = pgTable('user_billing', {
  userId: uuid('user_id').primaryKey(),
  plan: text('plan').notNull().default('free'),
  status: text('status').notNull().default('active'),
  tossBillingKey: text('toss_billing_key'),
  tossCustomerKey: text('toss_customer_key'),
  currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  canceledAt: timestamp('canceled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  orderId: text('order_id').notNull().unique(),
  tossPaymentKey: text('toss_payment_key'),
  amount: numeric('amount').notNull(),
  currency: text('currency').notNull().default('KRW'),
  status: text('status').notNull().default('requested'),
  plan: text('plan').notNull(),
  method: text('method'),
  failureReason: text('failure_reason'),
  rawResponse: jsonb('raw_response'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
}, (t) => ({
  userCreatedIdx: index('idx_payments_user_created').on(t.userId, t.createdAt),
}));

const billingPlans = pgTable('billing_plans', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  priceKrw: integer('price_krw').notNull(),
  features: jsonb('features').notNull().default([]),
  active: integer('active').notNull().default(1), // drizzle 은 boolean 도 지원하지만 CI drift 방지 위해 SQL 원형 유지
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

module.exports = { bookmarks, searchHistory, chatSessions, chatMessages, userBilling, payments, billingPlans };
