import {setTimeout as delay} from 'node:timers/promises';
import {Type} from '@earendil-works/pi-ai';
import {
  defineExtension,
  defineTool,
  defineTask,
  section,
  type AgentChange,
  type ConversationId,
  type Extension,
  type ModelRef,
} from '@earendil-works/pi-durable';
import {calendarTools} from './calendar.ts';
import {DEFAULT_TIME_ZONE, nowInDefaultZone} from './calendar-time.ts';
import {Fired} from './documents.ts';
import type {PersonalStore} from './personal-store.ts';

type TimerInput = {until: number; conversationId: ConversationId};
type TimerPhase = {phase: 'arm'} | {phase: 'fire'};

export const Timer = defineTask<TimerInput, TimerPhase, string>({
  name: 'mvp.timer',
  version: 1,
  initial: () => ({phase: 'arm'}),
  phases: {
    arm: async (task, runtime, context) => runtime.sleepUntil(task.input.until, {phase: 'fire'}, context),
    fire: async (task, runtime, context) => runtime.commit(async tx => {
      await tx.appendEntry(Fired, task.input.conversationId, {data: {text: '计时完成', until: task.input.until}});
      return {status: 'terminal', outcome: {status: 'completed', result: '计时完成'}};
    }, context),
  },
  abort: async (_task, runtime, context) => runtime.commit(
    () => ({status: 'terminal', outcome: {status: 'aborted'}}), context),
});

export const instructions = '你是个人日程能力验证助手。用中文回答。支持读取、新增、修改、改期和删除单次定时日程。修改或删除前先查询并使用已有日程 ID，匹配不唯一先追问；修改保留未指定字段，改期保留时长，优先直接修改而非先删后建。新增信息不足先追问，不擅自补全时间或时长。重叠必须寻求用户确认，提示使用页面确认按钮。只声称工具已成功执行的结果。不支持重复日程或提醒。';

export function defaultConversationAgent(model: ModelRef, extension: Extension): AgentChange {
  return {model, extensions: [extension], thinkingLevel: 'off', instructions};
}

const NOTEBOOK_PROMPT_LIMIT = 4000;

export function createAgentExtension(event: (kind: 'tool') => void, store?: PersonalStore) {
  const saveNote = defineTool({
    name: 'save_note',
    description: 'Replace the persistent notebook with the requested text.',
    parameters: Type.Object({text: Type.String()}),
    replay: 'safe',
    execute: async ({text}, api) => {
      event('tool');
      if (!store) throw new Error('PersonalStore is not configured');
      store.saveNote(text, `${api.conversationId}:${api.taskId}:${api.callId}`);
      return {output: [{type: 'text', text: '笔记已保存：' + text}]};
    },
  });
  const slowEcho = defineTool({
    name: 'slow_echo',
    description: 'Wait ten seconds then echo text. Safe to repeat after interruption.',
    parameters: Type.Object({text: Type.String({maxLength: 4000})}),
    replay: 'safe',
    execute: async ({text}, _api, context) => {
      event('tool');
      await delay(10000, undefined, {signal: context.abortSignal});
      return {output: [{type: 'text', text}]};
    },
  });
  const failDemo = defineTool({
    name: 'fail_demo',
    description: 'Deliberately fail to demonstrate error handling.',
    parameters: Type.Object({}),
    replay: 'safe',
    execute: async () => {
      event('tool');
      throw new Error('演示工具失败');
    },
  });
  return defineExtension({
    name: 'mvp',
    tasks: [Timer],
    tools: [saveNote, slowEcho, failDemo, ...calendarTools(event, store)],
    sections: [
      section('notebook', () => {
        const text = store?.getNote() ?? '';
        const preview = text.length > NOTEBOOK_PROMPT_LIMIT
          ? text.slice(0, NOTEBOOK_PROMPT_LIMIT) + '…（已截断，完整内容保存在本地笔记库）'
          : text;
        return 'Current notebook: ' + JSON.stringify(preview);
      }),
      section('calendar-clock', async () =>
        `Current time (UTC+8): ${nowInDefaultZone()}. ` +
        `Default calendar timezone is fixed UTC+8 (${DEFAULT_TIME_ZONE}, offset +08:00), including relative dates and unqualified user times. ` +
        'Honor any user-specified timezone. ' +
        '涉及任何日期、相对时间（今天/明天/后天/几点）时，必须先调用 get_current_time 获取当前时间与今天/明天日期。' +
        '创建或修改日程的日期请使用 when 参数（服务端会把它解析成绝对时刻），禁止自己把相对日期换算成绝对时间。' +
        '禁止使用或相信历史消息中的任何时间戳或旧日期；以 get_current_time 与 when 解析结果为准。' +
        '遇到 when 无法表达的日期（例如本周几），请用户提供具体日期。缺少具体时刻/日期且无法确定时，先追问用户，不要猜。' +
        'Ask for timezone clarification only when its meaning is ambiguous. ' +
        'Ask for missing title, date, start/end time; do not assume duration. ' +
        'Overlaps require user confirmation through the page. ' +
        'Calendar tools support listing, creating, updating and deleting timed events. ' +
        'Before editing/deleting, query the relevant date range and use saved event IDs. ' +
        'If multiple events match the user description, ask which; never guess an ID. ' +
        'Preserve unspecified fields on update, including duration when shifting dates. ' +
        'Prefer updating dates over delete-then-create to avoid losing events if creation fails. ' +
        'For multi-event requests process each and report partial failures accurately. ' +
        'A clear change/delete instruction authorizes that action; hypothetical comparisons do not. ' +
        'Only report success from successful tool results.'),
    ],
  });
}
