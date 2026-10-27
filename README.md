# Pedal Lab

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

1. Download `pedal-lab.html` from the latest [release](../../releases/latest).
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

Each release lists the SHA-256 checksum of `pedal-lab.html` (also attached as
`pedal-lab.html.sha256`). To check your copy is the released file, compare it with the output of:
- Windows (PowerShell): `Get-FileHash pedal-lab.html`
- macOS: `shasum -a 256 pedal-lab.html`
- Linux: `sha256sum pedal-lab.html`

## Updating

Download the new `pedal-lab.html` and replace the old one (same name, same folder). Your open tabs
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
npm run build    # dist/pedal-lab.html: the single file you share
```

See the [developer guide](docs/development.md) for how the code is organised and how to make a
release.

## Third-party software

The built file includes [PDF.js](https://mozilla.github.io/pdf.js/) (Apache License 2.0). The NAM
capture player is written after
[NeuralAmpModelerCore](https://github.com/sdatkinson/NeuralAmpModelerCore) (MIT). Both licence texts
are in the app under **Third-party licences** at the bottom of the page, and in `third-party/`.

## Licence

Pedal Lab is released under the [MIT License](LICENSE).
