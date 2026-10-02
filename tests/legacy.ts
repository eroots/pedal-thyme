// The pre-Phase-1 hand-written transfer functions, kept verbatim as test oracles for the netlist
// versions. Includes the ladder/nodal helpers they relied on. Not used by the app.
import { Cx, cx, ONE, par, Zc, Yr, Yc } from '../src/core/complex';
import { taper, potSplit } from '../src/core/pots';
import type { Opts, Values, Zterm } from '../src/core/types';

const num = (o: Opts, k: string) => Number(o[k]);
const addZs = (z: Zterm | null | undefined, x: Cx): Cx => (z && z.zs ? x.add(z.zs) : x);
const parZl = (z: Zterm | null | undefined, x: Cx): Cx => (z && z.zl ? par(x, z.zl) : x);

interface LadderStage { ser: Cx; sh: Cx }
function ladder(stages: LadderStage[], buffered: boolean, z?: Zterm | null): Cx {
  if (z && (z.zs || z.zl)) {
    stages = stages.map((st, i) => ({
      ser: i === 0 ? addZs(z, st.ser) : st.ser,
      sh: i === stages.length - 1 ? parZl(z, st.sh) : st.sh,
    }));
  }
  if (buffered) return stages.reduce((h, st) => h.mul(st.sh.div(st.ser.add(st.sh))), ONE);
  const n = stages.length, shEff: Cx[] = new Array(n);
  let zNext: Cx | null = null;
  for (let i = n - 1; i >= 0; i--) {
    shEff[i] = zNext ? par(stages[i].sh, zNext) : stages[i].sh;
    zNext = stages[i].ser.add(shEff[i]);
  }
  let h = ONE;
  for (let i = 0; i < n; i++) h = h.mul(shEff[i].div(stages[i].ser.add(shEff[i])));
  return h;
}

type Elem = [number, number, Cx];
/** The old nodal solver (1 mΩ input source). */
function nodal(n: number, elems: Elem[], inNode: number, zs?: Cx | null): Cx[] {
  const A = Array.from({ length: n }, () => Array.from({ length: n }, () => new Cx(0, 0)));
  const b = Array.from({ length: n }, () => new Cx(0, 0));
  const stamp = (i: number, j: number, y: Cx) => {
    if (i) A[i - 1][i - 1] = A[i - 1][i - 1].add(y);
    if (j) A[j - 1][j - 1] = A[j - 1][j - 1].add(y);
    if (i && j) { A[i - 1][j - 1] = A[i - 1][j - 1].sub(y); A[j - 1][i - 1] = A[j - 1][i - 1].sub(y); }
  };
  for (const [i, j, y] of elems) stamp(i, j, y);
  const ys = ONE.div(zs || cx(1e-3));
  stamp(inNode, 0, ys);
  b[inNode - 1] = ys;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (A[r][c].abs() > A[p][c].abs()) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c].div(A[c][c]);
      for (let k = c; k < n; k++) A[r][k] = A[r][k].sub(f.mul(A[c][k]));
      b[r] = b[r].sub(f.mul(b[c]));
    }
  }
  const x: Cx[] = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let acc = b[r];
    for (let k = r + 1; k < n; k++) acc = acc.sub(A[r][k].mul(x[k]));
    x[r] = acc.div(A[r][r]);
  }
  return [new Cx(0, 0), ...x];
}

const sallenKey = (Z1: Cx, Z2: Cx, Z3: Cx, Z4: Cx): Cx => Z3.mul(Z4).div(Z3.mul(Z4).add(Z3.mul(Z1.add(Z2))).add(Z1.mul(Z2)));

type H = (v: Values, s: Cx, o: Opts, z?: Zterm | null) => Cx;

