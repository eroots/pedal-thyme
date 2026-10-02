// Semiconductor device models and their large-signal equations (for the DC operating point).
// Parameters follow SPICE conventions. Temperature is fixed at 300 K.

export const VT = 0.025852; // thermal voltage kT/q at 300 K

export interface BjtModel {
  label: string;
  pol: 'npn' | 'pnp';
  is: number;   // saturation current (A)
  bf: number;   // forward beta
  br: number;   // reverse beta
  vaf: number;  // forward Early voltage (V); Infinity = none
  cje: number;  // B–E junction capacitance (F), used as a constant in AC
  cjc: number;  // B–C junction capacitance (F)
  spice: string;
  approx?: boolean;
}

export interface JfetModel {
  label: string;
  pol: 'n' | 'p';
  vto: number;    // pinch-off (threshold) voltage (V): negative for N-channel
  beta: number;   // transconductance parameter (A/V²); Idss = beta · vto²
  lambda: number; // channel-length modulation (1/V)
  cgs: number; cgd: number;
  spice: string;
  approx?: boolean;
}

export const BJT_MODELS: Record<string, BjtModel> = {
  '2N3904': { label: '2N3904 (Si NPN)', pol: 'npn', is: 6.734e-15, bf: 416.4, br: 0.7371, vaf: 74.03, cje: 4.493e-12, cjc: 3.638e-12,
    spice: 'NPN(Is=6.734f Xti=3 Eg=1.11 Vaf=74.03 Bf=416.4 Ne=1.259 Ise=6.734f Ikf=66.78m Xtb=1.5 Br=.7371 Nc=2 Isc=0 Ikr=0 Rc=1 Cjc=3.638p Mjc=.3085 Vjc=.75 Fc=.5 Cje=4.493p Mje=.2593 Vje=.75 Tr=239.5n Tf=301.2p Itf=.4 Vtf=4 Xtf=2 Rb=10)' },
  '2N3906': { label: '2N3906 (Si PNP)', pol: 'pnp', is: 1.41e-15, bf: 180.7, br: 4.977, vaf: 18.7, cje: 8.063e-12, cjc: 9.728e-12,
    spice: 'PNP(Is=1.41f Xti=3 Eg=1.11 Vaf=18.7 Bf=180.7 Ne=1.5 Ise=0 Ikf=80m Xtb=1.5 Br=4.977 Nc=2 Isc=0 Ikr=0 Rc=2.5 Cjc=9.728p Mjc=.5776 Vjc=.75 Fc=.5 Cje=8.063p Mje=.3677 Vje=.75 Tr=33.42n Tf=179.3p Itf=.4 Vtf=4 Xtf=6 Rb=10)' },
  BC109: { label: 'BC109 (Si NPN, high gain)', pol: 'npn', is: 1.8e-14, bf: 400, br: 35.5, vaf: 80, cje: 1.3e-11, cjc: 4e-12,
    spice: 'NPN(Is=1.8e-14 Bf=400 Br=35.5 Vaf=80 Cje=13p Cjc=4p)', approx: true },
  AC128: { label: 'AC128 (Ge PNP)', pol: 'pnp', is: 2e-6, bf: 90, br: 5, vaf: 40, cje: 2e-11, cjc: 1e-11,
    spice: 'PNP(Is=2u Bf=90 Br=5 Vaf=40 Cje=20p Cjc=10p)', approx: true },
};

export const JFET_MODELS: Record<string, JfetModel> = {
  J201: { label: 'J201 (N-JFET, low Vp)', pol: 'n', vto: -0.8, beta: 0.94e-3, lambda: 0.01, cgs: 4e-12, cgd: 1.6e-12,
    spice: 'NJF(Vto=-0.8 Beta=0.94m Lambda=10m Cgs=4p Cgd=1.6p)', approx: true },
  '2N5457': { label: '2N5457 (N-JFET)', pol: 'n', vto: -1.8, beta: 1.0e-3, lambda: 0.01, cgs: 4e-12, cgd: 1.5e-12,
    spice: 'NJF(Vto=-1.8 Beta=1m Lambda=10m Cgs=4p Cgd=1.5p)', approx: true },
  MPF102: { label: 'MPF102 (N-JFET)', pol: 'n', vto: -3, beta: 0.67e-3, lambda: 0.01, cgs: 4.5e-12, cgd: 1.5e-12,
    spice: 'NJF(Vto=-3 Beta=0.67m Lambda=10m Cgs=4.5p Cgd=1.5p)', approx: true },
  '2N5460': { label: '2N5460 (P-JFET)', pol: 'p', vto: -1.8, beta: 1.0e-3, lambda: 0.01, cgs: 5e-12, cgd: 2e-12,
    spice: 'PJF(Vto=-1.8 Beta=1m Lambda=10m Cgs=5p Cgd=2p)', approx: true },
};

/**
 * Enhancement MOSFET, SPICE level 1 (square law) with the source tied to the body, plus the
 * body diode (source → drain for N-channel). Discrete parts' thresholds vary widely between
 * samples (2N7000: roughly 0.8–3 V), so every preset is approximate.
 */
export interface MosModel {
  label: string;
  pol: 'n' | 'p';
  vth: number;    // threshold magnitude (V)
  kp: number;     // transconductance parameter KP·W/L (A/V²): Id = kp/2 · (Vgs − Vth)² in saturation
  lambda: number; // channel-length modulation (1/V)
  cgs: number; cgd: number;
  bodyIs: number; bodyN: number; // body diode
  spice: string;
  approx?: boolean;
}

