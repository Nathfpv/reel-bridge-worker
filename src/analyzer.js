import { access, readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { bridgeError } from './protocol.js';

const execFile = promisify(execFileCallback);

function timeToSeconds(value) {
  const parts = String(value || '0').split(':').map(Number);
  return parts.reduce((total, part) => total * 60 + (Number.isFinite(part) ? part : 0), 0);
}

function normalize(raw, analyzerVersion) {
  const transcript = (raw.transcript || []).map((entry, index, entries) => {
    const start = timeToSeconds(entry.time ?? entry.start_seconds);
    const next = entries[index + 1];
    return { ...entry, start_seconds: start, end_seconds: next ? timeToSeconds(next.time ?? next.start_seconds) : start };
  });
  const ocr = (raw.ocrResults || raw.ocr || []).map((entry) => ({ ...entry, timestamp_seconds: entry.timestamp_seconds ?? timeToSeconds(entry.time) }));
  return { ...raw, transcript, ocr, frames: raw.frames || [], timeline: raw.timeline || [], processing: { engine: `mcp-video-analyzer@${analyzerVersion}`, transcription_backend: 'huggingface-whisper', transcription_model: config.whisperHfModel, paid_api_used: false, analyzed_at: new Date().toISOString(), cache: 'miss' } };
}

async function installedAnalyzerVersion() {
  try {
    const packagePath = process.env.REEL_NODE_MODULES_ROOT
      ? join(process.env.REEL_NODE_MODULES_ROOT, 'mcp-video-analyzer', 'package.json')
      : join(process.cwd(), 'node_modules', 'mcp-video-analyzer', 'package.json');
    const parsed = JSON.parse(await readFile(packagePath, 'utf8'));
    return typeof parsed.version === 'string' && parsed.version ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function runAnalyzer(input, outputDir, options = {}) {
  const maxFrames = Number(options.maxFrames || config.maxFrames);
  const transcribe = options.transcribe !== false;
  const fields = options.fields || null;
  const detail = options.detail || 'detailed';
  const args = ['analyze', input, '--force-refresh', '--detail', detail, '--max-frames', String(maxFrames), '--max-width', String(config.maxWidth), '--ocr-language', config.ocrLanguage, '--out', outputDir];
  if (fields) args.push('--fields', fields.join(','));
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || '', LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || process.env.LANG || 'C.UTF-8', TMPDIR: process.env.TMPDIR || '/tmp',
    WHISPER_BIN: transcribe ? config.whisperBin : '/nonexistent/reel-bridge-whisper', WHISPER_HF_MODEL: transcribe ? config.whisperHfModel : '',
    HF_HOME: process.env.HF_HOME || join(config.analyzerRoot, 'models'),
    REEL_NODE_MODULES_ROOT: process.env.REEL_NODE_MODULES_ROOT || '', MCP_WRITE_SIDECARS: '0',
  };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'PUPPETEER_EXECUTABLE_PATH']) if (process.env[key]) env[key] = process.env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(config.analyzerBin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(bridgeError('ANALYZER_TIMEOUT', 'The Reel analyzer exceeded its processing timeout.')); }, config.analyzerTimeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(bridgeError(/private|unavailable|inaccessible|login required|rate.?limit/i.test(stderr) ? 'REEL_PRIVATE' : 'DOWNLOAD_FAILED', 'The Instagram media could not be downloaded or analyzed.'));
      const start = stdout.indexOf('{\n');
      try { resolve(JSON.parse(start >= 0 ? stdout.slice(start) : stdout)); }
      catch { reject(bridgeError('WORKER_ERROR', 'The private analyzer returned invalid JSON.')); }
    });
  });
}

function trustedMediaUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase();
    return host === 'instagram.com' || host.endsWith('.instagram.com') || host.endsWith('.cdninstagram.com') || host.endsWith('.fbcdn.net') ? url : null;
  } catch { return null; }
}

