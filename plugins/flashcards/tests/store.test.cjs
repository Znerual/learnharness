'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { openStore } = require('../src/store.cjs');

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flashcards-store-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('failed mutation and atomic write leave memory and persisted store unchanged', t => {
  const dir = directory(t), file = path.join(dir, 'flashcards.json');
  const store = openStore(dir);
  store.change(s => s.decks.push({ id: 'kept', name: 'Kept', propositionIds: [], newLimit: 20 }));
  const before = structuredClone(store.get()), bytes = fs.readFileSync(file, 'utf8');
  assert.throws(() => store.change(s => { s.decks.length = 0; throw new Error('Invalid update'); }), /Invalid update/);
  assert.deepEqual(store.get(), before);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('Synthetic rename failure'); });
  try {
    assert.throws(() => store.change(s => { s.decks.length = 0; }), /Synthetic rename failure/);
  } finally { rename.mock.restore(); }
  assert.deepEqual(store.get(), before);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.deepEqual(fs.readdirSync(dir), ['flashcards.json']);
  assert.deepEqual(openStore(dir).get(), before);
  store.change(s => { s.decks[0].name = 'Next successful write'; });
  assert.equal(openStore(dir).get().decks[0].name, 'Next successful write');
  assert.equal(store.get().revision, before.revision + 1);
});

test('converted sources use UUID-only private paths and never embed Markdown in the store state', t => {
  const dir = directory(t), store = openStore(dir), id = randomUUID(), markdown = '# Converted Markdown\n\nA supported fact.';
  const before = structuredClone(store.get());
  store.writeSource(id, markdown);
  assert.deepEqual(store.get(), before); assert.equal(fs.existsSync(path.join(dir, 'flashcards.json')), false);
  assert.equal(store.readSource(id), markdown);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'sources')), [`${id}.md`]);
  assert.equal(fs.statSync(path.join(dir, 'sources', `${id}.md`)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, 'sources')).mode & 0o777, 0o700);
  for (const unsafe of ['../outside', '/tmp/outside', 'notes.md', '', null]) {
    assert.throws(() => store.writeSource(unsafe, markdown), /Invalid file source ID/);
    assert.throws(() => store.readSource(unsafe), /Invalid file source ID/);
    assert.throws(() => store.removeSource(unsafe), /Invalid file source ID/);
  }
  assert.equal(openStore(dir).readSource(id), markdown);
  store.removeSource(id); store.removeSource(id);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'sources')), []);
});

test('failed source replacement retains accepted bytes and removes temporary files', t => {
  const dir = directory(t), store = openStore(dir), id = randomUUID();
  store.writeSource(id, 'Accepted converted Markdown');
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('Source rename unavailable'); });
  try { assert.throws(() => store.writeSource(id, 'Unaccepted replacement'), /Source rename unavailable/); }
  finally { rename.mock.restore(); }
  assert.equal(store.readSource(id), 'Accepted converted Markdown');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'sources')), [`${id}.md`]);
});

test('legacy cleanup is atomic, retains live manual cues and text-free receipts, and removes only deleted card text and review snapshots', t => {
  const dir = directory(t), file = path.join(dir, 'flashcards.json'), original = openStore(dir);
  original.change(s => {
    s.decks.push({ id: 'd', name: 'Kept container', propositionIds: ['p'], newLimit: 20 });
    s.propositions.p = { id: 'p', name: 'Live target', version: 1, learningCueId: 'gone', cues: [
      { id: 'kept', question: 'Kept question', answer: 'Kept answer', creation: { requestId: 'create-kept', hash: 'hash-kept' } },
      { id: 'gone', question: 'DELETED QUESTION', answer: 'DELETED ANSWER', deleted: true, creation: { requestId: 'create-gone', hash: 'hash-gone' } },
    ] };
    s.reviews.push({ id: 'r', propositionId: 'p', cueId: 'gone', question: 'OLD REVIEW QUESTION', answer: 'OLD REVIEW ANSWER', rating: 3, at: 123 });
  });
  const bytes = fs.readFileSync(file, 'utf8'), rename = t.mock.method(fs, 'renameSync', () => { throw new Error('Migration save unavailable'); });
  try { assert.throws(() => openStore(dir), /Migration save unavailable/); }
  finally { rename.mock.restore(); }
  assert.equal(fs.readFileSync(file, 'utf8'), bytes); assert.deepEqual(fs.readdirSync(dir).sort(), ['flashcards.json', 'reviews']);
  const migrated = openStore(dir).get(); assert.equal(migrated.revision, original.get().revision + 1);
  assert.deepEqual(migrated.propositions.p.cues, [{ id: 'kept', question: 'Kept question', answer: 'Kept answer' }]);
  assert.equal(migrated.propositions.p.learningCueId, null); assert.equal(migrated.propositions.p.version, 2);
  assert.deepEqual(migrated.reviews, [{ id: 'r', propositionId: 'p', cueId: 'gone', rating: 3, at: 123 }]);
  assert.deepEqual(migrated.creationReceipts.map(r => r.requestId), ['create-kept', 'create-gone']);
  assert.deepEqual(openStore(dir).get(), migrated);
});

