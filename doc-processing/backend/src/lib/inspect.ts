import { PDFDocument } from 'pdf-lib';

// The page cap is the plank's Textract cost ceiling, so it has to be decided
// from the bytes Textract will read, never from the filename: a 3,000-page
// TIFF or a PDF renamed x.png costs exactly what its pages cost. Everything
// here fails closed. A file whose content does not match its extension, that
// looks like two formats at once, or that cannot be walked to a page count is
// rejected before any OCR spend.

export type FileKind = 'pdf' | 'png' | 'jpeg' | 'tiff';

const EXT_KIND: Record<string, FileKind> = {
  pdf: 'pdf',
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  tif: 'tiff',
  tiff: 'tiff',
};

const LABEL: Record<FileKind, string> = { pdf: 'PDF', png: 'PNG', jpeg: 'JPEG', tiff: 'TIFF' };

export type Inspection = { ok: true; kind: FileKind; pages: number } | { ok: false; reason: string };

const startsWith = (b: Uint8Array, sig: number[]) => b.length >= sig.length && sig.every((v, i) => b[i] === v);

// PDF readers accept the "%PDF-" header anywhere in the first 1024 bytes, so
// that is where a PDF hiding behind an image signature would put it.
function hasPdfHeader(b: Uint8Array): boolean {
  const end = Math.min(b.length, 1024) - 5;
  for (let i = 0; i <= end; i++) {
    if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46 && b[i + 4] === 0x2d) return true;
  }
  return false;
}

/** Every format signature present in the bytes; more than one is a polyglot. */
export function sniffKinds(b: Uint8Array): (FileKind | 'bigtiff')[] {
  const kinds: (FileKind | 'bigtiff')[] = [];
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) kinds.push('png');
  if (startsWith(b, [0xff, 0xd8, 0xff])) kinds.push('jpeg');
  if (startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a])) kinds.push('tiff');
  if (startsWith(b, [0x49, 0x49, 0x2b, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2b])) kinds.push('bigtiff');
  if (hasPdfHeader(b)) kinds.push('pdf');
  return kinds;
}

/**
 * Pages in a classic TIFF = image file directories on the main chain. Stops
 * counting one past `stopAfter` (the caller only needs "over the cap"), and
 * throws on anything a decoder could read differently than this walk does:
 * offsets outside the file, a directory with no entries, or a chain that
 * loops back on itself.
 */
export function countTiffPages(b: Uint8Array, stopAfter: number): number {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const le = b[0] === 0x49;
  const seen = new Set<number>();
  let pages = 0;
  let off = dv.getUint32(4, le);
  while (off !== 0) {
    if (seen.has(off) || off + 2 > b.byteLength) throw new Error('TIFF directory offset is invalid');
    seen.add(off);
    const entries = dv.getUint16(off, le);
    const nextAt = off + 2 + entries * 12;
    if (entries === 0 || nextAt + 4 > b.byteLength) throw new Error('TIFF directory is truncated');
    pages++;
    if (pages > stopAfter) return pages;
    off = dv.getUint32(nextAt, le);
  }
  if (pages === 0) throw new Error('TIFF has no image directory');
  return pages;
}

/**
 * Decide what an upload really is and how many pages Textract would bill.
 * `ext` is the lower-cased filename extension the grant was issued for.
 */
export async function inspectUpload(bytes: Uint8Array, ext: string, maxPages: number): Promise<Inspection> {
  const expected = EXT_KIND[ext];
  if (!expected) return { ok: false, reason: `Unsupported file type .${ext}; PDF and image formats only` };

  const kinds = sniffKinds(bytes);
  if (kinds.length !== 1 || kinds[0] !== expected) {
    return { ok: false, reason: `File content is not a valid ${LABEL[expected]}; it does not match the .${ext} extension` };
  }

  let pages = 1; // PNG and JPEG are single images
  if (expected === 'pdf') {
    try {
      const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      pages = pdf.getPageCount();
    } catch {
      return { ok: false, reason: 'File could not be parsed as a PDF' };
    }
  } else if (expected === 'tiff') {
    try {
      pages = countTiffPages(bytes, maxPages);
    } catch {
      return { ok: false, reason: 'File could not be parsed as a TIFF' };
    }
  }

  if (pages < 1) return { ok: false, reason: 'Document has no pages' };
  if (pages > maxPages) {
    const count = expected === 'tiff' ? `more than ${maxPages}` : String(pages);
    return { ok: false, reason: `Document has ${count} pages; the demo cap is ${maxPages} pages per document` };
  }
  return { ok: true, kind: expected, pages };
}
