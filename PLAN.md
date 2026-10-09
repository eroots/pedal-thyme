# Pedal Lab — Roadmap

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
| Transistors (BJT/JFET) | Phase 4 (done): DC bias + small-signal linearisation. |
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

## Phase 1 — General circuit engine ✅ (2026-10-02)
Done: `src/engine/` (netlist, MNA, models, SPICE export); all 17 topologies are netlists, checked against
the old closed-form H(s) with and without source/load (`tests/legacy.ts`). The Playground gained an op-amp
model selector, Zin/Zout readouts and "Export SPICE (.cir)". Switches, inductors and diodes (open in AC) are in
the engine but not yet used by any Playground topology. LTspice cross-check done (2026-10-02, see below).
- MNA with stamps for R, C, L, independent V sources, VCVS, ideal op-amp (nullor),
  real op-amp macromodel (A0, GBW pole, Rout; TL072 / 4558 / LM308 / NE5532 presets),
  3-terminal pot (track value, taper A/B/C, rotation), rheostat, switch (SPST/SPDT, kept simple),
  9 V supply and Vref (AC ground), input/output jacks with source/load.
- Diodes: present in the netlist and treated as off for small-signal AC (documented).
- Analyses: AC transfer to any probe, input/output impedance, part/pot sweeps, tolerance (corners / Monte Carlo).
- Rebuild all 16 Playground topologies as netlists. The current closed-form H(s) become regression
  tests (they must match to ~1e-6 dB).
- SPICE `.cir` export from the Playground.

## Phase 2 — Shared schematic format and renderer ✅ (2026-10-02)
Done: `src/schematic/` (format, part library, renderer, extraction + ERC, builder DSL). All 17 Playground
topologies are re-drawn on a 10-unit grid; their netlists are extracted from the drawings (verified against the
legacy oracles) and every drawing passes ERC.
- JSON schematic: parts (type, value, position, rotation, mirror), wires (polylines), junctions,
  net labels (`9V`, `VREF`, `GND`, custom).
- SVG renderer with proper symbols, used by both sections. Playground schematics are re-authored in this format.
- Netlist extraction (union-find over pins, wire endpoints, junctions, labels).
- Electrical rule checks: floating nodes, unconnected pins, no DC path to ground, missing input/output, shorted supply.
  Plus a tiny gmin to ground as a numerical safety net.

## Phase 3 — Pedal Builder ✅ (2026-10-02)
Checkpoint 1 (2026-10-02): steps 1–3 done (canvas, palette, wiring, properties, ERC panel), plus a basic
output-jack response plot and "Open in Builder" from the Playground. Moving parts keeps wires attached
(stretch routing with an A* fallback), tested by dragging every part of every Playground circuit.
Since then: LTspice-style hotkeys, stretch vs move, delete mode. Step 4 done (2026-10-02): probes, front
panel (knobs/toggles), sweeps, tolerance band, phase, source/load with Zin/Zout. Steps 6–7 done: project save/open,
SPICE, BOM CSV, SVG/PNG export; TS-style and RAT-style templates.
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

## Phase 4 — Transistors and DC bias ✅ (2026-10-02)
Done: `src/engine/semis.ts` (models + device equations), `dc.ts` (Newton–Raphson operating point with junction
limiting, then gmin stepping, then source stepping), `linearize.ts` (diodes → r_d, BJTs → four VCCSs + Cje/Cjc,
JFETs → g_m, r_ds, Cgs/Cgd; new `G` element in the MNA). The Builder biases and linearises automatically, so
diodes now show their dynamic resistance instead of being open. NPN/PNP/N-JFET/P-JFET parts (Q, J hotkeys) with
model selection and an operating-point readout; a "DC bias" overlay (B) tags every net with its voltage.
SPICE export writes Q/J lines and `.model` cards. Templates: LPB-1-style booster, Fuzz Face-style fuzz.
MOSFETs (2026-10-02): enhancement N/P MOSFETs (2N7000, BS170, BS250; square law, body diode, insulated gate)
with a MOSFET booster and a Zendrive-style template (diode-connected 2N7000 clippers in an op-amp feedback loop).
Not done: a Big Muff template; temperature effects; charge-storage (diffusion) capacitance.
- Newton–Raphson DC operating point with diode (Shockley), BJT (Ebers–Moll) and JFET (square-law) models.
- Small-signal AC around the bias point, with node voltages shown on the schematic.
- Templates: Fuzz Face, Big Muff, LPB-1-style booster.

