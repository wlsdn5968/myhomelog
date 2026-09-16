# 082 — 첫 방문(랜딩 표시 중) 지도가 0×0 일 때 인기 마커 fitBounds 를 미루고, 지도가 보일 때 1회 수행

**작성 기준 커밋**: `2c8d13b` (2026-09-16) · 우선순위 P1 · 작업량 S · 의존: 없음

## 전제 확인 (계획자가 라이브·코드로 확인한 것)
- 라이브 데스크탑 첫 방문(랜딩 표시 → "건너뛰기"): 지도가 **전국 축척**으로 열리고 인기 마커 12개 중 라벨 1개만 보인다(나머지는 declutter 로 숨김) — "빈 지도 첫인상". 모바일(랜딩을 이미 본 상태)은 수도권 축척으로 12개가 보인다.
- 원인(코드):
  - `frontend/index.html:3574` 초기화에서 `setTimeout(loadPopularMarkers, 100)`.
  - `loadPopularMarkers()`(`:11707`) 의 `:11846~11866`: `_mapUserMoved` 가 아니고 현재 뷰포트에 마커가 0개면 수도권 마커(`metro`)에 맞춰 `mapObj.fitBounds(nb)` 1회.
  - 뷰 전환 `sv(v)`(`:11044`) 는 각 뷰를 `el.style.display = (id===v ? meta.display : 'none')` 로 토글한다(`:11044+17`). 랜딩이 떠 있는 동안 지도 뷰는 `display:none` → `#mapEl{flex:1;min-height:0}`(`:814`) 이 **0×0**. 이 상태에서 `getBounds()`/`fitBounds()` 가 계산되면 줌이 최소(6~7)로 떨어진다(숨긴 페인에서 재현: mapEl 0×0 → zoom 6).
  - `_landingDismiss`(`:3770`) → `sv('map')` → `:11044+24~27` 에서 `naver.maps.Event.trigger(mapObj,'resize')` 만 하고 **다시 맞추지 않는다**.

## 범위
- 수정: `frontend/index.html` 의 `loadPopularMarkers` fit 블록과 `sv()` 의 `v==='map'` 분기. 마커 생성·declutter·`_mapUserMoved` 의미는 불변.

## Step 1 — fit 블록을 함수로 뽑고 0×0 이면 보류
`:11846~11866` 의 `try { if (!window._mapUserMoved) { … fitBounds … } } catch(_) {}` 를 다음으로 바꾼다:
```js
    // MAP-FIT-DEFER-2026-09-16 (Plan 082): 랜딩 표시 중엔 지도 뷰가 display:none(0×0)이라 fitBounds 가
    //   전국 축척으로 떨어진다(첫 방문 데스크탑 실측). 크기가 없으면 보류했다가 sv('map') 에서 1회 수행.
    window._fitPopularMetro = function(){
      try {
        if (window._mapUserMoved) return;
        const me = document.getElementById('mapEl'); const rc = me && me.getBoundingClientRect();
        if (!rc || rc.width < 50 || rc.height < 50) { window._popFitPending = true; return; }
        window._popFitPending = false;
        const metro = popular.filter(p => p.lat >= 36.9 && p.lat <= 37.85 && p.lng >= 126.35 && p.lng <= 127.45);
        let vis = 0;
        const b = mapObj.getBounds && mapObj.getBounds();
        if (b) {
          vis = popular.filter(p => isNaver
            ? b.hasLatLng(new naver.maps.LatLng(p.lat, p.lng))
            : (b.contains && b.contains([p.lat, p.lng]))).length;
        }
        if (!vis && metro.length >= 3) {
          if (isNaver) {
            const nb = new naver.maps.LatLngBounds();
            metro.forEach(p => nb.extend(new naver.maps.LatLng(p.lat, p.lng)));
            mapObj.fitBounds(nb);
          } else if (window.L) {
            mapObj.fitBounds(L.latLngBounds(metro.map(p => [p.lat, p.lng])), { padding: [40, 40] });
          }
        }
      } catch(_) {}
    };
    window._fitPopularMetro();
```
(기존 조건·좌표 상자·분기는 **그대로** 옮긴다. `popular`·`isNaver` 는 그 스코프의 기존 변수.)

## Step 2 — `sv()` 의 지도 분기 (`:11044+24~27`, `naver.maps.Event.trigger(mapObj,'resize')` 다음 줄)
```js
      // MAP-FIT-DEFER-2026-09-16 (Plan 082): 랜딩 중 보류된 인기 마커 맞춤을 지도가 보일 때 1회 수행.
      if (window._popFitPending && typeof window._fitPopularMetro === 'function') setTimeout(() => { try { window._fitPopularMetro(); } catch(_) {} }, 60);
```
(Leaflet 분기 `invalidateSize()` 뒤에도 같은 줄이 실행되도록 분기 **바깥**에 둔다.)

## 검증·완료 기준
- `npm run verify` → `fail 0`(382). 프론트 계약 테스트가 `fitBounds(` 개수나 `_mapUserMoved` 문자열을 세면 기대치를 갱신하고 보고(`grep -rn "fitBounds\|_mapUserMoved\|loadPopularMarkers" backend/test/`).
- 정적: `grep -c "MAP-FIT-DEFER-2026-09-16" frontend/index.html` → 2 · `grep -c "_fitPopularMetro" frontend/index.html` → ≥3.
- 리뷰어 라이브 검증(배포 후): 랜딩 플래그 제거 → 첫 방문 재현 → 건너뛰기 → `mapObj.getZoom()` 이 10 안팎(수도권)이어야 한다. 실행자는 브라우저 검증 불필요.
- 커밋 1개: `fix(지도): 랜딩 중 0×0 지도에서 인기 마커 fitBounds 가 전국 축척으로 떨어지던 것 — 보일 때 1회 맞춤 (Plan 082)`.

## STOP 조건
- `:11846~11866` 의 실제 코드가 위 발췌와 다르다(변수명·조건) → 실제 코드를 보고하고 멈춘다.
