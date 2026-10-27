# Pedal Thyme user guide

Pedal Thyme has three sections, chosen with the buttons at the top right: the **Playground**, the
**Pedal Builder** and the **Pedalboard**. This guide is also built into the app: press **Help** at the
top right.

The header bar holds settings shared by all three:

| Setting | What it does |
|---|---|
| **Resistors / Caps** | The E-series (E6 … E96) that value stepping and "snap" use. |
| **R tol / C tol** | Component tolerances, used for the tolerance band on response plots. |
| **Range** | The frequency range of the plots. |

Anywhere a value is typed, engineering notation works: `4.7k`, `4k7`, `22n`, `2n2`, `1u`, `1M`,
`1e-9`.

- [Playground](#playground)
- [Pedal Builder](#pedal-builder)
  - [Drawing a schematic](#drawing-a-schematic)
  - [Parts and their properties](#parts-and-their-properties)
  - [Circuit blocks](#circuit-blocks)
  - [Tracing a schematic from a picture or PDF](#tracing-a-schematic-from-a-picture-or-pdf)
  - [Files, tabs and the schematics folder](#files-tabs-and-the-schematics-folder)
  - [Response](#response)
  - [Sound](#sound)
  - [Checks](#checks)
  - [LTspice](#ltspice)
- [Pedalboard](#pedalboard)
- [Tips and troubleshooting](#tips-and-troubleshooting)
- [Known limits](#known-limits)

---

## Playground

A catalogue of the building blocks of pedal and amp tone circuits:
- RC filters and band-passes;
- treble and bass shelves, including the Tube Screamer's gain shelf;
- mid scoops (Big Muff-style blend, bridged-T) and gyrator EQ bands;
- tone stacks (FMV and James);
- Sallen-Key and multiple-feedback active filters.

Pick one from the list on the left.

- **Components:** change any value. ‹ › or ↑ ↓ step through standard values, and **Snap to
  E-series** rounds every part. Presets load typical values (a TS808 at minimum and maximum drive,
  a Fender or Marshall tone stack, …).
- **Characteristics:** the corner frequencies, gains, Q and so on, worked out for an ideal source
  and load. Click a part in the schematic to edit it.
- **Source & load:** model what drives the circuit (a pickup and cable, a buffer, a previous stage)
  and what it drives (a pedal or amp input). The plot then shows the real-world response, with the
  ideal one dashed for comparison.
- **Frequency response:** the magnitude, optionally phase and a tolerance band. **Sweep** overlays
  curves for several settings of one pot or part.
- **Design from targets:** enter the response you want (a corner frequency, a gain …), pick an
  anchor part, and **Find component values** searches every standard value of the anchor and snaps
  the rest. There's no target design for tone stacks: their controls interact too much.
- **Compare & save:** pin the current curve as an overlay, and save designs to come back to (or
  export and import them as JSON).
- **Open in Builder** copies the circuit into the Pedal Builder as ordinary, editable parts.

---

## Pedal Builder

The Builder is a schematic editor and simulator. Start from **New ▾**, which offers an empty pedal
or a template:
- Tube Screamer-style overdrive;
- RAT-style distortion;
- LPB-1-style booster;
- MOSFET booster;
- Zendrive-style overdrive;
- Fuzz Face-style fuzz.

Every pedal needs an **input jack**, an **output jack** and a **ground**. Op-amps take their supply
from the **Supply rail** parts in the drawing.

### Drawing a schematic

| Action | How |
|---|---|
| Place a part | Click it in the palette on the left (or press its key), then click on the canvas. Right-click or Ctrl+R rotates it while placing. |
| Draw a wire | **Wire** (W). Click to start, click to bend, click a pin or wire to finish. Esc cancels. |
| Select | **Select** (V). Click, or drag on empty space to box-select. Ctrl+A selects everything. |
| Move | Drag a selection. In **Stretch** mode (S) wires follow the parts; in **Move** mode (M) parts detach from their wires. Holding Alt while dragging switches to the other mode for that drag. The arrow keys nudge the selection. |
| Copy | Ctrl+C (or **Copy**), then click a part, wire or note: a copy follows the cursor; click to drop it. With a selection, the whole selection is copied. Ctrl+V pastes and Ctrl+D duplicates. |
| Rotate / mirror | Ctrl+R / Ctrl+E. |
| Delete | Del deletes the selection. With nothing selected it enters delete mode, where each click deletes what's under it. |
| Undo / redo | Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z). |
| Text note | **Text** (T), then click where the note goes and type it in Properties (Enter for a new line). Select a note and drag the handle on its edge to make it wider or narrower: the text wraps to fit. |
| Probe | **Probe** (X), then click a wire or pin: that net gets its own curve on the Response plot. |
| Pan and zoom | Mouse wheel zooms. Space+drag or middle-drag pans. F fits the drawing to the view. |
| DC bias | **DC bias** (B) labels every net with its DC voltage. |

Part keys: R resistor, C capacitor, L inductor, D diode, P potentiometer, O op-amp, Q NPN
transistor, J N-channel JFET, G ground, X probe.

Wires connect where they end on a pin or another wire; a junction dot shows each connection.
Wires that just cross don't connect, and are drawn with a small hop to show it. A
part dropped onto a wire cuts it, so the part is wired in series. Net labels with the same name are
connected, so a **Net label** called `VREF` (or `9V`) joins everything that carries it.

Drag the bar under the canvas to make the schematic taller or shorter.

### Parts and their properties

Click a part to edit it in the **Properties** panel on the right. Double-click focuses its value.

- **Resistors, capacitors, inductors:** value, with ‹ › stepping through the E-series.
- **Potentiometers and variable resistors:**
  - total value, taper (A log, B linear, C reverse log), rotation and a Reverse option;
  - each one gets a knob in the **Front panel**;
  - **Ganged with** joins two pots (or rheostats) into one dual-gang pot: they share a knob and
    turn together.
- **Switches:** SPST, SPDT and on-off-on. Click the switch in the Front panel to change it.
  - **Linked with** makes switches of the same kind the poles of one switch: two SPDTs make a
    DPDT, two SPSTs a DPST, three a 3PDT and so on. They share one toggle and switch together.
    Draw each pole where it sits in the circuit.
- **Diodes and LEDs:** 1N4148, 1N914, 1S1588, 1N34A (germanium) and a red LED.
- **Transistors:**
  - NPN and PNP BJTs (2N3904, 2N5088, 2N5089, 2N3906, BC109, AC128);
  - JFETs (J201, 2N5457, MPF102, 2N5460);
  - MOSFETs (2N7000, BS170, BS250).

  With DC bias on, the Properties panel shows each transistor's operating point.
- **Op-amps:**
  - Ideal, TL072, JRC4558, NE5532, OPA2134, LM741, LM358 or LM308. Each real model has its own
    gain, bandwidth, slew rate and output swing.
  - **Input bias** overrides the model's typical input bias current, for a particular or unknown
    chip. Through a large feedback resistance it puts a small DC offset across clipping diodes,
    making the clipping slightly asymmetric.
  - **All pins** draws the chip as its 8-pin package, numbered as on the datasheet:
    - Use it when you want to wire the supply pins yourself, or show both halves of a dual
      op-amp as one part. The op-amp then clips at whatever voltages reach its supply pins (after
      a filter resistor, a charge pump and so on), instead of at the circuit's supply rails.
    - A dual chip (TL072, 4558, NE5532, OPA2134, LM358) shows op-amps A and B. If nothing is
      connected to one of them, it's left out.
    - Single op-amps (LM741, LM308) show their offset-null or compensation pins, which can be left
      unconnected.
    - Wires stay on the matching pins when you switch views. When you change the model of a
      package, each wire keeps its pin number, as when you put a different chip in the same socket.
  - **LM386:** the small power amp, always shown as its 8-pin package.
    - Its inputs are referenced to ground, and its output sits at half the supply on pin 6.
    - Its gain is 20 with pins 1 and 8 open, and up to 200 with a capacitor (e.g. 10 µF) between
      them; a resistor in series with the capacitor sets a gain in between.
    - LTspice export leaves it out (LTspice has no LM386 model) and adds a note saying so.
- **Unity buffer:** an ideal buffer, handy for isolating stages.
- **Supply rail:** a DC voltage (9 V by default; use −9 V parts for a bipolar supply).
- **Sweepable** (on pots, switches and parts): offers that part in the Sweep menus of the Response
  and Sound panels.

Models marked ≈ are approximate.

### Circuit blocks

**Blocks ▾** drops a ready-made stage into the schematic you're working on:
- Bias supply (VREF): 9 V into a 10k/10k divider with 47 µF, making the 4.5 V VREF the other
  blocks use;
- op-amp input buffer (Klon-style), JFET buffer and BJT buffer;
- Tube Screamer clipping stage, and Tube Screamer tone and volume;
- hard clipping to ground (RAT style).

Choose one and it follows the cursor; click to drop it (Esc cancels). Its references are renumbered
so they don't clash with the parts already there. Then wire up its **in** and **out** ends (the Checks
panel lists them until they're connected). If your circuit has no VREF yet, add the Bias supply
block too.

**Your own blocks.** Select part of a schematic (parts, wires and any notes, such as "in" and "out"
labels to show where it connects), then choose **Blocks ▾ → Save selection as block…** and give it a
name. It's listed under **Your blocks** in every pedal from then on, and drops in the same way.
- Your blocks are kept in this browser, like amp captures. Saving a block with a name you already use
  replaces it (the app asks first).
- **⤓** saves a block as a `.pfl-block.json` file, to back it up or share it; **×** removes it.
- **Import…** adds a block from a `.pfl-block.json` file. It also takes a saved pedal (`.pfl.json`),
  which becomes one block.
- To change a block, **Open** its `.pfl-block.json` (it opens like a pedal), edit it, select everything
  (Ctrl+A) and save it again under the same name.

### Tracing a schematic from a picture or PDF

**Trace ▾ → Load image or PDF…** puts a picture under the canvas to draw over:
- choose the page of a PDF, and set the opacity;
- **Move / scale** lets you drag the picture and scroll to scale it, so its parts line up with the
  grid;
- **Rotate 90°** turns it.

The picture is saved with the schematic.

### Files, tabs and the schematics folder

- **Save** (Ctrl+S) and **Save as…** write the pedal to a `.pfl.json` file. **Open** opens one, or
  imports an LTspice `.asc`.
- **Tabs:** each open schematic has its own tab, with its own undo history, settings, trace picture
  and rendered sound. Tabs are remembered between sessions.
- **Folder ▾** (Chrome and Edge) connects a folder of schematics. Open files from its list, and
  Save writes straight back into the folder. Pedalboards can also pick pedals from it.
- **Export ▾:**
  - LTspice schematic (`.asc`) and SPICE netlist (`.cir`);
  - parts list (`.csv`);
  - schematic image (`.svg` or `.png`).

Saved files are the reliable copy of your work. The browser's storage is a convenience and can be
cleared by the browser. If you close or reload the page while a tab or the pedalboard has unsaved
changes, the browser asks first.

### Response

The frequency response of the pedal (the **Output** curve), plus a curve for every probe.

- **Front panel:** turn the knobs and flip the switches, and the plot follows.
- **Tolerance:** the spread from the R and C tolerances set in the header.
- **Phase:** adds a phase plot.
- **Fix scale:** keeps the dB range fixed while you change values.
- **Sweep:** overlays curves for several settings of a Sweepable part, with **Steps** setting how
  many.
  - **and** adds a second sweep and draws every combination. For example, 5 Drive settings × 3
    Tone settings gives 15 curves: colour shows the first sweep's setting, line style (solid,
    dashed, dotted …) the second's.
- **Compare with:** overlays the output of a schematic open in another tab.
- **Source / Load:** model the guitar pickup and cable, and the amp or next pedal. The readout
  gives the input and output impedance.
- **Signal chains:** setting **Source** to **Output of ‹another tab›** feeds this pedal from that
  one. Everything (response, bias, sound) then runs through both, including how one loads the
  other.

The response is a small-signal analysis: diodes and transistors are linearised at their DC
operating point, so it shows the tone of a pedal but not its clipping. Use the Sound panel for
that.

### Sound

A full time-domain simulation of the pedal, clipping included.

- **Signal:** a sine, a fading sine (rings out like a plucked string, so you can watch the clipping
  ease off), a plucked note, a strummed chord, or an audio file (a DI guitar recording works best).
- **Level:** the guitar's peak voltage. Single coils give about 0.1–0.3 V, humbuckers 0.3–1 V.
- **Length:** in seconds, or in cycles for a steady sine (a few cycles render fast and show the
  clipping just as well).
- **Sweep:** renders several versions and overlays them. Sweep the input level, or a Sweepable part.
- **Quality:** oversampling. Higher is cleaner (less aliasing from clipping) but slower.
- **Amp:** plays the result through a Neural Amp Modeler capture.
  - Choose **Load a NAM capture (.nam)…** to add one; the app keeps it for next time.
  - **Into amp** sets how hard the pedal hits the amp.
  - Full-rig captures include the cabinet; an amp-only capture will sound harsh without a cabinet
    simulation.
- Press **Render**. You get:
  - the **Waveform**, with a window and position;
  - the **Spectrum**, with THD, the 2nd and 3rd harmonics, and the gain;
  - **▶ Pedal** and **▶ Bypass** to compare (with **Match loudness** on, to compare tone rather
    than level);
  - **Download WAV**.

If an op-amp's output reaches its supply rails, the readout warns you: that clipping comes from the
op-amp, not the diodes.

### Checks

The **Checks** panel lists problems with the drawing:
- unconnected pins;
- floating nets, or nets with no DC path to ground;
- a missing input or output jack;
- shorted supplies.

The toolbar shows a summary. Fix the errors before trusting the simulation.

### LTspice

- **Import:** open an LTspice `.asc` file.
  - For third-party symbols such as pots, select their `.asy` files at the same time.
  - The layout is kept and the connectivity is checked against LTspice's own rules.
  - An import report lists anything that was substituted (models, sources, unsupported parts).
  - **Double-check the result.** Our symbols are a different size from LTspice's, so parts shift a
    little and wires are stretched or rerouted to meet them; the drawing can come out a bit mangled
    (a wire doubling back, a part turned the other way). Compare it with the original, tidy it up,
    and check the values and models in the report.
- **Export:** Export ▾ → LTspice schematic writes an `.asc` with the same layout, nets, models and
  op-amp macromodels, ready to simulate.

---

## Pedalboard

Chain pedals together: Guitar → pedals → Amp.

- **Adding pedals:** use the menu, from the tabs open in the Builder or from your schematics
  folder.
- **Arranging them:** drag a pedal (or use ‹ ›) to reorder it. Each pedal shows its knobs; turning
  them edits that pedal.
- **Footswitches:** pedals that are off are left out of the chain, like true bypass.
- **Guitar and Amp:** set what drives the board and what it drives.
- **Stack mode:** the guitar goes through every pedal that's on. The plot shows the board's output,
  and dashed curves show the signal after each pedal.
- **Compare mode:** each pedal that's on is plotted on its own (guitar → that pedal → amp).
- **Sound:** the same panel as the Builder's, for the whole board.
- **Badges:** a pedal with problems is flagged on its card. The readout explains the problem: an
  error, a warning, or "no signal" when nothing gets from its input jack to its output jack.
- **Saving:** **Save** writes a `.pfl-board.json`. It records each pedal's file, order and on/off
  state, plus a copy of each schematic in case the file can't be found.

Pedals load each other just as they do in real life: a pedal with a low input impedance changes
the sound of the one before it. If a pedal changes the sound even with all its controls flat, that
loading is usually why. Real pedals often have an input buffer that schematics leave out; adding a
**Unity buffer** at its input shows the difference.

---

## Tips and troubleshooting

- **The response is flat or −∞ dB:** look at the Checks panel. Usually the input or output jack
  isn't connected, a wire ends short of a pin, or an op-amp has no supply.
- **The plot doesn't show clipping:** that's expected, because the response is small-signal.
  Render the Sound instead.
- **A knob doesn't seem to do much:** sweep it in the Sound panel and look at the harmonics. A
  stage that already clips hard changes little in level when its gain goes up; its tone and
  compression change instead. Try a lower input level.
- **DC voltages look wrong:** turn on DC bias (B) and compare against the original schematic's
  voltages. Check supply rails, net-label names and transistor orientation (mirror flips a
  transistor).
- **The sound renders slowly:** use cycles instead of seconds for sines, a lower Quality, or a
  shorter clip.
- **Saving a copy elsewhere:** Save as… always lets you choose a new file.
- **Found a bug?** Report it on the project's GitHub Issues page. Include the version (bottom of the
  page), your browser, and the pedal's `.pfl.json` if it's about a particular circuit.

## Known limits

- The app is designed for a computer with a mouse and keyboard, not phones or tablets.
- Part models are simplified. Diodes marked ≈ in the Model list use approximate values, and the
  LM386's bandwidth doesn't fall as its gain is turned up.
- The supply is ideal (no battery sag), and noise and hum aren't simulated.
- LTspice import can rearrange the drawing a little (our symbols are a different size), so check
  imported schematics against the original. LTspice export leaves out the LM386, which LTspice has
  no model for.
- Only 48 kHz amp captures load.
- Tabs, your blocks and amp captures are kept by this browser on this computer. Save pedals and
  export blocks to files to keep them safe.
