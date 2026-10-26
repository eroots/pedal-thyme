# Developer guide

Pedal Lab is written in TypeScript and built with Vite into a single self-contained HTML file. There
is no server and no framework: the UI is plain DOM, SVG and canvas.

## Setup

You need [Node.js](https://nodejs.org/) (the LTS version).

```bash
npm install
npm run dev        # development server at http://localhost:5173 (hot reload)
npm test           # unit tests (Vitest)
npm run typecheck  # tsc --noEmit
npm run build      # type-checks, then writes dist/pedal-lab.html
```

`npm run build` produces `dist/pedal-lab.html`, with everything inlined: scripts, styles, web
workers and PDF.js. The source entry stays `index.html`; a small plugin in `vite.config.ts` renames
the output.

## Code layout

| Path | Contents |
|---|---|
| `src/core/` | Complex numbers, units and engineering notation, E-series, pot tapers, source/load terminations, measurements |
| `src/engine/` | Netlist format; MNA small-signal solver (with Zin/Zout); DC operating point and linearisation; time-domain (DK-method) simulation; op-amp, diode and transistor models; signal chains; SPICE export |
| `src/schematic/` | Schematic JSON format, part library and symbols, SVG renderer, netlist extraction and electrical rule check, sanitising of untrusted files, a builder DSL |
| `src/topologies/` | The Playground catalogue: each topology's parts, schematic (its netlist is extracted from the drawing), metrics and design solver |
| `src/playground/` | Playground state, analysis, design search and UI |
| `src/builder/` | Pedal Builder and Pedalboard: document operations, wire router, canvas editor, tabs, files and folder, trace overlay, simulation and sound panels |
| `src/ltspice/` | LTspice `.asc` import and export, and symbol pin tables generated from LTspice's library |
| `src/audio/` | Test signals, spectrum and THD analysis, WAV export, render worker, rail-clipping checks, the NAM capture player and its library |
| `src/ui/` | Shared UI pieces (Bode plot, oscilloscope, downloads) |
| `tests/` | Unit tests. `legacy.ts` keeps the original closed-form H(s) of the Playground topologies as oracles for their netlists; `fixtures/compat/` holds files saved by each release |
| `third-party/` | Licence texts of bundled or adapted third-party code |

## How it works

**One circuit description.** Every circuit, including each Playground topology, is a schematic of
parts, pins and wires. `src/schematic/extract.ts` turns the drawing into a netlist (union-find over
pins, wire endpoints and net labels) and runs the electrical rule check. Each part's library entry
(`src/schematic/library.ts`) says which netlist elements it becomes.

**Small-signal analysis** (`src/engine/mna.ts`). Modified nodal analysis at each frequency:
- R, C and L, independent and controlled sources;
- pots and rheostats (value, taper, rotation);
- switches;
- ideal op-amps (nullors) and macromodels (open-loop gain, GBW pole, input and output resistance).

**DC operating point** (`src/engine/dc.ts`). Newton–Raphson with junction limiting, falling back to
gmin stepping, then source stepping. Op-amp input bias currents are included. `linearize.ts` then
replaces each nonlinear device with its small-signal equivalent at that bias:
- diodes become r_d;
- BJTs become four VCCSs plus Cje and Cjc;
- JFETs and MOSFETs become g_m, r_ds and their capacitances.

**Time domain** (`src/engine/transient.ts`). The nodal DK method:
- trapezoidal companion models at the audio rate × oversampling (2, 4 or 8×, with windowed-sinc
  resampling);
- everything linear is folded into a few matrices once;
- each step is a small Newton solve over the controls of the nonlinear parts only (diodes, BJTs,
  JFETs, MOSFETs and op-amps);
- op-amps have a slew-limited input stage into a damped integrator, and an output that saturates
  softly at the supply rails, less each model's headroom;
- the run starts from the DC operating point;
- rendering runs in web workers.

**Signal chains** (`src/engine/chain.ts`). Pedals are joined into one netlist: upstream pedals'
nodes are prefixed, each output is wired to the next pedal's input (so inter-pedal loading is
real), and each op-amp keeps its own pedal's supply rails.

