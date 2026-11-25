// The dev_notify_human result texts: each text asserts its exact wording, crossed with every urgent-DM variant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinEnv } from './helpers.mjs';

pinEnv();
const { mapNotifyResult } = await import('../../client/index.js');

const CHECK = ' Check the channel before sending again.';
const DMS = [
  ['dm absent', undefined, ''],
  ['dm accepted', { pat: true }, ' DM to pat accepted by Discord.'],
  ['dm not confirmed', { pat: false }, ' DM to pat not confirmed (it may not have been sent).'],
  ['dm empty (urgent tag with no pingable human)', {}, ' No urgent DM was sent: the tag has no pingable human.'],
  ['no bot token', 'no_bot_token', ' Urgent DM not sent: no bot token for this project.'],
];
const withDm = (r, dm) => (r && dm !== undefined ? { ...r, dm } : r);

const CASES = [
  ['posted, tagged pat', { ok: true, delivered: true, tagged: ['pat'], messageId: '9001' }, 'pat', 'Notification: posted to the channel; pinged pat.', false],
  ['posted, tagged []', { ok: true, delivered: true, tagged: [], messageId: '9001' }, 'sam', 'Notification: posted to the channel; nobody was pinged (tag sam).', false],
  ['posted, tagged absent (older server shape)', { ok: true, delivered: true, messageId: '9001' }, 'pat', 'Notification: posted to the channel; ping audience unknown.', false],
  ['no messageId, tagged pat', { ok: true, delivered: true, tagged: ['pat'] }, 'pat', `Notification: channel post unconfirmed; targeted pat; whether the mention landed is unconfirmed.${CHECK}`, false],
  ['no messageId, tagged []', { ok: true, delivered: true, tagged: [] }, 'all', `Notification: channel post unconfirmed; nobody was pinged (tag all).${CHECK}`, false],
  ['no messageId, tagged absent', { ok: true, delivered: true }, 'pat', `Notification: channel post unconfirmed; ping audience unknown.${CHECK}`, false],
  ['relay_failed from a 5xx', { error: 'relay_failed', message: 'Discord webhook returned 502; the notification may not have been delivered.', tagged: ['pat'] }, 'pat',
    `Notification: channel post unconfirmed: the webhook failed or timed out and the post may have landed (Discord webhook returned 502; the notification may not have been delivered.); targeted pat; whether the mention landed is unconfirmed.${CHECK}`, true],
  ['relay_failed from a thrown fetch', { error: 'relay_failed', message: 'Discord webhook unreachable: The operation was aborted due to timeout', tagged: ['pat'] }, 'pat',
    `Notification: channel post unconfirmed: the webhook failed or timed out and the post may have landed (Discord webhook unreachable: The operation was aborted due to timeout); targeted pat; whether the mention landed is unconfirmed.${CHECK}`, true],
  ['no_webhook', { error: 'no_webhook', message: 'Project x has no Discord webhook configured; the notification was NOT delivered.' }, 'pat', 'Notification: not posted: this project has no Discord webhook.', true],
  ['unknown_tag', { error: 'unknown_tag', message: 'Unknown tag(s): bob. Valid: pat, sam, all' }, 'bob', 'Notification not sent: Unknown tag(s): bob. Valid: pat, sam, all.', true],
  ['missing sender', { error: 'sender and message required' }, 'pat', 'Notification not sent: sender and message required.', true],
  ['bus unreachable', { error: 'Synapse unreachable: connect ECONNREFUSED' }, 'pat', `Notification outcome unconfirmed (Synapse unreachable: connect ECONNREFUSED).${CHECK}`, true],
  ['non-JSON', { error: 'Synapse returned non-JSON on /api/notify' }, 'pat', `Notification outcome unconfirmed (Synapse returned non-JSON on /api/notify).${CHECK}`, true],
];

for (const [label, result, tag, expected, isError] of CASES) {
  for (const [dmLabel, dm, dmText] of DMS) {
    test(`${label} x ${dmLabel}`, () => {
      const out = mapNotifyResult(withDm(result, dm), { tag });
      assert.equal(out.content[0].text, expected + dmText);
      assert.equal(!!out.isError, isError);
      assert.doesNotMatch(out.content[0].text, /delivered\)|DM sent|still landed/, 'no overclaim');
    });
  }
}

test('a null result is unconfirmed, never a success', () => {
  const out = mapNotifyResult(null, { tag: 'pat' });
  assert.equal(out.content[0].text, `Notification outcome unconfirmed (no response).${CHECK}`);
  assert.equal(out.isError, true);
});

test('the one text dev_ask trusts as a reached human is the posted-and-pinged line', () => {
  const t = mapNotifyResult({ ok: true, delivered: true, tagged: ['pat', 'sam'], messageId: '1' }, { tag: 'all' }).content[0].text;
  assert.ok(t.includes('posted to the channel; pinged pat, sam'));
});

test('the core bus queues on the dashboard: the text says nobody was pinged, and it is not an error', () => {
  const r = mapNotifyResult({ ok: true, delivered: false, via: 'dashboard', tagged: ['alex'] }, { tag: 'alex' });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /queued on the Synapse dashboard for alex; nobody was pinged/);
  assert.doesNotMatch(r.content[0].text, /posted to the channel/);
});
