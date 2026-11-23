import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {DEFAULT_TIME_ZONE, instant, range, resolveWhen, zonedClock} from './calendar-time.ts';

export const REQUEST_DEDUP_WINDOW = 2000;
export const OPERATION_HISTORY_WINDOW = 1000;
export const PENDING_RESOLVED_WINDOW = 500;
export const STATE_PENDING_RESOLVED_LIMIT = 50;
export const STATE_OPERATIONS_LIMIT = 50;

export type CalendarEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
  timeZone: string;
};

export type CalendarResult =
  | {status: 'not_found'; eventId: string}
  | {status: 'stale'; message: string}
  | {status: 'needs_confirmation'; confirmationId: string; event: CalendarEvent; conflicts: CalendarEvent[]; message?: string}
  | {status: 'created' | 'updated' | 'deleted'; event: CalendarEvent};

export type CalendarWriteOutcome =
  | CalendarResult
  | {status: 'needs_information'; missing: string[]; message?: string; reason?: string; spec?: unknown};

export type PendingEvent = {
  event: CalendarEvent;
  conflicts: CalendarEvent[];
  authorized: boolean;
  updateId?: string;
  original?: CalendarEvent;
  result?: CalendarResult;
};

export type CalendarSnapshot = {
  events: CalendarEvent[];
  pending: Record<string, PendingEvent>;
  operations: Record<string, CalendarResult>;
};

export interface CalendarWhenSpec {
  day?: string;
  date?: string;
  absolute?: string;
  time?: string;
  offsetMinutes?: number;
  durationMinutes?: number;
}

export interface CalendarWriteInput {
  eventId?: string;
  title?: string;
  start?: string;
  end?: string;
  timeZone?: string;
  when?: CalendarWhenSpec;
  confirmationId?: string;
}

export type BeginPromptResult =
  | {status: 'conflict'}
  | {status: 'existing'}
  | {status: 'inserted'; confirmationId?: string; authorizedChanged: boolean};

export interface PersonalStoreOptions {
  now?: () => number;
  requestDedupWindow?: number;
  operationHistoryWindow?: number;
  pendingResolvedWindow?: number;
}

type EventRow = {
  id: string;
  title: string;
  start_iso: string;
  end_iso: string;
  time_zone: string;
};

type PendingRow = {
  confirmation_id: string;
  event_json: string;
  conflicts_json: string;
  authorized: number;
  update_id: string | null;
  original_json: string | null;
  result_json: string | null;
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  start_iso TEXT NOT NULL,
  end_iso TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  time_zone TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (end_ms > start_ms)
);
CREATE INDEX IF NOT EXISTS idx_calendar_events_range ON calendar_events (start_ms, end_ms);

