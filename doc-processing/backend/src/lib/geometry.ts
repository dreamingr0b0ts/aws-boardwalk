import type { Box } from './store.js';

/** One OCR'd word: its character span in the assembled text plus page geometry. */
export interface WordRef {
  start: number;
  end: number;
  box: Box;
}

export const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
export const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Turn a character span of the assembled OCR text into page boxes via the
 * word map: collect the words the span overlaps, then merge horizontal runs
 * (same page, same baseline) into single bars. Offsets index into the exact
 * string the OCR step assembled, so for the ASCII text these documents
 * produce the mapping is exact; a multibyte drift would only nudge a bar by
 * a word.
 */
export function spanBoxes(words: WordRef[], begin: number, end: number): Box[] {
  const hit = words.filter((w) => w.start < end && w.end > begin).map((w) => w.box);
  const boxes: Box[] = [];
  for (const b of hit) {
    const prev = boxes[boxes.length - 1];
    const sameLine = prev && prev.p === b.p && Math.abs(prev.t - b.t) < Math.max(prev.h, b.h) * 0.6;
    if (sameLine) {
      const right = Math.max(prev.l + prev.w, b.l + b.w);
      const bottom = Math.max(prev.t + prev.h, b.t + b.h);
      prev.l = Math.min(prev.l, b.l);
      prev.t = Math.min(prev.t, b.t);
      prev.w = round4(right - prev.l);
      prev.h = round4(bottom - prev.t);
    } else {
      boxes.push({ ...b });
    }
  }
  return boxes;
}
