// Studio: the working method Lunchbox adds when the person switches it on. The model keeps its
// own taste and gains a process: decide a direction, build from a system, look at the result,
// criticise it, fix it, and hand over with evidence. The person's own guides always win.

export type Craft = 'ui' | 'graphic' | '3d' | 'slides' | 'motion' | 'writing' | 'code'

// Bare words such as "page", "scene", "render", "print", "cover", "brand" and "write" are left out
// on purpose: "render the list", "brand new" and "write a test" are not design requests.
const KINDS: [Craft, RegExp][] = [
  ['3d', /\b(3d|blender|cycles|eevee|hdri|three\.?js|react three fiber|r3f|webgl|webgpu|mesh(es)?|sculpt\w*|shaders?|glb|gltf|fbx|usdz|unreal engine|low ?poly|ray ?trac\w+|turntable|uv (map|unwrap)\w*|product renders?)\b/i],
  ['motion', /\b(animat\w+|motion|video|remotion|after effects|transitions?|keyframes?|lottie|gsap|easing|storyboard|title sequence|launch film|trailer)\b/i],
  ['slides', /\b(slides?|deck|presentation|keynote|powerpoint|pptx)\b/i],
  ['graphic', /\b(logo(type)?s?|wordmark|poster|flyer|banner|thumbnail|social (post|graphic|image)|og image|branding|rebrand|brand (identity|kit|book|mark|guide\w*)|icons?|favicon|illustrat\w+|typography|print (design|ad|layout)|for print|packaging|(book|album|magazine) cover|cover (art|image)|infographic|business card|merch|sticker|moodboard)\b/i],
  ['ui', /\b(ui|ux|website|web ?site|web ?app|landing|home ?page|web ?page|(pricing|about|contact|product|settings|login|sign ?up|checkout|onboarding) (page|screen|flow)|app screen|screens?|dashboard|components?|css|tailwind|html|front ?end|layout|nav(bar| bar|igation)|sidebar|modal|hero|figma|design system|redesign|restyle|dark mode|responsive)\b/i],
  ['writing', /\b(essay|blog|copywriting|(web|site|page|landing|marketing|ad|ux|micro) ?copy|copy for|email|article|story|newsletter|proofread|reword|rephrase|headline|tagline|press release|caption|speech|cover letter|tone)\b/i],
  ['code', /\b(bug|fix|refactor|tests?|api|endpoint|function|typescript|javascript|python|rust|swift|sql|database|migration|script|crash\w*|exception|stack trace|type error|lint\w*|compile\w*|build (error|fail\w*)|deploy\w*|regex)\b/i],
]

// The kinds of craft a message asks for, most specific first, at most two.
export function crafts(text: string): Craft[] {
  return KINDS.filter(([, re]) => re.test(text)).map(([k]) => k).slice(0, 2)
}

// Files that carry a project's own design direction. When any exist, they lead and Studio follows.
export const DESIGN_SOURCES = [
  'DESIGN.md', 'design.md', 'docs/DESIGN.md', 'docs/design.md', 'DESIGN_SYSTEM.md', 'docs/design-system.md',
  'BRAND.md', 'brand.md', 'docs/brand.md', 'BRAND_GUIDELINES.md', 'STYLEGUIDE.md', 'styleguide.md', 'docs/styleguide.md', '.impeccable.md',
  // Token exports: Tokens Studio, the Figma Design Tokens plugin, Figma variables, Style Dictionary.
  'tokens.json', 'design-tokens.json', 'design-tokens.tokens.json', 'figma-tokens.json', 'variables.json', 'tokens', 'design-tokens',
  'style-dictionary.config.json', 'style-dictionary.config.js', 'sd.config.js', 'sd.config.ts',
  'tokens.css', 'src/tokens.css', 'src/styles/tokens.css', 'styles/tokens.css', 'src/styles/variables.css', 'styles/variables.css', 'src/styles/_variables.scss',
  'theme.json', 'theme.ts', 'src/theme.ts', 'src/theme.js', 'src/styles/theme.css', 'src/styles/theme.ts', 'src/theme/index.ts',
  'tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.mjs', 'tailwind.config.cjs', 'panda.config.ts', 'uno.config.ts', 'components.json',
  'app/globals.css', 'src/app/globals.css', '.storybook',
  'brand', 'assets/brand', 'public/brand', 'design', 'references', 'reference', 'refs', 'inspiration', 'moodboard',
]

