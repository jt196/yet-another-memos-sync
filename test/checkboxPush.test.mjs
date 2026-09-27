import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

function load(file) {
  const { outputFiles } = buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', write: false });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', outputFiles[0].text)(module, module.exports, createRequire(import.meta.url));
  return module.exports;
}

const { extractCheckboxState, setFirstLineCheckboxState, planCheckboxPushes, executeCheckboxPushes } = load('src/utils/checkboxPush.ts');
const { parseExistingMemoBlocks } = load('src/utils/dailyNoteModifier.ts');

function memo(name, content) {
  return { name, content };
}

test('extractCheckboxState reads the marker or returns undefined for non-checkbox lines', () => {
  assert.equal(extractCheckboxState('- [ ] todo'), false);
  assert.equal(extractCheckboxState('- [x] done'), true);
  assert.equal(extractCheckboxState('- [X] done'), true);
  assert.equal(extractCheckboxState('  - [ ] indented'), false);
  assert.equal(extractCheckboxState('> [!info] callout'), undefined);
  assert.equal(extractCheckboxState('just text'), undefined);
});

test('setFirstLineCheckboxState only touches the first line\'s marker', () => {
  const content = '- [ ] task text\n  continuation\n- [ ] not this one';
  assert.equal(
    setFirstLineCheckboxState(content, true),
    '- [x] task text\n  continuation\n- [ ] not this one',
  );
  // No checkbox on the first line: left alone.
  assert.equal(setFirstLineCheckboxState('no checkbox here', true), 'no checkbox here');
});

test('planCheckboxPushes bootstraps unseen items from remote instead of pushing', () => {
  const local = new Map([['100', '- [x] 🌅 09:00 task #daily-record ^100']]);
  const raw = { 100: memo('memos/a', '- [ ] task') };
  const plan = planCheckboxPushes(local, raw, {});
  assert.equal(plan.toPush.size, 0);
  assert.deepEqual([...plan.baselineUpdates], [['100', false]]);
});

test('planCheckboxPushes pushes a local-only change and advances baseline on success', async () => {
  const local = new Map([['100', '- [x] 🌅 09:00 task #daily-record ^100']]);
  const raw = { 100: memo('memos/a', '- [ ] task') };
  const baseline = { 100: false };

  const plan = planCheckboxPushes(local, raw, baseline);
  assert.equal(plan.toPush.size, 1);

  const calls = [];
  const client = { async updateMemoContent(name, content) { calls.push({ name, content }); return memo(name, content); } };
  const result = await executeCheckboxPushes(client, plan, baseline);

  assert.equal(result.pushed, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(calls, [{ name: 'memos/a', content: '- [x] task' }]);
  assert.equal(result.updatedBaseline['100'], true);
});

test('planCheckboxPushes does nothing when local matches baseline (remote-only change, handled by the pull merge)', () => {
  const local = new Map([['100', '- [ ] 🌅 09:00 task #daily-record ^100']]);
  const raw = { 100: memo('memos/a', '- [x] task') }; // toggled remotely
  const baseline = { 100: false };

  const plan = planCheckboxPushes(local, raw, baseline);
  assert.equal(plan.toPush.size, 0);
  assert.deepEqual([...plan.baselineUpdates], [['100', true]]);
});

test('planCheckboxPushes treats both sides changing the same way as already in sync, not a push', () => {
  // A checkbox only has two states, so if local and remote both moved away
  // from the same baseline, they can only have moved to the same other
  // state - e.g. checked in Obsidian and also checked via the Memos app
  // before this sync ran. That's agreement, not a conflict: nothing to
  // push, just catch the baseline up.
  const local = new Map([['100', '- [x] 🌅 09:00 task #daily-record ^100']]);
  const raw = { 100: memo('memos/a', '- [x] task') };
  const baseline = { 100: false };

  const plan = planCheckboxPushes(local, raw, baseline);
  assert.equal(plan.toPush.size, 0);
  assert.deepEqual([...plan.baselineUpdates], [['100', true]]);
});

test('planCheckboxPushes skips items missing from the fetch window or without a checkbox', () => {
  const local = new Map([
    ['100', '- [x] 🌅 09:00 not fetched #daily-record ^100'],
    ['200', '- 🌅 09:05 plain memo, no checkbox #daily-record ^200'],
  ]);
  const raw = { 200: memo('memos/b', 'plain memo, no checkbox') }; // 100 missing (outside window/deleted)
  const plan = planCheckboxPushes(local, raw, {});
  assert.equal(plan.toPush.size, 0);
  assert.equal(plan.baselineUpdates.size, 0);
});

test('parseExistingMemoBlocks + planCheckboxPushes work together against a real daily-note section', () => {
  const section = '- [x] 🌅 09:28 Ser radio #daily-record ^1790152101\n- [ ] ☀️ 14:03 the twelve factor app #daily-record ^1790168631';
  const blocks = parseExistingMemoBlocks(section);
  assert.equal(blocks.size, 2);

  const raw = {
    1790152101: memo('memos/x', '- [ ] Ser radio'), // checked locally, still unchecked remotely
    1790168631: memo('memos/y', '- [ ] the twelve factor app'), // unchanged either side
  };
  const plan = planCheckboxPushes(blocks, raw, { 1790152101: false, 1790168631: false });
  assert.deepEqual([...plan.toPush.keys()], ['1790152101']);
  assert.equal(plan.toPush.get('1790152101').checked, true);
});
