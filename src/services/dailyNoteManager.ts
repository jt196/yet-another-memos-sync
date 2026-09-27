import { App, TFile, moment } from 'obsidian';
import { getDailyNote, createDailyNote, getAllDailyNotes, getDateFromFile } from 'obsidian-daily-notes-interface';

type MomentInstance = ReturnType<typeof moment>;
import { MemosAPIClient } from '../api/memosClient';
import { SimpleMemosPaginator } from '../api/memosPaginator';
import { DailyNoteModifier, findHeaderSection, parseExistingMemoBlocks } from '../utils/dailyNoteModifier';
import { planContentPushes, executeContentPushes, hashContent } from '../utils/contentPush';
import { ReverseTransformOptions } from '../utils/memoReverseTransform';
import { transformMemoToMarkdown } from '../utils/memoTransformer';
import { ConflictResolutionModal, ConflictItem } from '../ui/conflictModal';
import { headingTitle } from '../utils/markdownSections';
import { t } from '../i18n/translationManager';
import { APIClient, Memo, MemosProfile, MemosSettings } from '../types';

export interface SyncStateStore {
  markSyncedToday(): Promise<void>;
  saveSettings(): Promise<void>;
}

export type SyncMode = 'smart' | 'incremental' | 'force';

export class DailyNoteManager {
  constructor(
    private app: App,
    private settings: MemosSettings,
    private state: SyncStateStore,
  ) {}

  updateSettings(settings: MemosSettings): void {
    this.settings = settings;
  }

