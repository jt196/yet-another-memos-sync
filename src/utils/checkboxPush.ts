/**
 * Bidirectional checkbox sync: push a checkbox toggled locally in a daily
 * note back to the memo it came from on the Memos server.
 *
 * This is deliberately narrow in scope: it only ever changes the checkbox
 * marker (`[ ]`/`[x]`) on a memo's first line, matching the fact that only
 * the first line's checkbox is ever surfaced into the daily note (see
 * memoTransformer.transformMemoToMarkdown). It never touches memo text,
 * tags, or any other field.
 */

import { APIClient, Memo } from '../types';

const CHECKBOX_RE = /^(\s*(?:>\s*)?-\s*)\[([ xX])\](.*)$/;

/**
 * Read the checkbox state off a block's first line. Returns undefined if
 * the line has no checkbox (nothing to sync for it).
 */
export function extractCheckboxState(firstLine: string): boolean | undefined {
  const match = firstLine.match(CHECKBOX_RE);
  if (!match) return undefined;
  return match[2].toLowerCase() === 'x';
}

/**
 * Return `content` with its first line's checkbox marker set to `checked`.
 * Leaves every other line, and the rest of the first line, untouched. If
 * the first line has no checkbox, `content` is returned unchanged.
 */
export function setFirstLineCheckboxState(content: string, checked: boolean): string {
  const lines = content.split('\n');
  const match = lines[0].match(CHECKBOX_RE);
  if (!match) return content;
  lines[0] = `${match[1]}[${checked ? 'x' : ' '}]${match[3]}`;
  return lines.join('\n');
}

export interface CheckboxPushPlan {
  // Timestamp -> the memo update to send.
  toPush: Map<string, { memo: Memo; checked: boolean }>;
  // Baseline entries to write regardless of whether anything was pushed -
  // bootstrapping new items and tracking remote-only changes.
  baselineUpdates: Map<string, boolean>;
}

/**
 * Diff local checkbox state against the last-known baseline and the
 * freshly-fetched remote state to decide what (if anything) needs pushing.
 * Pure and synchronous - no network calls - so it's easy to test in
 * isolation from the actual push.
 *
 * @param localBlocks   This day's existing local memo blocks, keyed by
 *                       timestamp (from parseExistingMemoBlocks, using the
 *                       file content as it was *before* this sync's pull
 *                       merges remote changes in).
 * @param rawMemosByTs   This day's freshly-fetched raw memos, keyed by
 *                       timestamp (from SimpleMemosPaginator).
 * @param baseline       Last-known-synced checkbox state per timestamp,
 *                       persisted across syncs (MemosSettings.checkboxBaselines).
 */
export function planCheckboxPushes(
  localBlocks: Map<string, string>,
  rawMemosByTs: Record<string, Memo>,
  baseline: Record<string, boolean>,
): CheckboxPushPlan {
  const toPush = new Map<string, { memo: Memo; checked: boolean }>();
  const baselineUpdates = new Map<string, boolean>();

  for (const [timestamp, block] of localBlocks) {
    const memo = rawMemosByTs[timestamp];
    if (!memo) continue; // deleted remotely, or outside this sync's window - handled elsewhere

    const localFirstLine = block.split('\n', 1)[0];
    const remoteFirstLine = memo.content.split('\n', 1)[0];
    const localChecked = extractCheckboxState(localFirstLine);
    const remoteChecked = extractCheckboxState(remoteFirstLine);
    if (localChecked === undefined || remoteChecked === undefined) continue; // not a checkbox line

    const baselineChecked = baseline[timestamp];
    if (baselineChecked === undefined) {
      // First time we've seen this item - bootstrap from remote rather than
      // pushing, so upgrading the plugin doesn't fire off a burst of pushes.
      baselineUpdates.set(timestamp, remoteChecked);
      continue;
    }

    const localChanged = localChecked !== baselineChecked;
    const remoteChanged = remoteChecked !== baselineChecked;

    if (!localChanged) {
      // Nothing to push. If remote moved on its own (e.g. toggled in the
      // Memos UI), just track the new baseline - the existing pull/merge
      // path already reconciles the note content for this case.
      if (remoteChanged) baselineUpdates.set(timestamp, remoteChecked);
      continue;
    }

    if (localChecked === remoteChecked) {
      // Both sides already agree (e.g. toggled the same way in both
      // places, or remote moved to match what local already was) -
      // nothing to send, just catch the baseline up.
      //
      // This is also why a true tug-of-war conflict can't happen here:
      // a checkbox only has two states, so if both local and remote moved
      // away from the same baseline, they can only have moved to the same
      // other state - which is exactly this branch, not a disagreement.
      baselineUpdates.set(timestamp, localChecked);
      continue;
    }

    toPush.set(timestamp, { memo, checked: localChecked });
  }

  return { toPush, baselineUpdates };
}

export interface CheckboxPushResult {
  pushed: number;
  failed: number;
  updatedBaseline: Record<string, boolean>;
}

/**
 * Execute a CheckboxPushPlan against the server and fold the results into
 * an updated baseline map. Baseline is only advanced for successful pushes
 * (and bootstrap/remote-only entries) - a failed push keeps its old
 * baseline so it's retried on the next sync rather than silently dropped.
 */
export async function executeCheckboxPushes(
  client: APIClient,
  plan: CheckboxPushPlan,
  baseline: Record<string, boolean>,
): Promise<CheckboxPushResult> {
  const updatedBaseline = { ...baseline };
  for (const [timestamp, checked] of plan.baselineUpdates) {
    updatedBaseline[timestamp] = checked;
  }

  let pushed = 0;
  let failed = 0;

  for (const [timestamp, { memo, checked }] of plan.toPush) {
    const name = memo.name ?? (memo.uid ? `memos/${memo.uid}` : undefined);
    if (!name) {
      console.warn(`Cannot push checkbox change for memo at ^${timestamp}: no name/uid on the fetched memo.`);
      failed += 1;
      continue;
    }
    try {
      const newContent = setFirstLineCheckboxState(memo.content, checked);
      await client.updateMemoContent(name, newContent);
      updatedBaseline[timestamp] = checked;
      pushed += 1;
    } catch (error) {
      console.error(`Failed to push checkbox change for ${name} (^${timestamp}):`, error);
      failed += 1;
    }
  }

  return { pushed, failed, updatedBaseline };
}
