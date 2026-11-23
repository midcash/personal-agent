import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {BACKGROUND_CONTEXT as ctx} from '@earendil-works/chord/context';
import {Harness, createRegistry, defineExtension, type TaskId} from '@earendil-works/pi-durable';
import {createModels} from '@earendil-works/pi-ai/models';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import {Timer} from '../../durable_mvp/agent.ts';
import {DEFAULT_TIME_ZONE, nowInDefaultZone} from '../../durable_mvp/calendar-time.ts';
import {SessionTimers} from '../../durable_mvp/documents.ts';
import {openPersonalStore} from '../../durable_mvp/personal-store.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ENV_ALLOWLIST = new Set([
  'PATH',
  'SYSTEMROOT',
  'WINDIR',
  'TEMP',
  'TMP',
  'PATHEXT',
  'COMSPEC',
  'HOME',
  'USERPROFILE',
]);

interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  timeZone: string;
}

interface Message {
  id: number | string;
  role: 'user' | 'assistant' | 'toolResult' | 'system';
  kind?: string;
  text: string;
  calls: string[];
  error: boolean;
  model?: string;
  from?: {provider: string; modelId: string} | null;
  to?: {provider: string; modelId: string};
  reason?: 'startup' | 'user';
}

interface PendingEntry {
  event: CalendarEvent;
  conflicts?: CalendarEvent[];
  authorized: boolean;
  updateId?: string;
  result?: {status: string; message?: string; conflicts?: CalendarEvent[]};
}

interface StatePayload {
  conversationId: number;
  mode: string;
  model: {provider: string; modelId: string};
  availableModels: {provider: string; modelId: string}[];
  conversations: {id: number; title: string; model?: {provider: string; modelId: string}; busy: boolean; createdAt: string}[];
  messages: Message[];
  note: string;
  timers: {id: string; until: number; state?: {status: string; outcome?: {status: string}}}[];
  calendar: {
    events: CalendarEvent[];
    pending: Record<string, PendingEntry>;
    operations?: Record<string, {message?: string; conflicts?: CalendarEvent[]}>;
  };
  busy: boolean;
  fatal: boolean;
  counts: {model: number; tool: number};
}