// What makes work look machine made at a glance. Studio steers away from it unless asked for.
const GENERIC = [
  'a purple to blue gradient accent',
  'a centred hero above three identical icon cards',
  'a pill badge above every headline',
  'emoji as icons',
  'one radius and one soft shadow on everything',
  'one default sans (Inter, Roboto, system) at three near sizes',
  'filler copy such as "Unlock the power of"',
  'invented numbers, logos or testimonials',
  'blobs and sparkles that mean nothing',
]

export function studioCore(sources: string[]) {
  return [
    'Studio is on. The person wants finished, considered work. Work as a senior designer who also builds.',
    sources.length
      ? `1. Their direction rules. This project carries its own in: ${sources.join(', ')}. Read these first and follow them exactly, along with every attachment, reference and instruction from the person. Where they conflict with anything below, they win. Where they are silent, extend them in their own spirit. A file still at its framework default sets no direction.`
      : '1. Their direction rules. Whatever the person, the project or an attached file sets (a style, a design system, references, rules) is followed exactly. Where it conflicts with anything below, it wins. Where it is silent, extend it in its own spirit.',
    '2. Decide before building new visual work. In three lines: who it is for and what they should do or feel; one direction concrete enough to be wrong (a period, a material, a printed object, a named maker or place); what that rules out. If the design would still fit under another brand\'s name, sharpen it. Then fix the system: type families and scale, colours with roles, spacing unit, radius. For existing work, name the system already there and stay inside it.',
    `3. Unless asked for, avoid the machine made look: ${GENERIC.join('; ')}.`,
    '4. Build from the system: tokens first, then parts that use only those tokens.',
    '5. Look at the real result. Capture pages with studio_look at desktop and phone width (or browser_screenshot), render 3D and graphics to image files, then open the images and read them.',
    '6. Criticise honestly. In each image, find the weakest area first and name where it is. Squint: note what reads first, second and third, and compare with the order you intended, the direction and the checklist. List faults as what, where and the fix. Fix the worst three and capture again. New visual work gets two rounds at least; stop when a round finds nothing a careful person would notice, after four at most. Praise is no finding.',
    '7. A second eye. When a crewmate can read images, ask it once for the three weakest points in the final images, passing the paths and the direction. Act on what holds up.',
    '8. Hand over with evidence: what you checked, the image paths, and what is still weak or unverified. Every claim about how it looks rests on an image made after your last edit. If nothing could capture it, say so.',
    'Keep the size of the job. A one line fix stays a one line fix: skip steps 2 and 7, look once, report. Studio never adds pages, features, restyling or dependencies nobody asked for. Offer such an idea in one line and let the person choose.',
  ].join('\n')
}