export const MOS_MODELS: Record<string, MosModel> = {
  '2N7000': { label: '2N7000 (N-MOSFET)', pol: 'n', vth: 2.0, kp: 0.1, lambda: 0.01, cgs: 20e-12, cgd: 5e-12, bodyIs: 1e-13, bodyN: 1.2,
    spice: 'NMOS(Level=1 Vto=2 Kp=0.1 Lambda=10m)', approx: true },
  BS170: { label: 'BS170 (N-MOSFET)', pol: 'n', vth: 2.1, kp: 0.12, lambda: 0.01, cgs: 24e-12, cgd: 5e-12, bodyIs: 1e-13, bodyN: 1.2,
    spice: 'NMOS(Level=1 Vto=2.1 Kp=0.12 Lambda=10m)', approx: true },
  BS250: { label: 'BS250 (P-MOSFET)', pol: 'p', vth: 2.4, kp: 0.06, lambda: 0.01, cgs: 25e-12, cgd: 6e-12, bodyIs: 1e-13, bodyN: 1.2,
    spice: 'PMOS(Level=1 Vto=-2.4 Kp=0.06 Lambda=10m)', approx: true },
};

export const bjtModel = (k: string): BjtModel => BJT_MODELS[k] || BJT_MODELS['2N3904'];
export const mosModel = (k: string): MosModel => MOS_MODELS[k] || MOS_MODELS['2N7000'];
export const jfetModel = (k: string): JfetModel => JFET_MODELS[k] || JFET_MODELS.J201;

/* ---------- Large-signal equations ---------- */
const MAX_EXP = 80;
/** exp with linear continuation past MAX_EXP, so Newton steps can't overflow. */
export function safeExp(x: number): number {
  if (x < MAX_EXP) return Math.exp(x);
  const e = Math.exp(MAX_EXP);
  return e * (1 + x - MAX_EXP);
}

/** SPICE junction-voltage limiting: keeps each Newton step on an exponential junction sane. */
export function pnjlim(vnew: number, vold: number, vt: number, vcrit: number): number {
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vt) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / vt;
      return arg > 0 ? vold + vt * Math.log(arg) : vcrit;
    }
    return vt * Math.log(vnew / vt);
  }
  return vnew;
}
export const vcrit = (is: number, nvt: number): number => nvt * Math.log(nvt / (Math.SQRT2 * is));

/** Diode current and conductance at junction voltage v. */
export function diodeIV(v: number, is: number, n: number): { i: number; g: number } {
  const nvt = n * VT, e = safeExp(v / nvt);
  return { i: is * (e - 1), g: (is / nvt) * (v / nvt < MAX_EXP ? e : Math.exp(MAX_EXP)) };
}

/**
 * NPN transport model with forward Early effect, in terms of vbe and vbc (for a PNP, pass the
 * negated voltages and negate the resulting currents). Returns collector and base currents
 * (into the device) and their partial derivatives.
 */
export function bjtIV(vbe: number, vbc: number, m: BjtModel) {
  const fwd = diodeIV(vbe, m.is, 1), rev = diodeIV(vbc, m.is, 1);
  const q = isFinite(m.vaf) ? 1 - vbc / m.vaf : 1;
  const ict = (fwd.i - rev.i) * q;
  const ic = ict - rev.i / m.br;
  const ib = fwd.i / m.bf + rev.i / m.br;
  const dvaf = isFinite(m.vaf) ? (fwd.i - rev.i) / m.vaf : 0;
  return {
    ic, ib,
    dic_dvbe: fwd.g * q,
    dic_dvbc: -rev.g * q - dvaf - rev.g / m.br,
    dib_dvbe: fwd.g / m.bf,
    dib_dvbc: rev.g / m.br,
  };
}

/** N-channel enhancement MOSFET channel current: the JFET square law with a positive threshold. */
export const mosIV = (vgs: number, vds: number, m: MosModel) =>
  jfetIV(vgs, vds, { vto: m.vth, beta: m.kp / 2, lambda: m.lambda });

/**
 * N-channel Shichman–Hodges JFET (for P-channel, pass negated voltages and negate the current).
 * Handles vds < 0 by swapping drain and source. Returns drain current and its derivatives.
 */
export function jfetIV(vgs: number, vds: number, m: Pick<JfetModel, 'vto' | 'beta' | 'lambda'>): { id: number; gm: number; gds: number; region: 'cutoff' | 'linear' | 'saturation' } {
  if (vds < 0) {
    // Swap: the "source" is now the higher-potential terminal.
    const r = jfetIV(vgs - vds, -vds, m);
    // id(vgs, vds) = −id'(vgd, −vds); chain rule back to (vgs, vds).
    return { id: -r.id, gm: -r.gm, gds: r.gm + r.gds, region: r.region };
  }
  const vgst = vgs - m.vto;
  if (vgst <= 0) return { id: 0, gm: 0, gds: 0, region: 'cutoff' };
  const lam = 1 + m.lambda * vds;
  if (vds < vgst) {
    const id = m.beta * vds * (2 * vgst - vds) * lam;
    return { id, gm: 2 * m.beta * vds * lam, gds: m.beta * (2 * vgst - 2 * vds) * lam + m.beta * vds * (2 * vgst - vds) * m.lambda, region: 'linear' };
  }
  const id = m.beta * vgst * vgst * lam;
  return { id, gm: 2 * m.beta * vgst * lam, gds: m.beta * vgst * vgst * m.lambda, region: 'saturation' };
}
