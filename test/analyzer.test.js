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


test('yt-dlp requests all twenty Instagram carousel slides in both phases', async () => {
  const { MAX_INSTAGRAM_CAROUSEL_SLIDES, carouselYtDlpArgs } = await import('../src/analyzer.js');
  const url = 'https://www.instagram.com/p/DExample123/';
  const metadata = carouselYtDlpArgs(url);
  const thumbnails = carouselYtDlpArgs(url, '/tmp/carousel-%(playlist_index)03d-%(id)s.%(ext)s');
  assert.equal(MAX_INSTAGRAM_CAROUSEL_SLIDES, 20);
  for (const args of [metadata, thumbnails]) {
    const i = args.indexOf('--playlist-end');
    assert.equal(args[i + 1], '20');
    assert.equal(args.at(-1), url);
  }
  assert.ok(metadata.includes('--flat-playlist'));
  assert.ok(thumbnails.includes('--write-thumbnail'));
});

test('transcript last segment ends at video duration when no explicit end is available', async () => {
  const { normalize } = await import('../src/analyzer.js');
  const input = {
    metadata: { duration: 12.61 },
    transcript: [{ time: '0:00', text: 'Intro' }, { time: '0:11', text: 'Outro' }],
  };
  const result = normalize(input, 'test');
  assert.deepEqual(result.transcript.map(x => [x.start_seconds, x.end_seconds]), [[0, 11], [11, 12.61]]);
  assert.equal(result.processing.paid_api_used, false);
});

test('explicit transcript end is preserved and never precedes start', async () => {
  const { normalize } = await import('../src/analyzer.js');
  const result = normalize({
    metadata: { duration: 15 },
    transcript: [{ time: '0:02', end_seconds: 4.2, text: 'one' }, { time: '0:09', end_seconds: 8, text: 'bad time' }],
  }, 'test');
  assert.deepEqual(result.transcript.map(x => [x.start_seconds, x.end_seconds]), [[2, 4.2], [9, 9]]);
});
