# Reel Bridge Worker

This public repository contains only an isolated GitHub-hosted runner for downloading and analyzing public Instagram Reels/posts with FFmpeg, OCR, and local Whisper.

It deliberately contains no Gmail, Cloudflare, Hoststar, OAuth, API token, private URL, or private-state access. The workflow runs only after a signed `repository_dispatch` from the private control plane. Forked repositories do not receive the protected signing secret or callback configuration.

The runner accepts a validated public Instagram URL, produces `result.json` data, a contact sheet, and selected keyframes, then posts the evidence through a signed callback. The private control plane validates the callback and is solely responsible for Gmail result delivery.
