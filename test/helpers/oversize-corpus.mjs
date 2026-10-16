// Deterministic inputs for chunkerC (kg-relation-evidence D3/C6/C7.4). The first four have no blank
// line, no heading, no bullet and no fence, so the whole input is ONE oversize block and goes through
// splitOversize. They are synthetic and public: shaped like the inputs that exposed the cost (an
// accessibility-tree dump, a JSON dump, minified code), not copied from them.
function take(gen, nCp) {
  const out = []; let n = 0;
  for (const piece of gen()) for (const ch of piece) { if (n === nCp) return out.join(''); out.push(ch); n++; }
  return out.join('');
}
export const accessibilityTree = (nCp) => take(function* () {
  for (let i = 0; ; i += 2) yield `[${i}] button 'Item ${i} 상세 보기' focusable: True\r\n\t[${i + 1}] StaticText '값 ${i * 7} 🎉'\n`;
}, nCp);
export const jsonDump = (nCp) => take(function* () {
  yield '[';
  for (let i = 0; ; i++) yield `{"id":${i},"name":"n${i}","tags":["a","b"],"note":"메모 ${i}"},`;
}, nCp);
export const minifiedJs = (nCp) => take(function* () {
  for (let i = 0; ; i++) yield `function f${i}(a,b){return a*${i}+b/${i + 1}};var v${i}=f${i}(${i},2);`;
}, nCp);
export const cjkAstralCrlf = (nCp) => take(function* () {
  for (let i = 0; ; i++) yield `한글${i}文字🎉𝒳\r\n`;
}, nCp);
// A structure-split document: headings, paragraphs, bullets, fences, CRLF, CJK, astral — every block
// far below 800 tokens, so splitOversize is never reached (C7.4 asserts that via decode() == 0).
export function structureDoc() {
  const F = '`'.repeat(3);
  const parts = ['# Structure parity fixture\n\nIntro paragraph for the parity test.\n\n'];
  for (let s = 0; s < 12; s++) {
    parts.push(`## Section ${s}\n\n`);
    parts.push(`Paragraph ${s} `.repeat(40) + '\n\n');
    parts.push(`- bullet ${s}.1 한글 항목\n- bullet ${s}.2 🎉 emoji\n  - nested ${s}\n\n`);
    if (s % 3 === 0) parts.push(`${F}js\n` + `function f${s}() { return ${s}; }\n`.repeat(5) + `${F}\n\n`);
    if (s % 4 === 1) parts.push(`CRLF line ${s}\r\nsecond CRLF line\r\n\r\n`);
  }
  return parts.join('');
}
