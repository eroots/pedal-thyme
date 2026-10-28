// Circuit blocks: common stages to drop into any schematic (Blocks ▾). Each is a piece of schematic
// without jacks: its input and output are open wire ends, labelled "in" and "out", to wire into the
// circuit. Op-amp and transistor stages are biased from VREF (half the supply), like the templates;
// add the Basic power supply or Bias supply block if the circuit has no VREF yet. Refs are renumbered when a block is
// dropped, so they never clash with the circuit's.
import { sch, type SchBuilder } from '../schematic/build';
import type { Clip } from './doc';

export interface Block { id: string; name: string; description: string; build(): Clip }

const VREF = (b: SchBuilder, x: number, y: number, rot: 0 | 180) => b.part('LABEL', undefined, x, y, rot, undefined, { props: { name: 'VREF' } });
const sweepable = { props: { sweep: true } };
const ends = (b: SchBuilder, inAt: [number, number] | null, outAt: [number, number] | null) => {
  if (inAt) b.note(inAt[0] - 4, inAt[1] - 6, 'in', 'end');
  if (outAt) b.note(outAt[0] + 4, outAt[1] - 6, 'out', 'start');
  return b;
};
const clip = (b: SchBuilder): Clip => { const d = b.build(); return { parts: d.parts, wires: d.wires, notes: d.notes ?? [] }; };

/** 9 V supply with a 10k/10k divider and a 47 µF cap making VREF (4.5 V). */
function biasSupply(): Clip {
  const b = sch().part('SUPPLY', undefined, 0, 0, 0, 9, { props: { name: '9V' } })
    .R('R1', 0, 30, 90, 10e3).R('R2', 0, 90, 90, 10e3).GND(0, 120)
    .wire([0, 60], [40, 60]).C('C1', 40, 90, 90, 47e-6).GND(40, 120);
  VREF(b, 40, 60, 0);
  return clip(b);
}

/** Basic power supply: 9 V and an ideal VREF at 4.5 V (no divider), for the blocks that use VREF. */
function powerSupply(): Clip {
  const b = sch().part('SUPPLY', undefined, 0, 0, 0, 9, { props: { name: '9V' } })
    .part('SUPPLY', undefined, 60, 0, 0, 4.5, { props: { name: 'VREF' } });
  return clip(b);
}

/** Klon-style input buffer: 100 nF and 10k in, 1M to VREF, a TL072 follower (output to its − input). */
function opAmpBuffer(): Clip {
  const b = sch().wire([0, 0], [10, 0]).C('C1', 40, 0, 0, 100e-9).R('R1', 100, 0, 0, 10e3).wire([130, 0], [200, 0])
    .R('R2', 160, 30, 90, 1e6);
  VREF(b, 160, 60, 180);
  b.OA('U1', 240, 20, 'TL072', { mirror: true }).wire([200, 40], [190, 40], [190, 80], [290, 80], [290, 20]).wire([280, 20], [320, 20]);
  return clip(ends(b, [0, 0], [320, 20]));
}

/** JFET source follower: 100 nF in, 1M to VREF, J201 with 10k to ground, 1 µF out with 100k to ground. */
function jfetBuffer(): Clip {
  const b = sch().wire([0, 0], [10, 0]).C('C1', 40, 0, 0, 100e-9).wire([70, 0], [120, 0]).R('R1', 100, 30, 90, 1e6);
  VREF(b, 100, 60, 180);
  b.part('NJF', 'Q1', 150, 0, 0, undefined, { label: 'r', props: { model: 'J201' } })
    .part('SUPPLY', undefined, 160, -30, 0, 9, { props: { name: '9V' } })
    .R('R2', 160, 60, 90, 10e3, { label: 'l' }).GND(160, 90)
    .wire([160, 30], [200, 30]).C('C2', 230, 30, 0, 1e-6).wire([260, 30], [300, 30]).R('R3', 280, 60, 90, 100e3).GND(280, 90);
  return clip(ends(b, [0, 0], [300, 30]));
}

/** BJT emitter follower: 100 nF in, 1M to VREF, 2N5088 with 10k to ground, 1 µF out with 100k to ground. */
function bjtBuffer(): Clip {
  const b = sch().wire([0, 0], [10, 0]).C('C1', 40, 0, 0, 100e-9).wire([70, 0], [120, 0]).R('R1', 100, 30, 90, 1e6);
  VREF(b, 100, 60, 180);
  b.part('NPN', 'Q1', 150, 0, 0, undefined, { label: 'r', props: { model: '2N5088' } })
    .part('SUPPLY', undefined, 160, -30, 0, 9, { props: { name: '9V' } })
    .R('R2', 160, 60, 90, 10e3, { label: 'l' }).GND(160, 90)
    .wire([160, 30], [200, 30]).C('C2', 230, 30, 0, 1e-6).wire([260, 30], [300, 30]).R('R3', 280, 60, 90, 100e3).GND(280, 90);
  return clip(ends(b, [0, 0], [300, 30]));
}

