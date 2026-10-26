// A small Markdown renderer for the built-in user guide (docs/user-guide.md): headings, paragraphs,
// nested lists, tables, rules, **bold**, `code` and links. Every bit of text is escaped; links to
// sections become in-page links (their targets prefixed `idPrefix`), web links open in a new tab, and
// links to other files (which aren't in the app) become plain text.

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens. */
export const slug = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N} -]/gu, '').replace(/ /g, '-');

export function markdownToHtml(md: string, idPrefix = ''): string {
  const inline = (s: string): string => {
    const codes: string[] = [];
    let h = esc(s).replace(/`([^`]+)`/g, (_, c: string) => `\u0000${codes.push(c) - 1}\u0000`);
    h = h.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    h = h.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text: string, url: string) => {
      if (url.startsWith('#')) return `<a href="#" data-target="${idPrefix}${url.slice(1)}">${text}</a>`;
      if (/^https?:\/\//.test(url)) return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
      return text;
    });
    return h.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${codes[+i]}</code>`);
  };
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

  const out: string[] = [];
  let para: string[] = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  // Open lists, outermost first: each with its indent, tag and whether an item is open.
  const lists: { indent: number; tag: 'ul' | 'ol'; li: boolean }[] = [];
  const closeLists = (above: number) => {
    while (lists.length && lists[lists.length - 1].indent >= above) {
      const l = lists.pop()!;
      out.push(`${l.li ? '</li>' : ''}</${l.tag}>`);
    }
  };
  let blank = false;

  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], indent = line.length - line.trimStart().length, t = line.trim();
    if (!t) { flushPara(); blank = true; continue; }
    const item = /^([-*]|\d+\.) (.*)$/.exec(t);
    if (item) {
      flushPara();
      closeLists(indent + 1);
      const tag = /\d/.test(item[1]) ? 'ol' : 'ul';
      const top = lists[lists.length - 1];
      if (top && top.indent === indent && top.tag !== tag) closeLists(indent);
      const cur = lists[lists.length - 1];
      if (cur && cur.indent === indent) { if (cur.li) out.push('</li>'); }
      else { out.push(`<${tag}>`); lists.push({ indent, tag, li: false }); }
      out.push(`<li>${inline(item[2])}`);
      lists[lists.length - 1].li = true;
      blank = false;
      continue;
    }
    // A line inside a list item (indented under it): more of that item, or a new paragraph in it.
    if (lists.length && indent > 0) {
      closeLists(indent);
      if (lists.length) {
        out.push(blank ? `<p>${inline(t)}</p>` : ` ${inline(t)}`);
        blank = false;
        continue;
      }
    }
    if (blank || indent === 0) closeLists(0);
    blank = false;
    const h = /^(#{1,6}) (.*)$/.exec(t);
    if (h) {
      flushPara();
      const n = h[1].length;
      out.push(`<h${n} id="${idPrefix}${slug(h[2])}">${inline(h[2])}</h${n}>`);
      continue;
    }
    if (/^-{3,}$/.test(t)) { flushPara(); out.push('<hr>'); continue; }
    if (t.startsWith('|') && /^\|[\s:|-]+\|$/.test((lines[i + 1] ?? '').trim())) {
      flushPara();
      const head = cells(t);
      i++;
      const rows: string[][] = [];
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) rows.push(cells(lines[++i]));
      out.push(`<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    para.push(t);
  }
  flushPara();
  closeLists(0);
  return out.join('\n');
}
