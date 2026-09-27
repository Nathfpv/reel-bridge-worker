const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHORTCODE = /^[A-Za-z0-9_-]{5,32}$/;

export function bridgeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function validatePublicRequest(value) {
  if (!value || !REQUEST_ID.test(value.request_id || '')) throw bridgeError('INVALID_REQUEST_ID', 'Invalid request ID.');
  if (typeof value.url !== 'string' || value.url.length > 512) throw bridgeError('INVALID_URL', 'Invalid public Instagram URL.');
  let url;
  try { url = new URL(value.url); } catch { throw bridgeError('INVALID_URL', 'Invalid public Instagram URL.'); }
  const match = /^\/(reel|p)\/([A-Za-z0-9_-]{5,32})\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || !['instagram.com', 'www.instagram.com'].includes(url.hostname.toLowerCase()) || url.username || url.password || url.port || !match || !SHORTCODE.test(match[2])) {
    throw bridgeError('INVALID_URL', 'Invalid public Instagram URL.');
  }
  const kind = match[1] === 'p' ? 'post' : 'reel';
  return { requestId: value.request_id, originalUrl: value.url, canonicalUrl: `https://www.instagram.com/${kind === 'post' ? 'p' : 'reel'}/${match[2]}/`, shortcode: match[2], kind };
}
