'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const scheduler = require('./scheduler.cjs');

function atomicWrite(file, content) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, content); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function appendLines(file, lines) {
  if (!lines.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, 'a', 0o600);
  try { fs.writeFileSync(fd, lines.map(line => `${JSON.stringify(line)}\n`).join('')); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
// Keep retry receipts separate from card text so deletion can be physical.
// Generation output limit per chunk (owner, 2026-11-14): 32768 tokens, so a
// thinking model can reason and still submit its result.
const DEFAULT_OUTPUT_BUDGET = 32768;
// Model choices belong to one device: they live in ctx.localDataDirectory,
// never in the shared flashcards.json (multi-device, owner 2026-11-18).
const LOCAL_SETTINGS = ['modelOverride', 'thinkingOverride'];
const INSTALL_ID = /^[a-z0-9]{12}$/;

function migrate(state) {
  let changed = false;
  if (!Object.hasOwn(state.settings, 'outputBudget')) { state.settings.outputBudget = DEFAULT_OUTPUT_BUDGET; changed = true; }
  for (const p of Object.values(state.propositions)) {
    for (const cue of p.cues) if (cue.creation) {
      state.creationReceipts ??= [];
      if (!state.creationReceipts.some(r => r.requestId === cue.creation.requestId)) state.creationReceipts.push({ ...cue.creation, propositionId: p.id, cueId: cue.id });
      delete cue.creation; changed = true;
    }
    const active = p.cues.filter(c => !c.deleted);
    if (active.length !== p.cues.length || !active.length) {
      changed = true;
      if (active.length) {
        p.cues = active; p.version++;
        if (!active.some(c => c.id === p.learningCueId)) p.learningCueId = null;
      } else {
        delete state.propositions[p.id];
        for (const d of state.decks) d.propositionIds = d.propositionIds.filter(id => id !== p.id);
      }
    }
  }
  // Older deck-only deletion could leave an upload record that recreated the
  // deleted deck. Source assets now belong strictly to an existing deck.
  for (const source of Object.values(state.fileSources ?? {})) if (!state.decks.some(d => d.id === source.deckId)) {
    delete state.fileSources[source.id];
    state.pendingSourceRemovals ??= [];
    if (!state.pendingSourceRemovals.includes(source.id)) state.pendingSourceRemovals.push(source.id);
    changed = true;
  }
  return changed;
}
// Ratings/timing/schedule snapshots suffice for statistics and retry receipts.
function stripReview(review) {
  const r = { ...review };
  delete r.question; delete r.answer;
  if (r.settings) { r.settings = { ...r.settings }; for (const key of LOCAL_SETTINGS) delete r.settings[key]; }
  return r;
}
const byTime = (a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Rebuilds every reviewed proposition's schedule from all installs' reviews, in time
 * order, with the current settings (owner, 2026-11-18). Reviews from several devices
 * then give one schedule on every device, whatever order they arrived in.
 */
function replay(state) {
  let changed = false;
  const byProposition = new Map();
  for (const r of state.reviews) {
    if (!Object.hasOwn(state.propositions, r.propositionId)) continue;
    const list = byProposition.get(r.propositionId) ?? [];
    list.push(r); byProposition.set(r.propositionId, list);
  }
  for (const [id, reviews] of byProposition) {
    const p = state.propositions[id];
    let schedule = scheduler.createSchedule(), learningCueId = null;
    const latest = new Map();
    for (const r of reviews) {
      try { schedule = scheduler.rate(schedule, r.rating, r.at, state.settings); }
      catch { continue; } // a malformed review from another device does not stop the others
      const active = p.cues.some(c => c.id === r.cueId && !c.deleted);
      learningCueId = [1, 3].includes(schedule.state) && active ? r.cueId : null;
      latest.set(r.cueId, r);
    }
    const firstReviewedAt = reviews[0].at;
    let touched = false;
    if (!same(p.schedule, schedule)) { p.schedule = schedule; touched = true; }
    if (p.learningCueId !== learningCueId) { p.learningCueId = learningCueId; touched = true; }
    if (p.firstReviewedAt !== firstReviewedAt) { p.firstReviewedAt = firstReviewedAt; touched = true; }
    for (const c of p.cues) {
      const r = latest.get(c.id);
      if (r && (c.latestRating !== r.rating || c.lastReviewedAt !== r.at)) { c.latestRating = r.rating; c.lastReviewedAt = r.at; touched = true; }
    }
    // Replay runs when the store opens, before any review ticket exists, so versions stay.
    if (touched) changed = true;
  }
  return changed;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
/** This install's id, kept device-local. Without a local folder (an older host) there is one install. */
function installId(localDirectory) {
  if (!localDirectory) return 'local000000';
  const file = path.join(localDirectory, 'install.json');
  const existing = readJson(file);
  if (existing && INSTALL_ID.test(existing.id)) return existing.id;
  const id = randomUUID().replace(/-/g, '').slice(0, 12);
  fs.mkdirSync(localDirectory, { recursive: true, mode: 0o700 });
  atomicWrite(file, JSON.stringify({ id }));
  return id;
}
/** Every install's reviews (reviews/<install>.jsonl), each read line by line; a torn line is skipped. */
function readReviews(directory) {
  const dir = path.join(directory, 'reviews');
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => /^[A-Za-z0-9_][A-Za-z0-9._-]*\.jsonl$/.test(n)).sort(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const out = new Map();
  for (const name of names) for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r && typeof r.id === 'string' && typeof r.propositionId === 'string' && Number.isFinite(r.at) && !out.has(r.id)) out.set(r.id, r);
  }
  return out;
}

const defaults = () => ({ retention: 0.9, learningSteps: [1, 10], relearningSteps: [10], dayStart: 4, fuzz: false, chunkBudget: 4000, outputBudget: DEFAULT_OUTPUT_BUDGET, modelOverride: null });
function openStore(directory, options = {}) {
  fs.mkdirSync(directory, { recursive: true });
  const localDirectory = options.localDirectory ?? null;
  const file = path.join(directory, 'flashcards.json');
  const ownReviews = path.join(directory, 'reviews', `${installId(localDirectory)}.jsonl`);
  const localSettingsFile = localDirectory ? path.join(localDirectory, 'settings.json') : null;
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Could not read Flashcards data: ${error.message}`);
    state = { version: 1, revision: 0, settings: defaults(), decks: [], propositions: {}, batches: [] };
  }
  if (state.version !== 1 || !Number.isSafeInteger(state.revision) || !Array.isArray(state.decks) || (state.reviews !== undefined && !Array.isArray(state.reviews)) || !Array.isArray(state.batches) || !state.propositions || !state.settings) throw new Error('Unsupported or invalid Flashcards data. No data was changed.');

  // Reviews: one append-only file per install. Reviews still inside an older
  // flashcards.json move to this install's file once; ids that another install
  // already wrote (a folder copied between devices) are not written twice.
  const reviews = readReviews(directory);
  const legacy = (state.reviews ?? []).map(stripReview).filter(r => !reviews.has(r.id));
  appendLines(ownReviews, legacy);
  for (const r of legacy) reviews.set(r.id, r);
  let formatChanged = state.reviews !== undefined;

  // Device-local settings: an older shared value becomes this device's own once.
  let local = localSettingsFile ? readJson(localSettingsFile) : null;
  if (localSettingsFile && !local) {
    local = Object.fromEntries(LOCAL_SETTINGS.filter(k => Object.hasOwn(state.settings, k) && state.settings[k] != null).map(k => [k, state.settings[k]]));
    atomicWrite(localSettingsFile, JSON.stringify(local));
  }
  const shared = { ...state.settings };
  if (localSettingsFile) for (const key of LOCAL_SETTINGS) if (Object.hasOwn(shared, key)) { delete shared[key]; formatChanged = true; }

  state = { ...state, settings: { ...shared, modelOverride: null, ...(local ?? {}), ...(localSettingsFile ? {} : pick(state.settings)) }, reviews: [...reviews.values()].sort(byTime) };
  if (state.settings.thinkingOverride == null) delete state.settings.thinkingOverride;

  const migrated = structuredClone(state);
  const changed = migrate(migrated);
  const replayed = replay(migrated);
  if (changed) migrated.revision++;
  let persistedReviews = new Set(migrated.reviews.map(r => r.id));
  let persistedLocal = JSON.stringify(localPart(migrated.settings));
  if (changed || replayed || formatChanged) atomicWrite(file, JSON.stringify(sharedPart(migrated)));
  state = migrated;

  function pick(settings) { return Object.fromEntries(LOCAL_SETTINGS.filter(k => Object.hasOwn(settings, k)).map(k => [k, settings[k]])); }
  function localPart(settings) { return Object.fromEntries(LOCAL_SETTINGS.filter(k => settings[k] != null).map(k => [k, settings[k]])); }
  function sharedPart(s) {
    const out = { ...s, settings: { ...s.settings } };
    delete out.reviews;
    if (localSettingsFile) for (const key of LOCAL_SETTINGS) delete out.settings[key];
    return out;
  }
  function persist(next) {
    // Reviews first: if writing flashcards.json then fails, the next start replays them.
    const fresh = next.reviews.filter(r => !persistedReviews.has(r.id)).map(stripReview);
    appendLines(ownReviews, fresh);
    if (localSettingsFile) {
      const l = JSON.stringify(localPart(next.settings));
      if (l !== persistedLocal) { atomicWrite(localSettingsFile, l); persistedLocal = l; }
    }
    atomicWrite(file, JSON.stringify(sharedPart(next)));
    persistedReviews = new Set(next.reviews.map(r => r.id));
  }

  const sourceFile = id => {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid file source ID.');
    return path.join(directory, 'sources', `${id}.md`);
  };
  return {
    get: () => state,
    writeSource(id, markdown) { const file = sourceFile(id); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); atomicWrite(file, markdown); },
    readSource(id) { return fs.readFileSync(sourceFile(id), 'utf8'); },
    removeSource(id) { try { fs.unlinkSync(sourceFile(id)); } catch (error) { if (error.code !== 'ENOENT') throw error; } },
    change(update) {
      const next = structuredClone(state);
      const result = update(next);
      next.revision++;
      persist(next);
      state = next;
      return result;
    },
  };
}
module.exports = { openStore, defaults, replay };