/** Tube Screamer clipping stage: 1 µF in, 10k to VREF, 4558 with 4.7k + 47 nF to VREF, 51k + 500k drive, 51 pF, diodes in the loop. */
function tsClipping(): Clip {
  const b = sch().wire([220, 20], [240, 20]).C('C1', 270, 20, 0, 1e-6).wire([300, 20], [320, 20]).R('R1', 310, -10, 90, 10e3);
  VREF(b, 310, -40, 0);
  b.OA('U1', 360, 40, 'JRC4558', { mirror: true }).wire([320, 60], [300, 60], [300, 110]).wire([300, 110], [300, 230])
    .R('R2', 270, 110, 0, 4.7e3).C('C2', 240, 140, 90, 47e-9);
  VREF(b, 240, 170, 180);
  b.wire([300, 110], [330, 110]).R('R3', 360, 110, 0, 51e3).wire([390, 110], [420, 110])
    .RHEO('VR1', 450, 110, 0, 500e3, 0.5, 'A', sweepable).wire([480, 110], [500, 110])
    .wire([300, 150], [360, 150]).C('C3', 390, 150, 0, 51e-12).wire([420, 150], [500, 150])
    .wire([300, 190], [360, 190]).part('D', 'D1', 390, 190, 0, undefined, { props: { model: '1N914' } }).wire([420, 190], [500, 190])
    .wire([300, 230], [360, 230]).part('D', 'D2', 390, 230, 180, undefined, { props: { model: '1N914' } }).wire([420, 230], [500, 230])
    .wire([500, 40], [500, 230]).wire([400, 40], [540, 40]);
  return clip(ends(b, [220, 20], [540, 40]));
}

/** Tube Screamer-style tone and volume (as in the template): 10k, then 22 nF with a 20k tone pot to ground, then a 100k volume pot. */
function tsTone(): Clip {
  const b = sch().wire([500, 40], [520, 40]).R('R1', 550, 40, 0, 10e3).wire([580, 40], [680, 40])
    .C('C1', 600, 70, 90, 22e-9).RHEO('VR1', 600, 130, 90, 20e3, 0.5, 'B', sweepable).GND(600, 160)
    .POT('VR2', 680, 70, 270, 100e3, 0.7, 'A', { mirror: true, ...sweepable }).GND(680, 100)
    .wire([710, 70], [740, 70]);
  return clip(ends(b, [500, 40], [740, 70]));
}

/** Hard clipping to ground (RAT style): 1k series, two diodes to ground. */
function hardClip(): Clip {
  const b = sch().wire([0, 0], [10, 0]).R('R1', 40, 0, 0, 1e3).wire([70, 0], [140, 0])
    .part('D', 'D1', 90, 30, 90, undefined, { label: 'l', props: { model: '1N914' } }).GND(90, 60)
    .part('D', 'D2', 120, 30, 270, undefined, { label: 'r', props: { model: '1N914' } }).GND(120, 60);
  return clip(ends(b, [0, 0], [140, 0]));
}

export const BLOCKS: Block[] = [
  { id: 'power', name: 'Basic power supply', description: '9 V and VREF at 4.5 V, as ideal supplies (no divider): the quickest way to power the other blocks.', build: powerSupply },
  { id: 'bias', name: 'Bias supply (VREF)', description: '9 V with a 10k/10k divider and 47 µF: the VREF (4.5 V) the other blocks use.', build: biasSupply },
  { id: 'opbuf', name: 'Op-amp input buffer (Klon-style)', description: '100 nF and 10k in, 1M to VREF, a TL072 follower.', build: opAmpBuffer },
  { id: 'jfetbuf', name: 'JFET buffer', description: 'J201 source follower: 1M to VREF, 10k source resistor, 1 µF and 100k out.', build: jfetBuffer },
  { id: 'bjtbuf', name: 'BJT buffer', description: '2N5088 emitter follower: 1M to VREF, 10k emitter resistor, 1 µF and 100k out.', build: bjtBuffer },
  { id: 'tsclip', name: 'Tube Screamer clipping stage', description: 'JRC4558 gain stage with 500k drive and two diodes in the feedback.', build: tsClipping },
  { id: 'tstone', name: 'Tube Screamer tone and volume', description: '10k into 22 nF and a 20k tone pot (treble cut), then a 100k volume pot.', build: tsTone },
  { id: 'hardclip', name: 'Hard clipping to ground', description: '1k series resistor and two diodes to ground (RAT style).', build: hardClip },
];