async function analyzeCarousel(source, outputDir) {
  const ytDlp = process.env.REEL_YTDLP_BIN || 'yt-dlp';
  let playlist;
  try {
    const result = await execFile(ytDlp, ['-J', '--no-warnings', '--flat-playlist', source.canonicalUrl], { timeout: 90000, maxBuffer: 64 * 1024 * 1024 });
    playlist = JSON.parse(result.stdout);
  } catch { return null; }
  const entries = Array.isArray(playlist?.entries) ? playlist.entries.slice(0, 12) : [];
  if (entries.length < 2) return null;
  const mediaDir = join(outputDir, 'carousel-media');
  await (await import('node:fs/promises')).mkdir(mediaDir, { recursive: true, mode: 0o700 });
  const imageFiles = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const media = trustedMediaUrl(entry.url || entry.thumbnail);
    if (!media) continue;
    const response = await fetch(media, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!response.ok) continue;
    const type = response.headers.get('content-type') || '';
    if (!type.startsWith('image/')) continue;
    const file = join(mediaDir, `carousel-${String(index).padStart(2, '0')}.jpg`);
    await (await import('node:fs/promises')).writeFile(file, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
    imageFiles.push(file);
  }
  if (imageFiles.length < 2) return null;
  const slideshow = join(outputDir, 'carousel.mp4');
  const inputs = imageFiles.flatMap((file) => ['-loop', '1', '-t', '3', '-i', file]);
  const filters = imageFiles.map((_, index) => `[${index}:v]scale=${config.maxWidth}:-2:force_original_aspect_ratio=decrease,pad=${config.maxWidth}:ih:(ow-iw)/2:(oh-ih)/2,format=yuv420p[v${index}]`);
  filters.push(`${imageFiles.map((_, index) => `[v${index}]`).join('')}concat=n=${imageFiles.length}:v=1:a=0[out]`);
  await execFile(config.ffmpegBin, ['-hide_banner', '-loglevel', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '[out]', '-y', slideshow], { timeout: 120000 });
  const analyzed = await runAnalyzer(slideshow, outputDir);
  analyzed.carouselSlides = imageFiles.map((filePath, index) => ({ slide_index: index + 1, filePath }));
  return analyzed;
}

