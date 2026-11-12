'use strict';
/** `npm run setup` (scripts/setup-env.js): fills empty / placeholder secrets, keeps real values. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applySetup, isPlaceholder } = require('../scripts/setup-env');

test('placeholders and empty values are replaced with random hex of the right length', () => {
  const { text, actions } = applySetup('PORT=4000\nJWT_SECRET=change-me-to-a-long-random-string\nAI_SERVICE_TOKEN=\n');
  const jwt = /^JWT_SECRET=([0-9a-f]+)$/m.exec(text)[1];
  const ai = /^AI_SERVICE_TOKEN=([0-9a-f]+)$/m.exec(text)[1];
  assert.equal(jwt.length, 96); // 48 bytes
  assert.equal(ai.length, 48); // 24 bytes
  assert.match(text, /^PORT=4000$/m);
  assert.equal(actions.length, 2);
});

test('real values are never overwritten; missing keys are added; CRLF is preserved', () => {
  const real = 'a'.repeat(64);
  const { text, actions } = applySetup(`JWT_SECRET="${real}"\r\nPORT=4000\r\n`);
  assert.ok(text.includes(`JWT_SECRET="${real}"`));
  assert.match(text, /\r\nAI_SERVICE_TOKEN=[0-9a-f]{48}\r\n$/);
  assert.match(actions[0], /kept/);
  assert.equal(isPlaceholder('<your-token>'), true);
  assert.equal(isPlaceholder('secret'), true);
  assert.equal(isPlaceholder(real), false);
});
