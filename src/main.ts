import './styles.css';
import { initBuilder } from './builder/ui';
import { initPlayground } from './playground/ui';

type Section = 'playground' | 'builder';
const SECTION_KEY = 'pedal-filter-lab.section';

const builder = initBuilder();
initPlayground({
  openInBuilder: doc => { builder.load(doc); show('builder'); },
});

function show(section: Section): void {
  document.getElementById('playground')!.hidden = section !== 'playground';
  document.getElementById('builder')!.hidden = section !== 'builder';
  document.body.dataset.section = section;
  document.querySelectorAll<HTMLButtonElement>('nav.sections button').forEach(b => {
    const on = b.dataset.section === section;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  try { localStorage.setItem(SECTION_KEY, section); } catch { /* ignore */ }
  if (location.hash !== '#' + section) history.replaceState(null, '', '#' + section);
  if (section === 'builder') builder.shown();
  else window.dispatchEvent(new Event('resize'));
}

document.querySelector('nav.sections')!.addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-section]');
  if (b) show(b.dataset.section as Section);
});

window.addEventListener('hashchange', () => {
  const h = location.hash.slice(1);
  if (h === 'builder' || h === 'playground') show(h);
});

const fromHash = location.hash.slice(1);
let initial: Section = 'playground';
try { initial = (localStorage.getItem(SECTION_KEY) as Section) || initial; } catch { /* ignore */ }
show(fromHash === 'builder' || fromHash === 'playground' ? fromHash : initial);
