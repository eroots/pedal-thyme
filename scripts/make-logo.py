"""Make the app's logo files from the artwork in assets/logo.svg (exported from CorelDRAW).

Writes, into src/ui/logo/:
- logo.svg: the drawing with "Rooted Audio" under it (larger than in the artwork, to read at header
  size), its lettering turned into shapes (CorelDRAW stores it in an SVG font, which browsers don't show);
- name.svg: "Pedal Thyme" as shapes in Bahnschrift SemiBold, the logo's typeface (a Windows font that
  can't be bundled, so the letters are drawn instead);
- icon.svg: the drawing alone, square, with heavier lines, for the browser tab. It switches between
  dark and light lines with the browser's colour scheme.
Everything else uses currentColor, so the page sets the colour.

Needs Python 3 with fontTools, and Windows' Bahnschrift (C:\\Windows\\Fonts\\bahnschrift.ttf).
Run from the project folder:  python scripts/make-logo.py
"""
import re
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ART, FONT, OUT = 'assets/logo.svg', r'C:\Windows\Fonts\bahnschrift.ttf', 'src/ui/logo'
TEXT_SCALE = 1.6  # "Rooted Audio", relative to the artwork


def num(v: float) -> str:
    return f'{v:.1f}'.rstrip('0').rstrip('.')


art = open(ART, encoding='utf-16').read()

# The drawing: CorelDRAW's lines and paths, stroked in currentColor.
shapes = [f'<line x1="{a}" y1="{b}" x2="{c}" y2="{d}"/>' for a, b, c, d in
          re.findall(r'<line class="[^"]*" x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2=\s*"([\d.]+)"', art)]
shapes += [f'<path d="{d}"/>' for d in re.findall(r'<path class="fil0 str0" d="([^"]*)"', art)]
STROKE = float(re.search(r'stroke-width:([\d.]+)', art).group(1))
# Its extent (worked out from the paths' end points), with room for the stroke.
MX0, MY0, MX1, MY1 = 1714, 341, 4265, 4311


def drawing(width: float) -> str:
    return (f'<g fill="none" stroke="currentColor" stroke-width="{num(width)}" stroke-linecap="round" '
            f'stroke-linejoin="round">{"".join(shapes)}</g>')


# "Rooted Audio" from the SVG font's glyphs (units per em 1000, y up), centred under the drawing.
glyphs = {u: (float(a), d) for u, a, d in
          re.findall(r'<glyph\s+unicode="(.)"\s+horiz-adv-x="([\d.]+)"\s+d="([^"]*)"', art)}
default_adv = float(re.search(r'<font [^>]*horiz-adv-x="([\d.]+)"', art).group(1))
text = re.search(r'<text [^>]*>([^<]*)</text>', art).group(1)
size = float(re.search(r'font-size:([\d.]+)px', art).group(1)) * TEXT_SCALE
k = size / 1000
width = sum(glyphs.get(ch, (default_adv, ''))[0] for ch in text) * k
cap = 710 * k  # cap height of these glyphs
x, base = (MX0 + MX1) / 2 - width / 2, MY1 + 330 + cap
letters = []
for ch in text:
    adv, d = glyphs.get(ch, (default_adv, ''))
    if d:
        letters.append(f'<path transform="translate({num(x)} {num(base)}) scale({k:.4f} {-k:.4f})" d="{d}"/>')
    x += adv * k
pad = STROKE
x0, x1 = min(MX0, (MX0 + MX1) / 2 - width / 2) - pad, max(MX1, (MX0 + MX1) / 2 + width / 2) + pad
y0, y1 = MY0 - pad, base + 40 * k + pad  # a little below the baseline for "d"/"u" bottoms
logo = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{num(x0)} {num(y0)} {num(x1 - x0)} {num(y1 - y0)}">'
        f'{drawing(STROKE * 1.2)}<g fill="currentColor">{"".join(letters)}</g></svg>\n')

# "Pedal Thyme" in Bahnschrift SemiBold, with the font's pair kerning.
font = instantiateVariableFont(TTFont(FONT), {'wght': 600, 'wdth': 100})
cmap, gs, hmtx = font.getBestCmap(), font.getGlyphSet(), font['hmtx']


def kerning(left: str, right: str) -> int:
    for lookup in font['GPOS'].table.LookupList.Lookup:
        for st in lookup.SubTable:
            if lookup.LookupType == 9:
                st = st.ExtSubTable
            if getattr(st, 'LookupType', lookup.LookupType) != 2 or left not in st.Coverage.glyphs:
                continue
            if st.Format == 1:
                for pvr in st.PairSet[st.Coverage.glyphs.index(left)].PairValueRecord:
                    if pvr.SecondGlyph == right and pvr.Value1 is not None:
                        return getattr(pvr.Value1, 'XAdvance', 0) or 0
            else:
                c1, c2 = st.ClassDef1.classDefs.get(left, 0), st.ClassDef2.classDefs.get(right, 0)
                v = st.Class1Record[c1].Class2Record[c2].Value1
                if v is not None and getattr(v, 'XAdvance', 0):
                    return v.XAdvance
    return 0


name, x, parts, prev = 'Pedal Thyme', 0, [], None
for ch in name:
    g = cmap[ord(ch)]
    if prev:
        x += kerning(prev, g)
    pen = SVGPathPen(gs)
    gs[g].draw(TransformPen(pen, (1, 0, 0, -1, x, 0)))
    if pen.getCommands():
        parts.append(pen.getCommands())
    x += hmtx[g][0]
    prev = g
asc, desc = font['hhea'].ascent, -font['hhea'].descent
cap_h = font['OS/2'].sCapHeight
# Cap height to descender: the letters' own height, so the name sits level with the logo's lettering.
name_svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 {-cap_h - 40} {x} {cap_h + 40 + 430}">'
            f'<path fill="currentColor" d="{" ".join(parts)}"/></svg>\n')

# Tab icon: the drawing alone in a square, heavier lines; dark on light browsers, light on dark ones.
side = max(MX1 - MX0, MY1 - MY0) + 2 * 330
icx, icy = (MX0 + MX1) / 2 - side / 2, (MY0 + MY1) / 2 - side / 2
icon = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{num(icx)} {num(icy)} {num(side)} {num(side)}">'
        '<style>g{color:#1f1e1c}@media (prefers-color-scheme:dark){g{color:#ecebe8}}</style>'
        f'{drawing(330)}</svg>\n')

for fname, content in (('logo.svg', logo), ('name.svg', name_svg), ('icon.svg', icon)):
    with open(f'{OUT}/{fname}', 'w', encoding='utf-8', newline='\n') as f:
        f.write(content)
    print(fname, len(content), 'bytes')
