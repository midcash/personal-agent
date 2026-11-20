import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import type {CalendarEvent} from '../../durable_mvp/calendar.ts';
import type {Prompt, State} from '../../durable_mvp/web/api.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const MAX_MODEL_CALLS = 20;
const MAX_TOOL_CALLS = 15;

type StatePayload = Omit<State, 'calendar'> & {
  calendar: {events: CalendarEvent[]; pending: State['calendar']['pending']};
};

async function request(url: URL, signal: AbortSignal, prompt?: Prompt) {
  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const body = prompt === undefined ? undefined : JSON.stringify(prompt);
    const req = http.request(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : {'Content-Type': 'application/json'},
      agent: false,
      signal,
    }, resolve);
    req.once('error', reject);
    req.end(body);
  });
  let body = '';
  for await (const chunk of response.setEncoding('utf8')) body += chunk;
  assert.equal(response.statusCode, prompt === undefined ? 200 : 202, `${url.pathname} returned ${response.statusCode}: ${body}`);
  return body;
}

// Opt in with npm run check:real. The DeepSeek host may make billable requests.
test('DeepSeek creates events and reschedules only after overlap confirmation (S01, S04, S05)', {timeout: 120_000}, async ({signal}) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-mvp-real-'));
  const host = spawn(
    process.execPath,
    ['durable_mvp/server.ts', '--mode', 'deepseek', '--data', tempDir, '--port', '0'],
    {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']},
  );
  const closed = new Promise<void>(resolve => host.once('close', () => resolve()));
  const budgetController = new AbortController();
  const enforceBudget = (kind: 'model' | 'tool', count: number) => {
    const limit = kind === 'model' ? MAX_MODEL_CALLS : MAX_TOOL_CALLS;
    if (count > limit && !budgetController.signal.aborted) {
      host.kill();
      budgetController.abort(new Error(`Real-model call budget exceeded: ${kind}=${count} > ${limit}`));
    }
  };

  try {
    const startupSignal = AbortSignal.any([signal, budgetController.signal, AbortSignal.timeout(20_000)]);
    const url = await new Promise<string>((resolve, reject) => {
      let output = '';
      let lineBuffer = '';
      let stderr = '';
      startupSignal.addEventListener('abort', () => reject(new Error('DeepSeek host startup timed out')), {once: true});
      host.once('error', reject);
      host.once('close', (code, exitSignal) => {
        reject(new Error(`DeepSeek host exited before startup (${code ?? exitSignal}): ${stderr}`));
      });
      host.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      host.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        output += chunk;
        lineBuffer += chunk;
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('{"event":')) {
            const entry = JSON.parse(line) as {event?: string; count?: number};
            if ((entry.event === 'model' || entry.event === 'tool') && typeof entry.count === 'number') {
              enforceBudget(entry.event, entry.count);
            }
          }
        }
        const match = /^DURABLE_MVP (http:\/\/127\.0\.0\.1:\d+)\r?\n/m.exec(output);
        if (match) resolve(match[1]);
      });
    });

    async function turn(text: string, requestId: string): Promise<StatePayload> {
      const turnSignal = AbortSignal.any([signal, budgetController.signal, AbortSignal.timeout(60_000)]);
      await request(new URL('/prompt', url), turnSignal, {text, requestId});
      const stateUrl = new URL('/state', url);
      const readState = async () => {
        const snapshot = JSON.parse(await request(stateUrl, turnSignal)) as StatePayload;
        enforceBudget('model', snapshot.counts.model);
        enforceBudget('tool', snapshot.counts.tool);
        budgetController.signal.throwIfAborted();
        return snapshot;
      };
      while ((await readState()).busy) {
        await delay(100, undefined, {signal: turnSignal});
      }
      // /state reads messages before checking whether the turn is still busy.
      return readState();
    }

    let state = await turn('创建 2030 年 6 月 15 日 14:00 到 15:00 的项目评审', 'create-review');
    assert.equal(state.mode, 'deepseek');
    assert.equal(state.calendar.events.length, 1);
    const [reviewEvent] = state.calendar.events;
    assert.ok(reviewEvent.title.includes('项目评审'), reviewEvent.title);
    assert.equal(reviewEvent.start, '2030-06-15T14:00:00+08:00');
    assert.equal(reviewEvent.end, '2030-06-15T15:00:00+08:00');

    state = await turn('创建 2030 年 6 月 16 日 15:30 到 16:30 的已有会议', 'create-meeting');
    const beforeReschedule = state.calendar.events;
    assert.equal(beforeReschedule.length, 2);
    const meetingEvent = beforeReschedule.find(event => event.id !== reviewEvent.id);
    assert.ok(meetingEvent, 'Expected a second event with its own ID');
    assert.ok(meetingEvent.title.includes('已有会议'), meetingEvent.title);
    assert.equal(meetingEvent.start, '2030-06-16T15:30:00+08:00');
    assert.equal(meetingEvent.end, '2030-06-16T16:30:00+08:00');

    const beforeTurnMsgLen = state.messages.length;
    state = await turn('把 2030 年 6 月 15 日下午两点的项目评审改到 2030 年 6 月 16 日下午三点', 'reschedule-review');
    const calls = state.messages.slice(beforeTurnMsgLen).flatMap(message => message.calls);
    const listIndex = calls.indexOf('list_calendar_events');
    const updateIndex = calls.indexOf('update_calendar_event');
    assert.ok(updateIndex >= 0, 'Expected an update_calendar_event call');
    assert.ok(listIndex >= 0 && listIndex < updateIndex, 'Expected list_calendar_events before the first update_calendar_event call');
    assert.deepEqual(state.calendar.events, beforeReschedule);
    const pending = Object.entries(state.calendar.pending).find(([, entry]) => !entry.result);
    assert.ok(pending, 'Expected a pending overlap confirmation');
    const [confirmationId, entry] = pending;
    assert.equal(entry.updateId, reviewEvent.id);
    const start = '2030-06-16T15:00:00+08:00';
    const end = '2030-06-16T16:00:00+08:00';
    assert.equal(entry.event.start, start);
    assert.equal(entry.event.end, end);

    state = await turn('确认重叠 ' + confirmationId, 'confirm-reschedule');
    assert.equal(state.calendar.events.length, 2);
    const updated = state.calendar.events.find(event => event.id === reviewEvent.id);
    assert.ok(updated, 'Expected the rescheduled event to retain its ID');
    assert.equal(updated.start, start);
    assert.equal(updated.end, end);
    assert.deepEqual(state.calendar.events.find(event => event.id === meetingEvent.id), meetingEvent);

    const {mode, model, counts} = state;
    console.log(JSON.stringify({mode, model, counts}));
  } finally {
    host.kill();
    await closed;
    fs.rmSync(tempDir, {recursive: true, force: true});
  }
});
