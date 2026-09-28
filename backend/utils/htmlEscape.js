'use strict';
// ESC-UNIFY-2026-09-28 (Plan 124): SSR 라우트(aptPage·regionPage·briefing)의 같은 escape 3벌을 하나로.
//   null/undefined → '' · 그 외(0·false 포함)는 String() — share.js 의 escapeHtml 은 '$' 방어층이 있어 별도 유지.
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
module.exports = { escHtml };
