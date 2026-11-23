import fs from 'node:fs';
import path from 'node:path';
import http, {type OutgoingHttpHeaders, type ServerResponse} from 'node:http';
import {BACKGROUND_CONTEXT as ctx} from '@earendil-works/chord/context';
import {
  AgentDoc,
  configure,
  ConversationBusy,
  type Conversation,
  type ConversationId,
  type ConversationRecord,
  type Cursor,
  type EntryId,
  type Extension,
  type Harness,
  type HarnessInspection,
  type ModelRef,
  type TaskId,
} from '@earendil-works/pi-durable';
import {defaultConversationAgent, Timer} from './agent.ts';
import {currentTimeMs} from './calendar-time.ts';
import {ConversationMeta, ModelChanged, SessionTimers} from './documents.ts';
import type {PersonalStore} from './personal-store.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const assets = new Map([
  ['/style.css', path.join(import.meta.dirname, 'style.css')],
  ['/fullcalendar.js', path.join(repoRoot, 'node_modules/fullcalendar/index.global.min.js')],
  ['/calendar-zh-cn.js', path.join(repoRoot, 'node_modules/@fullcalendar/core/locales/zh-cn.global.min.js')],
  ['/luxon.js', path.join(repoRoot, 'node_modules/luxon/build/global/luxon.min.js')],
  ['/calendar-zone.js', path.join(repoRoot, 'node_modules/@fullcalendar/luxon3/index.global.min.js')],
]);

interface HostMetadata {
  personalStore: PersonalStore;
  extension: Extension;
  mode: 'offline' | 'deepseek';
  model: ModelRef;
  availableModels: readonly ModelRef[];
  counts: {model: number; tool: number};
}

interface StateMessage {
  id: EntryId;
  role: 'user' | 'assistant' | 'toolResult' | 'system';
  kind?: 'model-changed';
  text: string;
  calls: string[];
  error: boolean;
  model?: string;
  from?: ModelRef | null;
  to?: ModelRef;
  reason?: 'startup' | 'user';
}

class HttpRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function reply(res: ServerResponse, status: number, value: unknown, headers: OutgoingHttpHeaders = {}) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers});
  res.end(JSON.stringify(value));
}

function parseConversationId(raw: unknown): ConversationId | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw <= 0) throw new HttpRequestError(400, 'Invalid conversationId');
    return raw as ConversationId;
  }
  if (typeof raw === 'string') {
    if (!/^[1-9]\d*$/.test(raw)) throw new HttpRequestError(400, 'Invalid conversationId');
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new HttpRequestError(400, 'Invalid conversationId');
    return parsed as ConversationId;
  }
  throw new HttpRequestError(400, 'Invalid conversationId');
}

function isConversationBusy(inspection: HarnessInspection, conversationId: ConversationId): boolean {
  return (
    inspection.tasks.some(t => !t.record.background && t.record.conversationId === conversationId) ||
    inspection.submissions.some(s => s.conversationId === conversationId)
  );
}

