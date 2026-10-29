-- SEC-1030-C2 (보안 감사 2026-10-30): 채팅 저장 크기 DB 안전망.
--   API(backend/routes/chatSessions.js)가 내용 8000자·meta 2KB·제목 60자로 자르지만, DB 에는 역할 CHECK 뿐이었다.
--   적용 전 실측(2026-10-30): 내용 최대 338자 · meta 최대 5바이트(전부 빈 객체) · 제목 최대 15자 → 기존 행 위반 0.
--   추가 제약만 있고 삭제·권한 변경 없음.
alter table public.chat_messages
  add constraint chat_messages_content_len_chk check (char_length(content) <= 8000),
  add constraint chat_messages_meta_size_chk check (meta is null or octet_length(meta::text) <= 4096);
alter table public.chat_sessions
  add constraint chat_sessions_title_len_chk check (title is null or char_length(title) <= 60);
