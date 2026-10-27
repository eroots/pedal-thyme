// Export a netlist as a SPICE deck (tested against LTspice syntax) for cross-checking.
import { potFraction } from '../core/pots';
import type { Term } from '../core/termination';
import { clamp } from '../core/units';
import { DIODE_MODELS, OPAMP_MODELS, opAmpModel } from './models';
import { BJT_MODELS, JFET_MODELS, MOS_MODELS } from './semis';
import { GND, elementNodes, type Netlist, type Node } from './netlist';

export interface SpiceOptions {
  title?: string;
  /** Source/load termination; omitted parts are ideal. */
  term?: Term | null;
  /** AC sweep range in Hz. */
  fmin?: number;
  fmax?: number;
  /** Extra comment lines (e.g. knob settings). */
  notes?: string[];
}

/** SPICE number: plain exponent notation (SPICE reads "M" as milli, so avoid SI suffixes). */
export const spiceNum = (x: number): string => {
  if (x === 0) return '0';
  return String(parseFloat(x.toPrecision(6)));
};

const safe = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
/** Element names must start with their SPICE type letter. */
const ename = (letter: string, name: string) => (safe(name).toUpperCase().startsWith(letter) ? safe(name) : letter + safe(name));

export function toSpice(nl: Netlist, opt: SpiceOptions = {}): string {
  const nodeName = (n: Node) => (n === GND ? '0' : safe(n));
  const lines: string[] = [];
  const models = new Set<string>(), opamps = new Set<string>(), qmodels = new Set<string>(), jmodels = new Set<string>(), mmodels = new Set<string>();
  lines.push(`* ${opt.title || nl.title || 'Pedal Thyme circuit'}`);
  lines.push('* Exported from Pedal Thyme. Input node: ' + nodeName(nl.input) + ', output node: ' + nodeName(nl.output));
  for (const n of opt.notes || []) lines.push('* ' + n);
  lines.push('');

  // Signal source (with optional source impedance) and load.
  const src = opt.term?.src;
  if (src && src.on) {
    const hasL = src.L > 0;
    lines.push(`V_IN src_ideal 0 AC 1`);
    lines.push(`R_SRC src_ideal ${hasL ? 'src_rl' : nodeName(nl.input)} ${spiceNum(src.R || 1e-3)}`);
    if (hasL) lines.push(`L_SRC src_rl ${nodeName(nl.input)} ${spiceNum(src.L)}`);
    if (src.C > 0) lines.push(`C_CABLE ${nodeName(nl.input)} 0 ${spiceNum(src.C)}`);
  } else {
    lines.push(`V_IN ${nodeName(nl.input)} 0 AC 1`);
  }
  const load = opt.term?.load;
  if (load && load.on) {
    if (load.R > 0) lines.push(`R_LOAD ${nodeName(nl.output)} 0 ${spiceNum(load.R)}`);
    if (load.C > 0) lines.push(`C_LOAD ${nodeName(nl.output)} 0 ${spiceNum(load.C)}`);
  }
  lines.push('');

  for (const e of nl.elements) {
    const nn = elementNodes(e).map(nodeName);
    switch (e.type) {
      case 'R': lines.push(`${ename('R', e.name)} ${nn[0]} ${nn[1]} ${spiceNum(e.value)}`); break;
      case 'C': if (e.value > 0) lines.push(`${ename('C', e.name)} ${nn[0]} ${nn[1]} ${spiceNum(e.value)}`); else lines.push(`* ${e.name} omitted (0 F)`); break;
      case 'L': lines.push(`${ename('L', e.name)} ${nn[0]} ${nn[1]} ${spiceNum(e.value)}`); break;
      case 'V': lines.push(`${ename('V', e.name)} ${nn[0]} ${nn[1]} DC ${spiceNum(e.dc)}${e.ac ? ` AC ${spiceNum(e.ac)}` : ''}`); break;
      case 'E': lines.push(`${ename('E', e.name)} ${nn[0]} ${nn[1]} ${nn[2]} ${nn[3]} ${spiceNum(e.gain)}`); break;
      case 'OA': {
        const key = OPAMP_MODELS[e.model] ? e.model : 'ideal';
        opamps.add(key);
        lines.push(`X${safe(e.name)} ${nodeName(e.inP)} ${nodeName(e.inN)} ${nodeName(e.out)} ${opAmpSubcktName(key)}`);
        break;
      }
      case 'POT': {
        const f = clamp(potFraction(e.rot, e.taper, e.reverse), 1e-4, 1 - 1e-4);
        lines.push(`* ${e.name}: ${spiceNum(e.value)} ohm pot, taper ${e.taper}, rotation ${(e.rot * 100).toFixed(0)}%${e.reverse ? ', reversed' : ''}`);
        lines.push(`${ename('R', e.name + '_1')} ${nn[0]} ${nn[1]} ${spiceNum(e.value * f)}`);
        lines.push(`${ename('R', e.name + '_3')} ${nn[1]} ${nn[2]} ${spiceNum(e.value * (1 - f))}`);
        break;
      }
      case 'RHEO':
        lines.push(`* ${e.name}: ${spiceNum(e.value)} ohm pot as variable resistor, taper ${e.taper}, rotation ${(e.rot * 100).toFixed(0)}%${e.reverse ? ', reversed' : ''}`);
        lines.push(`${ename('R', e.name)} ${nn[0]} ${nn[1]} ${spiceNum(Math.max(1, e.value * potFraction(e.rot, e.taper, e.reverse)))}`);
        break;
      case 'SW':
        lines.push(e.closed ? `${ename('R', e.name)} ${nn[0]} ${nn[1]} 1e-3 ; switch closed` : `* ${e.name}: switch open`);
        break;
      case 'SPDT':
        lines.push(`${ename('R', e.name)} ${nn[0]} ${e.pos === 'a' ? nn[1] : nn[2]} 1e-3 ; switch to ${e.pos}`);
        break;
      case 'D':
        models.add(e.model);
        lines.push(`${ename('D', e.name)} ${nn[0]} ${nn[1]} ${safe(e.model)}`);
        break;
      case 'Q':
        qmodels.add(e.model);
        lines.push(`${ename('Q', e.name)} ${nn[0]} ${nn[1]} ${nn[2]} ${safe(e.model)}`);
        break;
      case 'J':
        jmodels.add(e.model);
        lines.push(`${ename('J', e.name)} ${nn[0]} ${nn[1]} ${nn[2]} ${safe(e.model)}`);
        break;
      case 'M':
        // Discrete MOSFET: body tied to source (its bulk junction is the body diode). W=L=1 makes the
        // model's per-metre gate overlap capacitances (Cgso, Cgdo) come out in farads.
        mmodels.add(e.model);
        lines.push(`${ename('M', e.name)} ${nn[0]} ${nn[1]} ${nn[2]} ${nn[2]} ${safe(e.model)} W=1 L=1`);
        break;
      case 'G': lines.push(`${ename('G', e.name)} ${nn[0]} ${nn[1]} ${nn[2]} ${nn[3]} ${spiceNum(e.gm)}`); break;
    }
  }

  const lib = modelLines({ opamps, diodes: models, bjts: qmodels, jfets: jmodels, mosfets: mmodels });
  if (lib.length) lines.push('', ...lib);

  lines.push('');
  lines.push(`.ac dec 100 ${spiceNum(opt.fmin ?? 10)} ${spiceNum(opt.fmax ?? 100e3)}`);
  lines.push('.end');
  return lines.join('\n') + '\n';
}

