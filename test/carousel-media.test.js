import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile as callback, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  MAX_CAROUSEL_SLIDES, canvasDimensions, canvasFilter,
  collectCarouselSlides, composeCarousel,
} from '../src/carousel-media.js';

const execFile = promisify(callback);
const ffmpeg = process.env.REEL_FFMPEG_BIN || 'ffmpeg';
const ffprobe = process.env.REEL_FFPROBE_BIN || 'ffprobe';
const binariesPresent = [ffmpeg, ffprobe].every((bin) => !spawnSync(bin, ['-version'], { timeout: 8000 }).error);

function numberedFiles(n) {
  return Array.from({ length: n }, (_, i) =>
    'carousel-' + String(i + 1).padStart(3, '0') + '-image.jpg');
}

test('allows all 20 slides without silently cutting off at slide twelve', () => {
  const files = numberedFiles(20);
  const result = collectCarouselSlides(files, Array.from({ length: 20 }, () => ({ ext: 'jpg' })));
  assert.equal(MAX_CAROUSEL_SLIDES, 20);
  assert.equal(result.length, 20);
  assert.equal(result[11].slide_index, 12);
  assert.equal(result[19].slide_index, 20);
});

test('rejects incomplete, unordered, ambiguous and truncated carousel downloads', () => {
  assert.throws(() => collectCarouselSlides([numberedFiles(3)[0], numberedFiles(3)[2]], [{}, {}, {}]), { code: 'CAROUSEL_INCOMPLETE' });
  assert.throws(() => collectCarouselSlides(['carousel-NA-a.jpg', 'carousel-002-b.jpg'], [{}, {}]), { code: 'CAROUSEL_INDEX_INVALID' });
  assert.throws(() => collectCarouselSlides(['carousel-001-a.jpg'], [{}, {}]), { code: 'CAROUSEL_INCOMPLETE' });
  assert.throws(() => collectCarouselSlides(numberedFiles(21)), { code: 'CAROUSEL_LIMIT_EXCEEDED' });
});

test('does not mistake a video thumbnail for a successfully retrieved video slide', () => {
  assert.throws(
    () => collectCarouselSlides(['carousel-001-poster.jpg'], [{ ext: 'mp4', duration: 8 }]),
    { code: 'CAROUSEL_VIDEO_MISSING' },
  );
  const mixed = collectCarouselSlides([
    'carousel-003-static.jpg', 'carousel-002-clip.mp4', 'carousel-001-static.jpg',
    'carousel-002-clip.jpg',
  ], [{ ext: 'jpg' }, { ext: 'mp4', duration: 4 }, { ext: 'jpg' }]);
  assert.deepEqual(mixed.map((x) => x.slide_index), [1, 2, 3]);
  assert.ok(mixed[1].video.endsWith('.mp4'));
});

test('normalization uses exactly matching dimensions for landscape, portrait and square media', () => {
  assert.deepEqual(canvasDimensions(1280), { width: 1280, height: 1600 });
  assert.match(canvasFilter(128), /pad=128:160:/);
  assert.doesNotMatch(canvasFilter(128), /pad=128:ih/);
});

test('real FFmpeg round-trip handles portrait/square/video slides and keeps audio', { timeout: 120000 }, async () => {
  assert.ok(binariesPresent, 'FFmpeg and FFprobe must be installed; media integration may not be skipped');
  const root = await mkdtemp(join(tmpdir(), 'reel-carousel-e2e-'));
  const mediaDir = join(root, 'media');
  const outputDir = join(root, 'rendered');
  await mkdir(mediaDir);
  try {
    async function run(args) {
      return execFile(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout: 30000 });
    }
    await run(['-f', 'lavfi', '-i', 'color=c=blue:s=240x320', '-frames:v', '1', join(mediaDir, 'carousel-001-blue.png')]);
    await run(['-f', 'lavfi', '-i', 'testsrc2=size=240x140:rate=12',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000',
      '-t', '1.2', '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac',
      join(mediaDir, 'carousel-002-video.mp4')]);
    await run(['-f', 'lavfi', '-i', 'color=c=red:s=240x240', '-frames:v', '1', join(mediaDir, 'carousel-003-red.png')]);
    const slides = collectCarouselSlides(await readdir(mediaDir),
      [{ ext: 'jpg' }, { ext: 'mp4', duration: 1.2 }, { ext: 'jpg' }]);
    const result = await composeCarousel(slides, { mediaDir, outputDir, ffmpegBin: ffmpeg, ffprobeBin: ffprobe, maxWidth: 128 });
    assert.deepEqual(result.slides.map((s) => s.media_type), ['image', 'video', 'image']);
    assert.deepEqual(result.slides.map((s) => s.slide_index), [1, 2, 3]);
    assert.ok(result.durationSeconds > 7 && result.durationSeconds < 8);
    const { stdout } = await execFile(ffprobe, ['-v', 'error', '-show_entries',
      'format=duration:stream=codec_type,width,height', '-of', 'json', result.videoPath]);
    const json = JSON.parse(stdout);
    assert.ok(json.streams.some((stream) => stream.codec_type === 'video' && stream.width === 128 && stream.height === 160));
    assert.ok(json.streams.some((stream) => stream.codec_type === 'audio'));
    assert.ok(Number(json.format.duration) >= 7);
    for (const slide of result.slides) assert.ok(slide.filePath.endsWith('.jpg'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
