import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentExtension} from '../../durable_mvp/agent.ts';
import {nowInDefaultZone, resolveWhen} from '../../durable_mvp/calendar-time.ts';

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

interface Message {
  role: 'user' | 'assistant' | 'toolResult';
  text: string;
}

interface StatePayload {
  messages: Message[];
  calendar: {
    events: {id: string; title: string; start: string; end: string; timeZone: string}[];
    pending: Record<string, unknown>;
  };
  busy: boolean;
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
  private readonly process: ChildProcess;
  private readonly closePromise: Promise<void>;

  private constructor(url: string, proc: ChildProcess, closePromise: Promise<void>) {
    this.url = url;
    this.process = proc;
    this.closePromise = closePromise;
  }

  static async start(folder: string, args: readonly string[] = []): Promise<Host> {
    const proc = spawn(
      process.execPath,
      [path.join(ROOT, 'durable_mvp/server.ts'), '--data', folder, '--port', '0', ...args],
      {cwd: ROOT, env: offlineEnv(), stdio: ['ignore', 'pipe', 'pipe']},
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
        proc.stdout.on('data', (chunk: Buffer) => {
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
        });
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
      return new Host(url, proc, closePromise);
    } catch (err) {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill();
      await closePromise;
      throw err;
    }
  }

  async call<T = unknown>(route: string, data?: unknown): Promise<T> {
    const target = new URL(route, this.url);
    const payload = data === undefined ? undefined : Buffer.from(JSON.stringify(data), 'utf8');
    const headers: Record<string, string> = {
      Connection: 'close',
      ...(payload === undefined ? {} : {'Content-Type': 'application/json', 'Content-Length': String(payload.length)}),
    };
    return new Promise<T>((resolve, reject) => {
      const req = http.request(
        target,
        {method: payload === undefined ? 'GET' : 'POST', headers, agent: false},
        res => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if ((res.statusCode ?? 0) >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${raw}`));
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

  async wait(timeoutMs = 20000): Promise<StatePayload> {
    const deadline = Date.now() + timeoutMs;
    let lastState: StatePayload | undefined;
    while (Date.now() < deadline) {
      lastState = await this.call<StatePayload>('/state');
      if (!lastState.busy) return lastState;
      await delay(50);
    }
    throw new Error('State deadline: ' + JSON.stringify(lastState));
  }

  prompt(text: string, requestId: string) {
    return this.call('/prompt', {text, requestId});
  }

  async kill(): Promise<void> {
    if (this.process.exitCode === null && this.process.signalCode === null) {
      this.process.kill();
    }
    await this.closePromise;
  }
}

function addIsoDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function toolResult<T = Record<string, unknown>>(state: StatePayload): T {
  const entry = [...state.messages].reverse().find(m => m.role === 'toolResult');
  assert.ok(entry, 'Expected a toolResult message');
  return JSON.parse(entry.text) as T;
}

describe('current-time and relative dates', () => {
  let tempDir: string;
  let host: Host;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-mvp-now-'));
    host = await Host.start(tempDir);
  });

  afterEach(async () => {
    await host.kill();
    fs.rmSync(tempDir, {recursive: true, force: true});
  });

  test('get_current_time tool returns fixed UTC+8 clock and relative days', async () => {
    const before = nowInDefaultZone();
    await host.prompt('/now', 'now-1');
    const state = await host.wait();
    const after = nowInDefaultZone();
    const result = toolResult<{
      now: string;
      timeZone: string;
      today: string;
      tomorrow: string;
      dayAfterTomorrow: string;
      weekday: string;
    }>(state);

    assert.ok([before.slice(0, 16), after.slice(0, 16)].includes(result.now.slice(0, 16)));
    assert.equal(result.timeZone, 'Etc/GMT-8');
    assert.equal(result.today, result.now.slice(0, 10));
    assert.equal(result.tomorrow, addIsoDays(result.today, 1));
    assert.equal(result.dayAfterTomorrow, addIsoDays(result.today, 2));
    assert.ok(['周日', '周一', '周二', '周三', '周四', '周五', '周六'].includes(result.weekday));
  });

  test('resolveWhen pure calendar arithmetic and validation boundaries', () => {
    const at = (value: string) => Date.parse(value);
    const base = at('2026-11-09T10:00:00+08:00');

    assert.deepEqual(resolveWhen({day: 'today', time: '20:10'}, base), {
      ok: true,
      start: '2026-11-09T20:10:00+08:00',
    });
    assert.deepEqual(resolveWhen({day: 'tomorrow', time: '08:00'}, base), {
      ok: true,
      start: '2026-11-10T08:00:00+08:00',
    });
    assert.deepEqual(resolveWhen({day: 'dayAfterTomorrow', time: '09:30'}, base), {
      ok: true,
      start: '2026-11-11T09:30:00+08:00',
    });
    assert.deepEqual(resolveWhen({offsetMinutes: 180}, base), {
      ok: true,
      start: '2026-11-09T13:00:00+08:00',
    });
    assert.deepEqual(resolveWhen({absolute: '2026-11-09T20:10:00+09:00'}, base), {
      ok: true,
      start: '2026-11-09T19:10:00+08:00',
    });
    assert.deepEqual(resolveWhen({day: 'tomorrow', time: '09:00'}, at('2026-01-31T23:00:00+08:00')), {
      ok: true,
      start: '2026-02-01T09:00:00+08:00',
    });
    assert.deepEqual(resolveWhen({day: 'dayAfterTomorrow', time: '08:00'}, at('2026-12-31T23:30:00+08:00')), {
      ok: true,
      start: '2027-01-02T08:00:00+08:00',
    });
    assert.deepEqual(resolveWhen({day: 'today', time: '09:00'}, at('0000-12-31T08:00:00+08:00')), {
      ok: true,
      start: '0000-12-31T09:00:00+08:00',
    });
    assert.deepEqual(resolveWhen({day: 'tomorrow', time: '09:00'}, at('0000-12-31T08:00:00+08:00')), {
      ok: true,
      start: '0001-01-01T09:00:00+08:00',
    });
    assert.deepEqual(resolveWhen({day: 'tomorrow', time: '09:00'}, at('0099-12-31T08:00:00+08:00')), {
      ok: true,
      start: '0100-01-01T09:00:00+08:00',
    });
    assert.deepEqual(resolveWhen({day: 'today', time: '20:10', durationMinutes: 90}, base), {
      ok: true,
      start: '2026-11-09T20:10:00+08:00',
      end: '2026-11-09T21:40:00+08:00',
    });

    const missingTime = resolveWhen({day: 'today'}, base);
    assert.equal(missingTime.ok, false);
    assert.ok(missingTime.missing?.includes('time'));

    assert.equal(resolveWhen({day: 'today', date: '2026-11-09', time: '10:00'}, base).ok, false);
    assert.equal(resolveWhen({offsetMinutes: 30, day: 'today', time: '10:00'}, base).ok, false);
    assert.equal(resolveWhen({absolute: '2026-11-09T10:00:00+08:00', offsetMinutes: 30}, base).ok, false);
    assert.equal(resolveWhen({day: 'constructor', time: '10:00'}, base).ok, false);
  });

  test('create with when missing time returns needs_information without writing', async () => {
    const payload = {title: '相对日程', when: {day: 'today'}};
    await host.prompt('/calendar ' + JSON.stringify(payload), 'when-missing-time');
    const state = await host.wait();
    const result = toolResult<{status: string; missing: string[]; spec: unknown}>(state);
    assert.equal(result.status, 'needs_information');
    assert.ok(result.missing.includes('time'));
    assert.deepEqual(result.spec, {day: 'today'});
    assert.deepEqual(state.calendar.events, []);
    assert.deepEqual(state.calendar.pending, {});
  });

  test('prompt requires get_current_time and server-side when resolution', async () => {
    const extension = createAgentExtension(() => {});
    const section = extension.sections?.find(item => item.key === 'calendar-clock');
    assert.ok(section, 'Missing calendar-clock section');
    const text = await section.render({} as Parameters<typeof section.render>[0], {} as Parameters<typeof section.render>[1]);
    assert.ok(typeof text === 'string', 'Expected string section output');
    for (const instruction of [
      '必须先调用 get_current_time',
      '创建或修改日程的日期请使用 when 参数',
      '禁止自己把相对日期换算成绝对时间',
      '缺少具体时刻/日期且无法确定时，先追问用户',
    ]) {
      assert.ok(text.includes(instruction), instruction);
    }
  });

  test('now-file rejects timestamp without offset', async () => {
    const clockFile = path.join(tempDir, 'now-without-offset.txt');
    fs.writeFileSync(clockFile, '2026-11-09T12:34:56', 'utf8');
    await assert.rejects(() => Host.start(tempDir, ['--now-file', clockFile]), /Invalid --now-file/);
  });

  test('now-file clock consistency', async () => {
    const clockFile = path.join(tempDir, 'now.txt');
    fs.writeFileSync(clockFile, '2026-11-09T12:34:56+08:00', 'utf8');
    await host.kill();
    host = await Host.start(tempDir, ['--now-file', clockFile]);
    await host.prompt('/now', 'now-fixed');
    const result = toolResult<{
      now: string;
      today: string;
      tomorrow: string;
      dayAfterTomorrow: string;
    }>(await host.wait());
    assert.ok(result.now.startsWith('2026-11-09T12:34:56'), result.now);
    assert.equal(result.today, '2026-11-09');
    assert.equal(result.tomorrow, '2026-11-10');
    assert.equal(result.dayAfterTomorrow, '2026-11-11');
  });

  test('now-file consistency for create with when', async () => {
    const clockFile = path.join(tempDir, 'now-create.txt');
    fs.writeFileSync(clockFile, '2026-11-09T12:34:56+08:00', 'utf8');
    await host.kill();
    host = await Host.start(tempDir, ['--now-file', clockFile]);

    await host.prompt('/now', 'now-fixed-create');
    const nowResult = toolResult<{now: string; today: string; tomorrow: string}>(await host.wait());
    assert.ok(nowResult.now.startsWith('2026-11-09T12:34:56'), nowResult.now);

    const payload = {
      title: '注入时钟日程',
      when: {day: 'tomorrow', time: '20:10', durationMinutes: 60},
    };
    await host.prompt('/calendar ' + JSON.stringify(payload), 'when-fixed-create');
    const result = toolResult<{status: string; event: {start: string}}>(await host.wait());
    assert.equal(result.status, 'created');
    const expectedStart = addIsoDays(nowResult.today, 1) + 'T20:10:00+08:00';
    assert.equal(result.event.start, expectedStart);
    assert.equal(result.event.start.slice(0, 10), nowResult.tomorrow);
    assert.equal(result.event.start.slice(0, 10), addIsoDays(nowResult.today, 1));
  });

  test('when create and move use event zone and preserve duration', async () => {
    await host.kill();
    host = await Host.start(tempDir, ['--now-file', '2026-11-09T23:30:00+08:00']);
    const createPayload = {
      title: '东京日程',
      timeZone: 'Asia/Tokyo',
      when: {day: 'today', time: '14:00', durationMinutes: 60},
    };
    await host.prompt('/calendar ' + JSON.stringify(createPayload), 'tokyo-create');
    const createdResult = toolResult<{
      status: string;
      event: {id: string; title: string; start: string; end: string; timeZone: string};
    }>(await host.wait());
    assert.equal(createdResult.status, 'created');
    const original = createdResult.event;
    assert.equal(original.start, '2026-11-10T14:00:00+09:00');
    assert.equal(original.end, '2026-11-10T15:00:00+09:00');

    const movePayload = {eventId: original.id, when: {day: 'tomorrow', time: '14:00'}};
    await host.prompt('/update ' + JSON.stringify(movePayload), 'tokyo-move');
    const state = await host.wait();
    const updatedResult = toolResult<{status: string; event: typeof original}>(state);
    assert.equal(updatedResult.status, 'updated');
    const expected = {
      ...original,
      start: '2026-11-11T14:00:00+09:00',
      end: '2026-11-11T15:00:00+09:00',
    };
    assert.deepEqual(updatedResult.event, expected);
    assert.deepEqual(state.calendar.events, [expected]);
  });
});
