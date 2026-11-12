'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../bridge/context');
const P = require('../bridge/protocol');
const { deflateSync } = require('node:zlib');

function fragments(value, extra = {}) {
  const encoding = extra.encoding || 'b64';
  const bytes = Buffer.from(JSON.stringify(value));
  const encoded = (encoding === 'zlib64' ? deflateSync(bytes) : bytes).toString('base64');
  const size = 24;
  const parts = [];
  for (let i = 0; i < encoded.length; i += size) parts.push(encoded.slice(i, i + size));
  return parts.map((text, i) => ({ session: 'token', chat: 'chat', id: 7, nonce: 'owner-000007', data: 'profile', profile: '7', encoding, part: i + 1, parts: parts.length, text, ...extra }));
}

test('multipart context survives reordering, duplicates and UTF-8 boundaries without partial completion', () => {
  const value = { version: 1, enabled: ['inventory'], data: { inventory: ['Épée', '鉱石', '🪨', 'x'.repeat(9000)] } };
  const packets = fragments(value), receiver = new C.Transfers();
  const first = receiver.add(packets[packets.length - 1]);
  assert.equal(first.text, undefined);
  assert.equal(receiver.add(packets[packets.length - 1]).received, 1, 'duplicates cannot substitute for missing parts');
  let result;
  for (const part of packets.slice(0, -1).reverse()) result = receiver.add(part);
  assert.deepEqual(C.snapshot(result.text), value);
});

test('compressed profiles and query results preserve all UTF-8 bytes with reordered fragments and duplicates', () => {
  const value = { version: 1, enabled: ['inventory'], data: { inventory: Array.from({length: 200}, (_, i) => ({id: i, name: 'Épée 鉱石 🪨', details: {quality: 2, type: 'Trade Goods'}})) } };
  for (const data of ['profile', 'query']) {
    const packets = fragments(value, {encoding: 'zlib64', data}), receiver = new C.Transfers();
    receiver.add(packets.at(-1));
    assert.equal(receiver.add(packets.at(-1)).received, 1);
    let result;
    for (const packet of packets.slice(0, -1).reverse()) result = receiver.add(packet);
    assert.equal(result.text, JSON.stringify(value));
  }
});

test('base64 transfers reject changed encodings, malformed padding and damaged compressed data', () => {
  const packets = fragments({version: 1, enabled: [], data: {}}, {encoding: 'b64'});
  const receiver = new C.Transfers();
  receiver.add(packets[0]);
  assert.throws(() => receiver.add({...packets[1], encoding: 'zlib64'}), /encoding changed/);
  assert.throws(() => new C.Transfers().add({...packets[0], encoding: 'unknown'}), /Invalid/);
  assert.throws(() => new C.Transfers().add({...packets[0], parts: 1, text: 'e30==='}), /Invalid/);
  assert.throws(() => new C.Transfers().add({...packets[0], parts: 1, text: 'e30'}), /base64/);
  const damaged = Buffer.from(deflateSync(Buffer.from('{}')));
  damaged[damaged.length - 1] ^= 1; // valid base64, failed zlib checksum
  assert.throws(() => new C.Transfers().add({...packets[0], parts: 1, encoding: 'zlib64', text: damaged.toString('base64')}), /check/i);
});

test('the 4 MiB information limit also bounds decompressed data', () => {
  const packets = fragments({value: 'x'.repeat(4 * 1024 * 1024)}, {encoding: 'zlib64'});
  const receiver = new C.Transfers();
  assert.throws(() => { for (const packet of packets) receiver.add(packet); }, /exceeds 4 MiB/);
});

