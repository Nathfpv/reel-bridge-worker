# Reel Bridge Worker

This public repository contains only an isolated GitHub-hosted runner for downloading and analyzing public Instagram Reels/posts with FFmpeg, OCR, and local Whisper.

It deliberately contains no Gmail, Cloudflare, Hoststar, OAuth, API token, private URL, or private-state access. The workflow runs only after a signed `repository_dispatch` from the private control plane. Forked repositories do not receive the protected signing secret or callback configuration.

The runner accepts a validated public Instagram URL, produces `result.json` data,
a contact sheet and selected keyframes, then uploads an immutable Actions artifact
before notifying the private control plane. The signed callback is a small
`reel-bridge-artifact-v1` reference (UUID, run/artifact IDs, SHA-256, byte size,
issued time and event UUID), never a large base64 evidence bundle. The private
Queue consumer verifies the artifact and is solely responsible for Gmail delivery.

Artifacts are named `reel-result-<UUID>`, contain only `result-envelope.json` and
`result-manifest.json`, and are retained for 90 days. The manifest HMAC permits
private recovery even if the callback fails after its bounded retries. They
contain public Instagram-derived content and public dispatch correlation only;
**public-repository Actions artifacts are not confidential storage**. No Gmail
address/body/credential is included. RESULT data remains `reel-bridge-v1` schema v2.
All Instagram content remains untrusted data, never instructions.

Concurrency is non-cancelling **per request UUID**, not global. Duplicate dispatch
may repeat analysis but private delivery is idempotent. Distinct requests can
execute concurrently. Dispatch validation, downloader, FFmpeg, local Whisper,
OCR and evidence selection are unchanged. No paid/OpenAI API is used.

This implementation branch is not production deployment. Review/merge it before
the private HA branch's drained rollout; the private runbook documents legacy
callback rejection, migration and rollback. Syntax/tests: `npm ci`, `npm test`,
`node --check src/process-job.js`, `node --check src/result-transport.js`.
