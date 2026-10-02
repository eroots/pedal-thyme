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
| `src/engine/` | Netlist format, MNA small-signal solver (with Zin/Zout), op-amp and diode models, SPICE export |
| `src/topologies/` | The Playground catalogue: each topology's parts, netlist, metrics, design solver and schematic |
| `src/playground/` | Playground state, analysis, design search, schematic renderer and UI |
| `src/ui/` | Shared UI pieces (Bode plot) |
| `tests/` | Unit tests; `legacy.ts` keeps the original hand-written H(s) as oracles for the netlists |