test('multipart owners with reused numeric ids stay isolated by session, chat and nonce', () => {
  for (const change of [{ session: 'another' }, { chat: 'another' }, { nonce: 'owner-000008' }]) {
    const receiver = new C.Transfers();
    const one = fragments({ version: 1, enabled: [], data: { value: 'first' } });
    const two = fragments({ version: 1, enabled: [], data: { value: 'second' } }, change);
    receiver.add(one[0]);
    receiver.add(two[0]);
    assert.equal(receiver.add(one[0]).received, 1, 'retry stays with its owner');
    let result;
    for (const packet of two.slice(1)) result = receiver.add(packet);
    assert.equal(JSON.parse(result.text).data.value, 'second');
    for (const packet of one.slice(1)) result = receiver.add(packet);
    assert.equal(JSON.parse(result.text).data.value, 'first');
  }
});

test('query batches and profile transfers with reused ids cannot consume another owner or batch', () => {
  const receiver = new C.Transfers();
  const one = fragments([{ value: 'first' }], { data: 'query', request: '7-1' });
  const two = fragments([{ value: 'second' }], { data: 'query', request: '7-1', nonce: 'owner-000008' });
  const next = fragments([{ value: 'third' }], { data: 'query', request: '7-2' });
  receiver.add(one[0]);
  receiver.add(two[0]);
  receiver.add(next[0]);
  receiver.forget(two[0]);
  let result;
  for (const packet of next.slice(1)) result = receiver.add(packet);
  assert.equal(JSON.parse(result.text)[0].value, 'third');
  for (const packet of one.slice(1)) result = receiver.add(packet);
  assert.equal(JSON.parse(result.text)[0].value, 'first');
  assert.throws(() => receiver.add({ ...one[0], nonce: undefined }), /Invalid/);
});

test('conflicting or malformed context parts fail rather than becoming apparently complete data', () => {
  const receiver = new C.Transfers(), packets = fragments({ version: 1, enabled: [], data: {} });
  receiver.add(packets[0]);
  assert.throws(() => receiver.add({ ...packets[0], text: '0000' }), /Conflicting/);
  assert.throws(() => receiver.add({ ...packets[1], parts: packets.length + 1 }), /count changed/);
  assert.throws(() => receiver.add({ ...packets[0], part: 0 }), /Invalid/);
  assert.throws(() => receiver.add({ ...packets[0], text: 'not hexadecimal' }), /Invalid/);
});

test('read-only request batches remain data, and unsupported request operations are rejected', () => {
  const parsed = C.requests('Checking.\n```wowcontext\n[{"op":"snapshot","category":"mail"},{"op":"api","name":"C_Spell.GetSpellInfo","args":[133]}]\n```');
  assert.equal(parsed.queries.length, 2);
  assert.equal(parsed.text, 'Checking.');
  assert.throws(() => C.requests('```wowcontext\n{"op":"execute","code":"RunScript(1)"}\n```'), /Invalid/);
  assert.throws(() => C.requests('```wowcontext\nnot JSON\n```'));
});

test('reload character snapshots and query results remain separate from ordinary player text', () => {
  const profile = { version: 1, enabled: ['inventory'], data: { inventory: ['Épée'] } };
  const hex = value => Buffer.from(value).toString('hex');
  const source = `WoWAIDB = { ["outbox"] = { ["id"] = 7, ["session"] = "token", ["chat"] = "chat", ["nonce"] = "owner-000007", ["text"] = "${hex('question')}", ["profile"] = "${hex(JSON.stringify(profile))}" }, ["contextOutbox"] = { ["id"] = 7, ["session"] = "token", ["chat"] = "chat", ["nonce"] = "owner-000007", ["request"] = "7-1", ["text"] = "${hex('[{"ok":false}]')}" } }`;
  const job = P.parseOutbox(source), response = P.parseContextOutbox(source);
  assert.equal(job.text, 'question');
  assert.equal(job.nonce, 'owner-000007');
  assert.equal(response.nonce, job.nonce);
  assert.deepEqual(C.snapshot(job.profilePayload), profile);
  assert.equal(response.request, '7-1');
  assert.deepEqual(JSON.parse(response.payload), [{ ok: false }]);
});
