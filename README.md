# Pedal Filter Lab

A browser app for designing guitar-pedal circuits. The **Playground** lets you try out filters, shelves,
scoops, gyrator EQ bands and tone stacks: tweak values, sweep pots, model source and load, and design
from target specs using standard E-series parts. A graphical **Pedal Builder** is planned; see [PLAN.md](PLAN.md).

## Running

Requires Node.js (LTS).

```bash
npm install
npm run dev        # dev server at http://localhost:5173
npm test           # unit tests (Vitest)
npm run typecheck
npm run build      # dist/index.html: one self-contained file, opens by double-click
```

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
