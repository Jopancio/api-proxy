// Preloaded only by server-credits.test.js. No real Cashi calls are allowed.
'use strict';

const fs = require('fs');
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const address = new URL(String(url));
  if (address.hostname !== 'cashi.id') return originalFetch(url, options);
  const fixtures = JSON.parse(fs.readFileSync(process.env.CASHI_TEST_FIXTURES, 'utf8'));
  const fixture = fixtures[address.pathname];
  if (!fixture) throw new Error(`Unexpected Cashi request in test: ${address.pathname}`);
  return Response.json(fixture.body, { status: fixture.status || 200 });
};
