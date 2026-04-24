-- ============================================================================
-- Phase 4.3 — chat_messages 멱등성 (idempotency)
--
-- 문제:
--   - 모바일 네트워크 불안정 시 사용자가 같은 메시지 더블탭 → AI 비용 2배
--   - 또는 클라이언트 재시도 로직이 동일 요청을 중복 전송
--
-- 해법:
--   - 클라이언트가 client_msg_id (UUID v4) 를 메시지마다 생성·전송
--   - 같은 (session_id, client_msg_id) 가 들어오면 INSERT 무시 (ON CONFLICT)
--   - 서버는 기존 행 그대로 반환 → 클라이언트는 idempotent 응답 받음
-- ============================================================================

ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS client_msg_id UUID;

-- 같은 session 내에서 같은 client_msg_id 는 단 1건만 허용
CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_session_client_msg_unique
  ON public.chat_messages (session_id, client_msg_id)
  WHERE client_msg_id IS NOT NULL;

COMMENT ON COLUMN public.chat_messages.client_msg_id IS
  '클라이언트 생성 UUID — 중복 전송 방어. session 내 unique';
