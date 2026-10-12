import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, copyFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The real rendering path runs against system FFmpeg in CI.
process.env.REEL_FFMPEG_BIN = 'ffmpeg';
const { createEvidencePackage } = await import('../src/analyzer.js');
const execFile = promisify(callback);

test('real contact sheet and individual attachments cover all 20 ordered carousel slides', { timeout: 120000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'carousel-evidence-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const sample = join(directory, 'source.jpg');
  await execFile('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'color=c=blue:s=160x160:d=1',
    '-frames:v', '1', '-update', '1', '-y', sample,
  ], { timeout: 30000 });

  const slides = [];
  for (let index = 1; index <= 20; index++) {
    const filePath = join(directory, 'slide-' + String(index).padStart(2, '0') + '.jpg');
    await copyFile(sample, filePath);
    slides.push({
      slide_index: index, media_type: 'image', filePath,
      start_seconds: 3 * (index - 1), end_seconds: 3 * index,
    });
  }
  const result = await createEvidencePackage('synthetic', {
    carouselSlides: slides, frames: [], ocr: [], timeline: [],
  }, directory, 'post');

  assert.ok(result.contactSheet?.length > 100);
  assert.equal(result.contactSheet[0], 0xff);
  assert.equal(result.contactSheet[1], 0xd8);
  assert.equal(result.manifest.carousel.slide_count, 20);
  assert.equal(result.manifest.carousel.original_slide_order_preserved, true);
  assert.deepEqual(result.manifest.contact_sheet.tiles.map((tile) => tile.slide_index),
    Array.from({ length: 20 }, (_, index) => index + 1));
  assert.deepEqual(result.keyframes.map((frame) => frame.filename),
    Array.from({ length: 20 }, (_, index) => 'slide_' + String(index + 1).padStart(2, '0') + '.jpg'));
  assert.deepEqual(await readFile(join(directory, 'contact_sheet.jpg')), result.contactSheet);
});