export function createHttpServer(harness: Harness, root: Conversation, metadata: HostMetadata) {
  let fatal = false;
  void harness.closed?.then(() => { fatal = true; });
  const {personalStore, extension, availableModels} = metadata;

  async function listOwnerlessConversations(): Promise<ConversationRecord[]> {
    const items: ConversationRecord[] = [];
    await harness.commit(async tx => {
      let cursor: Cursor | undefined;
      while (true) {
        const page = await tx.scanConversations({order: 'ascending'}, 200, cursor);
        for (const rec of page.items) {
          if (!rec.owner) items.push(rec);
        }
        if (!page.next) break;
        cursor = page.next;
      }
    }, ctx);
    return items;
  }

  async function resolveConversation(rawId: unknown): Promise<Conversation> {
    const id = parseConversationId(rawId);
    if (id === undefined || id === root.id) return root;
    const record = await harness.commit(tx => tx.conversation(id), ctx);
    if (!record || record.owner) throw new HttpRequestError(404, 'Conversation not found');
    const conv = await harness.conversation(id, ctx);
    if (!conv) throw new HttpRequestError(404, 'Conversation not found');
    return conv;
  }

  async function buildConversationSummaries(
    inspection: HarnessInspection,
    activeConversationId?: ConversationId,
    activeFallbackPreview?: string,
  ) {
    const records = await listOwnerlessConversations();
    return Promise.all(records.map(async rec => {
      const conv = rec.id === root.id ? root : await harness.conversation(rec.id, ctx);
      const meta = await harness.snapshot(ConversationMeta, rec.id, ctx);
      const agent = conv ? await conv.agent(ctx) : undefined;
      const fallback = rec.id === root.id
        ? (activeConversationId === root.id && activeFallbackPreview ? activeFallbackPreview : '默认对话')
        : `新对话 #${rec.id}`;
      const title = meta?.title?.trim() || meta?.preview?.trim() || fallback;
      return {
        id: rec.id,
        title,
        model: agent?.model ?? metadata.model,
        busy: isConversationBusy(inspection, rec.id),
        createdAt: meta?.createdAt ?? '',
      };
    }));
  }

  async function state(requestedConversationId?: string | null) {
    const conversation = await resolveConversation(requestedConversationId);
    const entries = (await conversation.context(ctx)).entries;
    const messages = entries.flatMap<StateMessage>(entry => {
      if (ModelChanged.is(entry)) {
        const text = entry.data.from
          ? `模型已切换：${entry.data.from.modelId} → ${entry.data.to.modelId}`
          : `模型已设置为：${entry.data.to.modelId}`;
        return [{
          id: entry.id,
          role: 'system' as const,
          kind: 'model-changed' as const,
          text,
          calls: [] as string[],
          error: false,
          from: entry.data.from,
          to: entry.data.to,
          reason: entry.data.reason,
        }];
      }
      return (entry.model ?? []).flatMap(message => {
        if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'toolResult') return [];
        const text = typeof message.content === 'string'
          ? message.content
          : message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        const calls = Array.isArray(message.content)
          ? message.content.flatMap(b => b.type === 'toolCall' ? [b.name] : [])
          : [];
        return [{
          id: entry.id,
          role: message.role,
          text,
          calls,
          error: (message.role === 'toolResult' && message.isError) ||
            (message.role === 'assistant' && message.stopReason === 'error'),
          ...(message.role === 'assistant' ? {model: message.model} : {}),
        }];
      });
    });

    const firstUser = messages.find(m => m.role === 'user');
    const activeFallbackPreview = firstUser?.text.trim().replace(/\s+/g, ' ').slice(0, 24);
    const inspection = await harness.inspect(ctx);
    const activeAgent = await conversation.agent(ctx);
    const conversations = await buildConversationSummaries(inspection, conversation.id, activeFallbackPreview);

    const timerDoc = await harness.snapshot(SessionTimers, ctx);
    const timers = await Promise.all(
      (timerDoc?.items ?? []).map(async item => ({...item, state: (await harness.getTask(item.id, ctx))?.state})),
    );
    return {
      conversationId: conversation.id,
      mode: metadata.mode,
      model: activeAgent.model ?? metadata.model,
      availableModels,
      counts: metadata.counts,
      conversations,
      messages,
      note: personalStore.getNote(),
      timers,
      calendar: personalStore.getCalendarSnapshot(conversation.id),
      busy: isConversationBusy(inspection, conversation.id),
      fatal,
    };
  }

  const server = http.createServer(async (req, res) => {
    const address = server.address();
    if (!address || typeof address === 'string') return reply(res, 503, {error: 'Host is not listening'});
    const origin = `http://127.0.0.1:${address.port}`;
    if (req.headers.host !== origin.slice(7) || (req.headers.origin && req.headers.origin !== origin))
      return reply(res, 403, {error: 'Only same-origin loopback requests are allowed'}, {Connection: 'close'});
    const url = req.url ?? '';
    const parsedUrl = new URL(url, origin);
    const pathname = parsedUrl.pathname;
    try {
      if (req.method === 'GET' && pathname === '/') {
        const html = fs.readFileSync(path.join(import.meta.dirname, 'index.html'));
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        });
        return res.end(html);
      }
      const asset = /^\/web\/[a-z-]+\.js$/.test(pathname)
        ? path.join(import.meta.dirname, 'dist', pathname)
        : assets.get(pathname);
      if (req.method === 'GET' && asset) {
        const content = fs.readFileSync(asset);
        res.writeHead(200, {
          'Content-Type': pathname.endsWith('.js') ? 'text/javascript' : 'text/css',
          'Cache-Control': 'no-store',
        });
        return res.end(content);
      }
      if (req.method === 'GET' && pathname === '/calendar') {
        const query = parsedUrl.searchParams;
        return reply(res, 200, personalStore.listCalendarEvents(query.get('start'), query.get('end')));
      }
      if (req.method === 'GET' && pathname === '/conversations') {
        const inspection = await harness.inspect(ctx);
        return reply(res, 200, {conversations: await buildConversationSummaries(inspection)});
      }
      if (req.method === 'GET' && pathname === '/state') {
        return reply(res, 200, await state(parsedUrl.searchParams.get('conversationId')));
      }
      if (req.method !== 'POST') return reply(res, 404, {error: 'Not found'});

      const mediaType = (req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
      // Rejections before the body is read must close the connection; the rest stays unread.
      if (mediaType !== 'application/json') return reply(res, 415, {error: 'Expected application/json'}, {Connection: 'close'});
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 16000) return reply(res, 413, {error: 'Request too large'}, {Connection: 'close'});
        chunks.push(chunk);
      }
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));

      if (pathname === '/conversations') {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          return reply(res, 400, {error: 'Expected JSON object'});
        }
        const rawTitle = 'title' in input ? input.title : undefined;
        let title = '';
        if (rawTitle !== undefined) {
          if (typeof rawTitle !== 'string' || rawTitle.trim().length > 80) {
            return reply(res, 400, {error: 'Invalid conversation title'});
          }
          title = rawTitle.trim();
        }
        const rawModelId = 'modelId' in input ? input.modelId : undefined;
        let chosenModel = metadata.model;
        if (rawModelId !== undefined) {
          if (typeof rawModelId !== 'string' || !rawModelId.trim()) {
            return reply(res, 400, {error: 'Invalid modelId'});
          }
          const matched = availableModels.find(candidate => candidate.modelId === rawModelId);
          if (!matched) return reply(res, 400, {error: 'Unsupported model'});
          chosenModel = matched;
        }
        const createdAt = new Date(currentTimeMs()).toISOString();
        const conv = await harness.createConversation({
          ownership: {kind: 'ownerless'},
          agent: defaultConversationAgent(chosenModel, extension),
          init: async (tx, id) => {
            const meta = await tx.doc(ConversationMeta, id);
            meta.title = title;
            meta.preview = '';
            meta.createdAt = createdAt;
          },
        }, ctx);
        return reply(res, 201, {
          id: conv.id,
          title: title || `新对话 #${conv.id}`,
          model: chosenModel,
          createdAt,
        });
      }

      if (pathname === '/model') {
        if (metadata.mode === 'offline') {
          return reply(res, 400, {error: 'Model switching is only available in real-model mode'});
        }
        if (!input || typeof input !== 'object' || Array.isArray(input) || !('modelId' in input) || typeof input.modelId !== 'string') {
          return reply(res, 400, {error: 'Invalid modelId'});
        }
        const rawProvider = 'provider' in input ? input.provider : undefined;
        if (rawProvider !== undefined && typeof rawProvider !== 'string') {
          return reply(res, 400, {error: 'Invalid provider'});
        }
        const target = availableModels.find(
          candidate => candidate.modelId === input.modelId && (rawProvider === undefined || candidate.provider === rawProvider),
        );
        if (!target) return reply(res, 400, {error: 'Unsupported model'});

        const conversation = await resolveConversation('conversationId' in input ? input.conversationId : undefined);
        const inspection = await harness.inspect(ctx);
        if (isConversationBusy(inspection, conversation.id)) {
          return reply(res, 409, {error: 'Conversation is busy'});
        }

        const existingAgent = await conversation.agent(ctx);
        const current = existingAgent.model;
        if (current?.provider === target.provider && current?.modelId === target.modelId) {
          return reply(res, 200, {conversationId: conversation.id, model: target, changed: false});
        }

        const changed = await conversation.commit(async tx => {
          const agentDoc = await tx.doc(AgentDoc, conversation.id);
          const storedModel = agentDoc.model;
          if (storedModel?.provider === target.provider && storedModel?.modelId === target.modelId) {
            return false;
          }
          await configure(tx, conversation.id, {model: target});
          await tx.appendEntry(ModelChanged, conversation.id, {
            data: {
              from: storedModel ?? null,
              to: target,
              reason: 'user',
              changedAt: new Date(currentTimeMs()).toISOString(),
            },
          });
          return true;
        }, ctx);
        return reply(res, 200, {conversationId: conversation.id, model: target, changed});
      }

      if (pathname === '/prompt') {
        if (
          !input ||
          typeof input !== 'object' ||
          !('text' in input) ||
          !('requestId' in input) ||
          typeof input.text !== 'string' ||
          !input.text.trim() ||
          input.text.length > 4000 ||
          typeof input.requestId !== 'string' ||
          !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/.test(input.requestId)
        ) {
          return reply(res, 400, {error: 'Invalid text or requestId'});
        }
        const conversation = await resolveConversation('conversationId' in input ? input.conversationId : undefined);
        const {text, requestId} = input;
        const dedup = personalStore.beginPromptRequest(conversation.id, requestId, text);
        if (dedup.status === 'conflict') {
          return reply(res, 409, {error: 'requestId already belongs to different text'});
        }

        let submission;
        try {
          submission = await conversation.submit(
            {type: 'input', content: text, requestId, whenBusy: 'reject'},
            ctx,
          );
        } catch (error) {
          if (dedup.status === 'inserted') {
            personalStore.rollbackPromptRequest(
              conversation.id,
              requestId,
              dedup.authorizedChanged ? dedup.confirmationId : undefined,
            );
          }
          throw error;
        }

        if (dedup.status === 'inserted' && !/^确认重叠 ([a-f0-9-]{36})$/.test(text.trim())) {
          const preview = text.trim().replace(/\s+/g, ' ').slice(0, 24);
          if (preview) {
            try {
              const existingMeta = await harness.snapshot(ConversationMeta, conversation.id, ctx);
              if (!existingMeta?.title && !existingMeta?.preview) {
                await conversation.commit(async tx => {
                  const meta = await tx.doc(ConversationMeta, conversation.id);
                  if (!meta.title && !meta.preview) {
                    meta.preview = preview;
                    if (!meta.createdAt) meta.createdAt = new Date(currentTimeMs()).toISOString();
                  }
                }, ctx);
              }
            } catch {
              // Best-effort preview update should not fail an admitted prompt.
            }
          }
        }

        return reply(res, 202, {submissionId: submission.id, conversationId: conversation.id});
      }

      if (pathname === '/abort') {
        const rawConversationId = input && typeof input === 'object' && 'conversationId' in input ? input.conversationId : undefined;
        const conversation = await resolveConversation(rawConversationId);
        await conversation.abort(ctx);
        return reply(res, 200, {aborted: true, conversationId: conversation.id});
      }

      if (pathname === '/timer') {
        const id = await root.commit(async tx => {
          const timers = await tx.doc(SessionTimers);
          const activeItems: {id: TaskId<string>; until: number}[] = [];
          const terminalItems: {id: TaskId<string>; until: number}[] = [];
          for (const item of timers.items) {
            const task = await tx.task(item.id);
            if (!task || task.state.status === 'terminal') {
              if (task) terminalItems.push(item);
            } else {
              activeItems.push(item);
            }
          }
          if (activeItems.length >= 20) throw new Error('Too many active timers (20)');
          const until = Date.now() + 10000;
          const id = await tx.createTask(
            Timer,
            {until, conversationId: root.id},
            {ownership: {kind: 'conversation'}, background: true},
          );
          const keptTerminal = terminalItems.slice(-49);
          timers.items = [...keptTerminal, ...activeItems, {id, until}];
          return id;
        }, ctx);
        harness.resume();
        return reply(res, 202, {taskId: id});
      }

      return reply(res, 404, {error: 'Not found'});
    } catch (error) {
      const status = error instanceof HttpRequestError
        ? error.status
        : error instanceof ConversationBusy
          ? 409
          : 400;
      reply(res, status, {error: error instanceof Error ? error.message : String(error)});
    }
  });
  return server;
}