function visualEntryKey(entry) {
  const seconds = Number(entry?.timestamp_seconds ?? timeToSeconds(entry?.time));
  const text = String(entry?.text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return `${Math.round(seconds * 100) / 100}|${text}`;
}

function mergeVisualEvidence(primary, anchor) {
  if (!anchor) return primary;
  const seenOcr = new Set((primary.ocrResults || primary.ocr || []).map(visualEntryKey));
  const mergedOcr = [...(primary.ocrResults || primary.ocr || [])];
  for (const entry of anchor.ocrResults || anchor.ocr || []) {
    const key = visualEntryKey(entry);
    if (!seenOcr.has(key)) {
      seenOcr.add(key);
      mergedOcr.push(entry);
    }
  }

  const frameKey = (frame) => {
    const seconds = Number(frame?.timestamp_seconds ?? timeToSeconds(frame?.time));
    return `${Math.round(seconds * 100) / 100}|${basename(String(frame?.filePath || frame?.path || ''))}`;
  };
  const seenFrames = new Set((primary.frames || []).map(frameKey));
  const mergedFrames = [...(primary.frames || [])];
  for (const frame of anchor.frames || []) {
    const key = frameKey(frame);
    if (!seenFrames.has(key)) {
      seenFrames.add(key);
      mergedFrames.push(frame);
    }
  }

  const warnings = [...(primary.warnings || [])];
  warnings.push(`Hybrid visual sampling merged supplemental ${config.sceneFrames}-frame scene-detection evidence with the dense ${config.maxFrames}-frame pass.`);
  return {
    ...primary,
    frames: mergedFrames.sort((a, b) => timeToSeconds(a.time) - timeToSeconds(b.time)),
    ocrResults: mergedOcr.sort((a, b) => timeToSeconds(a.time) - timeToSeconds(b.time)),
    warnings,
  };
}

export async function analyzeInstagram(source) {
  const kind = source.kind === 'post' ? 'post' : 'reel';
  const shortcode = source.shortcode;
  const url = source.canonicalUrl || `https://www.instagram.com/${kind === 'post' ? 'p' : 'reel'}/${encodeURIComponent(shortcode)}/`;
  const outputDir = join(config.analyzerFramesDir, `${kind}-${shortcode}`);
  let raw = kind === 'post'
    ? (await analyzeCarousel(source, outputDir)) || await runAnalyzer(url, outputDir)
    : await runAnalyzer(url, outputDir);

  const duration = Number(raw.metadata?.duration || 0);
  if (kind === 'reel' && config.sceneFrames > 0 && duration > 6) {
    const sceneDir = join(outputDir, `scenes-${config.sceneFrames}`);
    const sceneEvidence = await runAnalyzer(url, sceneDir, {
      maxFrames: config.sceneFrames,
      detail: 'standard',
      transcribe: false,
      fields: ['metadata', 'frames', 'ocrResults'],
    }).catch(() => null);
    raw = mergeVisualEvidence(raw, sceneEvidence);
  }

  if ((raw.metadata?.title === 'Unknown' || !raw.metadata) && !(raw.frames?.length) && !(raw.transcript?.length)) {
    throw bridgeError('DOWNLOAD_FAILED', 'The Reel could not be downloaded or analyzed.');
  }
  return { result: normalize(raw, await installedAnalyzerVersion()), cacheHit: false };
}

export async function analyzeReel(shortcode) {
  return analyzeInstagram({ kind: 'reel', shortcode, canonicalUrl: `https://www.instagram.com/reel/${encodeURIComponent(shortcode)}/` });
}

function frameSeconds(frame) {
  return Number(frame?.seconds ?? frame?.timestamp_seconds ?? timeToSeconds(frame?.time));
}

function normalizeOcrText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function nearestOcr(ocrEntries, seconds, toleranceSeconds = 0.75) {
  let best = null;
  let bestDiff = Infinity;
  for (const entry of ocrEntries || []) {
    const timestamp = Number(entry.timestamp_seconds ?? timeToSeconds(entry.time));
    const diff = Math.abs(timestamp - seconds);
    if (diff < bestDiff) {
      best = entry;
      bestDiff = diff;
    }
  }
  return bestDiff <= toleranceSeconds ? best : null;
}

function transcriptNear(timeline, seconds, toleranceSeconds = 2) {
  return (timeline || []).some((entry) => {
    if (!entry?.transcript) return false;
    return Math.abs(Number(entry.seconds ?? timeToSeconds(entry.time)) - seconds) <= toleranceSeconds;
  });
}

function scoredFrames(frames, ocrEntries = [], timeline = []) {
  let previousText = '';
  return frames.map((frame, index) => {
    const seconds = frameSeconds(frame);
    const ocr = nearestOcr(ocrEntries, seconds);
    const text = normalizeOcrText(ocr?.text);
    const confidence = Number(ocr?.confidence);
    const confident = Number.isFinite(confidence) ? confidence : 0;
    const textChanged = Boolean(text && text !== previousText);
    if (text) previousText = text;
    const score =
      (confident / 20) +
      Math.min(text.length / 80, 2) +
      (textChanged ? 2 : 0) +
      (transcriptNear(timeline, seconds) ? 1 : 0);
    return { ...frame, _sourceIndex: index, seconds, ocr, score };
  });
}

export function selectEvidenceFrameIndices(frames, ocrEntries = [], count = 15, timeline = []) {
  if (!Array.isArray(frames) || frames.length === 0 || count <= 0) return [];
  if (frames.length <= count) return frames.map((_, index) => index);

  const scored = scoredFrames(frames, ocrEntries, timeline);
  const selected = new Set([0, frames.length - 1]);
  const priorityBudget = Math.max(0, Math.min(count - selected.size, Math.ceil(count * 0.65)));
  const priority = scored
    .slice(1, -1)
    .sort((a, b) => b.score - a.score || a.seconds - b.seconds);

  for (const candidate of priority) {
    if (selected.size >= priorityBudget + 2 || selected.size >= count) break;
    if (candidate.score <= 0) break;
    const tooClose = [...selected].some((index) =>
      Math.abs(scored[index].seconds - candidate.seconds) < 0.75);
    if (!tooClose) selected.add(candidate._sourceIndex);
  }

  while (selected.size < count) {
    let bestIndex = null;
    let bestDistance = -1;
    let bestScore = -1;
    for (let index = 0; index < scored.length; index += 1) {
      if (selected.has(index)) continue;
      const distance = Math.min(
        ...[...selected].map((chosen) => Math.abs(scored[index].seconds - scored[chosen].seconds)),
      );
      if (distance > bestDistance || (distance === bestDistance && scored[index].score > bestScore)) {
        bestIndex = index;
        bestDistance = distance;
        bestScore = scored[index].score;
      }
    }
    if (bestIndex === null) break;
    selected.add(bestIndex);
  }

  return [...selected].sort((a, b) => scored[a].seconds - scored[b].seconds);
}

async function run(bin, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Contact sheet generation failed (${code}).`)));
  });
}

function contactSheetFilters(selected, width, height, withLabels) {
  return selected.map((frame, index) => {
    const base = `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
    if (!withLabels) return `${base}[v${index}]`;
    const label = frame.slideIndex
      ? `S${frame.slideIndex} ${Math.round(frame.seconds)}s`
      : `F${frame.frameIndex} ${Math.round(frame.seconds)}s`;
    return `${base},drawbox=x=0:y=ih-34:w=iw:h=34:color=black@0.72:t=fill,drawtext=text='${label}':x=10:y=ih-27:fontsize=18:fontcolor=white[v${index}]`;
  });
}

