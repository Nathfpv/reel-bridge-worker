import { join } from 'node:path';

const root = process.env.REEL_WORKER_ROOT || process.cwd();
const data = process.env.REEL_WORKER_DATA_DIR || join(root, '.reel-worker-data');

export const config = Object.freeze({
  protocol: 'reel-bridge-v1',
  analyzerRoot: data,
  analyzerFramesDir: join(data, 'frames'),
  analyzerBin: process.env.REEL_ANALYZER_BIN || join(root, 'node_modules', '.bin', 'mcp-video-analyzer'),
  ffmpegBin: process.env.REEL_FFMPEG_BIN || join(root, 'node_modules', 'ffmpeg-static', 'ffmpeg'),
  ytDlpBin: process.env.REEL_YTDLP_BIN || 'yt-dlp',
  whisperHfModel: process.env.WHISPER_HF_MODEL || 'onnx-community/whisper-base',
  whisperBin: process.env.WHISPER_BIN || join(root, 'bin', 'whisper'),
  maxFrames: Number(process.env.REEL_MAX_FRAMES || 36),
  sceneFrames: Number(process.env.REEL_SCENE_FRAMES || 24),
  maxWidth: Number(process.env.REEL_MAX_WIDTH || 1280),
  ocrLanguage: process.env.REEL_OCR_LANGUAGE || 'eng+deu+fra+ita',
  analyzerTimeoutMs: Number(process.env.REEL_ANALYZER_TIMEOUT_MS || 11 * 60 * 1000),
  contactSheetFrames: Number(process.env.REEL_CONTACT_SHEET_FRAMES || 15),
  keyFrameAttachments: Number(process.env.REEL_KEY_FRAME_ATTACHMENTS || 4),
  contactSheetWidth: 1440,
  maxResultBytes: 18 * 1024 * 1024,
});
