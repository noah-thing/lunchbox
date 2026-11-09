// A 5 by 7 dot matrix, one hex byte per row, low five bits used. Big numbers and the wordmark
// are drawn from these, so they are made of the same cells as everything else.
const FONT: Record<string, string> = {
  '0': '0e11131519110e', '1': '040c040404040e', '2': '0e11010204081f', '3': '1f02040201110e',
  '4': '02060a121f0202', '5': '1f101e0101110e', '6': '0608101e11110e', '7': '1f010204080808',
  '8': '0e11110e11110e', '9': '0e11110f01020c', A: '0e1111111f1111', B: '1e11111e11111e',
  C: '0e11101010110e', D: '1c12111111121c', E: '1f10101e10101f', F: '1f10101e101010',
  G: '0e11101711110f', H: '1111111f111111', I: '0e04040404040e', K: '11121418141211',
  L: '1010101010101f', M: '111b1515111111', N: '11111915131111', O: '0e11111111110e',
  P: '1e11111e101010', R: '1e11111e141211', S: '0f10100e01011e', T: '1f040404040404',
  U: '1111111111110e', V: '11111111110a04', W: '1111111515150a', X: '11110a040a1111',
  Y: '1111110a040404', '%': '18190204081303', '.': '00000000000c0c', ':': '000c0c000c0c00',
  '-': '0000001f000000', $: '040f140e051e04', ' ': '00000000000000', '/': '01010204081010',
}

export function glyph(ch: string): number[] {
  const hex = FONT[ch.toUpperCase()] ?? FONT[' ']
  return Array.from({ length: 7 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16))
}

// Lit dots for a line of text, as [x, y] in dot units, with one blank column between letters.
export function dots(text: string) {
  const out: [number, number][] = []
  ;[...text].forEach((ch, i) => {
    glyph(ch).forEach((row, y) => {
      for (let x = 0; x < 5; x++) if (row & (1 << (4 - x))) out.push([i * 6 + x, y])
    })
  })
  return { dots: out, width: text.length * 6 - 1, height: 7 }
}
