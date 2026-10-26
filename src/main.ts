import './styles.css';
import { initBuilder } from './builder/ui';
import { initPlayground } from './playground/ui';
import { initHelp } from './ui/help';

type Section = 'playground' | 'builder' | 'board';
const SECTIONS: Section[] = ['playground', 'builder', 'board'];
const SECTION_KEY = 'pedal-filter-lab.section';

// Which release this is (the app never checks online, so people can compare it with the latest release).
const versionEl = document.getElementById('appVersion');
if (versionEl) versionEl.textContent = `v${__APP_VERSION__}`;

initHelp();

// Leaving with work that isn't saved to a file: the open tabs are kept in the browser's storage, but
// that can be cleared (private windows, clean-up tools), so the browser asks first.
window.addEventListener('beforeunload', e => {
  if (builder.unsaved().length) { e.preventDefault(); e.returnValue = ''; }
});

const builder = initBuilder({ showBoard: () => show('board'), showBuilder: () => show('builder') });
initPlayground({
  openInBuilder: doc => { builder.load(doc); show('builder'); },
});

function show(section: Section): void {
  document.getElementById('playground')!.hidden = section !== 'playground';
  document.getElementById('builder')!.hidden = section !== 'builder';
  document.getElementById('board')!.hidden = section !== 'board';
  document.body.dataset.section = section;
  document.querySelectorAll<HTMLButtonElement>('nav.sections button').forEach(b => {
    const on = b.dataset.section === section;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  try { localStorage.setItem(SECTION_KEY, section); } catch { /* ignore */ }
  if (location.hash !== '#' + section) history.replaceState(null, '', '#' + section);
  if (section === 'builder') builder.shown();
  else if (section === 'board') builder.boardShown();
  else window.dispatchEvent(new Event('resize'));
}

document.querySelector('nav.sections')!.addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-section]');
  if (b) show(b.dataset.section as Section);
});

window.addEventListener('hashchange', () => {
  const h = location.hash.slice(1);
  if (SECTIONS.includes(h as Section)) show(h as Section);
});

const fromHash = location.hash.slice(1);
let initial: Section = 'playground';
try { initial = (localStorage.getItem(SECTION_KEY) as Section) || initial; } catch { /* ignore */ }
if (!SECTIONS.includes(initial)) initial = 'playground';
show(SECTIONS.includes(fromHash as Section) ? (fromHash as Section) : initial);
