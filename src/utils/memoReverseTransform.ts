/**
 * Recover the raw memo content that would produce a given local daily-note
 * block, so a text edit made in Obsidian can be pushed back to the memo it
 * came from.
 *
 * This is the inverse of memoTransformer.transformMemoToMarkdown, which is
 * NOT losslessly invertible in general: List Callout format merges every
 * line into one with spaces (permanently destroying line breaks), blank
 * lines inside multi-line content are dropped on the way in, and resource
 * embeds are appended lines that aren't part of `content` at all.
 *
 * Rather than trying to handle every case, this only ever succeeds for the
 * common case - a single-line memo, no attachments - and *proves* it got
 * the right answer by rendering the candidate content back through the
 * same forward transform and requiring an exact match against the local
 * block. Anything it can't confidently reverse returns undefined, which
 * callers must treat as "skip this one, don't push" - never guess.
 */

import { Memo } from '../types';
import { transformMemoToMarkdown } from './memoTransformer';

export interface ReverseTransformOptions {
  useCalloutFormat: boolean;
  useListCalloutFormat: boolean;
  skipImages: boolean;
}

// Unlikely to collide with real memo text; used to locate exactly where
// content-derived text lands inside the rendered block, independent of
// what that text actually is.
const SENTINEL = '\u0000YAMS-SENTINEL\u0000';

function render(content: string, timestamp: number, opts: ReverseTransformOptions): string {
  return transformMemoToMarkdown(
    { timestamp, content, resources: [] },
    opts.useCalloutFormat,
    false, // useListCalloutFormat - never used here, see module doc
    opts.skipImages,
  ).content.trim();
}

export function reverseTransformBlock(
  block: string,
  memo: Memo,
  timestamp: number,
  opts: ReverseTransformOptions,
): string | undefined {
  if (opts.useListCalloutFormat) return undefined; // irreversible - see module doc
  if (memo.content.trim().includes('\n')) return undefined; // v1: single-line memos only
  if ((memo.resources ?? memo.attachments ?? memo.resourceList ?? []).length > 0) return undefined; // v1: no attachments

  // Plain/list format repositions a leading checkbox marker relative to the
  // emoji/time prefix (see transformMemoToMarkdown's taskMatch handling);
  // callout format doesn't touch it at all. Only build the checkbox-shaped
  // template when it's actually needed, using whatever character block
  // currently has, so the rendered prefix can line up with it exactly.
  const checkboxMatch = !opts.useCalloutFormat ? block.match(/^-\s*\[([ xX])\]\s/) : null;
  const sentinelContent = checkboxMatch ? `- [${checkboxMatch[1]}] ${SENTINEL}` : SENTINEL;

  const rendered = render(sentinelContent, timestamp, opts);
  const sentinelIndex = rendered.indexOf(SENTINEL);
  if (sentinelIndex === -1) return undefined;

  const prefix = rendered.slice(0, sentinelIndex);
  const suffix = rendered.slice(sentinelIndex + SENTINEL.length);
  if (!block.startsWith(prefix) || !block.endsWith(suffix)) return undefined;

  const middle = block.slice(prefix.length, block.length - suffix.length);
  if (middle.includes('\n')) return undefined; // derived content must itself be single-line

  const candidateContent = sentinelContent.replace(SENTINEL, middle);

  // The proof: only trust the candidate if forward-transforming it
  // reproduces the local block exactly.
  if (render(candidateContent, timestamp, opts) !== block) return undefined;

  return candidateContent;
}
