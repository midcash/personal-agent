import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach, beforeEach, describe, test} from 'node:test';
import {openPersonalStore} from '../durable_mvp/personal-store.ts';

describe('personal-store open SQLite schema & invariants', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-store-test-'));
    dbPath = path.join(tempDir, 'personal.sqlite');
  });

  afterEach(() => {
    fs.rmSync(tempDir, {recursive: true, force: true});
  });

  test('initializes open-schema tables, indexes, and schema metadata', () => {
    const store = openPersonalStore(dbPath, {now: () => Date.parse('2026-11-23T12:00:00Z')});
    assert.equal(store.getMeta('schema_version'), '1');
    assert.equal(store.getMeta('created_at'), '2026-11-23T12:00:00.000Z');
    store.close();

    const raw = new DatabaseSync(dbPath, {readOnly: true});
    try {
      const objects = raw
        .prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY type, name")
        .all() as {type: string; name: string}[];
      const tables = new Set(objects.filter(o => o.type === 'table').map(o => o.name));
      const indexes = new Set(objects.filter(o => o.type === 'index').map(o => o.name));

      for (const name of [
        'schema_meta',
        'calendar_events',
        'calendar_pending',
        'calendar_operations',
        'notes',
        'request_dedup',
      ]) {
        assert.ok(tables.has(name), `Expected table ${name}`);
      }
      for (const index of [
        'idx_calendar_events_range',
        'idx_calendar_pending_open',
        'idx_calendar_operations_conv',
        'idx_request_dedup_seq',
      ]) {
        assert.ok(indexes.has(index), `Expected index ${index}`);
      }
    } finally {
      raw.close();
    }
  });

  test('supports >200 calendar events with indexed range queries and updates preserving order', () => {
    const store = openPersonalStore(dbPath, {now: () => Date.parse('2026-11-23T00:00:00+08:00')});
    try {
      const baseDay = Date.parse('2026-12-01T00:00:00+08:00');
      for (let i = 0; i < 250; i++) {
        const startMs = baseDay + i * 2 * 3600 * 1000;
        const endMs = startMs + 3600 * 1000;
        const start = new Date(startMs + 8 * 3600 * 1000).toISOString().replace('.000Z', '+08:00');
        const end = new Date(endMs + 8 * 3600 * 1000).toISOString().replace('.000Z', '+08:00');
        const res = store.runCalendarWrite({
          updating: false,
          input: {title: `日程-${i}`, start, end, timeZone: 'Etc/GMT-8'},
          conversationId: 1,
          taskId: 100 + i,
          callId: `call-${i}`,
        });
        assert.equal(res.status, 'created');
      }

      const all = store.allCalendarEvents();
      assert.equal(all.length, 250);
      assert.equal(all[249].title, '日程-249');

      // Half-open overlap boundaries: exact touching ends do not match; 1-minute overlap matches.
      const first = all[0];
      assert.deepEqual(
        store.listCalendarEvents(first.end, '2026-12-01T01:30:00+08:00'),
        [],
      );
      assert.deepEqual(
        store.listCalendarEvents('2026-12-01T00:59:00+08:00', '2026-12-01T01:30:00+08:00').map(e => e.id),
        [first.id],
      );

      // Update last event and verify sequence order is preserved.
      const last = all[249];
      const updated = store.runCalendarWrite({
        updating: true,
        input: {eventId: last.id, title: '日程-249-已改'},
        conversationId: 2,
        taskId: 500,
        callId: 'update-last',
      });
      assert.equal(updated.status, 'updated');
      const afterUpdate = store.allCalendarEvents();
      assert.equal(afterUpdate.length, 250);
      assert.equal(afterUpdate[249].id, last.id);
      assert.equal(afterUpdate[249].title, '日程-249-已改');
    } finally {
      store.close();
    }
  });

  test('enforces overlap confirmation, new-conflict reset, stale/deleted guards, and tool replay idempotency', () => {
    const store = openPersonalStore(dbPath, {
      now: () => Date.parse('2026-11-23T08:00:00+08:00'),
      operationHistoryWindow: 5,
      pendingResolvedWindow: 2,
    });
    try {
      const seed = store.runCalendarWrite({
        updating: false,
        input: {
          title: '已有会议',
          start: '2026-11-25T14:00:00+08:00',
          end: '2026-11-25T15:00:00+08:00',
        },
        conversationId: 1,
        taskId: 1,
        callId: 'seed',
      });
      assert.equal(seed.status, 'created');
      const seedId = seed.event.id;

      // Overlapping write creates pending item.
      const pendingRes = store.runCalendarWrite({
        updating: false,
        input: {
          title: '待确认会议',
          start: '2026-11-25T13:00:00+08:00',
          end: '2026-11-25T17:00:00+08:00',
        },
        conversationId: 1,
        taskId: 2,
        callId: 'pending-call',
      });
      assert.equal(pendingRes.status, 'needs_confirmation');
      const cid = pendingRes.confirmationId;

      // Replay with same operation key returns cached result.
      assert.deepEqual(
        store.runCalendarWrite({
          updating: false,
          input: {
            title: '待确认会议',
            start: '2026-11-25T13:00:00+08:00',
            end: '2026-11-25T17:00:00+08:00',
          },
          conversationId: 1,
          taskId: 2,
          callId: 'pending-call',
        }),
        pendingRes,
      );

      // Unauthorized confirm cannot commit.
      const unauth = store.runCalendarWrite({
        updating: false,
        input: {confirmationId: cid},
        conversationId: 1,
        taskId: 3,
        callId: 'unauth',
      });
      assert.equal(unauth.status, 'needs_confirmation');
      assert.equal(store.allCalendarEvents().length, 1);

      // Add a second conflict before user confirms.
      const secondConflict = store.runCalendarWrite({
        updating: false,
        input: {
          title: '新冲突',
          start: '2026-11-25T16:00:00+08:00',
          end: '2026-11-25T17:00:00+08:00',
        },
        conversationId: 2,
        taskId: 4,
        callId: 'second-conflict',
      });
      assert.equal(secondConflict.status, 'created');

      // Authorize via prompt and confirm -> recheck detects new conflict and revokes authorization.
      const auth1 = store.beginPromptRequest(2, 'req-confirm-1', `确认重叠 ${cid}`);
      assert.deepEqual(auth1, {status: 'inserted', confirmationId: cid, authorizedChanged: true});
      const recheck = store.runCalendarWrite({
        updating: false,
        input: {confirmationId: cid},
        conversationId: 2,
        taskId: 5,
        callId: 'recheck',
      });
      assert.equal(recheck.status, 'needs_confirmation');
      assert.equal(recheck.conflicts.length, 2);
      assert.equal(store.getCalendarSnapshot().pending[cid].authorized, false);

      // Confirm again -> now succeeds across conversations.
      const auth2 = store.beginPromptRequest(2, 'req-confirm-2', `确认重叠 ${cid}`);
      assert.deepEqual(auth2, {status: 'inserted', confirmationId: cid, authorizedChanged: true});
      const confirmed = store.runCalendarWrite({
        updating: false,
        input: {confirmationId: cid},
        conversationId: 2,
        taskId: 6,
        callId: 'confirm-ok',
      });
      assert.equal(confirmed.status, 'created');
      assert.equal(store.allCalendarEvents().length, 3);

      // Repeat confirmation returns cached created result without adding duplicates.
      assert.deepEqual(
        store.runCalendarWrite({
          updating: false,
          input: {confirmationId: cid},
          conversationId: 2,
          taskId: 7,
          callId: 'confirm-repeat',
        }),
        confirmed,
      );
      assert.equal(store.allCalendarEvents().length, 3);

      // Delete the wide spanning event so we can mutate seedId cleanly without overlap.
      store.deleteCalendarEvent({
        eventId: confirmed.event.id,
        conversationId: 1,
        taskId: 8,
        callId: 'cleanup-wide',
      });

      // Stale guard on update pending: create overlapping update, mutate target first, then confirm.
      const updatePending = store.runCalendarWrite({
        updating: true,
        input: {
          eventId: seedId,
          start: '2026-11-25T16:00:00+08:00',
          end: '2026-11-25T17:00:00+08:00',
        },
        conversationId: 1,
        taskId: 9,
        callId: 'upd-pending',
      });
      assert.equal(updatePending.status, 'needs_confirmation');
      const updCid = updatePending.confirmationId;

      // Leave an unresolved pending item alongside to verify unresolved pending is NEVER pruned.
      const unresolvedPending = store.runCalendarWrite({
        updating: false,
        input: {
          title: '保留未确认',
          start: '2026-11-25T14:00:00+08:00',
          end: '2026-11-25T14:30:00+08:00',
        },
        conversationId: 1,
        taskId: 10,
        callId: 'unresolved',
      });
      assert.equal(unresolvedPending.status, 'needs_confirmation');

      const mutated = store.runCalendarWrite({
        updating: true,
        input: {
          eventId: seedId,
          title: '被外部改过',
          start: '2026-11-25T10:00:00+08:00',
          end: '2026-11-25T11:00:00+08:00',
        },
        conversationId: 1,
        taskId: 11,
        callId: 'mutate-before-confirm',
      });
      assert.equal(mutated.status, 'updated');
      store.beginPromptRequest(1, 'req-confirm-stale', `确认重叠 ${updCid}`);
      const staleResult = store.runCalendarWrite({
        updating: true,
        input: {confirmationId: updCid},
        conversationId: 1,
        taskId: 12,
        callId: 'confirm-stale',
      });
      assert.equal(staleResult.status, 'stale');

      // Delete target and verify not_found on subsequent update confirmation.
      const delPending = store.runCalendarWrite({
        updating: true,
        input: {
          eventId: seedId,
          start: '2026-11-25T16:00:00+08:00',
          end: '2026-11-25T17:00:00+08:00',
        },
        conversationId: 1,
        taskId: 13,
        callId: 'del-pending',
      });
      assert.equal(delPending.status, 'needs_confirmation');
      store.deleteCalendarEvent({eventId: seedId, conversationId: 1, taskId: 14, callId: 'del-target'});
      store.beginPromptRequest(1, 'req-confirm-del', `确认重叠 ${delPending.confirmationId}`);
      const notFoundResult = store.runCalendarWrite({
        updating: true,
        input: {confirmationId: delPending.confirmationId},
        conversationId: 1,
        taskId: 15,
        callId: 'confirm-del',
      });
      assert.deepEqual(notFoundResult, {status: 'not_found', eventId: seedId});

      // Verify window pruning ran without dropping unresolved pending.
      const raw = new DatabaseSync(dbPath, {readOnly: true});
      try {
        const opCount = (raw.prepare('SELECT COUNT(*) AS n FROM calendar_operations').get() as {n: number}).n;
        const resolvedCount = (
          raw.prepare('SELECT COUNT(*) AS n FROM calendar_pending WHERE result_json IS NOT NULL').get() as {n: number}
        ).n;
        const openRow = raw
          .prepare('SELECT confirmation_id FROM calendar_pending WHERE confirmation_id = ?')
          .get(unresolvedPending.confirmationId) as {confirmation_id: string} | undefined;
        assert.ok(opCount <= 5, `Expected pruned operations <= 5, got ${opCount}`);
        assert.ok(resolvedCount <= 2, `Expected pruned resolved pending <= 2, got ${resolvedCount}`);
        assert.equal(openRow?.confirmation_id, unresolvedPending.confirmationId);
      } finally {
        raw.close();
      }
    } finally {
      store.close();
    }
  });

  test('supports bounded sliding window request dedup, conflict detection, and safe rollback', () => {
    const store = openPersonalStore(dbPath, {
      now: () => Date.parse('2026-11-23T09:00:00+08:00'),
      requestDedupWindow: 4,
    });
    try {
      const pending = store.runCalendarWrite({
        updating: false,
        input: {
          title: '占位',
          start: '2026-11-26T10:00:00+08:00',
          end: '2026-11-26T11:00:00+08:00',
        },
        conversationId: 1,
        taskId: 1,
        callId: 'base',
      });
      assert.equal(pending.status, 'created');
      const overlap = store.runCalendarWrite({
        updating: false,
        input: {
          title: '重叠项',
          start: '2026-11-26T10:30:00+08:00',
          end: '2026-11-26T11:30:00+08:00',
        },
        conversationId: 1,
        taskId: 2,
        callId: 'overlap',
      });
      assert.equal(overlap.status, 'needs_confirmation');
      const cid = overlap.confirmationId;

      assert.deepEqual(store.beginPromptRequest(1, 'r1', '你好'), {status: 'inserted', authorizedChanged: false});
      assert.deepEqual(store.beginPromptRequest(1, 'r1', '你好'), {status: 'existing'});
      assert.deepEqual(store.beginPromptRequest(1, 'r1', '改字'), {status: 'conflict'});
      // Same requestId in different conversation is isolated.
      assert.deepEqual(store.beginPromptRequest(2, 'r1', '改字'), {status: 'inserted', authorizedChanged: false});

      // Rollback reverts authorized only when authorizedChanged was true.
      const auth = store.beginPromptRequest(1, 'r-auth', `确认重叠 ${cid}`);
      assert.equal(auth.status, 'inserted');
      assert.equal(auth.authorizedChanged, true);
      assert.equal(store.getCalendarSnapshot().pending[cid].authorized, true);
      store.rollbackPromptRequest(1, 'r-auth', cid);
      assert.equal(store.getCalendarSnapshot().pending[cid].authorized, false);
      assert.deepEqual(store.beginPromptRequest(1, 'r-auth', `确认重叠 ${cid}`), {
        status: 'inserted',
        confirmationId: cid,
        authorizedChanged: true,
      });

      // Sliding window prunes oldest rows beyond 4.
      store.beginPromptRequest(1, 'r3', 'a');
      store.beginPromptRequest(1, 'r4', 'b');
      store.beginPromptRequest(1, 'r5', 'c');
      const raw = new DatabaseSync(dbPath, {readOnly: true});
      try {
        const count = (raw.prepare('SELECT COUNT(*) AS n FROM request_dedup').get() as {n: number}).n;
        assert.equal(count, 4);
      } finally {
        raw.close();
      }
    } finally {
      store.close();
    }
  });

  test('stores notes >4000 chars without truncation and respects operation idempotency', () => {
    const store = openPersonalStore(dbPath);
    try {
      const longNote = '笔记正文-'.repeat(1200); // > 6000 chars
      assert.ok(longNote.length > 4000);
      assert.deepEqual(store.saveNote(longNote, '1:10:call-a'), {changed: true, text: longNote});
      assert.deepEqual(store.saveNote('ignored replay', '1:10:call-a'), {changed: false, text: longNote});
      assert.equal(store.getNote(), longNote);
    } finally {
      store.close();
    }
  });
});
