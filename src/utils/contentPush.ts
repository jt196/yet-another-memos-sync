/**
 * Bidirectional content sync: push a memo's text (checkbox state included -
 * a checkbox toggle is just a one-character content change) back to the
 * server when it's been edited locally, using a per-memo baseline to tell
 * "changed locally since last sync" apart from "this is just what we last
 * pulled". See memoReverseTransform.ts for how local text is recovered.
 *
 * Unlike the checkbox-only version this replaces, a genuine conflict is
 * reachable here: content has effectively unlimited possible states, so
 * local and remote can both change since the same baseline to two
 * different values (impossible with a two-state checkbox). Those are
 * reported separately for the caller to resolve interactively rather than
 * silently picking a side.
 */

import { APIClient, Memo } from '../types';
import { reverseTransformBlock, ReverseTransformOptions } from './memoReverseTransform';

// Baseline only ever needs to answer "did this change since last sync?",
// never to reconstruct content, so a cheap non-cryptographic hash is fine
// here and keeps settings.json from carrying a second copy of every memo.
export function hashContent(content: string): string {
  let h = 0;
  for (let i = 0; i < content.length; i++) {
    h = (h * 31 + content.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

export interface ContentConflict {
  memo: Memo;
  localContent: string;
  remoteContent: string;
}

export interface ContentPushPlan {
  toPush: Map<string, { memo: Memo; newContent: string }>;
  // Baseline entries to write regardless of whether anything was pushed -
  // bootstrapping new items and tracking remote-only changes.
  baselineUpdates: Map<string, string>;
  conflicts: Map<string, ContentConflict>;
}

/**
 * Diff local content against the last-known baseline and the
 * freshly-fetched remote content to decide what needs pushing, and what's
 * a genuine conflict needing interactive resolution. Pure and synchronous.
 *
 * @param localBlocks   This day's existing local memo blocks, keyed by
 *                       timestamp (from parseExistingMemoBlocks, using the
 *                       file content as it was *before* this sync's pull
 *                       merges remote changes in).
 * @param rawMemosByTs   This day's freshly-fetched raw memos, keyed by
 *                       timestamp (from SimpleMemosPaginator).
 * @param baseline       Last-known-synced content hash per timestamp,
 *                       persisted across syncs (MemosSettings.contentBaselines).
 */
export function planContentPushes(
  localBlocks: Map<string, string>,
  rawMemosByTs: Record<string, Memo>,
  baseline: Record<string, string>,
  opts: ReverseTransformOptions,
): ContentPushPlan {
  const toPush = new Map<string, { memo: Memo; newContent: string }>();
  const baselineUpdates = new Map<string, string>();
  const conflicts = new Map<string, ContentConflict>();

  for (const [timestampStr, block] of localBlocks) {
    const memo = rawMemosByTs[timestampStr];
    if (!memo) continue; // deleted remotely, or outside this sync's window

    const localContent = reverseTransformBlock(block, memo, Number(timestampStr), opts);
    if (localContent === undefined) continue; // can't safely reverse - see memoReverseTransform.ts

    const remoteContent = memo.content;
    const localHash = hashContent(localContent);
    const remoteHash = hashContent(remoteContent);
    const baselineHash = baseline[timestampStr];

    if (baselineHash === undefined) {
      // First time we've seen this item - bootstrap from remote rather than
      // pushing, so enabling this on an existing vault doesn't fire off a
      // burst of pushes for content that was never actually edited locally.
      baselineUpdates.set(timestampStr, remoteHash);
      continue;
    }

    const localChanged = localHash !== baselineHash;
    const remoteChanged = remoteHash !== baselineHash;

    if (!localChanged) {
      // Nothing to push. If remote moved on its own, just track the new
      // baseline - the existing pull/merge path already handles this case.
      if (remoteChanged) baselineUpdates.set(timestampStr, remoteHash);
      continue;
    }

    if (localHash === remoteHash) {
      // Both sides changed but ended up agreeing - nothing to send, just
      // catch the baseline up.
      baselineUpdates.set(timestampStr, localHash);
      continue;
    }

    if (!remoteChanged) {
      toPush.set(timestampStr, { memo, newContent: localContent });
      continue;
    }

    // Both changed since baseline, to different content - a genuine
    // conflict (possible here, unlike with a two-state checkbox).
    conflicts.set(timestampStr, { memo, localContent, remoteContent });
  }

  return { toPush, baselineUpdates, conflicts };
}

export interface ContentPushResult {
  pushed: number;
  failed: number;
  updatedBaseline: Record<string, string>;
}

/**
 * Execute a plan's non-conflicting pushes against the server. Baseline is
 * only advanced for successful pushes (and bootstrap/remote-only entries) -
 * a failed push keeps its old baseline so it's retried next sync rather
 * than silently dropped. Conflicts are the caller's responsibility (they
 * need interactive resolution - see ConflictResolutionModal) and are not
 * touched here.
 */
export async function executeContentPushes(
  client: APIClient,
  plan: ContentPushPlan,
  baseline: Record<string, string>,
): Promise<ContentPushResult> {
  const updatedBaseline = { ...baseline };
  for (const [timestamp, hash] of plan.baselineUpdates) {
    updatedBaseline[timestamp] = hash;
  }

  let pushed = 0;
  let failed = 0;

  for (const [timestamp, { memo, newContent }] of plan.toPush) {
    const name = memo.name ?? (memo.uid ? `memos/${memo.uid}` : undefined);
    if (!name) {
      console.warn(`Cannot push content change for memo at ^${timestamp}: no name/uid on the fetched memo.`);
      failed += 1;
      continue;
    }
    try {
      await client.updateMemoContent(name, newContent);
      updatedBaseline[timestamp] = hashContent(newContent);
      pushed += 1;
    } catch (error) {
      console.error(`Failed to push content change for ${name} (^${timestamp}):`, error);
      failed += 1;
    }
  }

  return { pushed, failed, updatedBaseline };
}
