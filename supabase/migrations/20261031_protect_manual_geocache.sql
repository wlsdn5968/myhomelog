-- ============================================================================
-- 2026-10-31 — Plan 185: 손 보정 좌표(source='manual')를 DB 가 지킨다 (운영자 승인 "업데이트가 되더라도 고친게 이어질수 있도록", 2026-10-31)
--   [왜] 지금은 코드가 지킨다(geocodeCacheService.saveToDb 의 manual 건너뛰기, 매일 좌표 작업은 출처 kakao·kakao-sub·kakao-v·kakao-addr 만 고름).
--     코드가 바뀌거나 새 작업이 생기면 손으로 고친 좌표가 다시 덮일 수 있다("매번 원상복구" — 운영자 지적).
--   [동작] apt_geocache 의 manual 행에 대해
--     - UPDATE 가 source 를 manual 이 아닌 값으로 바꾸려 하면 바꾸지 않는다(기존 행 유지, 오류 없이 무시 — 자동 작업이 실패로 멈추지 않게).
--     - DELETE 는 하지 않는다(무시).
--     - source 를 manual 로 유지한 채 고치는 것(손 보정끼리의 수정)은 허용.
--   [풀기] 운영자가 정말 manual 을 풀거나 지울 때만, 같은 트랜잭션에서:
--     set local myhomelog.allow_manual_geocache_change = 'on';
-- [적용 상태] 2026-10-31 apply_migration 이 거절되어(declined) 운영자 Supabase SQL Editor 실행 대기. 적용 뒤 schema.sql 끝에 덧붙인다.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.protect_manual_geocache()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF coalesce(current_setting('myhomelog.allow_manual_geocache_change', true), '') = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.source = 'manual' THEN RETURN NULL; END IF;
    RETURN OLD;
  END IF;
  IF OLD.source = 'manual' AND NEW.source IS DISTINCT FROM 'manual' THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public.protect_manual_geocache() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_protect_manual_geocache ON public.apt_geocache;
CREATE TRIGGER trg_protect_manual_geocache
  BEFORE UPDATE OR DELETE ON public.apt_geocache
  FOR EACH ROW EXECUTE FUNCTION public.protect_manual_geocache();