async function renderContactSheet(selected, outputPath) {
  if (!selected.length) return null;
  const columns = 3;
  const width = Math.floor(config.contactSheetWidth / columns);
  const height = Math.round(width * 16 / 9 / 2) * 2;
  const inputs = selected.flatMap((frame) => ['-i', frame.path]);
  const layout = selected.map((_, i) => `${(i % columns) * width}_${Math.floor(i / columns) * height}`).join('|');

  for (const withLabels of [true, false]) {
    const filters = contactSheetFilters(selected, width, height, withLabels);
    filters.push(`${selected.map((_, index) => `[v${index}]`).join('')}xstack=inputs=${selected.length}:layout=${layout}:fill=black[out]`);
    try {
      await run(config.ffmpegBin, ['-hide_banner', '-loglevel', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '[out]', '-frames:v', '1', '-q:v', '5', '-y', outputPath]);
      return readFile(outputPath);
    } catch {
      await rm(outputPath, { force: true });
    }
  }
  return null;
}

function evidenceManifest(selected, result, keyframes) {
  return {
    contact_sheet: {
      filename: 'contact_sheet.jpg',
      selection_strategy: 'ocr-confidence-plus-temporal-diversity',
      tiles: selected.map((frame, tile) => {
        const ocr = nearestOcr(result.ocr || [], frame.seconds);
        const confidence = Number(ocr?.confidence);
        return {
          tile,
          frame_index: frame.frameIndex ?? null,
          slide_index: frame.slideIndex ?? null,
          timestamp: frame.seconds,
          ocr: ocr?.text ? {
            text: String(ocr.text).trim(),
            confidence: Number.isFinite(confidence) ? confidence : null,
          } : null,
        };
      }),
    },
    keyframes: keyframes.map((frame) => ({
      filename: frame.filename,
      frame_index: frame.frameIndex ?? null,
      slide_index: frame.slideIndex ?? null,
      timestamp: frame.seconds,
    })),
    carousel: result.carouselSlides?.length ? {
      slide_count: result.carouselSlides.length,
      original_slide_order_preserved: true,
    } : null,
  };
}

export async function createEvidencePackage(shortcode, result, outputDir, kind = 'reel') {
  const available = [];

  if (kind === 'post' && Array.isArray(result.carouselSlides) && result.carouselSlides.length > 1) {
    for (const slide of result.carouselSlides) {
      try {
        await access(slide.filePath);
        available.push({
          path: slide.filePath,
          seconds: (Number(slide.slide_index) - 1) * 3,
          frameIndex: null,
          slideIndex: Number(slide.slide_index),
        });
      } catch {}
    }
  } else {
    for (let frameIndex = 0; frameIndex < (result.frames || []).length; frameIndex += 1) {
      const frame = result.frames[frameIndex];
      const filename = basename(String(frame.filePath || frame.path || frame.url || ''));
      if (!/^[A-Za-z0-9_.-]+\.jpe?g$/i.test(filename)) continue;
      const candidates = [
        String(frame.filePath || frame.path || ''),
        join(config.analyzerFramesDir, `${kind}-${shortcode}`, filename),
      ].filter(Boolean);
      let path = null;
      for (const candidate of candidates) {
        try {
          await access(candidate);
          path = candidate;
          break;
        } catch {}
      }
      if (path) {
        available.push({
          path,
          seconds: frameSeconds(frame),
          frameIndex,
          slideIndex: null,
        });
      }
    }
  }

  if (!available.length) {
    return { contactSheet: null, manifest: null, keyframes: [] };
  }

  const indices = selectEvidenceFrameIndices(
    available,
    result.ocr || [],
    Math.min(config.contactSheetFrames, available.length),
    result.timeline || [],
  );
  const selected = indices.map((index) => available[index]);
  const contactSheetPath = join(outputDir, 'contact_sheet.jpg');
  const contactSheet = await renderContactSheet(selected, contactSheetPath);

  const ranked = scoredFrames(selected, result.ocr || [], result.timeline || [])
    .sort((a, b) => b.score - a.score || a.seconds - b.seconds);
  const keyframes = [];
  const used = new Set();
  for (const frame of ranked) {
    if (keyframes.length >= config.keyFrameAttachments) break;
    const identity = frame.slideIndex ? `s${frame.slideIndex}` : `f${frame.frameIndex}`;
    if (used.has(identity)) continue;
    used.add(identity);
    try {
      const filename = frame.slideIndex
        ? `slide_${String(frame.slideIndex).padStart(2, '0')}.jpg`
        : `keyframe_f${String(frame.frameIndex).padStart(3, '0')}_${String(Math.round(frame.seconds)).padStart(4, '0')}s.jpg`;
      keyframes.push({
        ...frame,
        filename,
        data: await readFile(frame.path),
      });
    } catch {}
  }

  return {
    contactSheet,
    keyframes,
    manifest: evidenceManifest(selected, result, keyframes),
  };
}

export async function createContactSheet(shortcode, result, outputPath, kind = 'reel') {
  const packageResult = await createEvidencePackage(
    shortcode,
    result,
    join(outputPath, '..'),
    kind,
  );
  return packageResult.contactSheet;
}