test('malformed and unsupported stores fail closed without overwriting original bytes', t => {
  const dir = directory(t), file = path.join(dir, 'flashcards.json');
  for (const bytes of ['{"broken":', JSON.stringify({ version: 99, revision: 0, decks: [], reviews: [], batches: [], propositions: {}, settings: {} })]) {
    fs.writeFileSync(file, bytes);
    assert.throws(() => openStore(dir), /Could not read Flashcards data|Unsupported or invalid/);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.deepEqual(fs.readdirSync(dir), ['flashcards.json']);
  }
});

test('stores from before the output limit setting get 32768, once', t => {
  const dir = directory(t), file = path.join(dir, 'flashcards.json');
  const old = { version: 1, revision: 3, settings: { retention: 0.9, learningSteps: [1, 10], relearningSteps: [10], dayStart: 4, fuzz: false, chunkBudget: 2000, modelOverride: null }, decks: [], propositions: {}, reviews: [], batches: [] };
  fs.writeFileSync(file, JSON.stringify(old));
  const store = openStore(dir);
  assert.equal(store.get().settings.outputBudget, 32768);
  assert.equal(store.get().settings.chunkBudget, 2000, 'other settings stay');
  assert.equal(store.get().revision, 4);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).settings.outputBudget, 32768);
  fs.writeFileSync(file, JSON.stringify({ ...old, settings: { ...old.settings, outputBudget: 8192 } }));
  assert.equal(openStore(dir).get().settings.outputBudget, 8192, 'a saved value is never replaced');
});

// ---------------------------------------------------------------- multi-device (ADR 0007)

const scheduler = require('../src/scheduler.cjs');
function installs(t) {
  const root = directory(t), data = path.join(root, 'data');
  return { data, local: name => path.join(root, `local-${name}`) };
}
function rate(store, propositionId, rating, at) {
  store.change(s => {
    const p = s.propositions[propositionId], before = p.schedule, introduced = p.firstReviewedAt == null;
    p.schedule = scheduler.rate(before, rating, at, s.settings); p.firstReviewedAt ??= at;
    p.learningCueId = [1, 3].includes(p.schedule.state) ? p.cues[0].id : null;
    p.cues[0].latestRating = rating; p.cues[0].lastReviewedAt = at; p.version++;
    s.reviews.push({ id: randomUUID(), propositionId, cueId: p.cues[0].id, rating, at, before, after: p.schedule, introduced, deckIds: introduced ? ['d'] : [], settings: structuredClone(s.settings) });
  });
}
function seed(store) {
  store.change(s => {
    s.decks.push({ id: 'd', name: 'Deck', propositionIds: ['p1', 'p2'], newLimit: 20 });
    for (const id of ['p1', 'p2']) s.propositions[id] = { id, origin: 'manual', name: id, statement: '', cues: [{ id: `${id}-c`, question: 'Q', answer: 'A' }], schedule: scheduler.createSchedule(), firstReviewedAt: null, learningCueId: null, version: 0 };
  });
}

test('each install appends its reviews to its own file; every install replays all of them into one schedule', t => {
  const { data, local } = installs(t);
  const a = openStore(data, { localDirectory: local('a') }); seed(a);
  const b = openStore(data, { localDirectory: local('b') });
  const day = 86400000, t0 = Date.UTC(2026, 10, 1, 12);
  rate(a, 'p1', 3, t0); rate(b, 'p1', 3, t0 + 2 * day); rate(a, 'p2', 1, t0 + day);
  const files = fs.readdirSync(path.join(data, 'reviews')).sort();
  assert.equal(files.length, 2, 'one review file per install');
  for (const f of files) assert.match(f, /^[a-z0-9]{12}\.jsonl$/);
  assert.ok(!Object.hasOwn(JSON.parse(fs.readFileSync(path.join(data, 'flashcards.json'), 'utf8')), 'reviews'), 'flashcards.json holds no reviews');
  const reopened = openStore(data, { localDirectory: local('a') }).get();
  assert.deepEqual(reopened.reviews.map(r => r.at), [t0, t0 + day, t0 + 2 * day], 'all installs, in time order');
  let expected = scheduler.createSchedule();
  expected = scheduler.rate(expected, 3, t0, reopened.settings); expected = scheduler.rate(expected, 3, t0 + 2 * day, reopened.settings);
  assert.deepEqual(reopened.propositions.p1.schedule, expected, 'p1 replays a\'s and b\'s reviews');
  assert.equal(reopened.propositions.p1.firstReviewedAt, t0);
  assert.deepEqual(openStore(data, { localDirectory: local('b') }).get().propositions, reopened.propositions, 'both installs agree');
});

