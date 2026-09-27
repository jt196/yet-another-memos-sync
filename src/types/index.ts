// Core types for Memos API (v0.22+ uses /api/v1; older `createdTs` kept for compat)
export interface Memo {
  id?: number | string;
  name?: string;
  uid?: string;
  content: string;
  timestamp?: number;
  createdTs?: number;
  createdAt?: string;
  createTime?: string;
  attachments?: Resource[];
  resourceList?: Resource[];
  resources?: Resource[];
}

export interface Resource {
  id?: string;
  name?: string;
  filename?: string;
  type?: string;
  size?: number;
  externalLink?: string;
  uid?: string;
}

export interface DailyMemo {
  date: string;
  timestamp: string;
  content: string;
}

export interface MemosProfile {
  id: string;
  name: string;
  apiUrl: string;
  apiToken: string;
  dailyMemoHeader: string;
  syncDaysLimit: number;
  enabled: boolean;
  // Opt-in: push local checkbox toggles back to this Memos server. Off by
  // default - unlike the rest of the plugin, this writes to the user's
  // server rather than only reading from it.
  enableBidirectionalSync: boolean;
}

export interface MemosSettings {
  // Profiles - one per memos account/instance
  profiles: MemosProfile[];

  timelineHeader: string;

  // Shared formatting settings
  attachmentFolderPath: string;
  createMissingDailyNotes: boolean;
  useCalloutFormat: boolean;
  useListCalloutFormat: boolean;
  skipImages: boolean;

  // Auto sync
  enableAutoSyncOnStartup: boolean;
  startupSyncDelay: number;
  skipIfSyncedToday: boolean;
  periodicSyncInterval: number;

  lastSyncDate: string;

  // Bidirectional sync: the last checkbox state (checked/unchecked) we
  // believe is in sync between the local note and the server, per profile
  // and per memo (keyed by the memo's unix timestamp, matching the ^ref
  // used in daily notes). Used to tell "user just checked this locally"
  // apart from "this is just what we last pulled" - see checkboxPush.ts.
  checkboxBaselines: Record<string, Record<string, boolean>>;
}

export interface ListMemosPage {
  memos: Memo[];
  nextPageToken: string;
}

export interface ListMemosOptions {
  pageSize?: number;
  pageToken?: string;
  filter?: string;
}

export interface APIClient {
  listMemos(opts?: ListMemosOptions): Promise<ListMemosPage>;
  // Replaces a memo's content wholesale (partial update, `content` field
  // only). Used to push a local checkbox toggle back to the server - see
  // checkboxPush.ts. Callers must send the full current content with just
  // the checkbox character changed, not a diff.
  updateMemoContent(name: string, content: string): Promise<Memo>;
}
