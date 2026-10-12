import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Use the system FFmpeg provided by the CI runner, with no paid services,
// accounts, external URLs, or private GitHub dispatch secrets.
process.env.REEL_FFMPEG_BIN = 'ffmpeg';
const { createEvidencePackage } = await import('../src/analyzer.js');
const execFile = promisify(execFileCb);

test('end-to-end contact sheet contains all 20 carousel slides in original order', async t => {
  const work = await mkdtemp(join(tmpdir(), 'reel-carousel-e2e-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const sample = join(work, 'sample.jpg');
  await execFile('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'color=c=blue:s=160x160:d=1',
    '-frames:v', '1', '-update', '1', '-y', sample,
  ], { timeout: 30_000 });
  const slides = [];
  for (let index = 1; index <= 20; index++) {
    const filePath = join(work, 'slide-' + String(index).padStart(2, '0') + '.jpg');
    await copyFile(sample, filePath);
    slides.push({ slide_index: index, filePath });
  }

  const output = await createEvidencePackage('DExample123', {
    carouselSlides: slides, frames: [], ocr: [], timeline: [],
  }, work, 'post');

  assert.ok(output.contactSheet?.length > 100, 'the real FFmpeg contact sheet must render');
  assert.equal(output.contactSheet[0], 0xff);
  assert.equal(output.contactSheet[1], 0xd8);
  assert.equal(output.manifest.carousel.slide_count, 20);
  assert.equal(output.manifest.carousel.original_slide_order_preserved, true);
  assert.equal(output.manifest.carousel.all_slides_in_contact_sheet, true);
  assert.deepEqual(output.manifest.contact_sheet.tiles.map(x => x.slide_index),
    Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal(output.keyframes.length, 4, 'existing attachment budget remains unchanged');
  assert.deepEqual(output.keyframes.map(x => x.filename),
    ['slide_01.jpg', 'slide_02.jpg', 'slide_03.jpg', 'slide_04.jpg']);
  assert.deepEqual(await readFile(join(work, 'contact_sheet.jpg')), output.contactSheet);
});
