# Pedal Thyme

Design guitar-pedal circuits, see what they do to your tone, and hear them, all in one web page
that runs offline on your own computer.

- **Playground:** filters, shelves, mid scoops, gyrator EQ bands and amp tone stacks, ready to tweak.
  Turn the knobs, sweep a pot, add a guitar pickup and an amp input, or ask it to pick standard
  part values that hit a target frequency.
- **Pedal Builder:** draw a pedal's schematic (from scratch, from ready-made blocks such as buffers and
  clipping stages or blocks you've saved yourself, or by tracing a picture or PDF), and simulate it:
  - the frequency response at any point in the circuit, with a knob for every pot;
  - the DC voltages at every node (bias);
  - the sound itself, clipping included. Render a sine, a plucked note, a chord or your own DI
    recording, then look at the waveform and harmonics and listen to it against bypass. You can also
    play it through a Neural Amp Modeler capture of an amp.
- **Pedalboard:** chain pedals in order, switch them on and off, and see and hear the whole board,
  including how each pedal loads the next.

It imports and exports LTspice schematics, and exports SPICE netlists, parts lists and schematic
images.

## Getting started

1. Download `pedal-thyme.html` from the latest [release](../../releases/latest).
2. Double-click it. It opens in your browser; there's nothing to install.

**Browsers:** Chrome or Edge is recommended, as they can save straight back into a folder of
schematics. Firefox and Safari save by downloading a new file each time instead, and need to be
recent (Firefox 115 or later, Safari 16.4 or later). A private window may not keep your open tabs
or amp captures between sessions; saved files are always the reliable copy.

Then read the **[user guide](docs/user-guide.md)**, which is also in the app under **Help**. The quickest way in: open the **Pedal Builder**,
pick **New ▾ → Tube Screamer-style overdrive**, turn the Drive knob in the Front panel, and press
**Render** in the Sound panel.

## Privacy and safety

- **Offline:** everything is inside the one HTML file. Its Content Security Policy stops it loading
  or sending anything over the network, so it works without internet and can't send anything
  anywhere.
- **Your work stays on your computer:** schematics are saved as files where you choose; open tabs
  and the current pedalboard are also kept in the browser's storage between sessions.
- **Files from other people** (schematics, pedalboards, LTspice files, PDFs) are treated as
  untrusted. Schematics are rebuilt field by field with checked types, all text is escaped before
  it's shown, and PDFs are drawn by PDF.js without running any code they contain.

## Checking a download

Each release lists the SHA-256 checksum of `pedal-thyme.html` (also attached as
`pedal-thyme.html.sha256`). To check your copy is the released file, compare it with the output of:
- Windows (PowerShell): `Get-FileHash pedal-thyme.html`
- macOS: `shasum -a 256 pedal-thyme.html`
- Linux: `sha256sum pedal-thyme.html`

## Updating

Download the new `pedal-thyme.html` and replace the old one (same name, same folder). Your open tabs
and pedalboard carry over, and files saved with older versions keep opening: every release is
tested against files saved by the earlier ones. The version number is shown at the bottom of the
page.

## Accuracy

The engine is a circuit simulator in the same family as SPICE:
- the frequency response is a small-signal analysis around the DC operating point;
- the Sound panel is a full nonlinear time-domain simulation.

Its results were cross-checked against LTspice; details are in the
[developer guide](docs/development.md#accuracy). The part models are simplified, though: op-amps
are macromodels (gain, bandwidth, slew rate, output swing, input bias current), and transistors
use Ebers–Moll and square-law models. Treat the results as a good guide to how a design behaves,
not as a guarantee of how a particular build will sound.

## Known limits

- **Desktop only.** The app is built for a mouse and keyboard on a computer screen; it isn't
  designed for phones or tablets.
- **Browsers:** Chrome and Edge are the main targets. Firefox (115+) and Safari (16.4+) should work,
  but save by downloading instead of writing into a folder, and have had less testing.
- **Simplified part models** (see [Accuracy](#accuracy)):
  - some diodes, such as the 1N34A and 1S1588, use approximate values, marked as such in the app;
  - the LM386's bandwidth doesn't fall as its gain is turned up, as a real one's does.
- **Ideal supply, no noise:** the supply is a perfect voltage source (no battery sag), and the
  noise and hum a real build picks up aren't simulated.
- **LTspice import** works, but the drawing can come out a little mangled: our part symbols are a
  different size from LTspice's, so parts shift slightly and wires are stretched or rerouted to meet
  them. The connections are checked against LTspice's, and anything it couldn't place is listed after
  importing, but double-check the imported schematic (parts, values and wiring) against the original.
- **LTspice export** leaves out the LM386 (LTspice has no model for it) and lists what it skipped.
- **Amp captures:** only 48 kHz `.nam` files load. The amp sound isn't checked sample-for-sample
  against Neural Amp Modeler's own player, though it follows the same model.
- **Stored in one browser:** open tabs, your blocks and amp captures are kept by the browser you
  use, on that computer. Clearing its site data removes them, and a private window may not keep
  them at all. Save pedals and export blocks to files to keep them safe.

## Amp captures

No amp captures are included. To play the sound through an amp, download Neural Amp Modeler
captures (`.nam` files) yourself, for example from [TONE3000](https://www.tone3000.com/), and load
them from the Sound panel's **Amp** menu. Full-rig captures (amp and cabinet) work best.

## Building from source

You need [Node.js](https://nodejs.org/) (the LTS version).

```bash
npm install
npm run dev      # development server at http://localhost:5173
npm test         # unit tests
npm run build    # dist/pedal-thyme.html: the single file you share
```

See the [developer guide](docs/development.md) for how the code is organised and how to make a
release.

## Third-party software

The built file includes [PDF.js](https://mozilla.github.io/pdf.js/) (Apache License 2.0). The NAM
capture player is written after
[NeuralAmpModelerCore](https://github.com/sdatkinson/NeuralAmpModelerCore) (MIT). Both licence texts
are in the app under **Third-party licences** at the bottom of the page, and in `third-party/`.

## Suggestions

Ideas for improvements are welcome: open a [suggestion on GitHub Issues](../../issues/new/choose).
I'll work through them as I'm able.

You're also free to fork the project and make your own changes (it's MIT licensed, see
[Licence](#licence)); [Building from source](#building-from-source) and the
[developer guide](docs/development.md) explain how. Pull requests aren't accepted, though: the app
is a file people download and run on their own computers, so for security every line of it is
written and reviewed here.

## Reporting a problem

Use [GitHub Issues](../../issues/new/choose). The bug report form asks for the version (shown at the
bottom of the page), your browser, and, if it's about a particular circuit, its `.pfl.json` file.

## Licence

Pedal Thyme is released under the [MIT License](LICENSE).
