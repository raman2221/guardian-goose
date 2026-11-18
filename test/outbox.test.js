import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installOutbox } from '../src/outbox.js';

// A fake socket that records the order sends actually go out.
function fakeSock() {
  const sent = [];
  return {
    sent,
    sendMessage: async (jid, content) => { sent.push(content.delete ? `delete:${content.delete.id}` : content.text); },
    sendPresenceUpdate: async () => {},
  };
}

test('deletes jump ahead of queued messages but keep their own order', async () => {
  const sock = installOutbox(fakeSock(), { minGapMs: 0, jitterMs: 0, dailyCap: 100 });
  const first = sock.sendMessage('g', { text: 'a' });      // starts sending right away
  const later = [
    sock.sendMessage('g', { text: 'b' }),
    sock.sendMessage('g', { text: 'c' }),
    sock.sendMessage('g', { delete: { id: 'x' } }),
    sock.sendMessage('g', { delete: { id: 'y' } }),
  ];
  await Promise.all([first, ...later]);
  assert.deepEqual(sock.sent, ['a', 'delete:x', 'delete:y', 'b', 'c']);
});

test('the daily cap still applies to deletes', async () => {
  const sock = installOutbox(fakeSock(), { minGapMs: 0, jitterMs: 0, dailyCap: 1 });
  await sock.sendMessage('g', { delete: { id: 'x' } });
  await assert.rejects(sock.sendMessage('g', { delete: { id: 'y' } }), /daily send cap/);
});
