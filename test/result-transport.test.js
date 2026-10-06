import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_RESULT_BYTES, notifyArtifact, prepareArtifact } from '../src/result-transport.js';

const secret = 'test-secret-only';
const requestId = '438dd96b-7153-461c-8eb6-9d4af963ddb8';
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'reel-transport-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
test('Artifact persists exact envelope bytes and independently verifiable signed manifest', async (t) => {
  const path = await directory(t);
  const envelope = { request_id: requestId, result: { status: 'failed' }, attachments: [] };
  const manifest = await prepareArtifact(envelope, { directory: path, runId: 123, secret, issuedAt: '2026-10-06T19:00:00Z' });
  const bytes = await readFile(join(path, 'result-envelope.json'));
  assert.equal(bytes.toString(), `${JSON.stringify(envelope)}\n`);
  assert.equal(manifest.byte_size, bytes.length);
  assert.equal(manifest.sha256, createHash('sha256').update(bytes).digest('hex'));
  const saved = JSON.parse(await readFile(join(path, 'result-manifest.json'), 'utf8'));
  assert.equal(saved.signature, createHmac('sha256', secret).update(JSON.stringify(manifest)).digest('hex'));
});
test('Notification retries temporary failures with the same small signed event', async (t) => {
  const path = await directory(t);
  await prepareArtifact({ request_id: requestId, result: {}, attachments: [] }, { directory: path, runId: 123, secret });
  const calls = [];
  const waits = [];
  await notifyArtifact({ directory: path, artifactId: 456, callbackUrl: 'https://bridge.example/internal/reel-result', secret,
    sleep: async (ms) => waits.push(ms),
    fetchImpl: async (url, options) => {
      calls.push(options);
      return new Response(null, { status: calls.length < 3 ? 503 : 202 });
    },
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(new Set(calls.map((item) => item.body)).size, 1);
  assert.ok(Buffer.byteLength(calls[0].body) < 2048);
  assert.equal(calls[0].headers['x-reel-bridge-signature'], createHmac('sha256', secret).update(calls[0].body).digest('hex'));
  assert.equal(JSON.parse(calls[0].body).artifact_id, 456);
  assert.equal(Object.hasOwn(JSON.parse(calls[0].body), 'attachments'), false);
});
test('Notification network outage exhausts explicitly while durable artifact remains available', async (t) => {
  const path = await directory(t);
  await prepareArtifact({ request_id: requestId }, { directory: path, runId: 123, secret });
  let attempts = 0;
  await assert.rejects(notifyArtifact({ directory: path, artifactId: 456, callbackUrl: 'https://bridge.example/internal/reel-result', secret,
    sleep: async () => {}, fetchImpl: async () => { attempts++; throw new Error('network'); },
  }), /CALLBACK_RETRIES_EXHAUSTED/);
  assert.equal(attempts, 5);
  assert.ok((await readFile(join(path, 'result-envelope.json'))).length > 0);
});
test('Notification permanent authentication error is not silently retried', async (t) => {
  const path = await directory(t);
  await prepareArtifact({ request_id: requestId }, { directory: path, runId: 123, secret });
  let attempts = 0;
  await assert.rejects(notifyArtifact({ directory: path, artifactId: 456, callbackUrl: 'https://bridge.example/internal/reel-result', secret,
    fetchImpl: async () => { attempts++; return new Response(null, { status: 401 }); },
  }), /CALLBACK_401/);
  assert.equal(attempts, 1);
});
test('Oversized artifact is rejected before creating a transport bundle', async (t) => {
  const path = await directory(t);
  await assert.rejects(prepareArtifact({ request_id: requestId, contents: 'x'.repeat(MAX_RESULT_BYTES) }, { directory: path, runId: 123, secret }), /RESULT_TOO_LARGE/);
});