const CHECKS: Record<Craft, string[]> = {
  ui: [
    'First read: one element wins each screen; the main action shows without scrolling at both widths.',
    'Type: one scale (ratio 1.2 to 1.33), two families at most, body 16px or more, 45 to 75 characters a line, body line height 1.4 to 1.6, headings tighter.',
    'Space: every gap a multiple of 4 or 8px. Gaps inside a group are smaller than gaps between groups.',
    'Colour: one accent, used for actions. Contrast 4.5:1 for text and 3:1 for large text, computed from the real values.',
    'States: hover, keyboard focus, disabled, loading, empty, error, and a very long name in every text slot.',
    'Phone (390px): no sideways scroll, nothing clipped or overlapping, tap targets 44px or more.',
    'Finish: one icon set at one stroke weight, real copy, images with set dimensions, motion of 150 to 300ms that respects the reduced motion setting.',
  ],
  graphic: [
    'One focal point, found within a second at thumbnail size, at least twice the size of the next element. A reading order of three steps.',
    'A grid with set margins, every edge on it. Nothing nearly aligned or nearly touching.',
    'Type: two families at most, display sizes kerned, no stretched or fake bold letters, no single word alone on a last line, no text over a busy area without a backing.',
    'Colour: three to five colours, each with a role. In greyscale the focal point still leads.',
    'Marks and icons: legible at 16px and 512px, in one colour, on light and dark.',
    'Export at final size and format (SVG for marks, PNG or PDF otherwise; 300dpi and 3mm bleed for print) and inspect the exported file.',
    'Generated images: read every letter and count fingers. Regenerate, or set the type yourself.',
  ],
  '3d': [
    'Scale in metres, transforms applied. Objects rest on the ground with a contact shadow; nothing floats or intersects.',
    'Hard edges bevelled enough to catch a highlight. No black faces or shading seams.',
    'Lighting chosen: key, fill and rim, or an HDRI, with one clear key direction. The silhouette separates from the background. No large blown or crushed areas.',
    'Materials: roughness varies, base colour is never pure black or pure white, no stretched UVs or visible tiling.',
    'Camera: 35 to 85mm for objects, level horizon, depth of field only with a reason.',
    'Weight fits the target: quads where it deforms; for the web, state triangle count and GLB size.',
    'Render three views (hero, opposite side, close detail), free of noise and fireflies, and inspect each. For the web, load the GLB in a page and capture it.',
  ],
  slides: [
    'One idea per slide. The headline is the takeaway as a sentence, and the headlines read in order tell the whole story.',
    'Body 24pt or more, about 30 words a slide, four bullets at most.',
    'One grid: titles in the same place and the same margins on every slide, one palette, nothing in the outer 5%.',
    'Show it: diagrams, real data in labelled charts with one series highlighted, full images.',
    'Render every slide to an image and inspect each for overflow, clipped text and leftover placeholders.',
  ],
  motion: [
    'Each movement has a cause and a direction, and the eye has one thing to follow at a time.',
    'Easing: out for entrances, in for exits, in and out for moves on screen. Linear only for mechanical or continuous motion.',
    'Timing: 150 to 300ms for interface motion, exits shorter than entrances, staggers of 20 to 60ms, text held long enough to read (about three words a second).',
    'Continuity: things travel from where they were. Avoid fading everything in at once.',
    'In interfaces, animate transform and opacity only, never block input, respect the reduced motion setting.',
    'Render and watch at full speed, then inspect the first, middle and last frame of every transition. For video, check cuts against the beat and text inside safe margins.',
  ],
  writing: [
    'The first sentence carries the point. A reader who stops there still has it.',
    'Short sentences, concrete nouns, active verbs, one idea a paragraph. Names and figures in place of adjectives.',
    'Cut filler, hedges, stock phrases and anything said twice.',
    'Match the person\'s own voice and spelling where samples exist, and the length and register of the medium.',
    'Facts, names and figures are checked or marked as unverified. Nothing invented.',
    'Read it once from start to finish as the reader before handing over.',
  ],
  code: [
    'Read the code around the change and match its conventions, names and error handling.',
    'Reproduce a bug before fixing it, and fix the cause.',
    'The smallest change that solves it. No refactors in passing, no new dependency without saying so.',
    'Cover the edges the change touches: empty, missing, failing, concurrent.',
    'Run the tests, type check or build after the last edit. Report exactly what ran, what it showed, and what is unverified.',
  ],
}

// The checklist for the kinds of work in this message. Empty when it is not a craft task.
export function studioChecks(text: string): string {
  const kinds = crafts(text)
  if (!kinds.length) return ''
  const names: Record<Craft, string> = { ui: 'interface', graphic: 'graphic design', '3d': '3D', slides: 'slides', motion: 'motion', writing: 'writing', code: 'code' }
  return kinds.map((k) => `Studio checklist for ${names[k]}:\n${CHECKS[k].map((c) => `- ${c}`).join('\n')}`).join('\n\n')
}

// What Lunchbox itself offers, so an agent can point the person to the right part of the app,
// at the right moment and no more often than that.
export const LUNCHBOX = [
  'Lunchbox around this room, for when it clearly helps the person:',
  '- Flows run work on a schedule with several steps, such as a daily summary or a weekly check. If the person asks for something that should repeat, offer one with propose_flow; it appears as a card they can accept.',
  '- Side by side sends one message to the whole crew and keeps the best answer. Library has playbooks and MCP tools added in one click. Checkpoints keep every change, so anything can be rewound. Pool shows the limits of every plan; Savings shows what caching saved. Studio is a working mode for design that the person can switch on in the message box.',
  'Mention one of these only when it plainly fits what the person is doing, at most once in a room, and never in place of doing the work.',
].join('\n')
