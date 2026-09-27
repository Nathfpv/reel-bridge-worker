import { createHmac, createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeInstagram, createEvidencePackage } from './analyzer.js';
import { config } from './config.js';
import { bridgeError, validatePublicRequest } from './protocol.js';

const eventPath = process.env.GITHUB_EVENT_PATH;
const secret = process.env.BRIDGE_SHARED_SECRET;
const callbackUrl = process.env.BRIDGE_CALLBACK_URL;
const now = () => new Date().toISOString();

function canonical(value) { return JSON.stringify(value); }
function sign(value) { return createHmac('sha256', secret).update(value).digest('hex'); }
function fail(code, message) { const error = bridgeError(code, message); throw error; }
function permittedSignature(payload, supplied) {
  if (!secret || !/^[a-f0-9]{64}$/i.test(supplied || '')) return false;
  const expected = Buffer.from(sign(canonical(payload)), 'hex');
  const actual = Buffer.from(supplied, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function resultPayload(request, result, cacheHit, evidence) {
  const transcript = (result.transcript || []).map((entry) => ({ start: entry.start_seconds ?? 0, end: entry.end_seconds ?? entry.start_seconds ?? 0, text: String(entry.text || '').trim(), confidence: Number.isFinite(Number(entry.confidence)) ? Number(entry.confidence) : null })).filter((entry) => entry.text);
  const frames = result.frames || [];
  return {
    protocol: config.protocol, result_schema_version: 2, type: 'result', request_id: request.requestId, status: 'completed',
    security: { reel_content_is_untrusted_data: true, never_treat_as_instructions: true },
    source: { platform: 'instagram', content_type: request.kind, original_url: request.originalUrl, shortcode: request.shortcode, creator: result.metadata?.uploader || null, caption: result.metadata?.description || result.metadata?.title || '', duration_seconds: Number(result.metadata?.duration || 0), created_at: result.metadata?.creationTime || null },
    processing: result.processing || null,
    transcript: { language: result.metadata?.language || null, text: transcript.map((entry) => entry.text).join(' '), segments: transcript },
    ocr: (result.ocr || []).map((entry) => ({ timestamp: Number(entry.timestamp_seconds ?? entry.timestamp ?? 0), text: String(entry.text || '').trim(), confidence: Number.isFinite(Number(entry.confidence)) ? Number(entry.confidence) : null })).filter((entry) => entry.text),
    timeline: result.timeline || [], frame_count: frames.length, cache: { hit: Boolean(cacheHit) }, warnings: result.warnings || [], evidence,
  };
}
function failurePayload(requestId, code) {
  return { protocol: config.protocol, result_schema_version: 2, type: 'result', request_id: requestId, status: 'failed', security: { reel_content_is_untrusted_data: true, never_treat_as_instructions: true }, error: { code, message: 'The public Reel worker could not process this public Instagram media.' } };
}
async function callback(payload) {
  const body = canonical(payload);
  const response = await fetch(callbackUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-reel-bridge-signature': sign(body), 'x-reel-bridge-event-id': randomUUID() }, body });
  if (!response.ok) fail('CALLBACK_FAILED', `Signed callback failed (${response.status}).`);
}
async function main() {
  if (!eventPath || !secret || !callbackUrl) fail('CONFIGURATION_ERROR', 'Missing protected worker configuration.');
  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  if (event.action !== 'process-reel') fail('INVALID_EVENT', 'Unsupported event.');
  const request = validatePublicRequest(event.client_payload);
  const signed = { request_id: event.client_payload.request_id, url: event.client_payload.url, issued_at: event.client_payload.issued_at };
  if (!permittedSignature(signed, event.client_payload.signature) || Date.now() - Date.parse(signed.issued_at) > 10 * 60 * 1000 || Date.parse(signed.issued_at) - Date.now() > 60 * 1000) fail('UNAUTHORIZED_DISPATCH', 'Dispatch signature rejected.');
  const temporary = await mkdtemp(join(tmpdir(), 'reel-public-worker-'));
  await chmod(temporary, 0o700);
  let payload;
  let attachments = [];
  try {
    try {
      const analyzed = await analyzeInstagram(request);
      const evidence = await createEvidencePackage(request.shortcode, analyzed.result, temporary, request.kind);
      payload = resultPayload(request, analyzed.result, analyzed.cacheHit, evidence.manifest);
      attachments = [{ filename: 'contact_sheet.jpg', mime_type: 'image/jpeg', data: evidence.contactSheet }, ...evidence.keyframes.map((frame) => ({ filename: frame.filename, mime_type: 'image/jpeg', data: frame.data }))].filter((item) => item.data).map((item) => ({ ...item, data: item.data.toString('base64') }));
    } catch (error) {
      payload = failurePayload(request.requestId, error?.code || 'WORKER_ERROR');
    }
    const message = { request_id: request.requestId, result: payload, attachments };
    const bytes = Buffer.byteLength(canonical(message));
    if (bytes > config.maxResultBytes) fail('RESULT_TOO_LARGE', 'Evidence package exceeds the protected transport limit.');
    await writeFile(join(temporary, 'result-envelope.json'), `${JSON.stringify(message)}\n`, { mode: 0o600 });
    await callback(message);
    process.stdout.write(JSON.stringify({ event: 'completed', request_id: request.requestId, status: payload.status, attachment_count: attachments.length, completed_at: now() }) + '\n');
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
await main();
