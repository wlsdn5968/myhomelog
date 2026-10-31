-- Plan 185 카카오맵 1대1 대조 대상 (관리 지역 125곳). 읽기 전용. 2026-10-31 작성·같은 날 산 번지 판정 정정.
-- 다시 돌릴 때: 결과의 rn 범위를 나눠 카카오 장소 검색·상세로 대조한다(plans/185-kakao-1to1-audit.md 방법 절).
with lawds as (select distinct lawd_cd from molit_ingest_runs where status in ('ok','archived')),
idx as materialized (select apt_name, sigungu, umd_nm, lawd_cd, max(build_year) by_, sum(deal_count) dc, max(recent_deal_date) rd
  from molit_apt_index where lawd_cd in (select lawd_cd from lawds) group by 1,2,3,4),
-- 2026-10-31 정정: 국토부 지번이 블록 번호("가-", "BL-19")면 숫자 지번과 비교할 수 없다 — 숫자 지번만 쓰고 앞의 "산"은 뗀다.
dimj as materialized (select apt_name, sigungu, umd_nm, array_agg(distinct regexp_replace(jibun,'^산','')) js from molit_apt_dim
  where lawd_cd in (select lawd_cd from lawds) and jibun ~ '^산?[0-9]' group by 1,2,3),
al as materialized (select m.kapt_code, m.apt_name master, m.sigungu, m.lawd_cd, m.umd_nm, split_part(x,'#',1) nm
  from apt_master m, jsonb_array_elements_text(case when jsonb_typeof(m.molit_aliases)='array' then m.molit_aliases else '[]' end) x
  where m.lawd_cd in (select lawd_cd from lawds)),
g as materialized (select g.apt_key, g.apt_name, g.sigungu, g.umd_nm, g.lat, g.lng, g.place_name, g.address, g.source, idx.rd, idx.dc, idx.by_,
  regexp_split_to_array(trim(coalesce(g.address,'')),'\s+') t,
  -- 2026-10-31 정정: 산 번지("죽곡리 산 56-1")는 마지막 앞 낱말이 "산"이라 동이 한 칸 앞에 있다(첫 조사에서 11곳이 이 때문에 "다른 동"으로 잘못 걸렸다).
  (case when (regexp_split_to_array(trim(coalesce(g.address,'')),'\s+'))[array_length(regexp_split_to_array(trim(coalesce(g.address,'')),'\s+'),1)-1] = '산'
        then (regexp_split_to_array(trim(coalesce(g.address,'')),'\s+'))[array_length(regexp_split_to_array(trim(coalesce(g.address,'')),'\s+'),1)-2]
        else (regexp_split_to_array(trim(coalesce(g.address,'')),'\s+'))[array_length(regexp_split_to_array(trim(coalesce(g.address,'')),'\s+'),1)-1] end) dtok,
  split_part(g.umd_nm,' ',array_length(string_to_array(g.umd_nm,' '),1)) dong,
  regexp_replace(regexp_replace(replace(g.apt_name,' ',''),'\([^)]*\)','','g'),'아파트$','') nn
  from apt_geocache g join idx on idx.apt_name=g.apt_name and idx.sigungu=g.sigungu and idx.umd_nm=g.umd_nm
  where g.apt_key like 'name:%' and g.source<>'kakao-x'),
c_fac as (select 'A_facility' cat, apt_key k, apt_name, sigungu, umd_nm, lat, lng, place_name, address, by_, rd from g
  where place_name ~ '관리사무소|경비실|관리동|상가|주차장|어린이집|유치원|놀이터|경로당|노인정|입구|정문|후문|충전소|공인중개|부동산|교회|성당|학원|마트|편의점|약국|병원|의원|치과|미용|세탁|카페|식당|출구|정류장|주민센터|복지관|택시|은행|우체국'
    and not (apt_name ~ '상가|관리|센터')),
