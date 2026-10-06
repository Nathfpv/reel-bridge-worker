import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_RESULT_BYTES = 18 * 1024 * 1024;
export function manifestFields(value) {
  return {
    protocol: value.protocol, request_id: value.request_id, run_id: value.run_id,
    sha256: value.sha256, byte_size: value.byte_size, issued_at: value.issued_at,
  };
}
export async function prepareArtifact(message, { directory, runId, secret, issuedAt = new Date().toISOString() }) {
  if (!directory || !secret || !Number.isSafeInteger(runId) || runId <= 0) throw new Error('INVALID_ARTIFACT_CONFIGURATION');
  const envelope = Buffer.from(`${JSON.stringify(message)}\n`);
  if (envelope.length > MAX_RESULT_BYTES) throw new Error('RESULT_TOO_LARGE');
  const manifest = manifestFields({
    protocol: 'reel-bridge-artifact-v1', request_id: message.request_id, run_id: runId,
    sha256: createHash('sha256').update(envelope).digest('hex'), byte_size: envelope.length, issued_at: issuedAt,
  });
  const signature = createHmac('sha256', secret).update(JSON.stringify(manifest)).digest('hex');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'result-envelope.json'), envelope, { mode: 0o600 });
  await writeFile(join(directory, 'result-manifest.json'), JSON.stringify({ ...manifest, signature }), { mode: 0o600 });
  return manifest;
}
export async function notifyArtifact({ directory, artifactId, callbackUrl, secret, fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (!Number.isSafeInteger(artifactId) || artifactId <= 0 || !secret || !callbackUrl) throw new Error('INVALID_NOTIFICATION_CONFIGURATION');
  const url = new URL(callbackUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('INVALID_CALLBACK_URL');
  const saved = JSON.parse(await readFile(join(directory, 'result-manifest.json'), 'utf8'));
  // Timestamp is bound to artifact bytes and cannot change when retrying.
  const body = JSON.stringify({ ...manifestFields(saved), artifact_id: artifactId, event_id: randomUUID() });
  const signature = createHmac('sha256', secret).update(body).digest('hex');
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetchImpl(url.href, {
        method: 'POST', signal: AbortSignal.timeout(30_000),
        headers: { 'content-type': 'application/json', 'x-reel-bridge-signature': signature }, body,
      });
      await response.body?.cancel();
      if (response.ok) return;
      if (response.status < 500 && response.status !== 429) throw Object.assign(new Error(`CALLBACK_${response.status}`), { permanent: true });
    } catch (error) {
      if (error.permanent) throw error;
      if (attempt === 4) throw new Error('CALLBACK_RETRIES_EXHAUSTED', { cause: error });
    }
    if (attempt < 4) await sleep(1000 * 2 ** attempt);
  }
  throw new Error('CALLBACK_RETRIES_EXHAUSTED');
}

if (process.argv[1]?.endsWith('/result-transport.js')) {
  await notifyArtifact({
    directory: process.env.BRIDGE_RESULT_DIRECTORY,
    artifactId: Number(process.env.BRIDGE_ARTIFACT_ID),
    callbackUrl: process.env.BRIDGE_CALLBACK_URL,
    secret: process.env.BRIDGE_SHARED_SECRET,
  });
}
