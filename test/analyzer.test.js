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