  async syncAll(mode: SyncMode): Promise<void> {
    const profiles = (this.settings.profiles || []).filter(p => p.enabled && p.apiUrl && p.apiToken);
    if (profiles.length === 0) {
      console.warn('No enabled profiles configured');
      return;
    }
    for (const profile of profiles) {
      try {
        await this.syncProfile(profile, mode);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Sync failed for profile "${profile.name}":`, error);
        throw new Error(`Profile "${profile.name}": ${message}`);
      }
    }
    await this.state.markSyncedToday();
  }

  private async syncProfile(profile: MemosProfile, mode: SyncMode): Promise<void> {
    if (this.settings.timelineHeader.trim() && headingTitle(this.settings.timelineHeader) === headingTitle(profile.dailyMemoHeader)) {
      throw new Error(t.t('TIMELINE_CONFLICT'));
    }
    const client = new MemosAPIClient(profile.apiUrl, profile.apiToken);

    // 'force' ignores syncDaysLimit and reconciles the entire history.
    // 'smart' and 'incremental' both reconcile the full syncDaysLimit window
    // on every run - see SimpleMemosPaginator for why cursor-based
    // incremental fetching was dropped (it broke permanently on any
    // out-of-order memo timestamp, backdated or future-dated).
    const effectiveSyncDaysLimit = mode === 'force' ? 0 : profile.syncDaysLimit;

    const paginator = new SimpleMemosPaginator(
      client,
      this.settings.useCalloutFormat,
      this.settings.useListCalloutFormat,
      this.settings.skipImages,
      effectiveSyncDaysLimit,
    );

    await this.processMemos(paginator, profile, client);
  }

  private async processMemos(
    paginator: SimpleMemosPaginator,
    profile: MemosProfile,
    client: APIClient,
  ): Promise<void> {
    // Bidirectional sync already protects a genuine local checkbox edit
    // earlier in this same sync (pushContentChanges, above) - so the old
    // blanket "always keep local's checkbox" merge behaviour would only
    // fight that, blocking a legitimate remote-side uncheck/check from ever
    // reaching the note. See DailyNoteModifier's constructor doc.
    const modifier = new DailyNoteModifier(profile.dailyMemoHeader, !profile.enableBidirectionalSync);
    const { dailyMemosByDay, rawMemosByDay, cutoffTimestamp } = await paginator.collect();

    // A day whose memos were all deleted remotely never appears in
    // dailyMemosByDay (there's nothing fetched for it), so without this it
    // would be silently skipped and its stale entries would never be
    // cleaned up. Add an empty bucket for every existing daily note inside
    // the sync window so modifyDailyNote still runs deletion detection
    // against it.
    for (const file of Object.values(getAllDailyNotes())) {
      const day = getDateFromFile(file, 'day');
      if (!day) continue;
      if (cutoffTimestamp > 0 && day.unix() < cutoffTimestamp) continue;
      const dateStr = day.format('YYYY-MM-DD');
      if (!(dateStr in dailyMemosByDay)) {
        dailyMemosByDay[dateStr] = {};
      }
    }

    let pushed = 0, pushFailed = 0;
    // Work off a copy so a mid-loop failure can't partially persist this
    // profile's baseline - saved once, after every day's push pass runs.
    const baseline = { ...(this.settings.contentBaselines[profile.id] ?? {}) };
    const reverseOpts: ReverseTransformOptions = {
      useCalloutFormat: this.settings.useCalloutFormat,
      useListCalloutFormat: this.settings.useListCalloutFormat,
      skipImages: this.settings.skipImages,
    };

    for (const [dateStr, memos] of Object.entries(dailyMemosByDay)) {
      try {
        const momentDay = moment(dateStr);
        if (!momentDay.isValid()) {
          console.warn(`Invalid date: ${dateStr}`);
          continue;
        }

        const dailyNote = await this.getOrCreateDailyNote(momentDay);
        if (!dailyNote) {
          continue;
        }

        if (profile.enableBidirectionalSync) {
          const result = await this.pushContentChanges(
            client, dailyNote, dateStr, profile, rawMemosByDay[dateStr] ?? {}, memos, baseline, reverseOpts,
          );
          pushed += result.pushed;
          pushFailed += result.failed;
        }

        await this.app.vault.process(dailyNote, currentContent =>
          modifier.modifyDailyNote(currentContent, dateStr, memos) ?? currentContent
        );
      } catch (error) {
        console.error(`Failed to process memos for ${dateStr}:`, error);
      }
    }

    if (profile.enableBidirectionalSync) {
      this.settings.contentBaselines[profile.id] = baseline;
      await this.state.saveSettings();
      if (pushFailed > 0) {
        console.warn(`Content push for "${profile.name}": ${pushed} pushed, ${pushFailed} failed - failures will retry next sync.`);
      }
    }
  }

  /**
   * Diff this day's local content against the freshly-fetched remote memos
   * and push any local changes back to the server, prompting to resolve
   * any genuine conflicts along the way. Mutates `baseline` and `memos` in
   * place. Must run before the pull/merge step below, against content as
   * it stood before that merge, or a remote-side change and a local edit
   * in the same sync would look identical.
   *
   * `memos` (this day's fetched, markdown-transformed content, about to be
   * merged into the note) is updated for anything pushed or resolved in
   * favour of local, so that merge step doesn't turn around and overwrite
   * the just-pushed line with the (now-stale) pre-push remote text.
   */
  private async pushContentChanges(
    client: APIClient,
    dailyNote: TFile,
    dateStr: string,
    profile: MemosProfile,
    rawMemosForDay: Record<string, Memo>,
    memos: Record<string, string>,
    baseline: Record<string, string>,
    reverseOpts: ReverseTransformOptions,
  ): Promise<{ pushed: number; failed: number }> {
    const currentContent = await this.app.vault.read(dailyNote);
    const section = findHeaderSection(currentContent, profile.dailyMemoHeader);
    if (!section) return { pushed: 0, failed: 0 };

    const localBlocks = parseExistingMemoBlocks(section.localRecordContent);
    const plan = planContentPushes(localBlocks, rawMemosForDay, baseline, reverseOpts);

    if (plan.conflicts.size > 0) {
      const items: ConflictItem[] = [...plan.conflicts].map(([timestamp, c]) => ({
        timestamp, localContent: c.localContent, remoteContent: c.remoteContent,
      }));
      const modal = new ConflictResolutionModal(this.app, profile.name, items);
      const resolutions = await modal.openAndAwaitResolution();
      for (const [timestamp, choice] of resolutions) {
        const conflict = plan.conflicts.get(timestamp);
        if (!conflict) continue;
        if (choice === 'local') {
          plan.toPush.set(timestamp, { memo: conflict.memo, newContent: conflict.localContent });
        } else {
          plan.baselineUpdates.set(timestamp, hashContent(conflict.remoteContent));
        }
      }
    }

    const result = await executeContentPushes(client, plan, baseline);
    // result.updatedBaseline is always a superset of the baseline passed in
    // (executeContentPushes only adds/overwrites entries, never removes),
    // so this is safe to assign wholesale.
    Object.assign(baseline, result.updatedBaseline);

    for (const [timestamp, { memo, newContent }] of plan.toPush) {
      if (!(timestamp in result.updatedBaseline) || result.updatedBaseline[timestamp] !== hashContent(newContent)) {
        continue; // this one failed to push - leave `memos` as the fetched remote text
      }
      memos[timestamp] = transformMemoToMarkdown(
        { timestamp: Number(timestamp), content: newContent, resources: memo.resources },
        reverseOpts.useCalloutFormat, reverseOpts.useListCalloutFormat, reverseOpts.skipImages,
      ).content;
    }

    if (result.failed > 0) {
      console.warn(`${result.failed} content push(es) failed for ${dateStr} ("${profile.name}") - will retry next sync.`);
    }
    return { pushed: result.pushed, failed: result.failed };
  }

  private async getOrCreateDailyNote(momentDay: MomentInstance): Promise<TFile | null> {
    try {
      // obsidian-daily-notes-interface bundles its own (older) obsidian.d.ts,
      // so use instanceof to narrow against the project's TFile class.
      const existing = getDailyNote(momentDay, getAllDailyNotes());
      if (existing instanceof TFile) {
        return existing;
      }
      if (this.settings.createMissingDailyNotes) {
        const created = await createDailyNote(momentDay);
        if (created instanceof TFile) {
          return created;
        }
      }
      return null;
    } catch (error) {
      console.error('Failed to get/create daily note:', error);
      return null;
    }
  }
}