test('replay keeps existing schedules when the settings did not change, and follows changed settings', t => {
  const { data, local } = installs(t);
  const a = openStore(data, { localDirectory: local('a') }); seed(a);
  const t0 = Date.UTC(2026, 10, 1, 12);
  rate(a, 'p1', 3, t0); rate(a, 'p1', 3, t0 + 86400000);
  const stored = structuredClone(a.get().propositions.p1);
  const bytes = fs.readFileSync(path.join(data, 'flashcards.json'), 'utf8');
  assert.deepEqual(openStore(data, { localDirectory: local('a') }).get().propositions.p1, stored);
  assert.equal(fs.readFileSync(path.join(data, 'flashcards.json'), 'utf8'), bytes, 'an unchanged store is not rewritten');
  a.change(s => { s.settings.retention = 0.97; });
  const replayed = openStore(data, { localDirectory: local('a') }).get().propositions.p1.schedule;
  assert.notDeepEqual(replayed, stored.schedule, 'the current retention applies to the whole history');
});

test('reviews in an older flashcards.json move to the install\'s file once, without duplicates across installs', t => {
  const { data, local } = installs(t);
  fs.mkdirSync(data, { recursive: true });
  const legacy = { version: 1, revision: 4, settings: { ...require('../src/store.cjs').defaults(), modelOverride: { provider: 'p', id: 'm' } }, decks: [], propositions: {}, batches: [],
    reviews: [{ id: 'r1', propositionId: 'gone', cueId: 'c', rating: 3, at: 5, question: 'Q', answer: 'A' }] };
  fs.writeFileSync(path.join(data, 'flashcards.json'), JSON.stringify(legacy));
  const a = openStore(data, { localDirectory: local('a') }).get();
  // The same old folder reached a second device before it synced: nothing is written twice.
  const b = openStore(data, { localDirectory: local('b') }).get();
  const lines = fs.readdirSync(path.join(data, 'reviews')).flatMap(f => fs.readFileSync(path.join(data, 'reviews', f), 'utf8').split('\n').filter(Boolean));
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { id: 'r1', propositionId: 'gone', cueId: 'c', rating: 3, at: 5 }, 'card text is not kept in reviews');
  assert.deepEqual(a.reviews, b.reviews);
  assert.equal(a.revision, 4, 'moving reviews is not a content change');
  // The model choice became a's own setting; b started from the same shared value.
  const shared = JSON.parse(fs.readFileSync(path.join(data, 'flashcards.json'), 'utf8'));
  assert.equal(Object.hasOwn(shared.settings, 'modelOverride'), false);
  assert.deepEqual(a.settings.modelOverride, { provider: 'p', id: 'm' });
  const again = openStore(data, { localDirectory: local('a') });
  again.change(s => { s.settings.modelOverride = { provider: 'p', id: 'other' }; });
  assert.deepEqual(openStore(data, { localDirectory: local('a') }).get().settings.modelOverride, { provider: 'p', id: 'other' });
  assert.equal(openStore(data, { localDirectory: local('c') }).get().settings.modelOverride, null, 'a new install has no model choice');
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(data, 'flashcards.json'), 'utf8')).settings, 'modelOverride'), false);
});

test('a torn or foreign review line is skipped', t => {
  const { data, local } = installs(t);
  const a = openStore(data, { localDirectory: local('a') }); seed(a);
  rate(a, 'p1', 3, Date.UTC(2026, 10, 1));
  fs.appendFileSync(path.join(data, 'reviews', 'other0000000.jsonl'), '{"id":"x","propositionId":"p1","cueId":"p1-c","rating":9,"at":1}\n{"id":"torn"');
  const s = openStore(data, { localDirectory: local('a') }).get();
  assert.equal(s.reviews.length, 2, 'the torn line is skipped');
  assert.equal(s.propositions.p1.schedule.reps, 1, 'a review with an invalid rating does not count');
});