CREATE TABLE IF NOT EXISTS calendar_pending (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  confirmation_id TEXT NOT NULL UNIQUE,
  conversation_id INTEGER,
  event_json TEXT NOT NULL,
  conflicts_json TEXT NOT NULL,
  authorized INTEGER NOT NULL DEFAULT 0 CHECK (authorized IN (0, 1)),
  update_id TEXT,
  original_json TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calendar_pending_open ON calendar_pending (seq) WHERE result_json IS NULL;

CREATE TABLE IF NOT EXISTS calendar_operations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_key TEXT NOT NULL UNIQUE,
  conversation_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  call_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calendar_operations_conv ON calendar_operations (conversation_id, seq);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  last_operation_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS request_dedup (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  body_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_request_dedup_seq ON request_dedup (seq);
`;

function rowToEvent(row: EventRow): CalendarEvent {
  return {
    id: row.id,
    title: row.title,
    start: row.start_iso,
    end: row.end_iso,
    timeZone: row.time_zone,
  };
}

function rowToPending(row: PendingRow): PendingEvent {
  const pending: PendingEvent = {
    event: JSON.parse(row.event_json) as CalendarEvent,
    conflicts: JSON.parse(row.conflicts_json) as CalendarEvent[],
    authorized: Boolean(row.authorized),
  };
  if (row.update_id !== null) pending.updateId = row.update_id;
  if (row.original_json !== null) pending.original = JSON.parse(row.original_json) as CalendarEvent;
  if (row.result_json !== null) pending.result = JSON.parse(row.result_json) as CalendarResult;
  return pending;
}

function eventsEqual(a: CalendarEvent, b: CalendarEvent | undefined): boolean {
  if (!b) return false;
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.start === b.start &&
    a.end === b.end &&
    a.timeZone === b.timeZone
  );
}

function validateOffsetMatchesZone(start: string, end: string, timeZone: string): void {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  for (const value of [start, end]) {
    if (formatter.format(new Date(value)).replace(' ', 'T') !== value.slice(0, 19)) {
      throw new Error('时间偏移与 timeZone 不一致，请确认时区');
    }
  }
}

export class PersonalStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly requestDedupWindow: number;
  private readonly operationHistoryWindow: number;
  private readonly pendingResolvedWindow: number;
  private closed = false;

  constructor(filePath: string, options: PersonalStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.requestDedupWindow = options.requestDedupWindow ?? REQUEST_DEDUP_WINDOW;
    this.operationHistoryWindow = options.operationHistoryWindow ?? OPERATION_HISTORY_WINDOW;
    this.pendingResolvedWindow = options.pendingResolvedWindow ?? PENDING_RESOLVED_WINDOW;

    this.db = new DatabaseSync(filePath, {timeout: 5000});
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA_SQL);

    const createdAt = new Date(this.now()).toISOString();
    this.transaction(() => {
      const insertMeta = this.db.prepare('INSERT OR IGNORE INTO schema_meta (key, value) VALUES (?, ?)');
      insertMeta.run('schema_version', '1');
      insertMeta.run('created_at', createdAt);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Ignore rollback failure when connection already closed or aborted.
      }
      throw error;
    }
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  private pruneOperations(): void {
    this.db.prepare(
      `DELETE FROM calendar_operations
       WHERE seq <= (
         SELECT seq FROM calendar_operations
         ORDER BY seq DESC
         LIMIT 1 OFFSET ?
       )`,
    ).run(this.operationHistoryWindow);
  }

  private pruneResolvedPending(): void {
    this.db.prepare(
      `DELETE FROM calendar_pending
       WHERE result_json IS NOT NULL
         AND seq <= (
           SELECT seq FROM calendar_pending
           WHERE result_json IS NOT NULL
           ORDER BY seq DESC
           LIMIT 1 OFFSET ?
         )`,
    ).run(this.pendingResolvedWindow);
  }

  private pruneRequestDedup(): void {
    this.db.prepare(
      `DELETE FROM request_dedup
       WHERE seq <= (
         SELECT seq FROM request_dedup
         ORDER BY seq DESC
         LIMIT 1 OFFSET ?
       )`,
    ).run(this.requestDedupWindow);
  }

  private recordOperation(
    operationKey: string,
    conversationId: number,
    taskId: number,
    callId: string,
    result: CalendarResult,
    createdAt: string,
  ): void {
    this.db.prepare(
      `INSERT INTO calendar_operations (operation_key, conversation_id, task_id, call_id, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(operationKey, conversationId, taskId, callId, JSON.stringify(result), createdAt);
    this.pruneOperations();
  }

  private findOverlaps(startMs: number, endMs: number, excludeId: string | undefined): CalendarEvent[] {
    const rows = this.db.prepare(
      `SELECT id, title, start_iso, end_iso, time_zone
       FROM calendar_events
       WHERE start_ms < ? AND end_ms > ? AND (? IS NULL OR id != ?)
       ORDER BY seq ASC`,
    ).all(endMs, startMs, excludeId ?? null, excludeId ?? null) as EventRow[];
    return rows.map(rowToEvent);
  }

  private findEventById(id: string): CalendarEvent | undefined {
    const row = this.db.prepare(
      `SELECT id, title, start_iso, end_iso, time_zone
       FROM calendar_events
       WHERE id = ?`,
    ).get(id) as EventRow | undefined;
    return row ? rowToEvent(row) : undefined;
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(key) as
      | {value: string}
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.transaction(() => {
      this.db.prepare(
        `INSERT INTO schema_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(key, value);
    });
  }

  getNote(id = 'default'): string {
    const row = this.db.prepare('SELECT content FROM notes WHERE id = ?').get(id) as
      | {content: string}
      | undefined;
    return row?.content ?? '';
  }

  saveNote(text: string, operationKey: string, id = 'default'): {changed: boolean; text: string} {
    return this.transaction(() => {
      const existing = this.db.prepare(
        'SELECT content, last_operation_key FROM notes WHERE id = ?',
      ).get(id) as {content: string; last_operation_key: string | null} | undefined;
      if (existing && existing.last_operation_key === operationKey) {
        return {changed: false, text: existing.content};
      }
      const nowIso = this.nowIso();
      this.db.prepare(
        `INSERT INTO notes (id, content, last_operation_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           content = excluded.content,
           last_operation_key = excluded.last_operation_key,
           updated_at = excluded.updated_at`,
      ).run(id, text, operationKey, nowIso, nowIso);
      return {changed: true, text};
    });
  }

  listCalendarEvents(start: unknown, end: unknown): CalendarEvent[] {
    const [a, b] = range(start, end);
    const rows = this.db.prepare(
      `SELECT id, title, start_iso, end_iso, time_zone
       FROM calendar_events
       WHERE start_ms < ? AND end_ms > ?
       ORDER BY seq ASC`,
    ).all(b, a) as EventRow[];
    return rows.map(rowToEvent);
  }

  allCalendarEvents(): CalendarEvent[] {
    const rows = this.db.prepare(
      `SELECT id, title, start_iso, end_iso, time_zone
       FROM calendar_events
       ORDER BY seq ASC`,
    ).all() as EventRow[];
    return rows.map(rowToEvent);
  }

  getCalendarSnapshot(conversationId?: number): CalendarSnapshot {
    const events = this.allCalendarEvents();

    const pendingRows = this.db.prepare(
      `SELECT confirmation_id, event_json, conflicts_json, authorized, update_id, original_json, result_json
       FROM (
         SELECT seq, confirmation_id, event_json, conflicts_json, authorized, update_id, original_json, result_json
         FROM calendar_pending
         WHERE result_json IS NULL
         UNION ALL
         SELECT seq, confirmation_id, event_json, conflicts_json, authorized, update_id, original_json, result_json
         FROM (
           SELECT seq, confirmation_id, event_json, conflicts_json, authorized, update_id, original_json, result_json
           FROM calendar_pending
           WHERE result_json IS NOT NULL
           ORDER BY seq DESC
           LIMIT ?
         )
       )
       ORDER BY seq ASC`,
    ).all(STATE_PENDING_RESOLVED_LIMIT) as PendingRow[];

    const pending: Record<string, PendingEvent> = {};
    for (const row of pendingRows) {
      pending[row.confirmation_id] = rowToPending(row);
    }

    const opRows = (
      conversationId !== undefined
        ? this.db.prepare(
            `SELECT call_id, result_json FROM (
               SELECT seq, call_id, result_json
               FROM calendar_operations
               WHERE conversation_id = ?
               ORDER BY seq DESC
               LIMIT ?
             )
             ORDER BY seq ASC`,
          ).all(conversationId, STATE_OPERATIONS_LIMIT)
        : this.db.prepare(
            `SELECT call_id, result_json FROM (
               SELECT seq, call_id, result_json
               FROM calendar_operations
               ORDER BY seq DESC
               LIMIT ?
             )
             ORDER BY seq ASC`,
          ).all(STATE_OPERATIONS_LIMIT)
    ) as {call_id: string; result_json: string}[];

    const operations: Record<string, CalendarResult> = {};
    for (const row of opRows) {
      operations[row.call_id] = JSON.parse(row.result_json) as CalendarResult;
    }

    return {events, pending, operations};
  }

  runCalendarWrite(params: {
    updating: boolean;
    input: CalendarWriteInput;
    conversationId: number;
    taskId: number;
    callId: string;
  }): CalendarWriteOutcome {
    const {updating, conversationId, taskId, callId} = params;
    let input = params.input;
    if (!updating && Object.hasOwn(input, 'eventId')) {
      throw new Error('创建工具不接受 eventId；修改请使用 update_calendar_event');
    }
    const operationKey = `${conversationId}:${taskId}:${callId}`;

    return this.transaction(() => {
      const existingOp = this.db.prepare(
        'SELECT result_json FROM calendar_operations WHERE operation_key = ?',
      ).get(operationKey) as {result_json: string} | undefined;
      if (existingOp) return JSON.parse(existingOp.result_json) as CalendarResult;

      const nowIso = this.nowIso();

      if (input.confirmationId) {
        const pendingRow = this.db.prepare(
          `SELECT confirmation_id, event_json, conflicts_json, authorized, update_id, original_json, result_json
           FROM calendar_pending
           WHERE confirmation_id = ?`,
        ).get(input.confirmationId) as PendingRow | undefined;
        if (!pendingRow) throw new Error('待确认日程不存在');
        const pending = rowToPending(pendingRow);
        if (pending.result) return pending.result;
        if (!pending.authorized) {
          return {
            status: 'needs_confirmation',
            confirmationId: input.confirmationId,
            event: pending.event,
            conflicts: pending.conflicts,
          };
        }

        const updateId = pending.updateId;
        if (updateId) {
          const original = this.findEventById(updateId);
          if (!original) {
            const result: CalendarResult = {status: 'not_found', eventId: updateId};
            this.db.prepare(
              'UPDATE calendar_pending SET result_json = ?, updated_at = ? WHERE confirmation_id = ?',
            ).run(JSON.stringify(result), nowIso, input.confirmationId);
            this.recordOperation(operationKey, conversationId, taskId, callId, result, nowIso);
            this.pruneResolvedPending();
            return result;
          }
          if (!eventsEqual(original, pending.original)) {
            const result: CalendarResult = {status: 'stale', message: '原日程已改变，请重新查询并修改'};
            this.db.prepare(
              'UPDATE calendar_pending SET result_json = ?, updated_at = ? WHERE confirmation_id = ?',
            ).run(JSON.stringify(result), nowIso, input.confirmationId);
            this.recordOperation(operationKey, conversationId, taskId, callId, result, nowIso);
            this.pruneResolvedPending();
            return result;
          }
        }

        const candidate = pending.event;
        const [startMs, endMs] = range(candidate.start, candidate.end);
        const conflicts = this.findOverlaps(startMs, endMs, updateId);
        const previousConflicts = pending.conflicts;
        if (
          conflicts.some(
            e => !previousConflicts.some(old => old.id === e.id && old.start === e.start && old.end === e.end),
          )
        ) {
          this.db.prepare(
            `UPDATE calendar_pending
             SET authorized = 0, conflicts_json = ?, updated_at = ?
             WHERE confirmation_id = ?`,
          ).run(JSON.stringify(conflicts), nowIso, input.confirmationId);
          const result: CalendarResult = {
            status: 'needs_confirmation',
            confirmationId: input.confirmationId,
            event: candidate,
            conflicts,
            message: '出现新的冲突，请用户重新确认',
          };
          this.recordOperation(operationKey, conversationId, taskId, callId, result, nowIso);
          return result;
        }

        if (updateId) {
          this.db.prepare(
            `UPDATE calendar_events
             SET title = ?, start_iso = ?, end_iso = ?, start_ms = ?, end_ms = ?, time_zone = ?, updated_at = ?
             WHERE id = ?`,
          ).run(
            candidate.title,
            candidate.start,
            candidate.end,
            startMs,
            endMs,
            candidate.timeZone,
            nowIso,
            updateId,
          );
        } else {
          this.db.prepare(
            `INSERT INTO calendar_events (id, title, start_iso, end_iso, start_ms, end_ms, time_zone, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            candidate.id,
            candidate.title,
            candidate.start,
            candidate.end,
            startMs,
            endMs,
            candidate.timeZone,
            nowIso,
            nowIso,
          );
        }

        const result: CalendarResult = {status: updateId ? 'updated' : 'created', event: candidate};
        this.db.prepare(
          'UPDATE calendar_pending SET result_json = ?, updated_at = ? WHERE confirmation_id = ?',
        ).run(JSON.stringify(result), nowIso, input.confirmationId);
        this.recordOperation(operationKey, conversationId, taskId, callId, result, nowIso);
        this.pruneResolvedPending();
        return result;
      }

      const updateId = updating && typeof input.eventId === 'string' ? input.eventId : undefined;
      if (updating && !updateId) {
        return {status: 'needs_information', missing: ['eventId']};
      }

      let original: CalendarEvent | undefined;
      if (updateId) {
        original = this.findEventById(updateId);
        if (!original) {
          const result: CalendarResult = {status: 'not_found', eventId: updateId};
          this.recordOperation(operationKey, conversationId, taskId, callId, result, nowIso);
          return result;
        }
      }

      const timeZone = input.timeZone || original?.timeZone || DEFAULT_TIME_ZONE;
      let resolvedStart: string | undefined;
      let resolvedEnd: string | undefined;
      if (input.when !== undefined) {
        const resolved = resolveWhen(input.when, this.now(), timeZone);
        if (!resolved.ok) {
          return {
            status: 'needs_information',
            missing: resolved.missing ?? [],
            reason: resolved.reason,
            spec: input.when,
          };
        }
        if (input.start !== undefined && Date.parse(input.start) !== Date.parse(resolved.start)) {
          return {
            status: 'needs_information',
            missing: [],
            reason: 'start 与 when 冲突',
            spec: input.when,
          };
        }
        resolvedStart = resolved.start;
        resolvedEnd = resolved.end ?? input.end;
        if (resolvedEnd === undefined && original) {
          const [oldStart, oldEnd] = range(original.start, original.end);
          resolvedEnd = zonedClock(timeZone).format(instant(resolved.start) + oldEnd - oldStart);
        }
      }

      const title = input.title !== undefined ? input.title : original?.title;
      const start = resolvedStart ?? (input.start !== undefined ? input.start : original?.start);
      const end = resolvedEnd ?? (input.end !== undefined ? input.end : original?.end);

      if (!title?.trim() || !start?.trim() || !end?.trim()) {
        const missing: string[] = [];
        if (!title?.trim()) missing.push('title');
        if (!start?.trim()) missing.push('start');
        if (!end?.trim()) missing.push('end');
        return {status: 'needs_information', missing, message: '请向用户追问缺少的信息'};
      }

      const [startMs, endMs] = range(start, end);
      validateOffsetMatchesZone(start, end, timeZone);

      const candidate: CalendarEvent = {
        id: updateId || randomUUID(),
        title: title.trim(),
        start,
        end,
        timeZone,
      };
      const conflicts = this.findOverlaps(startMs, endMs, updateId);
      if (conflicts.length) {
        const confirmationId = randomUUID();
        this.db.prepare(
          `INSERT INTO calendar_pending (
             confirmation_id, conversation_id, event_json, conflicts_json,
             authorized, update_id, original_json, result_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 0, ?, ?, NULL, ?, ?)`,
        ).run(
          confirmationId,
          conversationId,
          JSON.stringify(candidate),
          JSON.stringify(conflicts),
          updateId ?? null,
          original ? JSON.stringify(original) : null,
          nowIso,
          nowIso,
        );
        const result: CalendarResult = {
          status: 'needs_confirmation',
          confirmationId,
          event: candidate,
          conflicts,
        };
        this.recordOperation(operationKey, conversationId, taskId, callId, result, nowIso);
        return result;
      }

      if (updateId) {
        this.db.prepare(
          `UPDATE calendar_events
           SET title = ?, start_iso = ?, end_iso = ?, start_ms = ?, end_ms = ?, time_zone = ?, updated_at = ?
           WHERE id = ?`,
        ).run(
          candidate.title,
          candidate.start,
          candidate.end,
          startMs,
          endMs,
          candidate.timeZone,
          nowIso,
          updateId,
        );
      } else {
        this.db.prepare(
          `INSERT INTO calendar_events (id, title, start_iso, end_iso, start_ms, end_ms, time_zone, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          candidate.id,
          candidate.title,
          candidate.start,
          candidate.end,
          startMs,
          endMs,
          candidate.timeZone,
          nowIso,
          nowIso,
        );
      }

      const result: CalendarResult = {status: updateId ? 'updated' : 'created', event: candidate};
      this.recordOperation(operationKey, conversationId, taskId, callId, result, nowIso);
      return result;
    });
  }

  deleteCalendarEvent(params: {
    eventId: string;
    conversationId: number;
    taskId: number;
    callId: string;
  }): CalendarResult {
    const {eventId, conversationId, taskId, callId} = params;
    const operationKey = `${conversationId}:${taskId}:${callId}`;

    return this.transaction(() => {
      const existingOp = this.db.prepare(
        'SELECT result_json FROM calendar_operations WHERE operation_key = ?',
      ).get(operationKey) as {result_json: string} | undefined;
      if (existingOp) return JSON.parse(existingOp.result_json) as CalendarResult;

      const existing = this.findEventById(eventId);
      const result: CalendarResult = existing
        ? {status: 'deleted', event: existing}
        : {status: 'not_found', eventId};
      if (existing) {
        this.db.prepare('DELETE FROM calendar_events WHERE id = ?').run(eventId);
      }
      this.recordOperation(operationKey, conversationId, taskId, callId, result, this.nowIso());
      return result;
    });
  }

  beginPromptRequest(conversationId: number, requestId: string, text: string): BeginPromptResult {
    return this.transaction(() => {
      const existing = this.db.prepare(
        'SELECT body_text FROM request_dedup WHERE conversation_id = ? AND request_id = ?',
      ).get(conversationId, requestId) as {body_text: string} | undefined;
      if (existing) {
        return existing.body_text === text ? {status: 'existing'} : {status: 'conflict'};
      }

      const nowIso = this.nowIso();
      this.db.prepare(
        `INSERT INTO request_dedup (conversation_id, request_id, body_text, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(conversationId, requestId, text, nowIso);
      this.pruneRequestDedup();

      const confirmation = /^确认重叠 ([a-f0-9-]{36})$/.exec(text.trim());
      if (confirmation) {
        const confirmationId = confirmation[1];
        const info = this.db.prepare(
          `UPDATE calendar_pending
           SET authorized = 1, updated_at = ?
           WHERE confirmation_id = ? AND result_json IS NULL AND authorized = 0`,
        ).run(nowIso, confirmationId);
        return {
          status: 'inserted',
          confirmationId,
          authorizedChanged: Number(info.changes) > 0,
        };
      }
      return {status: 'inserted', authorizedChanged: false};
    });
  }

  rollbackPromptRequest(conversationId: number, requestId: string, revertConfirmationId?: string): void {
    this.transaction(() => {
      this.db.prepare(
        'DELETE FROM request_dedup WHERE conversation_id = ? AND request_id = ?',
      ).run(conversationId, requestId);
      if (revertConfirmationId) {
        this.db.prepare(
          `UPDATE calendar_pending
           SET authorized = 0, updated_at = ?
           WHERE confirmation_id = ? AND result_json IS NULL`,
        ).run(this.nowIso(), revertConfirmationId);
      }
    });
  }
}

export function openPersonalStore(filePath: string, options?: PersonalStoreOptions): PersonalStore {
  return new PersonalStore(filePath, options);
}
