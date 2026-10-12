import test from 'node:test';
import assert from 'node:assert/strict';
import { carouselSlideIndex, sortCarouselSlideFilenames } from '../src/analyzer.js';

test('sorts downloaded Instagram slide thumbnails by playlist index', () => {
  assert.deepEqual(
    sortCarouselSlideFilenames([
      'carousel-010-last.jpg',
      'ignore.txt',
      'carousel-002-second.jpeg',
      'carousel-001-first.jpg',
      'carousel-NA-single.jpg',
    ]),
    [
      'carousel-001-first.jpg',
      'carousel-002-second.jpeg',
      'carousel-010-last.jpg',
      'carousel-NA-single.jpg',
    ],
  );
});

test('parses numeric carousel playlist indices safely', () => {
  assert.equal(carouselSlideIndex('carousel-007-abc.jpg'), 7);
  assert.equal(carouselSlideIndex('carousel-NA-abc.jpg'), Number.MAX_SAFE_INTEGER);
});

test('transcript final segment reaches the actual video duration', async () => {
  const { normalize } = await import('../src/analyzer.js');
  const result = normalize({
    metadata: { duration: 12.61 },
    transcript: [{ time: '0:00', text: 'Intro' }, { time: '0:11', text: 'Outro' }],
  }, 'test');
  assert.deepEqual(result.transcript.map((x) => [x.start_seconds, x.end_seconds]),
    [[0, 11], [11, 12.61]]);
});

test('explicit transcript end times are preserved and clamped to their starts', async () => {
  const { normalize } = await import('../src/analyzer.js');
  const result = normalize({
    metadata: { duration: 15 },
    transcript: [
      { time: '0:02', end_seconds: 4.2, text: 'first' },
      { time: '0:09', end_seconds: 8, text: 'second' },
    ],
  }, 'test');
  assert.deepEqual(result.transcript.map((x) => [x.start_seconds, x.end_seconds]),
    [[2, 4.2], [9, 9]]);
});


test('Instagram photo entries receive thumbnails without attempting video downloads', async () => {
  const { carouselDownloadArgs, carouselVideoIndices } = await import('../src/analyzer.js');
  const entries = Array.from({ length: 12 }, (_, i) => ({
    id: 'photo' + i, ext: 'none', duration: null,
  }));
  assert.deepEqual(carouselVideoIndices(entries), []);
  const plan = carouselDownloadArgs('https://www.instagram.com/p/Dexample/', 'carousel-%(playlist_index)03d.%(ext)s', entries);
  assert.equal(plan.videos, null);
  assert.ok(plan.thumbnails.includes('--skip-download'));
  assert.ok(plan.thumbnails.includes('--write-thumbnail'));
  assert.ok(plan.thumbnails.includes('--convert-thumbnails'));
  assert.ok(!plan.thumbnails.includes('--playlist-items'));
});

test('Mixed Instagram carousels download only video items while preserving thumbnail pass', async () => {
  const { carouselDownloadArgs, carouselVideoIndices } = await import('../src/analyzer.js');
  const entries = [
    { ext: 'jpg', duration: null },
    { ext: 'mp4', duration: 4.5 },
    { ext: 'webp' },
    { ext: null, duration: 2 },
    { ext: 'png', duration: null },
  ];
  assert.deepEqual(carouselVideoIndices(entries), [2, 4]);
  const plan = carouselDownloadArgs('https://www.instagram.com/p/Dmixed/', 'output', entries);
  assert.ok(plan.thumbnails.includes('--skip-download'));
  assert.ok(plan.videos.includes('--playlist-items'));
  assert.equal(plan.videos[plan.videos.indexOf('--playlist-items') + 1], '2,4');
  assert.ok(!plan.videos.includes('--skip-download'));
  assert.ok(!plan.videos.includes('--write-thumbnail'));
});
