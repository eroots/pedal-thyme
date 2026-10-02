// Starter pedals for the Builder. Op-amp stages are biased from a 9 V → VREF divider like the real
// circuits. Diodes and transistors are biased at their DC operating point and linearised there.
import { sch, type SchBuilder } from '../schematic/build';
import type { Schematic } from '../schematic/types';
import { emptyDoc } from './doc';

export interface Template { id: string; name: string; description: string; build(): Schematic }

const VREF = (b: SchBuilder, x: number, y: number, rot: 0 | 180) => b.part('LABEL', undefined, x, y, rot, undefined, { props: { name: 'VREF' } });
const sweepable = { props: { sweep: true } };

/** 9 V supply with a 10k/10k divider and a 47 µF cap making VREF; supply pin at (x, y). */
function biasSupply(b: SchBuilder, x: number, y: number, refs: [string, string, string]): SchBuilder {
  b.part('SUPPLY', undefined, x, y, 0, 9, { props: { name: '9V' } })
    .R(refs[0], x, y + 30, 90, 10e3).R(refs[1], x, y + 90, 90, 10e3).GND(x, y + 120)
    .wire([x, y + 60], [x + 40, y + 60]).C(refs[2], x + 40, y + 90, 90, 47e-6).GND(x + 40, y + 120);
  return VREF(b, x + 40, y + 60, 0);
}

function tubeScreamer(): Schematic {
  const b = sch();
  // Input coupling and bias, then a unity-gain buffer.
  b.IN(0, 0).wire([0, 0], [10, 0]).C('C1', 40, 0, 0, 47e-9).wire([70, 0], [140, 0]).R('R1', 100, 30, 90, 1e6);
  VREF(b, 100, 60, 180);
  b.OA('U1', 180, 20, 'JRC4558', { mirror: true }).wire([140, 40], [130, 40], [130, 80], [230, 80], [230, 20]);
  // Clipping stage: non-inverting gain with Rg·Cg bass cut, drive pot, treble cap and diodes in the feedback.
  b.wire([220, 20], [240, 20]).C('C2', 270, 20, 0, 1e-6).wire([300, 20], [320, 20]).R('R2', 310, -10, 90, 10e3);
  VREF(b, 310, -40, 0);
  b.OA('U2', 360, 40, 'JRC4558', { mirror: true }).wire([320, 60], [300, 60], [300, 110]).wire([300, 110], [300, 230])
    .R('R3', 270, 110, 0, 4.7e3).C('C3', 240, 140, 90, 47e-9);
  VREF(b, 240, 170, 180);
  b.wire([300, 110], [330, 110]).R('R4', 360, 110, 0, 51e3).wire([390, 110], [420, 110])
    .RHEO('VR1', 450, 110, 0, 500e3, 0.5, 'A', sweepable).wire([480, 110], [500, 110])
    .wire([300, 150], [360, 150]).C('C4', 390, 150, 0, 51e-12).wire([420, 150], [500, 150])
    .wire([300, 190], [360, 190]).part('D', 'D1', 390, 190, 0, undefined, { props: { model: '1N914' } }).wire([420, 190], [500, 190])
    .wire([300, 230], [360, 230]).part('D', 'D2', 390, 230, 180, undefined, { props: { model: '1N914' } }).wire([420, 230], [500, 230])
    .wire([500, 40], [500, 230]).wire([400, 40], [520, 40]);
  // Tone (treble cut via a pot in series with the tone cap) and volume.
  b.R('R5', 550, 40, 0, 10e3).wire([580, 40], [680, 40]).C('C5', 600, 70, 90, 22e-9)
    .RHEO('VR2', 600, 130, 90, 20e3, 0.5, 'B', sweepable).GND(600, 160)
    .POT('VR3', 680, 70, 270, 100e3, 0.7, 'A', { mirror: true, ...sweepable }).GND(680, 100)
    .wire([710, 70], [760, 70]).OUT(760, 70);
  biasSupply(b, 40, 140, ['R6', 'R7', 'C6']);
  b.note(300, 275, 'VR1 drive · VR2 tone · VR3 volume. D1/D2 clip large signals (not modelled in this small-signal view).', 'start');
  return b.build();
}