export const LEGACY_H: Record<string, H> = {
  'rc-lp': (v, s, o, z) => ladder([{ ser: cx(v.R), sh: Zc(v.C, s) }], false, z),
  'rc-hp': (v, s, o, z) => ladder([{ ser: Zc(v.C, s), sh: cx(v.R) }], false, z),
  'rc2-lp': (v, s, o, z) => ladder([{ ser: cx(v.R1), sh: Zc(v.C1, s) }, { ser: cx(v.R2), sh: Zc(v.C2, s) }], !!o.buf, z),
  'rc2-hp': (v, s, o, z) => ladder([{ ser: Zc(v.C1, s), sh: cx(v.R1) }, { ser: Zc(v.C2, s), sh: cx(v.R2) }], !!o.buf, z),
  'bp': (v, s, o, z) => ladder([{ ser: Zc(v.C1, s), sh: cx(v.R1) }, { ser: cx(v.R2), sh: Zc(v.C2, s) }], !!o.buf, z),
  'shelf-tc': (v, s, o, z) => ladder([{ ser: cx(v.R1), sh: Zc(v.C, s).add(v.R2) }], false, z),
  'shelf-bc': (v, s, o, z) => ladder([{ ser: cx(v.R1).div(ONE.add(s.scale(v.R1 * v.C))), sh: cx(v.R2) }], false, z),
  'opamp-shelf': (v, s) => {
    const zf = cx(v.Rf).div(ONE.add(s.scale(v.Rf * v.Cf)));
    const yg = s.scale(v.Cg).div(ONE.add(s.scale(v.Rg * v.Cg)));
    return ONE.add(zf.mul(yg));
  },
  'scoop-bm': (v, s, o, z) => {
    const [ra, rb] = potSplit(v.VR, num(o, 'blend') / 100);
    const els: Elem[] = [[1, 2, Yr(v.R1)], [2, 0, Yc(v.C1, s)], [1, 3, Yc(v.C2, s)], [3, 0, Yr(v.R2)], [2, 4, Yr(ra)], [4, 3, Yr(rb)]];
    if (z && z.zl) els.push([4, 0, ONE.div(z.zl)]);
    return nodal(4, els, 1, z && z.zs)[4];
  },
  'scoop-bt': (v, s, o, z) => {
    const els: Elem[] = [[1, 2, Yc(v.C1, s)], [2, 3, Yc(v.C2, s)], [2, 0, Yr(v.R1)], [1, 3, Yr(v.R2)]];
    if (z && z.zl) els.push([3, 0, ONE.div(z.zl)]);
    return nodal(3, els, 1, z && z.zs)[3];
  },
  'gyrator': (v, s, o, z) => {
    const [RA, RB] = potSplit(v.VR, (num(o, 'pos') + 100) / 200), Z1 = addZs(z, cx(v.R1));
    const zg = cx(v.R4).mul(ONE.add(s.scale(v.R3 * v.C2))).div(ONE.add(s.scale(v.R4 * v.C2)));
    const yb = ONE.div(Zc(v.C1, s).add(zg)), den = yb.add(1 / RA + 1 / RB);
    const vin = ONE.add(yb.mul(Z1).scale(1 / RA).div(den)), vout = ONE.add(yb.scale(v.R2 / RB).div(den));
    return vout.div(vin);
  },
  'ts-fmv': (v, s, o, z) => {
    const [tTop, tBot] = potSplit(v.RT, 1 - taper(num(o, 'treble') / 10, 'A'));
    const rb = Math.max(1, v.RB * taper(num(o, 'bass') / 10, 'A')), rm = Math.max(1, v.RM * taper(num(o, 'mid') / 10, 'B'));
    const els: Elem[] = [[1, 2, Yc(v.C1, s)], [2, 3, Yr(tTop)], [3, 5, Yr(tBot)], [1, 4, Yr(v.R1)],
      [4, 5, Yc(v.C2, s)], [4, 6, Yc(v.C3, s)], [5, 6, Yr(rb)], [6, 0, Yr(rm)]];
    if (z && z.zl) els.push([3, 0, ONE.div(z.zl)]);
    return nodal(6, els, 1, z && z.zs)[3];
  },
  'ts-james': (v, s, o, z) => {
    const [tTop, tBot] = potSplit(v.RT, 1 - taper(num(o, 'treble') / 10, 'A'));
    const [bTop, bBot] = potSplit(v.RB, 1 - taper(num(o, 'bass') / 10, 'A'));
    const els: Elem[] = [[1, 2, Yc(v.C1, s)], [2, 4, Yr(tTop)], [4, 3, Yr(tBot)], [3, 0, Yc(v.C2, s)],
      [1, 5, Yr(v.R1)], [5, 7, Yr(bTop)], [7, 6, Yr(bBot)], [5, 7, Yc(v.C3, s)], [7, 6, Yc(v.C4, s)], [6, 0, Yr(v.R2)],
      [7, 4, Yr(v.R3)]];
    if (z && z.zl) els.push([4, 0, ONE.div(z.zl)]);
    return nodal(7, els, 1, z && z.zs)[4];
  },
  'sk-lp': (v, s, o, z) => sallenKey(addZs(z, cx(v.R1)), cx(v.R2), Zc(v.C1, s), Zc(v.C2, s)),
  'sk-hp': (v, s, o, z) => sallenKey(addZs(z, Zc(v.C1, s)), Zc(v.C2, s), cx(v.R1), cx(v.R2)),
  'mfb-lp': (v, s, o, z) => {
    const Z1 = addZs(z, cx(v.R1)), k = cx(v.R2).div(Z1);
    const d1 = k.scale(v.R3).add(v.R2 + v.R3).mul(s.scale(v.C2));
    return k.scale(-1).div(ONE.add(d1).add(s.mul(s).scale(v.C1 * v.C2 * v.R2 * v.R3)));
  },
  'mfb-bp': (v, s, o, z) => {
    const Y1 = ONE.div(addZs(z, cx(v.R1)));
    return s.scale(-v.C1 * v.R2).mul(Y1).div(Y1.add(1 / v.R3).add(s.scale(v.C1 + v.C2)).add(s.mul(s).scale(v.C1 * v.C2 * v.R2)));
  },
};
