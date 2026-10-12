import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { bridgeError } from './protocol.js';

const execFile = promisify(callback);
export const MAX_CAROUSEL_SLIDES = 20;
export const PHOTO_DURATION_SECONDS = 3;

export function carouselSlideIndex(filename) {
  const match = /^carousel-(\d{1,3})-/.exec(String(filename || ''));
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function sortCarouselSlideFilenames(filenames) {
  return [...(filenames || [])]
    .filter((filename) => /^carousel-.*\.jpe?g$/i.test(filename))
    .sort((left, right) => carouselSlideIndex(left) - carouselSlideIndex(right) || left.localeCompare(right));
}

export function canvasDimensions(maxWidth) {
  const width = 2 * Math.floor(Number(maxWidth) / 2);
  if (!Number.isSafeInteger(width) || width < 64 || width > 3840) {
    throw bridgeError('CAROUSEL_CONFIGURATION_ERROR', 'Invalid carousel canvas width.');
  }
  return { width, height: 2 * Math.ceil((width * 5 / 4) / 2) };
}

export function canvasFilter(maxWidth) {
  const { width, height } = canvasDimensions(maxWidth);
  return 'scale=' + width + ':' + height +
    ':force_original_aspect_ratio=decrease,' +
    'pad=' + width + ':' + height + ':(ow-iw)/2:(oh-ih)/2,' +
    'setsar=1,format=yuv420p';
}

function mediaError(code, reason) {
  return bridgeError(code, reason);
}

export function collectCarouselSlides(filenames, expectedEntries = null) {
  const found = new Map();
  let unindexed = false;
  for (const filename of filenames || []) {
    const match = /^carousel-(\d{1,3}|NA)-(.+)\.(jpe?g|png|webp|mp4|mkv|webm|mov)$/i.exec(filename);
    if (!match) continue;
    const index = match[1] === 'NA' ? 1 : Number(match[1]);
    if (match[1] === 'NA') unindexed = true;
    if (!Number.isSafeInteger(index) || index < 1) throw mediaError('CAROUSEL_INDEX_INVALID', 'Invalid slide index.');
    const slide = found.get(index) || { slide_index: index, image: null, video: null };
    const ext = match[3].toLowerCase();
    const isVideo = /^(mp4|mkv|webm|mov)$/.test(ext);
    if (isVideo) {
      if (slide.video) throw mediaError('CAROUSEL_MEDIA_AMBIGUOUS', 'More than one video for a slide.');
      slide.video = filename;
    } else {
      if (!slide.image || ext === 'jpg' || ext === 'jpeg') slide.image = filename;
    }
    found.set(index, slide);
  }
  const slides = [...found.values()].sort((a, b) => a.slide_index - b.slide_index);
  if (!slides.length) throw mediaError('CAROUSEL_MEDIA_MISSING', 'The downloader returned no usable post media.');
  if (slides.length > MAX_CAROUSEL_SLIDES) throw mediaError('CAROUSEL_LIMIT_EXCEEDED', 'Carousel exceeds the supported number of slides.');
  if (unindexed && slides.length > 1) throw mediaError('CAROUSEL_INDEX_INVALID', 'The downloader did not preserve slide indices.');
  if (expectedEntries && expectedEntries.length > MAX_CAROUSEL_SLIDES) {
    throw mediaError('CAROUSEL_LIMIT_EXCEEDED', 'Carousel exceeds the supported number of slides.');
  }
  if (expectedEntries && expectedEntries.length !== slides.length) {
    throw mediaError('CAROUSEL_INCOMPLETE', 'One or more carousel slides were not downloaded.');
  }
  for (let i = 0; i < slides.length; i += 1) {
    const slide = slides[i];
    if (slide.slide_index !== i + 1) throw mediaError('CAROUSEL_INCOMPLETE', 'Carousel slide indices are not contiguous.');
    const entry = expectedEntries?.[i];
    const isExpectedVideo = entry && (
      Number(entry.duration) > 0 || /^(mp4|mkv|webm|mov)$/i.test(String(entry.ext || ''))
    );
    if (isExpectedVideo && !slide.video) throw mediaError('CAROUSEL_VIDEO_MISSING', 'A carousel video was replaced by a thumbnail.');
  }
  return slides;
}

function quotedConcatPath(value) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

async function checkedExec(bin, args, code, timeout = 180000) {
  try {
    return await execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024 });
  } catch (cause) {
    const error = mediaError(code, 'Carousel media conversion failed.');
    error.stage = code;
    error.exitCode = cause?.code ?? null;
    error.stderrTail = String(cause?.stderr || cause?.message || '').slice(-1200);
    throw error;
  }
}

