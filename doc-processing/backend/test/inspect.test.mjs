// Unit tests for the byte-level upload guard (src/lib/inspect.ts): the code
// that decides, before any Textract spend, what a file really is and how many
// pages it would bill. Run with `npm test`; esbuild bundles the TypeScript
// module to a temp file so no extra test tooling is needed.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { PDFDocument } from 'pdf-lib';

const MAX = 6;
let dir;
let inspectUpload;
let countTiffPages;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'idp-inspect-'));
  const outfile = join(dir, 'inspect.mjs');
  await build({
    entryPoints: ['src/lib/inspect.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  ({ inspectUpload, countTiffPages } = await import(pathToFileURL(outfile).href));
});

after(() => rmSync(dir, { recursive: true, force: true }));

async function pdf(pages) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  return doc.save();
}

/** A structurally valid classic TIFF with `pages` 1x1 bilevel pages. */
function tiff(pages, { bigEndian = false } = {}) {
  const le = !bigEndian;
  const IFD = 2 + 8 * 12 + 4;
  const buf = new Uint8Array(8 + 1 + pages * IFD);
  const dv = new DataView(buf.buffer);
  buf.set(le ? [0x49, 0x49] : [0x4d, 0x4d], 0);
  dv.setUint16(2, 42, le);
  dv.setUint32(4, pages ? 9 : 0, le);
  buf[8] = 0x80; // the one pixel every page shares
  for (let p = 0; p < pages; p++) {
    const at = 9 + p * IFD;
    dv.setUint16(at, 8, le);
    const tags = [[256, 1], [257, 1], [258, 1], [259, 1], [262, 1], [273, 8], [278, 1], [279, 1]];
    tags.forEach(([tag, value], i) => {
      const e = at + 2 + i * 12;
      dv.setUint16(e, tag, le);
      dv.setUint16(e + 2, 4, le); // LONG
      dv.setUint32(e + 4, 1, le);
      dv.setUint32(e + 8, value, le);
    });
    dv.setUint32(at + 2 + 8 * 12, p + 1 < pages ? at + IFD : 0, le);
  }
  return buf;
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]);

test('PDF at the cap is accepted with its exact page count', async () => {
  assert.deepEqual(await inspectUpload(await pdf(MAX), 'pdf', MAX), { ok: true, kind: 'pdf', pages: MAX });
});

test('PDF over the cap is rejected', async () => {
  const v = await inspectUpload(await pdf(MAX + 1), 'pdf', MAX);
  assert.equal(v.ok, false);
  assert.match(v.reason, /has 7 pages; the demo cap is 6/);
});

test('single-page TIFF is accepted, little- and big-endian', async () => {
  assert.deepEqual(await inspectUpload(tiff(1), 'tif', MAX), { ok: true, kind: 'tiff', pages: 1 });
  assert.deepEqual(await inspectUpload(tiff(3, { bigEndian: true }), 'tiff', MAX), { ok: true, kind: 'tiff', pages: 3 });
});

test('TIFF at the cap is accepted, one page over is rejected', async () => {
  assert.equal((await inspectUpload(tiff(MAX), 'tiff', MAX)).ok, true);
  const v = await inspectUpload(tiff(MAX + 1), 'tiff', MAX);
  assert.equal(v.ok, false);
  assert.match(v.reason, /more than 6 pages/);
});

test('a 3,000-page TIFF is rejected and the walk stops early', async () => {
  const big = tiff(3000);
  assert.equal(countTiffPages(big, MAX), MAX + 1);
  assert.equal((await inspectUpload(big, 'tiff', MAX)).ok, false);
});

test('TIFF whose directory chain loops is rejected', async () => {
  const t = tiff(2);
  const IFD = 2 + 8 * 12 + 4;
  new DataView(t.buffer).setUint32(9 + IFD + 2 + 8 * 12, 9, true); // page 2 -> page 1
  assert.throws(() => countTiffPages(t, MAX));
  assert.deepEqual(await inspectUpload(t, 'tiff', MAX), { ok: false, reason: 'File could not be parsed as a TIFF' });
});

test('TIFF pointing outside the file, or truncated, is rejected', async () => {
  const t = tiff(1);
  new DataView(t.buffer).setUint32(4, 0xfffffff0, true);
  assert.equal((await inspectUpload(t, 'tiff', MAX)).ok, false);
  assert.equal((await inspectUpload(tiff(2).slice(0, 60), 'tiff', MAX)).ok, false);
  assert.equal((await inspectUpload(tiff(0), 'tiff', MAX)).ok, false);
});

test('BigTIFF is rejected', async () => {
  const t = tiff(1);
  t[2] = 0x2b;
  assert.equal((await inspectUpload(t, 'tiff', MAX)).ok, false);
});

test('PNG and JPEG are one page each', async () => {
  assert.deepEqual(await inspectUpload(PNG, 'png', MAX), { ok: true, kind: 'png', pages: 1 });
  assert.deepEqual(await inspectUpload(JPEG, 'jpg', MAX), { ok: true, kind: 'jpeg', pages: 1 });
  assert.deepEqual(await inspectUpload(JPEG, 'jpeg', MAX), { ok: true, kind: 'jpeg', pages: 1 });
});

test('content that does not match the extension is rejected', async () => {
  const sevenPages = await pdf(MAX + 1);
  for (const ext of ['png', 'jpg', 'tiff']) {
    const v = await inspectUpload(sevenPages, ext, MAX);
    assert.equal(v.ok, false, `PDF bytes as .${ext}`);
    assert.match(v.reason, /does not match/);
  }
  assert.equal((await inspectUpload(tiff(MAX + 1), 'png', MAX)).ok, false);
  assert.equal((await inspectUpload(PNG, 'pdf', MAX)).ok, false);
  assert.equal((await inspectUpload(new TextEncoder().encode('just some text'), 'pdf', MAX)).ok, false);
  assert.equal((await inspectUpload(new Uint8Array(0), 'png', MAX)).ok, false);
});

test('a file carrying two signatures is rejected whatever it is called', async () => {
  const body = await pdf(MAX + 1);
  const polyglot = new Uint8Array(PNG.length + body.length);
  polyglot.set(PNG, 0);
  polyglot.set(body, PNG.length);
  for (const ext of ['png', 'pdf']) assert.equal((await inspectUpload(polyglot, ext, MAX)).ok, false, ext);

  const tiffPdf = new Uint8Array(tiff(1).length + body.length);
  tiffPdf.set(tiff(1), 0);
  tiffPdf.set(body, tiff(1).length);
  assert.equal((await inspectUpload(tiffPdf, 'tiff', MAX)).ok, false);
});

test('unknown extensions are rejected', async () => {
  assert.equal((await inspectUpload(PNG, 'exe', MAX)).ok, false);
});
