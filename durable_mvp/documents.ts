import {defineDoc, defineEntry, type ModelRef, type TaskId} from '@earendil-works/pi-durable';

export const SessionTimers = defineDoc<{items: {id: TaskId<string>; until: number}[]}>({
  kind: 'mvp.session-timers',
  version: 1,
  scope: 'session',
  initial: () => ({items: []}),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20,
});

export const ConversationMeta = defineDoc<{title: string; preview: string; createdAt: string}>({
  kind: 'mvp.conversation-meta',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({title: '', preview: '', createdAt: ''}),
  checkpointWhen: () => true,
});

export const ModelChanged = defineEntry<{
  from: ModelRef | null;
  to: ModelRef;
  reason: 'startup' | 'user';
  changedAt: string;
}>('mvp.model-changed');

export const Fired = defineEntry<{text: string; until: number}>('mvp.timer-fired');