async function probeVideo(file, ffprobeBin) {
  const result = await checkedExec(ffprobeBin, [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type',
    '-of', 'json', file,
  ], 'CAROUSEL_PROBE_FAILED');
  let info;
  try { info = JSON.parse(result.stdout); }
  catch { throw mediaError('CAROUSEL_PROBE_FAILED', 'Invalid ffprobe result.'); }
  const duration = Number(info?.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw mediaError('CAROUSEL_PROBE_FAILED', 'Invalid carousel video duration.');
  }
  if (!info.streams?.some((stream) => stream.codec_type === 'video')) {
    throw mediaError('CAROUSEL_VIDEO_INVALID', 'Video slide is missing a video stream.');
  }
  return { duration, hasAudio: info.streams.some((stream) => stream.codec_type === 'audio') };
}

/**
 * Normalize each slide into an identically encoded H.264/AAC segment.
 * Video slides retain their full duration and audio; photo slides receive silence.
 * This avoids FFmpeg concat rejecting different original aspect ratios.
 */
export async function composeCarousel(slides, { mediaDir, outputDir, ffmpegBin, ffprobeBin = 'ffprobe', maxWidth }) {
  if (!slides.length) throw mediaError('CAROUSEL_MEDIA_MISSING', 'No carousel slides.');
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const filter = canvasFilter(maxWidth);
  const segments = [];
  const evidence = [];
  let offset = 0;
  for (const [i, slide] of slides.entries()) {
    const input = join(mediaDir, slide.video || slide.image);
    const video = Boolean(slide.video);
    const probe = video ? await probeVideo(input, ffprobeBin) : null;
    const duration = video ? probe.duration : PHOTO_DURATION_SECONDS;
    const output = join(outputDir, 'segment-' + String(i + 1).padStart(3, '0') + '.mp4');
    const audioSource = 'anullsrc=channel_layout=mono:sample_rate=16000';
    const args = video ? [
      '-i', input,
      ...(!probe.hasAudio ? ['-f', 'lavfi', '-i', audioSource] : []),
      '-map', '0:v:0', '-map', probe.hasAudio ? '0:a:0' : '1:a:0',
    ] : [
      '-loop', '1', '-framerate', '12', '-i', input,
      '-f', 'lavfi', '-i', audioSource,
      '-map', '0:v:0', '-map', '1:a:0',
    ];
    args.push('-vf', filter, '-r', '12', '-c:v', 'libx264', '-preset', 'veryfast',
      '-crf', '27', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '1',
      '-ar', '16000', '-t', String(duration), '-y', output);
    await checkedExec(ffmpegBin, ['-hide_banner', '-loglevel', 'error', ...args], 'CAROUSEL_COMPOSE_FAILED',
      Math.max(120000, Math.ceil(duration * 4000)));
    const poster = join(outputDir, 'poster-' + String(i + 1).padStart(3, '0') + '.jpg');
    await checkedExec(ffmpegBin, [
      '-hide_banner', '-loglevel', 'error', '-i', video ? input : join(mediaDir, slide.image),
      '-vf', 'scale=960:1200:force_original_aspect_ratio=decrease',
      '-frames:v', '1', '-q:v', '7', '-y', poster,
    ], 'CAROUSEL_POSTER_FAILED', 60000);
    segments.push(output);
    evidence.push({
      slide_index: slide.slide_index,
      media_type: video ? 'video' : 'image',
      filePath: poster,
      start_seconds: offset,
      end_seconds: offset + duration,
    });
    offset += duration;
  }
  const listFile = join(outputDir, 'segments.ffconcat');
  await writeFile(listFile, 'ffconcat version 1.0\n' + segments.map((file) => 'file ' + quotedConcatPath(file)).join('\n') + '\n', { mode: 0o600 });
  const outputVideo = join(outputDir, 'carousel.mp4');
  await checkedExec(ffmpegBin, [
    '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0',
    '-i', listFile, '-c', 'copy', '-movflags', '+faststart', '-y', outputVideo,
  ], 'CAROUSEL_CONCAT_FAILED', 120000);
  return { videoPath: outputVideo, slides: evidence, durationSeconds: offset };
}
