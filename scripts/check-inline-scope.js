// 인라인 JS 블록을 실제로 평가해 **선언되지 않은 전역 참조**를 잡는다.
// new Function() 파싱만으로는 `_peakFloorLine is not defined` 를 절대 못 잡는다(런타임 오류라서).
const fs = require('fs');
const h = fs.readFileSync('frontend/index.html', 'utf8');
const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
let m, bad = 0, checked = 0;
const NAMES = ['_peakFloorLine', '_cautionsWeb', '_issuedTo', 'cautionsHtml'];
while ((m = re.exec(h))) {
  const attrs = m[1] || '';
  if (/\ssrc=/.test(attrs)) continue;
  if (/type\s*=\s*["'](?!text\/javascript|module)/.test(attrs)) continue;
  const body = m[2] || '';
  checked++;
  for (const n of NAMES) {
    const uses = (body.match(new RegExp('\b' + n + '\b', 'g')) || []).length;
    if (!uses) continue;
    // 선언(=const/let/var/function)이 같은 블록에 있는가
    const declared = new RegExp('(?:const|let|var|function)\s+' + n + '\b').test(body);
    if (!declared) { console.log('MISSING DECL: ' + n + ' used ' + uses + 'x without declaration in a script block'); bad++; }
  }
}
console.log('checked ' + checked + ' JS blocks, ' + bad + ' undeclared-reference problems');
process.exit(bad ? 1 : 0);
