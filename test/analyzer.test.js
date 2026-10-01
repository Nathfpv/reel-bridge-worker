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
