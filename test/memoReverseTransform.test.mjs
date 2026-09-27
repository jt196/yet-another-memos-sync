import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

function load(file) {
  const { outputFiles } = buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['obsidian'] });
  const module = { exports: {} };
  const nodeRequire = createRequire(import.meta.url);
  // 'obsidian' isn't an npm package - it's the plugin host's runtime API.
  // Stub just enough of it (moment) for memoTransformer.ts's needs outside Obsidian.
  const stubbedRequire = (id) => (id === 'obsidian' ? { moment: nodeRequire('moment') } : nodeRequire(id));
  new Function('module', 'exports', 'require', outputFiles[0].text)(module, module.exports, stubbedRequire);
  return module.exports;
}

const { reverseTransformBlock } = load('src/utils/memoReverseTransform.ts');
const { transformMemoToMarkdown } = load('src/utils/memoTransformer.ts');

const TS = 1726221600; // fixed timestamp so rendering is deterministic across tests
const plainOpts = { useCalloutFormat: false, useListCalloutFormat: false, skipImages: false };
const calloutOpts = { useCalloutFormat: true, useListCalloutFormat: false, skipImages: false };

function memo(content, extra = {}) {
  return { name: 'memos/x', content, resources: [], ...extra };
}

test('plain format: recovers a simple single-line edit', () => {
  const block = transformMemoToMarkdown({ timestamp: TS, content: 'Buy milk', resources: [] }, false, false, false).content.trim();
  // Simulate the user editing the visible text in Obsidian.
  const editedBlock = block.replace('Buy milk', 'Buy bread');
  const recovered = reverseTransformBlock(editedBlock, memo('Buy milk'), TS, plainOpts);
  assert.equal(recovered, 'Buy bread');
});

test('plain format: recovers a checkbox toggle plus a text edit together', () => {
  const block = transformMemoToMarkdown({ timestamp: TS, content: '- [ ] Buy milk', resources: [] }, false, false, false).content.trim();
  const editedBlock = block.replace('[ ]', '[x]').replace('Buy milk', 'Buy oat milk');
  const recovered = reverseTransformBlock(editedBlock, memo('- [ ] Buy milk'), TS, plainOpts);
  assert.equal(recovered, '- [x] Buy oat milk');
});

test('callout format: recovers a single-line edit', () => {
  const block = transformMemoToMarkdown({ timestamp: TS, content: 'Buy milk', resources: [] }, true, false, false).content.trim();
  const editedBlock = block.replace('Buy milk', 'Buy bread');
  const recovered = reverseTransformBlock(editedBlock, memo('Buy milk'), TS, calloutOpts);
  assert.equal(recovered, 'Buy bread');
});

test('List Callout format is never attempted, even with an unmodified block', () => {
  const opts = { useCalloutFormat: false, useListCalloutFormat: true, skipImages: false };
  const block = transformMemoToMarkdown({ timestamp: TS, content: 'Buy milk', resources: [] }, false, true, false).content.trim();
  assert.equal(reverseTransformBlock(block, memo('Buy milk'), TS, opts), undefined);
});

test('multi-line memo content is not attempted', () => {
  const block = transformMemoToMarkdown({ timestamp: TS, content: 'line one\nline two', resources: [] }, false, false, false).content.trim();
  assert.equal(reverseTransformBlock(block, memo('line one\nline two'), TS, plainOpts), undefined);
});

test('a memo with attachments is not attempted', () => {
  const block = transformMemoToMarkdown({ timestamp: TS, content: 'Buy milk', resources: [] }, false, false, false).content.trim();
  const withResource = memo('Buy milk', { resources: [{ id: 'r1', filename: 'a.png', type: 'image/png' }] });
  assert.equal(reverseTransformBlock(block, withResource, TS, plainOpts), undefined);
});

test('a block that no longer matches the expected decoration is rejected, not guessed at', () => {
  // Wrong timestamp relative to the block's actual decoration - prefix/suffix won't line up.
  const block = transformMemoToMarkdown({ timestamp: TS, content: 'Buy milk', resources: [] }, false, false, false).content.trim();
  const recovered = reverseTransformBlock(block, memo('Buy milk'), TS + 3600, plainOpts);
  assert.equal(recovered, undefined);
});

test('editing text so it happens to contain the literal tag/blockref text is still rejected safely', () => {
  const block = transformMemoToMarkdown({ timestamp: TS, content: 'Buy milk', resources: [] }, false, false, false).content.trim();
  // Insert extra text right before the trailing " #daily-record ^TS" suffix, breaking the
  // expected boundary - must not be silently accepted as if nothing changed structurally.
  const tamperedBlock = block.replace(` #daily-record ^${TS}`, ` extra #daily-record ^${TS}x`);
  const recovered = reverseTransformBlock(tamperedBlock, memo('Buy milk'), TS, plainOpts);
  assert.equal(recovered, undefined);
});