**Amp captures** (`src/audio/nam.ts`). A WaveNet player written after NeuralAmpModelerCore (MIT):
- ungated layers, per-layer kernels and dilations, bottleneck, layer 1×1 and head kernel;
- SlimmableContainer files (the full-size model is used);
- unsupported features (gating, FiLM, LSTM) are refused rather than guessed.

Pedal volts are scaled to the capture's digital level using its `input_level_dbu`.

## Accuracy

Cross-checks against LTspice 24:

- **Import connectivity:** checked against LTspice's own netlister on 158 example schematics
  (3,969 pins), with no differences.
- **Exported schematics:** every template and Playground circuit runs in LTspice without warnings.
  |H| at 100 Hz, 1 kHz and 10 kHz matches to 0.00 dB for passive, op-amp and MOSFET circuits.
  - BJT circuits differ by 0.6–3.5 dB, because LTspice's 2N3904 model has more parameters (Ikf,
    Ise/Ne, Rb …) than the Ebers–Moll model used here.
  - The TS differs by 0.15 dB at 10 kHz, from diode junction capacitance.
- **Small-signal transient vs AC:** within 0.25 dB for every template.
- **1 kHz, 100 mV transient vs LTspice `.four`:**

  | Template | THD, Pedal Lab / LTspice | Notes |
  |---|---|---|
  | TS | 20.95 / 21.04 % | Same fundamental |
  | MOSFET booster | 0.26 / 0.28 % | Same fundamental |
  | Fuzz Face | 129 / 136 % | Fundamental within 0.2 % |
  | Zendrive | similar | Fundamental 1.4 dB apart |
  | RAT | | Fundamental 0.9 dB apart; Pedal Lab models the LM308's slew limit and the exported macromodel doesn't |

- **NAM player:** the weight counts match each file's layout. Each file's 3- and 8-channel
  submodels agree to an ESR of 0.0005–0.03. A sample-exact comparison with the NAM plugin hasn't
  been done.

## Security model

The built file is meant to be shared and to open files from strangers.
- **No network.** A Content Security Policy (added at build time in `vite.config.ts`) allows only
  inline scripts and styles, `blob:` workers and `data:`/`blob:` media. `connect-src` and every
  other source is `'none'`.
- **Untrusted files.** `src/schematic/sanitize.ts` rebuilds every schematic and board read from a
  file or storage, field by field with checked types. Unknown fields are dropped. All text is
  escaped before it reaches the DOM. PDFs are rendered by PDF.js, which doesn't run their scripts, with XFA and WebAssembly
  off.
- **No bundled captures.** NAM files are loaded by the user and kept in IndexedDB.

Keep these properties when adding features: no `innerHTML` with unescaped text, no network APIs,
and new file fields added to the sanitiser.

## Files and storage

| What | Where |
|---|---|
| Pedal | `.pfl.json` file: the schematic, simulation settings and trace picture |
| Pedalboard | `.pfl-board.json` file: each pedal's file name, order and on/off, the mode, and a copy of each schematic |
| Open tabs, the current board, settings | `localStorage` |
| Trace pictures, folder handles, amp captures | IndexedDB |

Storage keys and file kinds still carry the project's earlier name (`pedal-filter-lab.*`,
`pedal-filter-lab/builder-project`, `pedal-filter-lab-board`). They're kept so existing work keeps
opening; don't rename them.

## Compatibility

`tests/compat.test.ts` opens every file in `tests/fixtures/compat/v*/`, so a change that would stop
files saved by an earlier release from opening fails the tests. When a file format changes, add a
migration rather than breaking old files.

## Making a release

1. Set `version` in `package.json` (it's shown in the app's footer).
2. Run `npm test`, then `npm run build`.
3. Add files saved with this release to `tests/fixtures/compat/v<version>/`: a schematic, a
   pedalboard, and anything else people save.
4. Commit, tag (`git tag v<version>`) and push the tag.
5. Create a GitHub release for the tag and attach `dist/pedal-lab.html`.

## Third-party code

| Code | Licence | How it's used |
|---|---|---|
| [PDF.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) | Apache 2.0 | Bundled into the built file, for the trace overlay |
| [NeuralAmpModelerCore](https://github.com/sdatkinson/NeuralAmpModelerCore) | MIT | `src/audio/nam.ts` follows its WaveNet layout and arithmetic |

Both licence texts are in `third-party/`, and the build puts them in the app's footer under
**Third-party licences**.
