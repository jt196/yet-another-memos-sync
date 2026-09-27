import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

function load(file) {
  const { outputFiles } = buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['obsidian'] });
  const module = { exports: {} };
  const nodeRequire = createRequire(import.meta.url);
  const stubbedRequire = (id) => (id === 'obsidian' ? { moment: nodeRequire('moment') } : nodeRequire(id));
  new Function('module', 'exports', 'require', outputFiles[0].text)(module, module.exports, stubbedRequire);
  return module.exports;
}

const { planContentPushes, executeContentPushes, hashContent } = load('src/utils/contentPush.ts');
const { parseExistingMemoBlocks, DailyNoteModifier } = load('src/utils/dailyNoteModifier.ts');
const { transformMemoToMarkdown } = load('src/utils/memoTransformer.ts');

const TS = 1726221600;
const opts = { useCalloutFormat: false, useListCalloutFormat: false, skipImages: false };

function memo(content, name = 'memos/x') {
  return { name, content, resources: [] };
}

function blockFor(content) {
  return transformMemoToMarkdown({ timestamp: TS, content, resources: [] }, false, false, false).content.trim();
}

test('bootstraps unseen items from remote instead of pushing', () => {
  const local = new Map([[String(TS), blockFor('hello')]]);
  const raw = { [TS]: memo('hello') };
  const plan = planContentPushes(local, raw, {}, opts);
  assert.equal(plan.toPush.size, 0);
  assert.equal(plan.conflicts.size, 0);
  assert.deepEqual([...plan.baselineUpdates], [[String(TS), hashContent('hello')]]);
});

