import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Only public tools and synthetic media, no Instagram request or private bridge state.
process.env.REEL_FFMPEG_BIN = 'ffmpeg';
const { createEvidencePackage } = await import('../src/analyzer.js');
const execFile = promisify(execFileCb);

test('real FFmpeg contact sheet preserves distinct pixels for all 20 ordered carousel slides', async t => {
  const work = await mkdtemp(join(tmpdir(), 'reel-carousel-e2e-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const slides = [];

  // Unlike a metadata-only test, every slide has a different known color.
  for (let index = 0; index < 20; index++) {
    const filePath = join(work, 'slide-' + String(index + 1).padStart(2, '0') + '.jpg');
    const r = (index * 12).toString(16).padStart(2, '0');
    const b = (255 - index * 12).toString(16).padStart(2, '0');
    await execFile('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'color=c=0x' + r + '40' + b + ':s=160x160:d=1',
      '-frames:v', '1', '-update', '1', '-q:v', '2', '-y', filePath,
    ], { timeout: 30_000 });
    slides.push({ slide_index: index + 1, filePath });
  }

  const output = await createEvidencePackage('DExample123', {
    carouselSlides: slides, frames: [], ocr: [], timeline: [],
  }, work, 'post');

  assert.ok(output.contactSheet?.length > 100, 'FFmpeg must generate JPEG');
  assert.equal(output.contactSheet[0], 0xff);
  assert.equal(output.contactSheet[1], 0xd8);
  assert.equal(output.manifest.carousel.slide_count, 20);
  assert.equal(output.manifest.carousel.original_slide_order_preserved, true);
  assert.equal(output.manifest.contact_sheet.tiles.length, 20);
  assert.deepEqual(output.manifest.contact_sheet.tiles.map(x => x.slide_index),
    Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal(output.keyframes.length, 20, 'complete carousel requires every slide attachment');
  assert.deepEqual(output.keyframes.map(x => x.filename),
    Array.from({ length: 20 }, (_, i) => 'slide_' + String(i + 1).padStart(2, '0') + '.jpg'));
  assert.deepEqual(await readFile(join(work, 'contact_sheet.jpg')), output.contactSheet);

  // Decode the ACTUAL rendered contact sheet and inspect the central RGB pixel
  // of each tile. This fails if the images are duplicated, scrambled or omitted,
  // even when the accompanying manifest claims the correct slide order.
  const sheetWidth = 1440;
  const tileWidth = 480;
  const tileHeight = 854;
  const rawPath = join(work, 'contact-sheet.rgb');
  await execFile('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', join(work, 'contact_sheet.jpg'),
    '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-y', rawPath,
  ], { timeout: 30_000 });
  const pixels = await readFile(rawPath);
  assert.equal(pixels.length, sheetWidth * tileHeight * 7 * 3);
  for (let index = 0; index < 20; index++) {
    const x = (index % 3) * tileWidth + tileWidth / 2;
    const y = Math.floor(index / 3) * tileHeight + tileHeight / 2;
    const offset = (y * sheetWidth + x) * 3;
    const observedR = pixels[offset];
    const observedB = pixels[offset + 2];
    assert.ok(Math.abs(observedR - index * 12) <= 8,
      'tile ' + (index + 1) + ': wrong red pixel ' + observedR);
    assert.ok(Math.abs(observedB - (255 - index * 12)) <= 8,
      'tile ' + (index + 1) + ': wrong blue pixel ' + observedB);
  }
});
