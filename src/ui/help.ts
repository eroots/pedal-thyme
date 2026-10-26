// Help: the user guide (docs/user-guide.md, built into the app so it works offline) in a dialog.
import guide from '../../docs/user-guide.md?raw';
import { markdownToHtml } from './markdown';

const ID = 'help-';

export function initHelp(): void {
  const dlg = document.getElementById('helpDlg') as HTMLDialogElement, body = document.getElementById('helpBody')!;
  let rendered = false;
  document.getElementById('helpBtn')!.addEventListener('click', () => {
    if (!rendered) { body.innerHTML = markdownToHtml(guide, ID); rendered = true; }
    dlg.showModal();
    body.scrollTop = 0;
  });
  document.getElementById('helpClose')!.addEventListener('click', () => dlg.close());
  // Clicking the backdrop (outside the dialog's box) closes it too.
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  // Links between sections scroll within the guide (the page's own #hash picks the app's section).
  body.addEventListener('click', e => {
    const a = (e.target as Element).closest<HTMLAnchorElement>('a[data-target]');
    if (!a) return;
    e.preventDefault();
    document.getElementById(a.dataset.target!)?.scrollIntoView({ block: 'start' });
  });
}