class HttpError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body}`);
    this.status = status;
    this.body = body;
  }
}

function offlineEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && ENV_ALLOWLIST.has(key.toUpperCase())) env[key] = value;
  }
  return env;
}

class Host {
  readonly url: string;
  readonly output: string[];
  private readonly process: ChildProcess;
  private readonly closePromise: Promise<void>;

  private constructor(
    url: string,
    proc: ChildProcess,
    output: string[],
    closePromise: Promise<void>,
  ) {
    this.url = url;
    this.process = proc;
    this.output = output;
    this.closePromise = closePromise;
  }

  static async start(
    folder: string,
    options: {args?: readonly string[]; env?: Record<string, string>} = {},
  ): Promise<Host> {
    const proc = spawn(
      process.execPath,
      [path.join(ROOT, 'durable_mvp/server.ts'), '--data', folder, '--port', '0', ...(options.args ?? [])],
      {cwd: ROOT, env: {...offlineEnv(), ...(options.env ?? {})}, stdio: ['ignore', 'pipe', 'pipe']},
    );
    const output: string[] = [];
    const closePromise = new Promise<void>(resolve => {
      proc.once('close', () => resolve());
    });

    let buffer = '';
    let settled = false;
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          settled = true;
          reject(new Error('Host startup timeout: ' + output.join('')));
        }, 20000);
        const onText = (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          output.push(text);
          if (settled) return;
          buffer += text;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (line.startsWith('DURABLE_MVP ')) {
              settled = true;
              clearTimeout(timer);
              resolve(line.slice('DURABLE_MVP '.length).trim());
              return;
            }
          }
        };
        proc.stdout.on('data', onText);
        proc.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
        proc.once('error', err => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
        proc.once('close', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(output.join('') || 'Host exited before ready'));
        });
      });
      return new Host(url, proc, output, closePromise);
    } catch (err) {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill();
      await closePromise;
      throw err;
    }
  }

  async call<T = unknown>(
    route: string,
    data?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    const target = new URL(route, this.url);
    const payload = data === undefined ? undefined : Buffer.from(JSON.stringify(data), 'utf8');
    const requestHeaders: Record<string, string> = {
      Connection: 'close',
      ...(headers ?? (payload === undefined ? {} : {'Content-Type': 'application/json'})),
    };
    if (payload !== undefined) requestHeaders['Content-Length'] = String(payload.length);

    return new Promise<T>((resolve, reject) => {
      const req = http.request(
        target,
        {method: payload === undefined ? 'GET' : 'POST', headers: requestHeaders, agent: false},
        res => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode ?? 0;
            if (status >= 400) {
              reject(new HttpError(status, raw));
              return;
            }
            resolve(JSON.parse(raw) as T);
          });
        },
      );
      req.setTimeout(20000, () => req.destroy(new Error('HTTP request timeout')));
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  async wait(
    condition: (state: StatePayload) => boolean = state => !state.busy,
    timeoutMs = 20000,
    conversationId?: number,
  ): Promise<StatePayload> {
    const route = conversationId !== undefined ? `/state?conversationId=${conversationId}` : '/state';
    const deadline = Date.now() + timeoutMs;
    let lastState: StatePayload | undefined;
    while (Date.now() < deadline) {
      lastState = await this.call<StatePayload>(route);
      if (condition(lastState)) return lastState;
      await delay(50);
    }
    throw new Error('State deadline: ' + JSON.stringify(lastState));
  }

  prompt(text: string, requestId: string, conversationId?: number): Promise<{submissionId: string; conversationId: number}> {
    return this.call<{submissionId: string; conversationId: number}>('/prompt', {
      text,
      requestId,
      ...(conversationId !== undefined ? {conversationId} : {}),
    });
  }

  async kill(): Promise<void> {
    if (this.process.exitCode === null && this.process.signalCode === null) {
      this.process.kill();
    }
    await this.closePromise;
  }
}

function rawPost(
  baseUrl: string,
  contentType: string,
  body: Buffer,
  origin?: string,
): Promise<string> {
  const parsed = new URL(baseUrl);
  const originHeader = origin ? `Origin: ${origin}\r\n` : '';
  const head = Buffer.from(
    `POST /prompt HTTP/1.1\r\nHost: ${parsed.host}\r\n` +
      `Content-Type: ${contentType}\r\nContent-Length: ${body.length}\r\n` +
      `${originHeader}Connection: keep-alive\r\n\r\n`,
    'utf8',
  );
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({host: parsed.hostname, port: Number(parsed.port)}, () => {
      socket.write(Buffer.concat([head, body]));
    });
    const chunks: Buffer[] = [];
    socket.setTimeout(10000, () => socket.destroy(new Error('Raw socket timeout')));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
}

async function accessInstructions(folder: string, seed?: string): Promise<string> {
  const registry = createRegistry();
  registry.install(defineExtension({name: 'mvp'}));
  const storage = await openNodeSqliteStorage(path.join(folder, 'session.sqlite'));
  const harness = await Harness.open(storage, {models: createModels(), registry}, ctx);
  try {
    const root = await harness.root(ctx);
    if (seed !== undefined) await root.configure({instructions: seed}, ctx);
    return (await root.agent(ctx)).instructions ?? '';
  } finally {
    await harness.close(ctx);
  }
}

async function seedOver200PersonalData(folder: string): Promise<void> {
  const store = openPersonalStore(path.join(folder, 'personal.sqlite'));
  try {
    const baseMs = Date.parse('2026-12-01T00:00:00+08:00');
    for (let index = 0; index < 250; index++) {
      const startMs = baseMs + index * 2 * 3600 * 1000;
      const endMs = startMs + 3600 * 1000;
      const start = new Date(startMs + 8 * 3600 * 1000).toISOString().replace('.000Z', '+08:00');
      const end = new Date(endMs + 8 * 3600 * 1000).toISOString().replace('.000Z', '+08:00');
      store.runCalendarWrite({
        updating: false,
        input: {title: `历史日程-${index}`, start, end, timeZone: 'Etc/GMT-8'},
        conversationId: 1,
        taskId: index + 1,
        callId: `seed-cal-${index}`,
      });
      store.beginPromptRequest(1, `seed-req-${index}`, `历史请求-${index}`);
    }
  } finally {
    store.close();
  }
}

async function seedSessionTimers(folder: string, count: number, completed: boolean): Promise<void> {
  const registry = createRegistry();
  registry.install(defineExtension({name: 'mvp', tasks: [Timer]}));
  const storage = await openNodeSqliteStorage(path.join(folder, 'session.sqlite'));
  const harness = await Harness.open(storage, {models: createModels(), registry}, ctx);
  try {
    const root = await harness.root(ctx);
    const createdIds: TaskId<string>[] = [];
    await root.commit(async tx => {
      const doc = await tx.doc(SessionTimers);
      const until = completed ? Date.now() - 1000 : Date.now() + 600_000;
      for (let i = 0; i < count; i++) {
        const id = await tx.createTask(
          Timer,
          {until, conversationId: root.id},
          {ownership: {kind: 'conversation'}, background: true},
        );
        doc.items.push({id, until});
        createdIds.push(id);
      }
    }, ctx);
    if (completed) {
      harness.resume();
      await Promise.all(createdIds.map(id => harness.waitForTask(id, ctx)));
    }
  } finally {
    await harness.close(ctx);
  }
}

function lastToolResult(state: StatePayload): Message {
  const found = [...state.messages].reverse().find(m => m.role === 'toolResult');
  assert.ok(found, 'Expected a toolResult message');
  return found;
}

describe('durable-mvp', () => {
  let tempDir: string;
  let host: Host;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-mvp-test-'));
    host = await Host.start(tempDir);
  });

  afterEach(async () => {
    await host.kill();
    fs.rmSync(tempDir, {recursive: true, force: true});
  });

  async function restart() {
    await host.kill();
    host = await Host.start(tempDir);
  }

  async function calendarPrompt(event: Record<string, unknown>, requestId: string) {
    await host.prompt('/calendar ' + JSON.stringify(event), requestId);
    return host.wait();
  }

  test('note restore and idempotent retry', async () => {
    const receipt = await host.prompt('/note MVP笔记', 'note-1');
    const before = await host.wait();
    assert.equal(before.note, 'MVP笔记');
    assert.deepEqual(before.counts, {model: 2, tool: 1});
    assert.deepEqual(await host.prompt('/note MVP笔记', 'note-1'), receipt);
    assert.deepEqual((await host.wait()).counts, before.counts);

    await restart();
    const after = await host.wait();
    assert.deepEqual(after.messages, before.messages);
    assert.equal(after.note, before.note);
    assert.deepEqual(after.counts, {model: 0, tool: 0});
    assert.deepEqual(await host.prompt('/note MVP笔记', 'note-1'), receipt);
    assert.deepEqual((await host.wait()).counts, {model: 0, tool: 0});

    await assert.rejects(
      () => host.prompt('different', 'note-1'),
      err => err instanceof HttpError && err.status === 409,
    );
    await host.prompt('继续', 'next-1');
    const next = await host.wait();
    assert.ok(next.messages[next.messages.length - 1].text.includes('继续'));
  });

  test('calendar create, query, restart, and retry', async () => {
    const event = {
      title: '项目评审',
      start: '2026-11-06T15:00:00+08:00',
      end: '2026-11-06T16:00:00+08:00',
      timeZone: 'Etc/GMT-8',
    };
    const before = await calendarPrompt(event, 'calendar-1');
    assert.equal(before.calendar.events.length, 1);
    const saved = before.calendar.events[0];
    assert.deepEqual(
      {title: saved.title, start: saved.start, end: saved.end, timeZone: saved.timeZone},
      event,
    );

    const query = {start: '2026-11-06T00:00:00+08:00', end: '2026-11-07T00:00:00+08:00'};
    await host.prompt('/events ' + JSON.stringify(query), 'query-1');
    const state = await host.wait();
    const result = JSON.parse(lastToolResult(state).text) as {events: CalendarEvent[]};
    assert.deepEqual(result.events, [saved]);
    assert.deepEqual(
      await host.call('/calendar?start=2026-11-06T00:00:00Z&end=2026-11-07T00:00:00Z'),
      [saved],
    );
    assert.deepEqual(
      await host.call('/calendar?start=2026-11-07T00:00:00Z&end=2026-11-08T00:00:00Z'),
      [],
    );

    await restart();
    const restored = await host.wait();
    assert.deepEqual(restored.calendar, state.calendar);
    assert.deepEqual(restored.messages, state.messages);
    const retried = await calendarPrompt(event, 'calendar-1');
    assert.deepEqual(retried.calendar, state.calendar);
    assert.deepEqual(retried.counts, {model: 0, tool: 0});
  });

  test('calendar default timezone is fixed UTC+8', async () => {
    const event = {
      title: '默认时区',
      start: '2026-11-06T09:00:00+08:00',
      end: '2026-11-06T10:00:00+08:00',
    };
    const state = await calendarPrompt(event, 'default-zone');
    assert.equal(state.calendar.events.length, 1);
    assert.equal(state.calendar.events[0].timeZone, 'Etc/GMT-8');

    const other = {
      title: '偏移不符',
      start: '2026-11-06T09:00:00+09:00',
      end: '2026-11-06T10:00:00+09:00',
    };
    const rejected = await calendarPrompt(other, 'default-zone-mismatch');
    assert.deepEqual(rejected.calendar.events, state.calendar.events);
    assert.ok(lastToolResult(rejected).text.includes('时间偏移与 timeZone 不一致'));

    const allowed = await calendarPrompt({...other, timeZone: 'Asia/Tokyo'}, 'explicit-zone');
    assert.equal(allowed.calendar.events.length, 2);
    assert.equal(allowed.calendar.events[1].timeZone, 'Asia/Tokyo');
  });

  test('prompt clock is fixed UTC+8', () => {
    const formatter = new Intl.DateTimeFormat('sv-SE', {
      timeZone: DEFAULT_TIME_ZONE,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const wallClock = (ms: number) => formatter.format(ms).replace(' ', 'T');
    const samples = [
      ['2026-11-06T16:30:00Z', '2026-11-07T00:30'],
      ['2026-11-06T15:59:59Z', '2026-11-06T23:59'],
      ['2026-03-08T20:00:00Z', '2026-03-09T04:00'],
    ] as const;

    for (const [value, expectedPrefix] of samples) {
      const ms = Date.parse(value);
      const actual = nowInDefaultZone(ms);
      assert.equal(actual.slice(0, 16), expectedPrefix);
      assert.equal(Date.parse(actual), ms);
      assert.ok(actual.startsWith(wallClock(ms)));
    }

    const clockLines = fs
      .readFileSync(path.join(ROOT, 'durable_mvp/agent.ts'), 'utf8')
      .split(/\r?\n/)
      .filter(line => line.includes('Current time'));
    assert.equal(clockLines.length, 1);
    assert.ok(clockLines[0].includes('nowInDefaultZone()'));
  });

  test('calendar update, delete, and move', async () => {
    const event = {
      title: '动车',
      start: '2026-11-06T21:00:00+08:00',
      end: '2026-11-06T22:00:00+08:00',
    };
    let state = await calendarPrompt(event, 'seed');
    const saved = state.calendar.events[0];

    async function tool(command: string, args: Record<string, unknown>, key: string) {
      await host.prompt(command + ' ' + JSON.stringify(args), key);
      return host.wait();
    }

    state = await tool('/update', {eventId: saved.id, title: '航班'}, 'rename');
    assert.deepEqual(state.calendar.events[0], {...saved, title: '航班'});

    state = await tool(
      '/update',
      {
        eventId: saved.id,
        start: '2026-11-08T21:00:00+08:00',
        end: '2026-11-08T22:00:00+08:00',
      },
      'move',
    );
    const moved = state.calendar.events[0];
    assert.equal(moved.id, saved.id);
    assert.equal(moved.title, '航班');
    assert.equal(moved.start, '2026-11-08T21:00:00+08:00');
    assert.equal(moved.end, '2026-11-08T22:00:00+08:00');

    const invalid = await tool('/update', {eventId: saved.id, end: moved.start}, 'invalid');
    assert.deepEqual(invalid.calendar.events, [moved]);

    const absent = await tool('/delete', {eventId: 'unknown'}, 'absent');
    assert.deepEqual(absent.calendar.events, [moved]);

    state = await tool('/delete', {eventId: saved.id}, 'delete');
    assert.deepEqual(state.calendar.events, []);

    await restart();
    assert.deepEqual((await host.wait()).calendar, state.calendar);
    const retry = await tool('/delete', {eventId: saved.id}, 'delete');
    assert.deepEqual(retry.counts, {model: 0, tool: 0});
  });

  test('calendar create rejects edit id', async () => {
    const event = {
      title: '原安排',
      start: '2026-11-06T21:00:00+08:00',
      end: '2026-11-06T22:00:00+08:00',
    };
    const before = (await calendarPrompt(event, 'original')).calendar;
    const saved = before.events[0];
    const bad = {
      ...event,
      eventId: saved.id,
      start: '2026-11-08T21:00:00+08:00',
      end: '2026-11-08T22:00:00+08:00',
    };
    const state = await calendarPrompt(bad, 'mistaken-create');
    assert.deepEqual(state.calendar, before);
    assert.ok(lastToolResult(state).text.includes('update_calendar_event'));
    assert.ok(state.messages[state.messages.length - 1].text.includes('工具失败'));
  });

  test('existing session refreshes app instructions', async () => {
    const before = await calendarPrompt(
      {
        title: '保留日程',
        start: '2026-11-06T21:00:00+08:00',
        end: '2026-11-06T22:00:00+08:00',
      },
      'keep',
    );
    await host.kill();
    assert.ok((await accessInstructions(tempDir, '不支持改期、删除。')).includes('不支持改期'));

    host = await Host.start(tempDir);
    const after = await host.wait();
    assert.deepEqual(after.messages, before.messages);
    assert.deepEqual(after.calendar, before.calendar);
    assert.deepEqual(after.counts, {model: 0, tool: 0});

    await host.kill();
    const instructions = await accessInstructions(tempDir);
    assert.ok(instructions.includes('支持读取、新增、修改、改期和删除'));
    assert.ok(!instructions.includes('不支持改期'));
  });

  test('calendar update overlap confirmation and deleted target', async () => {
    const a = {
      title: '原安排',
      start: '2026-11-06T21:00:00+08:00',
      end: '2026-11-06T22:00:00+08:00',
    };
    const b = {
      title: '另一个安排',
      start: '2026-11-07T21:00:00+08:00',
      end: '2026-11-07T22:00:00+08:00',
    };
    const first = (await calendarPrompt(a, 'a')).calendar.events[0];
    await calendarPrompt(b, 'b');

    await host.prompt(
      '/update ' + JSON.stringify({eventId: first.id, start: b.start, end: b.end}),
      'overlap',
    );
    let state = await host.wait();
    assert.deepEqual(state.calendar.events[0], first);
    const firstCid = Object.keys(state.calendar.pending)[0];

    await restart();
    await host.prompt('确认重叠 ' + firstCid, 'confirm');
    state = await host.wait();
    assert.equal(state.calendar.events.length, 2);
    assert.equal(state.calendar.events[0].start, b.start);
    assert.equal(state.calendar.events[0].end, b.end);
    assert.equal(state.calendar.events[0].id, first.id);

    await host.prompt('确认重叠 ' + firstCid, 'confirm-again');
    assert.deepEqual((await host.wait()).calendar.events, state.calendar.events);

    await host.prompt('/update ' + JSON.stringify({eventId: first.id, title: '新标题'}), 'pending-again');
    state = await host.wait();
    const secondCid = Object.entries(state.calendar.pending).find(([, v]) => !v.result)?.[0];
    assert.ok(secondCid);

    await host.prompt('/delete ' + JSON.stringify({eventId: first.id}), 'remove-target');
    const remaining = (await host.wait()).calendar.events;

    await host.prompt('确认重叠 ' + secondCid, 'confirm-deleted');
    state = await host.wait();
    assert.deepEqual(state.calendar.events, remaining);
    assert.equal(state.calendar.pending[secondCid].result?.status, 'not_found');
  });

  test('calendar missing, invalid, and overlap confirmation', async () => {
    let state = await calendarPrompt({title: '信息不足'}, 'missing-1');
    assert.ok(state.messages[state.messages.length - 1].text.includes('needs_information'));
    assert.deepEqual(state.calendar.events, []);

    const event = {
      title: '原会议',
      start: '2026-11-06T15:00:00+08:00',
      end: '2026-11-06T16:00:00+08:00',
      timeZone: 'Etc/GMT-8',
    };
    const invalidPayloads = [
      {end: event.start},
      {start: '2026-02-30T15:00:00+08:00'},
      {timeZone: 'Europe/Paris'},
      {start: '2026-11-06T15:00:00'},
    ];
    for (const [index, change] of invalidPayloads.entries()) {
      state = await calendarPrompt({...event, ...change}, `invalid-${index}`);
      assert.deepEqual(state.calendar.events, []);
      assert.equal(lastToolResult(state).error, true);
    }

    await calendarPrompt(event, 'original-1');
    state = await calendarPrompt({...event, title: '重叠会议'}, 'overlap-1');
    assert.equal(state.calendar.events.length, 1);
    const token = Object.keys(state.calendar.pending)[0];

    const unauthorized = await calendarPrompt({confirmationId: token}, 'fake-confirm-1');
    assert.equal(unauthorized.calendar.events.length, 1);
    assert.equal(unauthorized.calendar.pending[token].authorized, false);

    await restart();
    await host.wait();
    await host.prompt('确认重叠 ' + token, 'confirm-1');
    const confirmed = await host.wait();
    assert.equal(confirmed.calendar.events.length, 2);

    await calendarPrompt({confirmationId: token}, 'confirm-again');
    assert.equal((await host.wait()).calendar.events.length, 2);

    const adjacent = {
      ...event,
      title: '接续会议',
      start: event.end,
      end: '2026-11-06T17:00:00+08:00',
    };
    assert.equal((await calendarPrompt(adjacent, 'adjacent-1')).calendar.events.length, 3);
  });

  test('calendar confirmation rechecks new conflicts', async () => {
    const event = {
      title: '原安排',
      start: '2026-11-06T14:00:00+08:00',
      end: '2026-11-06T15:00:00+08:00',
    };
    await calendarPrompt(event, 'first');
    let state = await calendarPrompt(
      {
        ...event,
        title: '待确认',
        start: '2026-11-06T13:00:00+08:00',
        end: '2026-11-06T17:00:00+08:00',
      },
      'pending',
    );
    const token = Object.keys(state.calendar.pending)[0];

    state = await calendarPrompt(
      {
        ...event,
        title: '新冲突',
        start: '2026-11-06T16:00:00+08:00',
        end: '2026-11-06T17:00:00+08:00',
      },
      'new',
    );
    assert.equal(state.calendar.events[0].timeZone, 'Etc/GMT-8');

    await host.prompt('确认重叠 ' + token, 'approve-first');
    state = await host.wait();
    assert.equal(state.calendar.events.length, 2);
    assert.equal(state.calendar.pending[token].authorized, false);
    assert.equal(state.calendar.pending[token].conflicts?.length, 2);

    const result = JSON.parse(lastToolResult(state).text) as {
      conflicts: CalendarEvent[];
      message?: string;
    };
    const cached = Object.values(state.calendar.operations ?? {}).filter(
      value => value.message === '出现新的冲突，请用户重新确认',
    );
    assert.deepEqual(cached, [result]);
    assert.deepEqual(result.conflicts, state.calendar.pending[token].conflicts);

    await restart();
    const restored = await host.wait();
    assert.deepEqual(restored.calendar, state.calendar);
    assert.deepEqual(restored.counts, {model: 0, tool: 0});

    await host.prompt('确认重叠 ' + token, 'approve-again');
    state = await host.wait();
    assert.equal(state.calendar.events.length, 3);
  });

  test('calendar, requests, and notes exceed legacy 200/4000 caps without limit errors', async () => {
    await host.kill();
    await seedOver200PersonalData(tempDir);
    host = await Host.start(tempDir);

    const state251 = await calendarPrompt(
      {
        title: '第251条日程',
        start: '2026-11-06T14:00:00+08:00',
        end: '2026-11-06T15:00:00+08:00',
      },
      'req-251',
    );
    assert.equal(state251.calendar.events.length, 251);
    assert.equal(state251.calendar.events[250].title, '第251条日程');

    // Overlap confirmation on #252 succeeds cleanly beyond 200 events and 200 requests.
    const overlapState = await calendarPrompt(
      {
        title: '第252条重叠日程',
        start: '2026-11-06T14:30:00+08:00',
        end: '2026-11-06T15:30:00+08:00',
      },
      'req-252',
    );
    assert.equal(overlapState.calendar.events.length, 251);
    const cid = Object.keys(overlapState.calendar.pending)[0];
    assert.ok(cid);
    await host.prompt('确认重叠 ' + cid, 'req-253');
    const confirmed = await host.wait();
    assert.equal(confirmed.calendar.events.length, 252);

    // Note >4000 chars persisted intact via store/tool path without 4000-char cap.
    const store = openPersonalStore(path.join(tempDir, 'personal.sqlite'));
    try {
      const longNote = '长笔记'.repeat(1600);
      assert.ok(longNote.length > 4000);
      store.saveNote(longNote, 'manual-long-note');
    } finally {
      store.close();
    }
    const afterNote = await host.wait();
    assert.ok(afterNote.note.length > 4000);
  });

  test('multi-conversation isolates transcripts while sharing calendar and note, and survives session.sqlite deletion', async () => {
    await host.prompt('/note 跨会话共享笔记', 'conv1-note');
    await host.wait();
    const conv1State = await calendarPrompt(
      {
        title: '跨会话会议',
        start: '2026-11-06T15:00:00+08:00',
        end: '2026-11-06T16:00:00+08:00',
      },
      'conv1-cal',
    );
    assert.equal(conv1State.conversations.length, 1);

    const created = await host.call<{id: number; title: string}>('/conversations', {title: '第二个对话'});
    assert.ok(created.id > conv1State.conversationId);

    const conv2Initial = await host.wait(undefined, 20000, created.id);
    assert.equal(conv2Initial.conversationId, created.id);
    assert.deepEqual(conv2Initial.messages, []);
    assert.equal(conv2Initial.note, '跨会话共享笔记');
    assert.deepEqual(conv2Initial.calendar.events, conv1State.calendar.events);
    assert.equal(conv2Initial.conversations.length, 2);

    // Trigger overlap in conv 1, then confirm it from conv 2.
    await host.prompt(
      '/calendar ' +
        JSON.stringify({
          title: '跨会话确认日程',
          start: '2026-11-06T15:30:00+08:00',
          end: '2026-11-06T16:30:00+08:00',
        }),
      'conv1-overlap',
      conv1State.conversationId,
    );
    const pendingState = await host.wait(undefined, 20000, conv1State.conversationId);
    const cid = Object.keys(pendingState.calendar.pending)[0];
    assert.ok(cid);

    await host.prompt('确认重叠 ' + cid, 'conv2-confirm', created.id);
    const conv2After = await host.wait(undefined, 20000, created.id);
    assert.equal(conv2After.calendar.events.length, 2);
    assert.ok(conv2After.messages.some(m => m.role === 'user' && m.text.includes('确认重叠')));

    const conv1After = await host.wait(undefined, 20000, conv1State.conversationId);
    assert.equal(conv1After.calendar.events.length, 2);
    assert.ok(!conv1After.messages.some(m => m.text.includes('确认重叠')));

    // Delete session.sqlite completely and restart; personal.sqlite preserves calendar and note.
    await host.kill();
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(path.join(tempDir, 'session.sqlite' + suffix), {force: true});
    }
    host = await Host.start(tempDir);
    const rebuilt = await host.wait();
    assert.deepEqual(rebuilt.messages, []);
    assert.equal(rebuilt.note, '跨会话共享笔记');
    assert.equal(rebuilt.calendar.events.length, 2);
  });

  test('real mode allows same-directory model switching with transcript record and rejects offline/real mix', async () => {
    await host.kill();

    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-mvp-model-switch-'));
    try {
      const baseEnv = {
        DEEPSEEK_API_KEY: 'test-key-offline-only',
        DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
      };
      // Mixing offline store in real mode must fail without corrupting data.
      await assert.rejects(
        () => Host.start(tempDir, {args: ['--mode', 'deepseek'], env: {...baseEnv, DEEPSEEK_MODEL: 'deepseek-flash'}}),
        /Cannot mix offline and real-model mode/,
      );

      host = await Host.start(realDir, {
        args: ['--mode', 'deepseek'],
        env: {...baseEnv, DEEPSEEK_MODEL: 'deepseek-flash'},
      });
      const initial = await host.wait();
      assert.equal(initial.mode, 'deepseek');
      assert.equal(initial.model.modelId, 'deepseek-flash');
      assert.ok(initial.availableModels.some(m => m.modelId === 'deepseek-v4-pro'));

      const conv2 = await host.call<{id: number}>('/conversations', {title: '保持默认模型'});

      // Runtime switch on conv 1 records mvp.model-changed without affecting conv 2.
      const switchRes = await host.call<{conversationId: number; model: {modelId: string}; changed: boolean}>(
        '/model',
        {conversationId: initial.conversationId, modelId: 'deepseek-v4-pro'},
      );
      assert.equal(switchRes.changed, true);
      assert.equal(switchRes.model.modelId, 'deepseek-v4-pro');

      const conv1AfterSwitch = await host.wait(undefined, 20000, initial.conversationId);
      assert.equal(conv1AfterSwitch.model.modelId, 'deepseek-v4-pro');
      assert.ok(
        conv1AfterSwitch.messages.some(
          m => m.role === 'system' && m.kind === 'model-changed' && m.reason === 'user' && m.to?.modelId === 'deepseek-v4-pro',
        ),
      );
      assert.equal((await host.wait(undefined, 20000, conv2.id)).model.modelId, 'deepseek-flash');

      // Restarting with unchanged DEEPSEEK_MODEL preserves conv 1's user-chosen model.
      await host.kill();
      host = await Host.start(realDir, {
        args: ['--mode', 'deepseek'],
        env: {...baseEnv, DEEPSEEK_MODEL: 'deepseek-flash'},
      });
      assert.equal((await host.wait(undefined, 20000, initial.conversationId)).model.modelId, 'deepseek-v4-pro');
      assert.equal((await host.wait(undefined, 20000, conv2.id)).model.modelId, 'deepseek-flash');

      // Restarting with a new DEEPSEEK_MODEL syncs remaining conversations and appends startup model-changed entry.
      await host.kill();
      host = await Host.start(realDir, {
        args: ['--mode', 'deepseek'],
        env: {...baseEnv, DEEPSEEK_MODEL: 'deepseek-v4-pro'},
      });
      const conv2Synced = await host.wait(undefined, 20000, conv2.id);
      assert.equal(conv2Synced.model.modelId, 'deepseek-v4-pro');
      assert.ok(
        conv2Synced.messages.some(
          m => m.role === 'system' && m.kind === 'model-changed' && m.reason === 'startup' && m.to?.modelId === 'deepseek-v4-pro',
        ),
      );
      // Opening real-mode directory in offline mode must still be rejected.
      await host.kill();
      await assert.rejects(() => Host.start(realDir), /Cannot mix offline and real-model mode/);
    } finally {
      await host.kill();
      fs.rmSync(realDir, {recursive: true, force: true});
    }

    host = await Host.start(tempDir);
  });

  test('completed timers prune cleanly without permanent 20-timer lockup while capping concurrent live timers at 20', async () => {
    await host.kill();
    await seedSessionTimers(tempDir, 20, true);
    host = await Host.start(tempDir);

    const res21 = await host.call<{taskId: number}>('/timer', {});
    assert.ok(res21.taskId > 0);
    const after21 = await host.wait(state => state.timers.some(t => Number(t.id) === res21.taskId));
    assert.ok(after21.timers.length <= 21);

    // Concurrent live (sleeping) timers still cap at 20.
    const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-mvp-live-timers-'));
    try {
      await seedSessionTimers(liveDir, 20, false);
      const liveHost = await Host.start(liveDir);
      try {
        await assert.rejects(
          () => liveHost.call('/timer', {}),
          err => err instanceof HttpError && err.status === 400 && err.body.includes('20'),
        );
      } finally {
        await liveHost.kill();
      }
    } finally {
      fs.rmSync(liveDir, {recursive: true, force: true});
    }
  });

  test('interrupted safe tool resumes', async () => {
    await host.prompt('/slow 恢复完成', 'slow-1');
    await host.wait(state => state.counts.tool === 1);
    await restart();
    const state = await host.wait();
    assert.deepEqual(state.counts, {model: 1, tool: 1});
    assert.ok(state.messages[state.messages.length - 1].text.includes('恢复完成'));
    assert.equal(state.messages.filter(m => m.role === 'user').length, 1);
  });

  test('abort and continue', async () => {
    await host.prompt('/slow 取消这轮', 'abort-1');
    await host.wait(state => state.counts.tool === 1);
    await host.call('/abort', {});
    assert.equal((await host.wait()).busy, false);
    await host.prompt('下一轮', 'abort-2');
    const state = await host.wait();
    assert.ok(state.messages[state.messages.length - 1].text.includes('下一轮'));
  });

  test('tool error is visible and conversation continues', async () => {
    await host.prompt('/fail', 'fail-1');
    const state = await host.wait();
    assert.ok(state.messages.some(m => m.role === 'toolResult' && m.error));
    await host.prompt('还能继续', 'fail-2');
    const next = await host.wait();
    assert.ok(next.messages[next.messages.length - 1].text.includes('还能继续'));
  });

  test('background timer survives restart and abort', async () => {
    await host.call('/timer', {});
    await host.wait(state => state.timers.length > 0 && state.timers[0].state?.status === 'sleeping');
    await host.call('/abort', {});
    await restart();
    const state = await host.wait(state => state.timers[0].state?.status === 'terminal');
    assert.equal(state.timers[0].state?.outcome?.status, 'completed');
    assert.deepEqual(state.counts, {model: 0, tool: 0});
    await restart();
    assert.deepEqual((await host.wait()).timers, state.timers);
  });

  test('read only poll and http boundaries', async () => {
    const before = await host.wait();
    for (let i = 0; i < 3; i++) {
      assert.deepEqual((await host.call<StatePayload>('/state')).counts, before.counts);
    }
    const invalidRequests: [Record<string, string>, number][] = [
      [{Origin: 'https://evil.invalid', 'Content-Type': 'application/json'}, 403],
      [{'Content-Type': 'text/plain'}, 415],
    ];
    for (const [headers, code] of invalidRequests) {
      await assert.rejects(
        () => host.call('/prompt', {text: 'test', requestId: 'test-1'}, headers),
        err => err instanceof HttpError && err.status === code,
      );
    }
    await assert.rejects(
      () => host.prompt(' ', 'empty-1'),
      err => err instanceof HttpError && err.status === 400,
    );
    assert.deepEqual((await host.call<StatePayload>('/state')).messages, before.messages);
  });

  test('json media type with parameters is accepted', async () => {
    const receipt = await host.call<{submissionId: string}>(
      '/prompt',
      {text: '带参数类型', requestId: 'charset-1'},
      {'Content-Type': 'application/json; charset=utf-8'},
    );
    assert.ok('submissionId' in receipt);
    const state = await host.wait();
    assert.ok(state.messages[state.messages.length - 1].text.includes('带参数类型'));
  });

  test('oversized request is rejected and closes connection', async () => {
    const body = Buffer.from(JSON.stringify({text: 'x'.repeat(20000), requestId: 'oversized-1'}), 'utf8');
    const response = await rawPost(host.url, 'application/json', body);
    assert.ok(response.startsWith('HTTP/1.1 413'), response.slice(0, 100));
    assert.ok(response.includes('Connection: close'));
    assert.ok(response.includes('Request too large'));
    assert.deepEqual((await host.call<StatePayload>('/state')).messages, []);
  });

  test('unread rejection closes connection', async () => {
    const body = Buffer.from(JSON.stringify({text: 'x'.repeat(20000), requestId: 'wrong-type-1'}), 'utf8');
    const response = await rawPost(host.url, 'text/plain', body);
    assert.ok(response.startsWith('HTTP/1.1 415'), response.slice(0, 100));
    assert.ok(response.includes('Connection: close'));
    assert.deepEqual((await host.call<StatePayload>('/state')).messages, []);
  });

  test('foreign origin closes unread post', async () => {
    const body = Buffer.from('{"text":"blocked","requestId":"foreign-origin"}', 'utf8');
    const response = await rawPost(host.url, 'application/json', body, 'http://example.invalid');
    assert.ok(response.startsWith('HTTP/1.1 403'), response.slice(0, 100));
    assert.ok(response.includes('Connection: close'));
    assert.deepEqual((await host.call<StatePayload>('/state')).messages, []);
  });

  test('second host cannot open same store', async () => {
    await assert.rejects(() => Host.start(tempDir), /already in use/);
    assert.equal((await host.wait()).fatal, false);
  });

  test('corrupt lock database keeps its own error', async () => {
    const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-mvp-corrupt-'));
    try {
      fs.writeFileSync(
        path.join(corruptDir, 'host.lock.sqlite'),
        Buffer.from('not a sqlite database'.repeat(256)),
      );
      await assert.rejects(
        () => Host.start(corruptDir),
        err => {
          assert.ok(err instanceof Error);
          assert.ok(!err.message.includes('already in use'), err.message);
          assert.ok(err.message.includes('not a database'), err.message);
          return true;
        },
      );
    } finally {
      fs.rmSync(corruptDir, {recursive: true, force: true});
    }
  });

  test('chunked utf8 is not corrupted', async () => {
    const target = new URL('/prompt', host.url);
    const body = Buffer.from(JSON.stringify({text: '/note 分块中文', requestId: 'utf8-1'}), 'utf8');

    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        target,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Transfer-Encoding': 'chunked',
            Connection: 'close',
          },
          agent: false,
        },
        res => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.setTimeout(20000, () => req.destroy(new Error('Chunked request timeout')));
      req.on('error', reject);
      void (async () => {
        for (let index = 0; index < body.length; index++) {
          await new Promise<void>(written => req.write(body.subarray(index, index + 1), () => written()));
        }
        req.end();
      })().catch(reject);
    });

    assert.equal(status, 202);
    assert.equal((await host.wait()).note, '分块中文');
  });
});
