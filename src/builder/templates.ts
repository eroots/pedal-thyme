// Starter pedals for the Builder. Op-amp stages are biased from a 9 V → VREF divider like the real
// circuits; clipping diodes are included (they're open in the small-signal analysis).
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
  b.note(300, 275, 'VR1 drive · VR2 tone · VR3 volume. D1/D2 clip large signals (off in this small-signal view).', 'start');
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
  b.note(300, 300, 'VR1 distortion · VR2 filter · VR3 volume. D1/D2 clip to ground (off in this small-signal view).', 'start');
  return b.build();
}

export const TEMPLATES: Template[] = [
  { id: 'empty', name: 'Empty pedal', description: 'Just the input and output jacks.', build: emptyDoc },
  { id: 'ts', name: 'Tube Screamer-style overdrive', description: 'Buffer, op-amp clipping stage with drive pot, tone and volume.', build: tubeScreamer },
  { id: 'rat', name: 'RAT-style distortion', description: 'LM308 gain stage, hard clipping to ground, filter and volume.', build: rat },
];