export interface UsedModels { opamps: Set<string>; diodes: Set<string>; bjts: Set<string>; jfets: Set<string>; mosfets: Set<string> }

export const opAmpSubcktName = (key: string): string => `OPAMP_${safe(OPAMP_MODELS[key] ? key : 'ideal')}`;

/**
 * .subckt definitions for op-amps and .model cards for semiconductors. `ports` sets the op-amp subckt's
 * port order: 'p-n' = (in+, in−, out) as used by toSpice; 'n-p' = (in−, in+, out) as LTspice's opamp symbol.
 * `suffix` renames the models (LTspice already ships 2N3904, 1N914 … and rejects a second definition).
 */
export function modelLines(u: UsedModels, ports: 'p-n' | 'n-p' = 'p-n', suffix = ''): string[] {
  const lines: string[] = [];
  for (const key of u.opamps) {
    const m = opAmpModel(key);
    lines.push(`* ${m.label}: single-pole macromodel (A0, GBW, Rin, Rout); no slew or swing limits`);
    // LTspice's opamp symbol passes Aol/GBW parameters, so that variant accepts (and ignores) them.
    lines.push(`.subckt ${opAmpSubcktName(key)} ${ports === 'p-n' ? 'inp inn out' : 'inn inp out params: Aol=100K GBW=10Meg'}`);
    if (m.a0 === Infinity) {
      lines.push('E1 out 0 inp inn 1e9');
    } else {
      const fp = m.gbw / m.a0; // dominant pole
      if (isFinite(m.rin)) lines.push(`Rin inp inn ${spiceNum(m.rin)}`);
      lines.push(`E1 a 0 inp inn ${spiceNum(m.a0)}`);
      lines.push('Rp a b 1e3');
      lines.push(`Cp b 0 ${spiceNum(1 / (2 * Math.PI * 1e3 * fp))}`);
      lines.push('E2 c 0 b 0 1');
      lines.push(`Rout c out ${spiceNum(Math.max(m.rout, 1e-3))}`);
    }
    lines.push('.ends');
  }
  const card = (key: string, m: { spice: string; approx?: boolean } | undefined, what: string, note = ' ; approximate') =>
    lines.push(m ? `.model ${safe(key)}${suffix} ${m.spice}${m.approx ? note : ''}` : `* unknown ${what} model ${key}`);
  for (const key of u.diodes) card(key, DIODE_MODELS[key], 'diode');
  for (const key of u.bjts) card(key, BJT_MODELS[key], 'transistor');
  for (const key of u.jfets) card(key, JFET_MODELS[key], 'JFET');
  for (const key of u.mosfets) card(key, MOS_MODELS[key], 'MOSFET', ' ; approximate: thresholds vary between samples');
  return lines;
}