test('pushes a local-only edit and advances baseline on success', async () => {
  const editedBlock = blockFor('hello').replace('hello', 'hello world');
  const local = new Map([[String(TS), editedBlock]]);
  const raw = { [TS]: memo('hello') };
  const baseline = { [TS]: hashContent('hello') };

  const plan = planContentPushes(local, raw, baseline, opts);
  assert.equal(plan.toPush.size, 1);
  assert.equal(plan.toPush.get(String(TS)).newContent, 'hello world');

  const calls = [];
  const client = { async updateMemoContent(name, content) { calls.push({ name, content }); return memo(content, name); } };
  const result = await executeContentPushes(client, plan, baseline);

  assert.equal(result.pushed, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(calls, [{ name: 'memos/x', content: 'hello world' }]);
  assert.equal(result.updatedBaseline[TS], hashContent('hello world'));
});

test('remote-only change advances baseline without pushing (pull/merge handles it)', () => {
  const local = new Map([[String(TS), blockFor('hello')]]); // unchanged locally
  const raw = { [TS]: memo('hello there') }; // changed remotely
  const baseline = { [TS]: hashContent('hello') };

  const plan = planContentPushes(local, raw, baseline, opts);
  assert.equal(plan.toPush.size, 0);
  assert.equal(plan.conflicts.size, 0);
  assert.deepEqual([...plan.baselineUpdates], [[String(TS), hashContent('hello there')]]);
});

test('both sides changed to the same content: no push, no conflict, baseline catches up', () => {
  const local = new Map([[String(TS), blockFor('hello world')]]);
  const raw = { [TS]: memo('hello world') };
  const baseline = { [TS]: hashContent('hello') };

  const plan = planContentPushes(local, raw, baseline, opts);
  assert.equal(plan.toPush.size, 0);
  assert.equal(plan.conflicts.size, 0);
  assert.deepEqual([...plan.baselineUpdates], [[String(TS), hashContent('hello world')]]);
});

test('both sides changed to DIFFERENT content: a real conflict, not silently resolved', () => {
  const local = new Map([[String(TS), blockFor('hello world')]]);
  const raw = { [TS]: memo('hello there') };
  const baseline = { [TS]: hashContent('hello') };

  const plan = planContentPushes(local, raw, baseline, opts);
  assert.equal(plan.toPush.size, 0);
  assert.equal(plan.baselineUpdates.size, 0);
  assert.equal(plan.conflicts.size, 1);
  const conflict = plan.conflicts.get(String(TS));
  assert.equal(conflict.localContent, 'hello world');
  assert.equal(conflict.remoteContent, 'hello there');
});

test('unreversible local blocks (multi-line, attachments) are skipped, never guessed at', () => {
  const local = new Map([[String(TS), blockFor('line one\nline two')]]);
  const raw = { [TS]: memo('line one\nline two') };
  const plan = planContentPushes(local, raw, {}, opts);
  assert.equal(plan.toPush.size, 0);
  assert.equal(plan.baselineUpdates.size, 0);
  assert.equal(plan.conflicts.size, 0);
});

test('a failed push leaves the baseline untouched so it retries next sync', async () => {
  const editedBlock = blockFor('hello').replace('hello', 'hello world');
  const local = new Map([[String(TS), editedBlock]]);
  const raw = { [TS]: memo('hello') };
  const baseline = { [TS]: hashContent('hello') };

  const plan = planContentPushes(local, raw, baseline, opts);
  const client = { async updateMemoContent() { throw new Error('network down'); } };
  const result = await executeContentPushes(client, plan, baseline);

  assert.equal(result.pushed, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.updatedBaseline[TS], hashContent('hello')); // unchanged
});

test('bug: with the old blanket checkbox preservation, a remote-only uncheck never reaches the note', () => {
  // Reproduces the exact scenario reported live: local was checked (and
  // matches baseline - the user made no local edit this sync), the memo
  // was then unchecked on the server, but the note stayed checked forever
  // because mergeTodoStates always re-imposed local's checkbox by text
  // match, regardless of which side actually changed.
  const header = '## Memos';
  const checkedBlock = blockFor('- [x] Gout. Medical issue');
  const uncheckedRemote = transformMemoToMarkdown({ timestamp: TS, content: '- [ ] Gout. Medical issue', resources: [] }, false, false, false).content.trim();
  const note = `${header}\n\n${checkedBlock}\n`;

  const modifier = new DailyNoteModifier(header);
  const defaultResult = modifier.modifyDailyNote(note, '2026-01-01', { [String(TS)]: uncheckedRemote });
  assert.equal(defaultResult, undefined); // "no update needed" - the bug: remote's uncheck is silently dropped

  // Passing this timestamp in trustRemoteTimestamps (what contentPush.ts
  // computes once it's successfully reasoned about an item) is what fixes it.
  const trustedResult = modifier.modifyDailyNote(note, '2026-01-01', { [String(TS)]: uncheckedRemote }, new Set([String(TS)]));
  assert.ok(trustedResult.includes('- [ ]')); // remote's uncheck now lands locally
  assert.ok(!trustedResult.includes('[x]'));
  assert.ok(trustedResult.includes('Gout. Medical issue'));
});

test('a timestamp NOT in trustRemoteTimestamps still gets the old text-preservation safety net (e.g. multi-line memos contentPush cannot reach)', () => {
  const header = '## Memos';
  const checkedBlock = blockFor('- [x] Gout. Medical issue');
  const uncheckedRemote = transformMemoToMarkdown({ timestamp: TS, content: '- [ ] Gout. Medical issue', resources: [] }, false, false, false).content.trim();
  const note = `${header}\n\n${checkedBlock}\n`;

  const modifier = new DailyNoteModifier(header);
  // Empty trustRemoteTimestamps (the default) - as if contentPush.ts skipped
  // this item entirely (multi-line/attachments/unparseable).
  const result = modifier.modifyDailyNote(note, '2026-01-01', { [String(TS)]: uncheckedRemote }, new Set());
  assert.equal(result, undefined); // local's checked state is preserved, exactly as before this feature existed
});

test('parseExistingMemoBlocks + planContentPushes work together against a real daily-note section', () => {
  const block1 = blockFor('Ser radio');
  const editedBlock1 = block1.replace('Ser radio', 'Ser radio (fixed)');
  const block2 = transformMemoToMarkdown({ timestamp: TS + 100, content: 'the twelve factor app', resources: [] }, false, false, false).content.trim();
  const section = `${editedBlock1}\n${block2}`;

  const blocks = parseExistingMemoBlocks(section);
  assert.equal(blocks.size, 2);

  const raw = {
    [TS]: memo('Ser radio'),
    [TS + 100]: memo('the twelve factor app'),
  };
  const baseline = { [TS]: hashContent('Ser radio'), [TS + 100]: hashContent('the twelve factor app') };
  const plan = planContentPushes(blocks, raw, baseline, opts);
  assert.deepEqual([...plan.toPush.keys()], [String(TS)]);
  assert.equal(plan.toPush.get(String(TS)).newContent, 'Ser radio (fixed)');
});
