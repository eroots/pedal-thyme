// Small-signal model around a DC operating point: every diode, BJT, JFET and MOSFET is replaced by
// conductances, VCCSs ('G') and junction capacitances, so the ordinary AC Circuit can solve it.
import { dcOp, type DcOptions, type OpPoint } from './dc';
import { Circuit } from './mna';
import { isNonlinear, type Element, type Netlist } from './netlist';
import { bjtModel, jfetModel, mosModel } from './semis';

/** Diode/junction conductances below this are left open (they'd only add ~1e-12 S anyway). */
const G_OPEN = 1e-12;

export function linearize(nl: Netlist, op: OpPoint): Netlist {
  const out: Element[] = [];
  for (const e of nl.elements) {
    const d = op.devices.get(e);
    if (!d) { if (!isNonlinear(e)) out.push(e); continue; }
    if (e.type === 'D' && d.type === 'D') {
      if (d.gd > G_OPEN) out.push({ type: 'R', name: `${e.name}.rd`, a: e.a, b: e.k, value: 1 / d.gd });
    } else if (e.type === 'Q' && d.type === 'Q') {
      const m = bjtModel(e.model);
      // Currents into c and b, linear in v(b,e) and v(b,c); the emitter takes the remainder.
      const g = (name: string, p: string, cp: string, cn: string, gm: number) => {
        if (gm !== 0) out.push({ type: 'G', name: `${e.name}.${name}`, p, n: e.e, cp, cn, gm });
      };
      g('gm', e.c, e.b, e.e, d.dic_dvbe);
      g('gmr', e.c, e.b, e.c, d.dic_dvbc);
      g('gpi', e.b, e.b, e.e, d.dib_dvbe);
      g('gmu', e.b, e.b, e.c, d.dib_dvbc);
      out.push({ type: 'C', name: `${e.name}.cje`, a: e.b, b: e.e, value: m.cje });
      out.push({ type: 'C', name: `${e.name}.cjc`, a: e.b, b: e.c, value: m.cjc });
    } else if ((e.type === 'J' && d.type === 'J') || (e.type === 'M' && d.type === 'M')) {
      const m = e.type === 'J' ? jfetModel(e.model) : mosModel(e.model);
      if (d.type === 'M' && d.gbody > G_OPEN) out.push({ type: 'R', name: `${e.name}.rbody`, a: e.s, b: e.d, value: 1 / d.gbody });
      if (d.gm) out.push({ type: 'G', name: `${e.name}.gm`, p: e.d, n: e.s, cp: e.g, cn: e.s, gm: d.gm });
      if (d.gds > G_OPEN) out.push({ type: 'R', name: `${e.name}.rds`, a: e.d, b: e.s, value: 1 / d.gds });
      out.push({ type: 'C', name: `${e.name}.cgs`, a: e.g, b: e.s, value: m.cgs });
      out.push({ type: 'C', name: `${e.name}.cgd`, a: e.g, b: e.d, value: m.cgd });
    }
  }
  return { ...nl, elements: out };
}

export interface AcModel {
  circuit: Circuit;
  /** Operating point, or null for a circuit with no semiconductors. */
  op: OpPoint | null;
}

/** AC circuit for any netlist: biased and linearised first when it contains semiconductors. */
export function acModel(nl: Netlist, opt: DcOptions = {}): AcModel {
  if (!nl.elements.some(isNonlinear)) return { circuit: new Circuit(nl), op: null };
  const op = dcOp(nl, opt);
  return { circuit: new Circuit(linearize(nl, op)), op };
}