function rat(): Schematic {
  const b = sch();
  b.IN(0, 0).wire([0, 0], [10, 0]).C('C1', 40, 0, 0, 22e-9).wire([70, 0], [160, 0]).R('R1', 100, 30, 90, 1e6);
  VREF(b, 100, 60, 180);
  // LM308 gain stage: distortion pot in the feedback, two gain legs to VREF.
  b.OA('U1', 200, 20, 'LM308', { mirror: true })
    .wire([160, 40], [140, 40], [140, 100]).RHEO('VR1', 210, 100, 0, 100e3, 0.5, 'A', sweepable)
    .wire([140, 100], [180, 100]).wire([240, 100], [260, 100], [260, 20])
    .C('C2', 210, 140, 0, 100e-12).wire([140, 100], [140, 140], [180, 140]).wire([240, 140], [260, 140], [260, 100])
    .wire([140, 100], [60, 100]).R('R2', 100, 130, 90, 47).C('C3', 100, 190, 90, 2.2e-6)
    .R('R3', 60, 130, 90, 560, { label: 'l' }).C('C4', 60, 190, 90, 4.7e-6, { label: 'l' });
  VREF(b, 100, 220, 0);
  VREF(b, 60, 220, 180);
  // Output coupling, hard clipping to ground, then the filter (tone) and volume.
  b.wire([240, 20], [300, 20]).C('C5', 330, 20, 0, 4.7e-6).R('R4', 390, 20, 0, 1e3).wire([420, 20], [500, 20])
    .part('D', 'D1', 450, 50, 90, undefined, { label: 'l', props: { model: '1N914' } }).GND(450, 80)
    .part('D', 'D2', 480, 50, 270, undefined, { label: 'r', props: { model: '1N914' } }).GND(480, 80)
    .RHEO('VR2', 530, 20, 0, 100e3, 0.5, 'B', sweepable).R('R5', 590, 20, 0, 1e3).wire([620, 20], [740, 20])
    .C('C6', 640, 50, 90, 3.3e-9, { label: 'l' }).GND(640, 80)
    .POT('VR3', 740, 50, 270, 100e3, 0.7, 'A', { mirror: true, ...sweepable }).GND(740, 80)
    .wire([770, 50], [820, 50]).OUT(820, 50);
  biasSupply(b, 40, 260, ['R6', 'R7', 'C7']);
  b.note(300, 300, 'VR1 distortion · VR2 filter · VR3 volume. D1/D2 clip to ground (not modelled in this small-signal view).', 'start');
  return b.build();
}

const Q = (b: SchBuilder, kind: 'NPN' | 'PNP', ref: string, x: number, y: number, model: string, o: { label?: 'l' | 'r' | 't' | 'b'; mirror?: boolean } = {}) =>
  b.part(kind, ref, x, y, 0, undefined, { ...o, props: { model } });

/** LPB-1-style single-transistor booster: common emitter, divider bias, unbypassed emitter resistor. */
function lpb1(): Schematic {
  const b = sch();
  b.IN(0, 0).wire([0, 0], [10, 0]).C('C1', 40, 0, 0, 100e-9).wire([70, 0], [120, 0]);
  Q(b, 'NPN', 'Q1', 150, 0, '2N3904', { label: 'r' });
  b.part('SUPPLY', undefined, 120, -90, 0, 9, { props: { name: '9V' } }).wire([120, -90], [160, -90])
    .R('R1', 120, -60, 90, 430e3, { label: 'l' }).wire([120, -30], [120, 0])
    .R('RC', 160, -60, 90, 10e3, { label: 'r' })
    .R('R2', 120, 30, 90, 43e3, { label: 'l' }).GND(120, 60)
    .R('RE', 160, 60, 90, 390, { label: 'r' }).GND(160, 90)
    .wire([160, -30], [200, -30]).C('C2', 230, -30, 0, 100e-9).wire([260, -30], [300, -30])
    .POT('VR1', 300, 0, 270, 100e3, 0.7, 'A', { mirror: true, props: { sweep: true } }).GND(300, 30)
    .wire([330, 0], [370, 0]).OUT(370, 0);
  b.note(40, 130, 'About 25 dB of clean boost. Turn on DC bias (B) to see the collector sit around 5 V.', 'start');
  return b.build();
}

