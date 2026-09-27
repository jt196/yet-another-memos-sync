/**
 * Daily Note Modifier - handles updating daily notes with memos
 */

import { mergeTodoStates, isSameExceptTodoStates } from './todoStateManager';

import { headingTitle, markdownHeadings } from './markdownSections';

export interface HeaderSection {
  prefix: string;
  suffix: string;
  localRecordContent: string;
}

/**
 * Locate the single heading matching `header` in `content` and split the
 * file around the section it owns (from the heading to the next heading of
 * the same or shallower level, or EOF). Returns undefined if the heading
 * isn't found exactly once.
 */
export function findHeaderSection(content: string, header: string): HeaderSection | undefined {
  const headings = markdownHeadings(content);
  const level = header.trim().match(/^(#{1,6})\s/)?.[1].length ?? 1;
  const matches = headings.filter(h => h.level === level && h.title === headingTitle(header));
  if (matches.length !== 1) return undefined;

  const section = matches[0];
  const from = section.end;
  const to = headings.find(h => h.start >= from)?.start ?? content.length;
  return {
    prefix: content.slice(0, from),
    suffix: content.slice(to),
    localRecordContent: content.slice(from, to).trim(),
  };
}

/**
 * Parse a header section's body into per-memo blocks keyed by the memo's
 * `^timestamp` block ref. Each block is the full local line(s) for that
 * memo (checkbox marker, text, any indented continuation lines).
 */
export function parseExistingMemoBlocks(localRecordContent: string): Map<string, string> {
  const existingMemos = new Map<string, string>();
  if (!localRecordContent) return existingMemos;

  const memoRegex = /\^(\d+)/g;
  let match;
  while ((match = memoRegex.exec(localRecordContent)) !== null) {
    const timestamp = match[1];
    const memoStartIndex = localRecordContent.lastIndexOf('\n', match.index);
    const memoEndIndex = localRecordContent.indexOf('\n- ', match.index);
    const fullMemoEndIndex = localRecordContent.indexOf('\n\n', match.index);

    let memoEnd = memoEndIndex !== -1 ? memoEndIndex : fullMemoEndIndex;
    if (memoEnd === -1) memoEnd = localRecordContent.length;

    const memoStart = memoStartIndex !== -1 ? memoStartIndex + 1 : 0;
    const memoContent = localRecordContent.slice(memoStart, memoEnd).trim();

    if (memoContent) {
      existingMemos.set(timestamp, memoContent);
    }
  }
  return existingMemos;
}

export class DailyNoteModifier {
  private dailyMemosHeader: string;

  constructor(dailyMemosHeader: string) {
    this.dailyMemosHeader = dailyMemosHeader;
  }

  /**
   * Modify daily note content with fetched memos
   * Uses smart incremental update strategy to minimize file changes
   *
   * @param trustRemoteTimestamps  Memo timestamps (as string keys, matching
   *   `fetchedRecordList`) for which remote should simply overwrite local
   *   outright, checkbox included, instead of the default of always
   *   re-imposing whatever checkbox state the local note currently shows
   *   (matched by text - the only thing stopping a stale pull from
   *   reverting a check you'd just made, when nothing else is watching for
   *   local edits).
   *
   *   Bidirectional sync (contentPush.ts) passes exactly the timestamps it
   *   was able to reason about this sync - it already protected any
   *   genuine local edit among them earlier in the same sync (and mutated
   *   the fetched content to match before this ever runs), so for those,
   *   any remaining difference here is a legitimate remote-side change
   *   that should win. Deliberately per-timestamp, not per-profile:
   *   contentPush only ever handles single-line, attachment-free memos
   *   (see memoReverseTransform.ts) - anything outside that still needs
   *   the default text-preservation behaviour, or a checkbox on e.g. a
   *   multi-line memo would lose the only protection it has, with nothing
   *   to replace it (contentPush can't push it back either).
   */
  modifyDailyNote(
    originFileContent: string,
    today: string,
    fetchedRecordList: Record<string, string>,
    trustRemoteTimestamps: ReadonlySet<string> = new Set(),
  ): string | undefined {
    const header = this.dailyMemosHeader;
    const section = findHeaderSection(originFileContent, header);
    if (!section) {
      // Every existing daily note in the sync window is checked now (so full-day
      // deletions can be detected - see DailyNoteManager.processMemos), including
      // ones that never had this header, e.g. notes predating the plugin's setup.
      // Only warn when there's actual content that couldn't be placed; a header
      // that's simply absent with nothing to sync is not a problem.
      if (Object.keys(fetchedRecordList).length > 0) {
        console.warn(`Expected one header "${header}" for ${today}.`);
      }
      return;
    }
    const { prefix, suffix, localRecordContent } = section;
    const existingMemos = parseExistingMemoBlocks(localRecordContent);

    // Determine what needs to be updated
    const updates = new Map<string, string>();
    const additions = new Map<string, string>();
    const deletions = new Set<string>();

    // Find additions and updates
    for (const [timestamp, content] of Object.entries(fetchedRecordList)) {
      const existingContent = existingMemos.get(timestamp);
      if (existingContent !== undefined) {
        const remoteContent = content;

        const trustRemote = trustRemoteTimestamps.has(timestamp);

        // Check if contents are the same except for todo states
        if (isSameExceptTodoStates(existingContent, remoteContent)) {
          const mergedContent = trustRemote
            ? remoteContent
            : mergeTodoStates(existingContent, remoteContent);
          if (mergedContent !== existingContent) {
            updates.set(timestamp, mergedContent);
          }
          // If merged content is same as existing, no update needed
        } else if (existingContent !== remoteContent) {
          // Content has changed beyond just todo states
          const mergedContent = trustRemote
            ? remoteContent
            : mergeTodoStates(existingContent, remoteContent);
          updates.set(timestamp, mergedContent);
        }
        // If contents are exactly the same, no update needed
      } else {
        additions.set(timestamp, content);
      }
    }

    // Find deletions (existing memos not in fetched list). Safe to run
    // unconditionally: the caller always fetches the complete state for
    // this day within the sync window (see SimpleMemosPaginator /
    // DailyNoteManager.processMemos), so fetchedRecordList is authoritative
    // for `today`, not a partial/incremental slice.
    for (const timestamp of existingMemos.keys()) {
      if (!fetchedRecordList[timestamp]) {
        deletions.add(timestamp);
      }
    }

    // If no changes needed, return undefined to indicate no update
    if (updates.size === 0 && additions.size === 0 && deletions.size === 0) {
      return undefined;
    }

    // Create the updated content
    const allMemos = new Map<string, string>();

    // Keep existing memos that weren't deleted or updated
    for (const [timestamp, content] of existingMemos) {
      if (!deletions.has(timestamp) && !updates.has(timestamp)) {
        allMemos.set(timestamp, content);
      }
    }

    // Add updated memos
    for (const [timestamp, content] of updates) {
      allMemos.set(timestamp, content);
    }

    // Add new memos
    for (const [timestamp, content] of additions) {
      allMemos.set(timestamp, content);
    }

    // Sort by timestamp and create final content
    const sortedMemos = Array.from(allMemos.entries())
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([_, content]) => content)
      .join("\n");

    const modifiedFileContent = prefix + (prefix.endsWith("\n") ? "" : "\n") + `\n${sortedMemos}\n\n` + suffix;
    return modifiedFileContent;
  }
}
