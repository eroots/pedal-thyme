import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { markdownToHtml, slug } from '../src/ui/markdown';

const squash = (h: string) => h.replace(/\n/g, '');

describe('markdown (the built-in user guide)', () => {
  it('headings get GitHub-style anchors', () => {
    expect(slug('Files, tabs and the schematics folder')).toBe('files-tabs-and-the-schematics-folder');
    expect(markdownToHtml('## Tips and troubleshooting', 'help-')).toBe('<h2 id="help-tips-and-troubleshooting">Tips and troubleshooting</h2>');
  });

  it('paragraphs, bold, code, nested lists and continuation lines', () => {
    const md = 'Some **bold** and `4k7`\nsecond line.\n\n- one\n  more of one\n  - inner\n- two\n\n  a paragraph in two\n\n1. first\n2. second';
    expect(squash(markdownToHtml(md))).toBe(
      '<p>Some <b>bold</b> and <code>4k7</code> second line.</p>'
      + '<ul><li>one more of one<ul><li>inner</li></ul></li><li>two<p>a paragraph in two</p></li></ul>'
      + '<ol><li>first</li><li>second</li></ol>');
  });

  it('tables and rules', () => {
    expect(squash(markdownToHtml('| A | B |\n|---|---|\n| **x** | y |\n\n---'))).toBe(
      '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td><b>x</b></td><td>y</td></tr></tbody></table><hr>');
  });

  it('links: sections stay in the page, web links open a new tab, other files become text', () => {
    expect(markdownToHtml('[Sound](#sound) [NAM](https://example.com/a?b=1&c=2) [dev](development.md)', 'help-')).toBe(
      '<p><a href="#" data-target="help-sound">Sound</a> <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">NAM</a> dev</p>');
  });

  it('escapes everything else', () => {
    expect(markdownToHtml('<img src=x onerror=alert(1)> `<b>`')).toBe('<p>&lt;img src=x onerror=alert(1)&gt; <code>&lt;b&gt;</code></p>');
    expect(markdownToHtml('[x](javascript:alert(1))')).toBe('<p>x)</p>');
  });

  it('every section link in the user guide leads to a heading', () => {
    const html = markdownToHtml(readFileSync(new URL('../docs/user-guide.md', import.meta.url), 'utf8'), 'help-');
    const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map(m => m[1]));
    const targets = [...html.matchAll(/data-target="([^"]+)"/g)].map(m => m[1]);
    expect(targets.length).toBeGreaterThan(10);
    expect(targets.filter(t => !ids.has(t))).toEqual([]);
  });
});