## LTspice import/export and trace overlay ✅ (2026-10-02)
- **Import (.asc)**: keeps the layout (scaled 10/16), places each part where its pins best match and bridges
  the difference with short wires, then checks the result net-for-net against LTspice's connectivity and
  reconnects any mismatch with net labels. Built-in symbols, all 651 OpAmps symbols, .param expressions,
  .model types; third-party symbols (e.g. pots) via their .asy files. Signal source → input jack, grounded DC
  sources → supply rails, flags → labels / ground / output jack. Substitutions are listed in an import report.
  Connectivity verified against LTspice 24's own netlister on 158 example schematics (3,969 pins, no
  differences); it models LTspice's rule that a part cuts the wire it sits on.
- **Export (.asc)**: same layout (×1.6), net names as flags, the signal source and supplies as voltage sources,
  models and op-amp macromodels in a directive. Every template and Playground circuit runs in LTspice with no
  warnings; |H| at 100 Hz/1 kHz/10 kHz matches this app to 0.00 dB for all passive, op-amp and MOSFET circuits.
  BJT circuits differ by 0.6–3.5 dB (LPB-1, Fuzz Face) because LTspice's 2N3904 model has more parameters
  (Ikf, Ise/Ne, Rb …) than ours; the TS differs by 0.15 dB at 10 kHz (diode junction capacitance).
- **Trace overlay**: an image or PDF page (pdf.js) under the canvas, with opacity, rotate, page choice and a
  move/scale mode; saved with the project.

## Phase 5 — Time domain ✅ (2026-10-02, offline render)
Done: `src/engine/transient.ts` uses the nodal DK method: trapezoidal companion models at the audio rate
× oversampling (2/4/8×, windowed-sinc resampling), with everything linear folded into a few matrices once.
Each step is a small Newton solve (junction limiting plus a backtracking line search) in the controls of
the nonlinear parts only: diodes, BJTs, JFETs, MOSFETs and op-amps. Op-amps have a slew-limited input
stage into a damped internal integrator, and an output that saturates softly at the supply rails minus each
model's headroom (TL072 1.5 V, LM308 0.3 V/µs …). The run starts from the DC operating point. Diode
junction capacitance was added to the models (AC too).
The Builder's **Sound** panel offers:
- signals: sine, plucked note, strummed chord or an audio file, at a pickup level;
- rendering in a worker (inlined in the single-file build);
- waveform and spectrum with THD and harmonics;
- A/B playback (with matched loudness) and WAV download.
Verified: RC filter vs theory; small-signal transient vs AC within 0.25 dB for every template; diode clipper,
rail clipping and slew rate; and 1 kHz/100 mV transient vs LTspice `.four`:

| Template | Fundamental | THD (this app / LTspice) | Notes |
|---|---|---|---|
| TS | same | 20.95 / 21.04 % | |
| MOSFET booster | same | 0.26 / 0.28 % | |
| Fuzz Face | within 0.2 % | 129 / 136 % | |
| Zendrive | 1.4 dB apart | similar | |
| RAT | 0.9 dB apart | | this app models the LM308's slew limit; the exported macromodel doesn't |
| LPB-1 | | | BJT model difference, as in AC |

Speed: about 1–2 s per second of audio at 4×. Not done: real-time live input (would come next if wanted).

## Tabs, comparison and signal chains ✅ (2026-10-04)
- Builder tabs: each holds its own drawing, history, file, sim settings, trace and sound render; the session
  survives reloads.
- Response "Compare with": another tab's output overlaid.
- Signal chain, part 1: Source → "Output of <tab>". `src/engine/chain.ts` joins the netlists:
  - upstream pedals are prefixed `u{k}:`, and each output is wired to the next pedal's input, so inter-pedal
    loading is real;
  - each op-amp keeps its own pedal's rails;
  - the response, sweeps, tolerance, DC bias and sound all run through the chain;
  - the first pedal's source drives the chain; this tab's load ends it.

## Pedalboard (signal chain, part 2) ✅ (2026-10-04)
- A **Pedalboard** section: Guitar (source preset) → pedals → Amp (load preset). The pedals are open Builder
  tabs. Each pedal has a footswitch (bypassed pedals are left out of the chain: true bypass), its knobs
  (edits go into that tab's own history), reordering by dragging or with ‹ ›, Edit and Remove.
- Response: the board output plus the signal after each pedal (dashed). Sound: the Builder's panel reused,
  with its own element ids.
- Board files (`.pfl-board.json`) list each pedal's schematic file name, its order and on/off, plus a copy of
  each schematic. Opening one opens the pedals as tabs, reusing tabs that are already open; a file not
  found in the project folder falls back to the copy. Builder Open and Folder recognise board files.

- Stack / Compare (2026-10-09): Compare plots (and renders) each pedal that is on by itself; the mode is
  saved with the board. Pedals can be added straight from the project folder (they open as background
  tabs). Each pedal card shows its problems (errors, warnings, or "no signal" when nothing gets from its
  input jack to its output jack), and the readout explains them.

## Next
- Split screen: two tabs side by side.