c_dong as (select 'B_other_dong' cat, apt_key k, apt_name, sigungu, umd_nm, lat, lng, place_name, address, by_, rd from g
  where t[array_length(t,1)] ~ '^[0-9]+(-[0-9]+)?$' and dtok <> dong),
c_jib as (select 'C_jibun' cat, g.apt_key k, g.apt_name, g.sigungu, g.umd_nm, g.lat, g.lng, g.place_name, g.address, g.by_, g.rd from g
  join dimj d on d.apt_name=g.apt_name and d.sigungu=g.sigungu and d.umd_nm=g.umd_nm
  where t[array_length(t,1)] ~ '^[0-9]+(-[0-9]+)?$' and g.dtok = g.dong
    and not (split_part(t[array_length(t,1)],'-',1) = any(select split_part(j,'-',1) from unnest(d.js) j))),
c_nocoord as (select 'D_no_coord' cat, 'name:'||idx.apt_name||'|'||idx.sigungu||'|'||idx.umd_nm k, idx.apt_name, idx.sigungu, idx.umd_nm,
    null::numeric lat, null::numeric lng, null place_name, null address, idx.by_, idx.rd from idx
  where idx.rd >= current_date-180 and not exists (select 1 from apt_geocache x where x.apt_key like 'name:%' and x.apt_name=idx.apt_name and x.sigungu=idx.sigungu and x.umd_nm=idx.umd_nm and x.source<>'kakao-x')),
b as materialized (select idx.*, regexp_replace(regexp_replace(regexp_replace(replace(idx.apt_name,' ',''),'\([^)]*\)','','g'),'[0-9]+동(~[0-9]+동)?$|[A-Da-d]$|[가나다라]동?$',''),'(아파트)$','') base from idx),
grp as (select b.lawd_cd, b.sigungu, b.umd_nm, b.base, array_agg(b.apt_name order by b.apt_name) names, count(distinct coalesce(al.kapt_code,'N:'||b.apt_name)) gg,
    count(distinct b.by_) ny, max(b.rd) rd, max(b.by_) by_
  from b left join al on al.lawd_cd=b.lawd_cd and al.umd_nm=b.umd_nm and al.nm=b.apt_name
  where length(b.base) >= 2 group by 1,2,3,4 having count(*) >= 2),
c_split as (select 'E_split' cat, 'grp:'||sigungu||'|'||umd_nm||'|'||base k, base apt_name, sigungu, umd_nm, null::numeric lat, null::numeric lng,
    array_to_string(names,' / ') place_name, null address, by_, rd from grp where gg>=2 and ny=1 and rd>=current_date-180),
c_sus as (select 'F_unverified' cat, apt_key k, apt_name, sigungu, umd_nm, lat, lng, place_name, address, by_, rd from g
  where source not in ('kakao-v','manual') and rd >= current_date-180
    and not (replace(coalesce(place_name,''),' ','') like '%'||nn||'%' and coalesce(address,'') like '%'||dong||'%')),
c_far as (select 'G_far_from_official' cat, n.apt_key k, n.apt_name, n.sigungu, n.umd_nm, n.lat, n.lng, n.place_name, n.address, null::int by_, null::date rd
  from al join apt_geocache kk on kk.apt_key='kapt:'||al.kapt_code and kk.source<>'kakao-x'
  join apt_geocache n on n.apt_key like 'name:%' and n.apt_name=al.nm and n.umd_nm=al.umd_nm and n.sigungu=al.sigungu and n.source<>'kakao-x'
  where 6371000*2*asin(sqrt(power(sin(radians(n.lat-kk.lat)/2),2)+cos(radians(kk.lat))*cos(radians(n.lat))*power(sin(radians(n.lng-kk.lng)/2),2))) > 300),
allc as (select * from c_fac union all select * from c_dong union all select * from c_jib union all select * from c_nocoord
  union all select * from c_split union all select * from c_sus union all select * from c_far)
select row_number() over (order by cat, k) rn, cat, k, apt_name, sigungu, umd_nm, round(lat,6) lat, round(lng,6) lng, place_name, address, by_, rd from allc
