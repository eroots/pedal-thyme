# Pedal Filter Lab — Roadmap

Two sections on one shared engine:

- **Playground**: the current app. Pick a filter or stage, tweak values, sweep, design from targets.
- **Pedal Builder**: a graphical schematic editor for wiring a whole pedal and seeing the small-signal
  EQ curve at any probe, with a knob for every pot.

Every circuit, including each Playground topology, is described the same way: a **schematic of parts,
pins and wires**, extracted into a netlist and solved by a single MNA (modified nodal analysis) engine.

## Decisions (2026-10-02)

| Topic | Decision |
|---|---|
| Tooling | Node + TypeScript + Vite. Dev server for work; the build outputs a single double-clickable HTML file. |
| Transistors (BJT/JFET) | Later (Phase 4). Builder v1 covers passives, op-amps and diodes. |
| Playground → Builder | Parts only: "Open in Builder" pastes the circuit as editable parts (no collapsible blocks). |
| Builder v1 extras | SPICE/LTspice `.cir` export, parts list (BOM) CSV export, real op-amp models (finite GBW). |
| Time-domain / audio | Deferred to the end (Phase 5). The engine must not preclude it. |

## Phase 0 — Restructure ✅ (2026-10-02)
- Vite + TypeScript project, with `vite-plugin-singlefile` (or equivalent) so `dist/index.html` still opens by double-click.
- Layout: `src/core` (complex, units, E-series, MNA, analyses), `src/parts` (part models and symbols),
  `src/schematic` (format, renderer, netlist extraction, checks), `src/playground`, `src/builder`,
  `src/ui` (plots, controls), `tests/`.
- Unit tests with Vitest.
- Port the current app as-is first, then refactor.

## Phase 1 — General circuit engine (no visible change)
- MNA with stamps for R, C, L, independent V sources, VCVS, ideal op-amp (nullor),
  real op-amp macromodel (A0, GBW pole, Rout; TL072 / 4558 / LM308 / NE5532 presets),
  3-terminal pot (track value, taper A/B/C, rotation), rheostat, switch (SPST/SPDT, kept simple),
  9 V supply and Vref (AC ground), input/output jacks with source/load.
- Diodes: present in the netlist and treated as off for small-signal AC (documented).
- Analyses: AC transfer to any probe, input/output impedance, part/pot sweeps, tolerance (corners / Monte Carlo).
- Rebuild all 16 Playground topologies as netlists. The current closed-form H(s) become regression
  tests (they must match to ~1e-6 dB).
- SPICE `.cir` export from the Playground.

## Phase 2 — Shared schematic format and renderer
- JSON schematic: parts (type, value, position, rotation, mirror), wires (polylines), junctions,
  net labels (`9V`, `VREF`, `GND`, custom).
- SVG renderer with proper symbols, used by both sections. Playground schematics are re-authored in this format.
- Netlist extraction (union-find over pins, wire endpoints, junctions, labels).
- Electrical rule checks: floating nodes, unconnected pins, no DC path to ground, missing input/output, shorted supply.
  Plus a tiny gmin to ground as a numerical safety net.

## Phase 3 — Pedal Builder (largest phase)
Build in this order, so each step is usable on its own:
1. Canvas: grid snap, pan/zoom, select / box-select, move, rotate, mirror, delete, undo/redo, copy/paste.
2. Parts palette (Phase 1 parts) and click-pin-to-pin orthogonal wiring with bend points, junction dots and net labels.
3. Properties panel: value entry with E-series stepping, tolerance, pot taper/rotation, op-amp and diode model.
4. Simulation panel: live EQ at one or more probes, an auto-generated front panel with a knob per pot,
   sweeps, tolerance band, source/load on the jacks.
5. "Open in Builder" from any Playground circuit (pasted as parts).
6. Files: save/load JSON, SPICE `.cir` export, BOM CSV export, schematic SVG/PNG export.
7. Starter templates (op-amp and diode based): TS-style overdrive, RAT-style distortion, op-amp EQ pedal,
   Klon-style buffer/EQ sections.

## Phase 4 — Transistors and DC bias
- Newton–Raphson DC operating point with diode (Shockley), BJT (Ebers–Moll) and JFET (square-law) models.
- Small-signal AC around the bias point, with node voltages shown on the schematic.
- Templates: Fuzz Face, Big Muff, LPB-1-style booster.

## Phase 5 — Time domain (deferred)
- Transient analysis (trapezoidal companion models, Newton per step), waveforms, clipping, harmonics,
  audio through the circuit (Web Audio, in a worker).

## Verification
- Closed-form oracles for every Playground topology.
- Netlist-extraction unit tests.
- LTspice cross-checks on a few reference circuits via `.cir` export.
