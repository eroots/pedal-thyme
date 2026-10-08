# Pedal Lab

A browser app for designing guitar-pedal circuits:
- The **Playground** lets you try out filters, shelves, scoops, gyrator EQ bands and tone stacks: tweak
  values, sweep pots, model source and load, and design from target specs using standard E-series parts.
- The **Pedal Builder** is a schematic editor (with LTspice import/export) that simulates what you draw:
  frequency response, DC bias, and the sound itself, clipping included.
- The **Pedalboard** chains pedals together.

See [PLAN.md](PLAN.md) for what's been built and how.

## Sharing it

Give people `dist/pedal-lab.html`, the only file needed; there's nothing to install. It opens by
double-click in Chrome or Edge (Firefox works too, but saves by downloading instead of into a folder).
The version is shown at the bottom of the page.
- **Offline:** everything is inside that one file, and its Content Security Policy forbids loading or
  sending anything over the network, so it works offline and can't phone home.
- **Untrusted files:** schematics, boards, LTspice files and PDFs from other people are treated as untrusted.
  Schematics are rebuilt with checked types (`src/schematic/sanitize.ts`), all text is escaped before
  display, and PDFs are rendered by PDF.js without evaluating any code.
- **Storage and updates:** open tabs and the current pedalboard are kept in the browser's storage;
  saved files (`.pfl.json`, `.pfl-board.json`) are the reliable copy. To update, replace the old
  `pedal-lab.html` with the new one (same name, same folder), and open tabs carry over.
- **Licences:** the file includes PDF.js (Apache License 2.0); its licence text is embedded at the end.

## Running

Requires Node.js (LTS).

```bash
npm install
npm run dev        # dev server at http://localhost:5173
npm test           # unit tests (Vitest)
npm run typecheck
npm run build      # dist/pedal-lab.html: one self-contained file, opens by double-click
```

## Making a release

1. Set `version` in `package.json` (it is shown in the app's footer).
2. `npm test`, then `npm run build`.
3. Add files saved with this release to `tests/fixtures/compat/v<version>/`: a schematic, a pedalboard,
   and anything else people save. `tests/compat.test.ts` opens every release's files, so a later change
   that would stop old work opening fails the tests.
4. Create a GitHub release and attach `dist/pedal-lab.html`.

## Layout

| Path | Contents |
|---|---|
| `src/core/` | Complex numbers, units, E-series, pot tapers, source/load terminations, measurements |
| `src/engine/` | Netlist format, MNA small-signal solver (with Zin/Zout), DC operating point and linearisation, time-domain (DK-method) simulation, op-amp/diode/transistor models, SPICE export |
| `src/schematic/` | Schematic JSON format, part library and symbols, SVG renderer, netlist extraction + electrical rule check, builder DSL |
| `src/topologies/` | The Playground catalogue: each topology's parts, schematic (netlist is extracted from it), metrics and design solver |
| `src/playground/` | Playground state, analysis, design search and UI |
| `src/builder/` | Pedal Builder: document operations, wire router, canvas editor, trace overlay and UI |
| `src/ltspice/` | LTspice schematic (.asc) import and export, symbol pin tables generated from LTspice's library |
| `src/audio/` | Test signals, spectrum/THD analysis, WAV export and the render worker for the time-domain simulation |
| `src/ui/` | Shared UI pieces (Bode plot, oscilloscope) |
| `tests/` | Unit tests; `legacy.ts` keeps the original hand-written H(s) as oracles for the netlists |
