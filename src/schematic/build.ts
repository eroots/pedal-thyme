// Fluent helper for authoring schematics in code (Playground topologies, Builder templates).
import type { TaperKey } from '../core/pots';
import type { Pt } from './geometry';
import type { LabelSide, PartKind, PartProps, Rot, SchPart, Schematic } from './types';

export interface PlaceOpts { mirror?: boolean; label?: LabelSide; props?: PartProps }

export class SchBuilder {
  private parts: SchPart[] = [];
  private wires: Schematic['wires'] = [];
  private notes: NonNullable<Schematic['notes']> = [];
  private n = 0;

  part(kind: PartKind, ref: string | undefined, x: number, y: number, rot: Rot = 0, value?: number, o: PlaceOpts = {}): this {
    this.parts.push({
      id: ref || `${kind.toLowerCase()}${++this.n}`, kind, ref, x, y, rot, value,
      ...(o.mirror ? { mirror: true } : {}), ...(o.label ? { labelSide: o.label } : {}), ...(o.props ? { props: o.props } : {}),
    });
    return this;
  }
  R(ref: string, x: number, y: number, rot: Rot, value: number, o?: PlaceOpts) { return this.part('R', ref, x, y, rot, value, o); }
  C(ref: string, x: number, y: number, rot: Rot, value: number, o?: PlaceOpts) { return this.part('C', ref, x, y, rot, value, o); }
  POT(ref: string, x: number, y: number, rot: Rot, value: number, turn: number, taper: TaperKey, o: PlaceOpts = {}) {
    return this.part('POT', ref, x, y, rot, value, { ...o, props: { ...o.props, turn, taper } });
  }
  RHEO(ref: string, x: number, y: number, rot: Rot, value: number, turn: number, taper: TaperKey, o: PlaceOpts = {}) {
    return this.part('RHEO', ref, x, y, rot, value, { ...o, props: { ...o.props, turn, taper } });
  }
  OA(ref: string, x: number, y: number, model: string, o: PlaceOpts = {}) {
    return this.part('OA', ref, x, y, 0, undefined, { ...o, props: { ...o.props, model } });
  }
  BUF(ref: string, x: number, y: number) { return this.part('BUF', ref, x, y, 0); }
  GND(x: number, y: number) { return this.part('GND', undefined, x, y, 0); }
  IN(x: number, y: number) { return this.part('IN', undefined, x, y, 0); }
  OUT(x: number, y: number) { return this.part('OUT', undefined, x, y, 0); }
  wire(...pts: Pt[]): this {
    this.wires.push({ id: `w${this.wires.length + 1}`, pts });
    return this;
  }
  note(x: number, y: number, text: string, anchor: 'start' | 'middle' | 'end' = 'middle'): this {
    this.notes.push({ id: `n${this.notes.length + 1}`, x, y, text, anchor });
    return this;
  }
  build(): Schematic {
    return { version: 1, parts: this.parts, wires: this.wires, ...(this.notes.length ? { notes: this.notes } : {}) };
  }
}

export const sch = () => new SchBuilder();