/** Fuzz Face-style two-transistor fuzz (silicon NPN), with the classic DC feedback from Q2's emitter. */
function fuzzFace(): Schematic {
  const b = sch();
  b.IN(0, 0).wire([0, 0], [10, 0]).C('C1', 40, 0, 0, 2.2e-6).wire([70, 0], [120, 0]);
  Q(b, 'NPN', 'Q1', 150, 0, '2N3904', { label: 'r' }).GND(160, 30);
  Q(b, 'NPN', 'Q2', 230, -30, '2N3904', { label: 'r' });
  b.part('SUPPLY', undefined, 160, -180, 0, 9, { props: { name: '9V' } }).wire([160, -180], [240, -180])
    .R('R1', 160, -150, 90, 33e3, { label: 'l' }).wire([160, -120], [160, -30]).wire([160, -30], [200, -30])
    .R('R3', 240, -150, 90, 8.2e3, { label: 'r' }).R('R2', 240, -90, 90, 470, { label: 'r' })
    // Fuzz: 1k pot from Q2's emitter to ground, its wiper bypassed to ground.
    .POT('VR1', 240, 30, 270, 1e3, 0.8, 'B', { mirror: true, props: { sweep: true } }).GND(240, 60)
    .wire([270, 30], [290, 30]).C('C2', 290, 60, 90, 22e-6, { label: 'r' }).GND(290, 90)
    // DC feedback: Q2 emitter to Q1 base.
    .wire([120, 0], [120, 110]).R('R4', 150, 110, 0, 100e3).wire([180, 110], [220, 110], [220, 0], [240, 0])
    // Output from the 470/8.2k junction through 10 nF to the volume pot.
    .wire([240, -120], [280, -120]).C('C3', 310, -120, 0, 10e-9).wire([340, -120], [360, -120])
    .POT('VR2', 360, -90, 270, 500e3, 0.7, 'A', { mirror: true, props: { sweep: true } }).GND(360, -60)
    .wire([390, -90], [430, -90]).OUT(430, -90);
  b.note(0, 160, 'VR1 fuzz · VR2 volume. Silicon NPN version; the bias sets the character, so watch Q2 with DC bias (B).', 'start');
  return b.build();
}

/**
 * MOSFET booster: 2N7000 common source with drain-to-gate feedback bias (RF = RG puts the gate at half
 * the drain voltage), which keeps the drain near mid-supply despite the 2N7000's threshold spread.
 */
function mosBooster(): Schematic {
  const b = sch();
  b.IN(0, 0).wire([0, 0], [10, 0]).C('C1', 40, 0, 0, 100e-9).wire([70, 0], [120, 0])
    .part('NMOS', 'Q1', 150, 0, 0, undefined, { label: 'r', props: { model: '2N7000' } })
    .part('SUPPLY', undefined, 160, -90, 0, 9, { props: { name: '9V' } })
    .R('RD', 160, -60, 90, 10e3, { label: 'r' })
    .R('RS', 160, 60, 90, 1e3, { label: 'r' }).GND(160, 90)
    .R('RG', 120, 30, 90, 1e6, { label: 'l' }).GND(120, 60)
    .R('RF', 120, -60, 90, 1e6, { label: 'l' }).wire([120, -30], [120, 0])
    .wire([120, -90], [120, -120], [210, -120], [210, -30])
    .wire([160, -30], [240, -30]).C('C2', 270, -30, 0, 100e-9).wire([300, -30], [330, -30])
    .POT('VR1', 330, 0, 270, 100e3, 0.7, 'A', { mirror: true, props: { sweep: true } }).GND(330, 30)
    .wire([360, 0], [400, 0]).OUT(400, 0);
  b.note(0, 140, 'RF/RG feedback holds the drain near 5 V even though 2N7000 thresholds vary. About 19 dB at the drain.', 'start');
  return b.build();
}

/**
 * Zendrive-style overdrive (loosely after the Hermida Zendrive): op-amp gain stage whose feedback is
 * clipped by two diode-connected 2N7000s in anti-parallel, a Voice control in the gain leg, then tone and
 * volume. Values are representative, not a copy of the original.
 */
