import { App, ButtonComponent, Modal } from 'obsidian';
import { t } from '../i18n/translationManager';

export interface ConflictItem {
  timestamp: string;
  localContent: string;
  remoteContent: string;
}

export type ConflictChoice = 'local' | 'remote';
export type ConflictResolutions = Map<string, ConflictChoice>;

/**
 * Shown when a memo's content changed both locally and on the server since
 * the last sync (see contentPush.ts) - something a two-state checkbox can
 * never produce, but free text can. Blocks until every listed conflict has
 * a choice, on manual sync *and* on background/periodic sync alike (opted
 * into deliberately: the alternative of silently favouring one side was
 * judged worse than an occasional pop-up while away from the keyboard).
 *
 * Closing the modal without deciding every row (Esc, clicking outside)
 * defaults any undecided item to "remote" - i.e. do nothing extra and let
 * the normal pull/merge apply - so an unreviewed dismissal can never
 * overwrite the server with a local edit nobody actually confirmed.
 */
export class ConflictResolutionModal extends Modal {
  private resolutions: ConflictResolutions = new Map();
  private resolvePromise: (result: ConflictResolutions) => void = () => {};

  constructor(app: App, private profileName: string, private conflicts: ConflictItem[]) {
    super(app);
  }

  // Named distinctly from Modal#open (which returns void) so this doesn't
  // override that signature with an incompatible Promise-returning one.
  openAndAwaitResolution(): Promise<ConflictResolutions> {
    this.open();
    return new Promise(resolve => { this.resolvePromise = resolve; });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(`${t.t('CONFLICT_MODAL_TITLE')} — ${this.profileName}`);
    contentEl.createEl('p', { text: t.t('CONFLICT_MODAL_DESC') });

    for (const conflict of this.conflicts) {
      const row = contentEl.createDiv({ cls: 'yams-conflict-row' });
      row.createEl('div', { cls: 'yams-conflict-side', text: `${t.t('CONFLICT_LOCAL_LABEL')}: ${conflict.localContent}` });
      row.createEl('div', { cls: 'yams-conflict-side', text: `${t.t('CONFLICT_REMOTE_LABEL')}: ${conflict.remoteContent}` });

      const buttons = row.createDiv({ cls: 'modal-button-container' });
      const localBtn = new ButtonComponent(buttons).setButtonText(t.t('CONFLICT_KEEP_LOCAL')).setCta();
      const remoteBtn = new ButtonComponent(buttons).setButtonText(t.t('CONFLICT_KEEP_REMOTE'));

      const choose = (choice: ConflictChoice): void => {
        this.resolutions.set(conflict.timestamp, choice);
        localBtn.setDisabled(true);
        remoteBtn.setDisabled(true);
        (choice === 'local' ? localBtn : remoteBtn).buttonEl.addClass('yams-conflict-chosen');
        if (this.resolutions.size === this.conflicts.length) {
          window.setTimeout(() => this.close(), 150);
        }
      };
      localBtn.onClick(() => choose('local'));
      remoteBtn.onClick(() => choose('remote'));
    }
  }

  onClose(): void {
    this.contentEl.empty();
    for (const conflict of this.conflicts) {
      if (!this.resolutions.has(conflict.timestamp)) {
        this.resolutions.set(conflict.timestamp, 'remote');
      }
    }
    this.resolvePromise(this.resolutions);
  }
}
