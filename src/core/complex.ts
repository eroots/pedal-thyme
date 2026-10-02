// Immutable complex numbers and impedance helpers.

export class Cx {
  constructor(public readonly re: number, public readonly im = 0) {}
  add(b: Cx | number): Cx { const o = cx(b); return new Cx(this.re + o.re, this.im + o.im); }
  sub(b: Cx | number): Cx { const o = cx(b); return new Cx(this.re - o.re, this.im - o.im); }
  mul(b: Cx | number): Cx { const o = cx(b); return new Cx(this.re * o.re - this.im * o.im, this.re * o.im + this.im * o.re); }
  div(b: Cx | number): Cx {
    const o = cx(b), d = o.re * o.re + o.im * o.im;
    return new Cx((this.re * o.re + this.im * o.im) / d, (this.im * o.re - this.re * o.im) / d);
  }
  scale(k: number): Cx { return new Cx(this.re * k, this.im * k); }
  abs(): number { return Math.hypot(this.re, this.im); }
  arg(): number { return Math.atan2(this.im, this.re); }
}

export const cx = (b: Cx | number): Cx => (b instanceof Cx ? b : new Cx(b, 0));
export const ONE = new Cx(1, 0);
/** Parallel combination a ∥ b. */
export const par = (a: Cx, b: Cx): Cx => a.mul(b).div(a.add(b));
/** Capacitor impedance 1/(sC). */
export const Zc = (C: number, s: Cx): Cx => ONE.div(s.scale(C));
/** Resistor admittance. */
export const Yr = (R: number): Cx => cx(1 / R);
/** Capacitor admittance sC. */
export const Yc = (C: number, s: Cx): Cx => s.scale(C);
