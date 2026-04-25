-- D1 정정거래 dedup_key 수정 (감사 보고서 1-1 🟠 — 2026-04-25)
--
-- 문제:
--   기존 dedup_key = md5(... || deal_amount::text)
--   → 같은 거래가 정정되어 금액 변경 시 다른 dedup_key 생성 → 두 row 잔존
--   → 사용자에게 동일 단지·일자에 거래 2건 노출 (오인)
--
-- 수정:
--   dedup_key 에서 deal_amount 제외 → (apt, 면적, 일자, 층) 조합만 사용
--   → 정정 시 같은 dedup_key → ON CONFLICT DO UPDATE 로 deal_amount 갱신
--   → molitIngest.js 의 upsert ignoreDuplicates:false 로 변경 (별도 commit)
--
-- 절차:
--   1) 새 컬럼 dedup_key_v2 추가 (GENERATED, deal_amount 제외)
--   2) 같은 v2 중 ingested_at 최신만 남김
--   3) 기존 unique index drop
--   4) 기존 dedup_key drop
--   5) v2 → dedup_key rename
--   6) unique index 재생성

ALTER TABLE public.molit_transactions
  ADD COLUMN dedup_key_v2 TEXT GENERATED ALWAYS AS (
    md5(
      COALESCE(apt_seq, apt_name || ':' || COALESCE(umd_nm, '')) || '|' ||
      exclu_use_ar::text || '|' ||
      deal_year::text || '-' || deal_month::text || '-' || deal_day::text || '|' ||
      COALESCE(floor, 0)::text
    )
  ) STORED;

DELETE FROM public.molit_transactions a
USING public.molit_transactions b
WHERE a.dedup_key_v2 = b.dedup_key_v2
  AND a.id < b.id;

DROP INDEX IF EXISTS public.uq_molit_dedup;
ALTER TABLE public.molit_transactions DROP COLUMN dedup_key;
ALTER TABLE public.molit_transactions RENAME COLUMN dedup_key_v2 TO dedup_key;
CREATE UNIQUE INDEX uq_molit_dedup ON public.molit_transactions (dedup_key);
