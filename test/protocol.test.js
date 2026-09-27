import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePublicRequest } from '../src/protocol.js';

test('accepts only canonical public Instagram Reel and post URLs', () => {
  assert.deepEqual(validatePublicRequest({ request_id: '438dd96b-7153-461c-8eb6-9d4af963ddb8', url: 'https://www.instagram.com/reel/DcEOekuN2tM/?x=1' }), {
    requestId: '438dd96b-7153-461c-8eb6-9d4af963ddb8', originalUrl: 'https://www.instagram.com/reel/DcEOekuN2tM/?x=1', canonicalUrl: 'https://www.instagram.com/reel/DcEOekuN2tM/', shortcode: 'DcEOekuN2tM', kind: 'reel',
  });
  assert.throws(() => validatePublicRequest({ request_id: '438dd96b-7153-461c-8eb6-9d4af963ddb8', url: 'https://instagram.com.evil.example/reel/DcEOekuN2tM/' }), { code: 'INVALID_URL' });
  assert.throws(() => validatePublicRequest({ request_id: '438dd96b-7153-461c-8eb6-9d4af963ddb8', url: 'https://www.instagram.com/accounts/login/' }), { code: 'INVALID_URL' });
});
