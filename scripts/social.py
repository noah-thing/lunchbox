"""Social previews for GitHub (1280x640) and the website (1200x630), built from the real app.

Left: the mark, the name, the line and the crew. Right: the room from the README shot, running
off the edge. Rendered from SVG so type and logos stay sharp. python3 scripts/social.py
"""
import base64, io, json, re, subprocess
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / '.github' / 'assets'
INK, PAPER, DIM, LINE = '#121110', '#F2F0EA', '#A29E95', 'rgba(242,240,234,.12)'

mark = re.search(r'(<g transform=.*?</g>)', (ASSETS / 'mark-paper.svg').read_text(), re.S).group(1)
mark_box = [float(v) for v in re.search(r'viewBox="([^"]+)"', (ASSETS / 'mark-paper.svg').read_text()).group(1).split()]
brands = json.loads('{' + re.search(r'BRANDS[^=]*=\s*\{(.*?)\n\}', (ROOT / 'src/ui/brands.ts').read_text(), re.S).group(1).strip().rstrip(',').replace('\n', '').replace('  ', '')
                    .replace('claude:', '"claude":').replace('codex:', '"codex":').replace('openai:', '"openai":').replace('grok:', '"grok":')
                    .replace('gemini:', '"gemini":').replace('ollama:', '"ollama":').replace('lmstudio:', '"lmstudio":').replace('openrouter:', '"openrouter":')
                    .replace('opencode:', '"opencode":') + '}')


def shot(width, height):
    """The room, cropped to the conversation, with rounded corners, as a data URI."""
    im = Image.open(ASSETS / 'room-dark.png').convert('RGB')
    # The conversation column of the README shot: Grok's answer, Codex's banner, Claude's post.
    im = im.crop((470, 120, 2230, 1500))
    im = im.resize((width * 2, round(width * 2 * im.height / im.width)), Image.LANCZOS)
    im = im.crop((0, 0, width * 2, min(im.height, height * 2)))
    mask = Image.new('L', im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, im.width - 1, im.height - 1), 36, fill=255)
    im.putalpha(mask)
    buf = io.BytesIO()
    im.save(buf, 'PNG', optimize=True)
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode(), im.width // 2, im.height // 2


def render(name, W, H):
    k = H / 640
    x0 = 84 * k
    sw = int(W * 0.52)
    uri, iw, ih = shot(sw, int(H * 0.86))
    sx, sy = W - sw + 40 * k, 78 * k
    msize = 64 * k
    mscale = msize / mark_box[2]
    logos = ''
    for i, key in enumerate(['claude', 'codex', 'grok', 'gemini']):
        lx = x0 + i * 46 * k
        logos += f'<g transform="translate({lx:.1f} {H - 128 * k:.1f}) scale({26 * k / 24:.4f})" fill="{PAPER}" fill-rule="evenodd">' + ''.join(f'<path d="{d}"/>' for d in brands[key]) + '</g>'
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
<defs>
  <radialGradient id="glow" cx="0.82" cy="0.35" r="0.7"><stop offset="0" stop-color="#2a2824"/><stop offset="1" stop-color="{INK}"/></radialGradient>
  <filter id="shadow" x="-10%" y="-10%" width="130%" height="130%"><feDropShadow dx="0" dy="{18 * k:.1f}" stdDeviation="{24 * k:.1f}" flood-color="#000" flood-opacity=".55"/></filter>
</defs>
<rect width="{W}" height="{H}" fill="url(#glow)"/>
<g filter="url(#shadow)"><image x="{sx:.1f}" y="{sy:.1f}" width="{iw}" height="{ih}" xlink:href="{uri}"/></g>
<rect x="{sx + .5:.1f}" y="{sy + .5:.1f}" width="{iw}" height="{ih}" rx="{18:.1f}" fill="none" stroke="{LINE}"/>
<g transform="translate({x0:.1f} {120 * k:.1f}) scale({mscale:.5f}) translate({-mark_box[0]:.1f} {-mark_box[1]:.1f})">{mark}</g>
<text x="{x0:.1f}" y="{292 * k:.1f}" fill="{PAPER}" font-family="Helvetica Neue" font-weight="500" font-size="{80 * k:.1f}" letter-spacing="{-2.4 * k:.2f}">Lunchbox</text>
<text font-family="Helvetica Neue" font-size="{29 * k:.1f}" fill="{DIM}" letter-spacing="{-.2 * k:.2f}">
  <tspan x="{x0:.1f}" y="{352 * k:.1f}">The AI tools you already pay for,</tspan>
  <tspan x="{x0:.1f}" y="{392 * k:.1f}">working together in one room.</tspan>
</text>
{logos}
<text x="{x0:.1f}" y="{H - 66 * k:.1f}" fill="{DIM}" font-family="Menlo" font-size="{15 * k:.1f}" letter-spacing="{.4 * k:.2f}">claude code · codex · grok · gemini · local models</text>
</svg>'''
    out = ASSETS / f'{name}.svg'
    out.write_text(svg)
    subprocess.run(['rsvg-convert', '-w', str(W * 2), '-h', str(H * 2), str(out), '-o', str(ASSETS / f'{name}@2x.png')], check=True)
    subprocess.run(['rsvg-convert', '-w', str(W), '-h', str(H), str(out), '-o', str(ASSETS / f'{name}.png')], check=True)
    out.unlink()
    print(name, W, H)


render('social-github', 1280, 640)
render('social-web', 1200, 630)