function zendrive(): Schematic {
  const b = sch();
  b.IN(0, 0).wire([0, 0], [10, 0]).C('C1', 40, 0, 0, 47e-9).wire([70, 0], [140, 0]).R('R1', 100, 30, 90, 1e6);
  VREF(b, 100, 60, 180);
  b.OA('U1', 180, 20, 'TL072', { mirror: true }).wire([140, 40], [130, 40], [130, 80], [230, 80], [230, 20]);
  b.wire([220, 20], [240, 20]).C('C2', 270, 20, 0, 1e-6).wire([300, 20], [320, 20]).R('R2', 310, -10, 90, 1e6);
  VREF(b, 310, -40, 0);
  // Gain leg to VREF: Voice pot + cap (where the boost, and so the clipping, starts).
  b.OA('U2', 360, 40, 'TL072', { mirror: true }).wire([320, 60], [300, 60], [300, 110]).wire([300, 110], [300, 290])
    .RHEO('VR4', 270, 110, 0, 5e3, 0.5, 'B', { label: 't', props: { sweep: true } }).C('C3', 240, 140, 90, 100e-9);
  VREF(b, 240, 170, 180);
  // Feedback: gain pot, treble roll-off cap, and the MOSFET clippers (gate tied to drain).
  b.wire([300, 110], [330, 110]).R('R4', 360, 110, 0, 4.7e3).wire([390, 110], [420, 110])
    .RHEO('VR1', 450, 110, 0, 1e6, 0.5, 'A', { props: { sweep: true } }).wire([480, 110], [500, 110])
    .wire([300, 150], [360, 150]).C('C4', 390, 150, 0, 100e-12).wire([420, 150], [500, 150])
    .wire([300, 210], [360, 210]).part('NMOS', 'Q1', 390, 200, 90, undefined, { label: 'b', props: { model: '2N7000' } })
    .wire([390, 170], [420, 170], [420, 210]).wire([420, 210], [500, 210])
    .wire([300, 290], [360, 290]).part('NMOS', 'Q2', 390, 280, 90, undefined, { mirror: true, label: 'b', props: { model: '2N7000' } })
    .wire([390, 250], [360, 250], [360, 290]).wire([420, 290], [500, 290])
    .wire([500, 40], [500, 290]).wire([400, 40], [520, 40]);
  // Tone (treble cut) and volume.
  b.R('R5', 550, 40, 0, 10e3).wire([580, 40], [680, 40]).C('C5', 600, 70, 90, 22e-9)
    .RHEO('VR2', 600, 130, 90, 20e3, 0.5, 'B', { props: { sweep: true } }).GND(600, 160)
    .POT('VR3', 680, 70, 270, 100e3, 0.7, 'A', { mirror: true, props: { sweep: true } }).GND(680, 100)
    .wire([710, 70], [760, 70]).OUT(760, 70);
  biasSupply(b, 40, 140, ['R6', 'R7', 'C6']);
  b.note(300, 375, 'VR1 gain · VR2 tone · VR3 volume · VR4 voice. Q1/Q2: diode-connected 2N7000 clippers (clipping not modelled in this small-signal view).', 'start');
  return b.build();
}

export const TEMPLATES: Template[] = [
  { id: 'empty', name: 'Empty pedal', description: 'Just the input and output jacks.', build: emptyDoc },
  { id: 'ts', name: 'Tube Screamer-style overdrive', description: 'Buffer, op-amp clipping stage with drive pot, tone and volume.', build: tubeScreamer },
  { id: 'rat', name: 'RAT-style distortion', description: 'LM308 gain stage, hard clipping to ground, filter and volume.', build: rat },
  { id: 'lpb1', name: 'LPB-1-style booster', description: 'One NPN common-emitter stage with divider bias: clean boost.', build: lpb1 },
  { id: 'mosboost', name: 'MOSFET booster (2N7000)', description: 'Common-source 2N7000 with drain-feedback bias: clean boost.', build: mosBooster },
  { id: 'zendrive', name: 'Zendrive-style overdrive', description: 'Op-amp gain stage clipped by two diode-connected 2N7000s, voice, tone and volume.', build: zendrive },
  { id: 'fuzz', name: 'Fuzz Face-style fuzz', description: 'Two silicon NPN transistors with DC feedback, fuzz and volume pots.', build: fuzzFace },
];
