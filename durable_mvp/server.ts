import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {syncBuiltinESMExports} from 'node:module';
import {BACKGROUND_CONTEXT as ctx} from '@earendil-works/chord/context';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import {
  configure,
  createRegistry,
  Harness,
  type Conversation,
  type ConversationId,
  type Cursor,
  type ModelRef,
} from '@earendil-works/pi-durable';
import {createAgentExtension, defaultConversationAgent, instructions} from './agent.ts';
import {currentTimeMs, setNowProvider} from './calendar-time.ts';
import {ModelChanged} from './documents.ts';
import {loadEnv, parseHostOptions} from './env.ts';
import {createHttpServer} from './http.ts';
import {configureModels} from './models.ts';
import {openPersonalStore, type PersonalStore} from './personal-store.ts';

async function syncConversationsOnStartup(
  harness: Harness,
  personalStore: PersonalStore,
  offline: boolean,
  model: ModelRef,
  availableModels: readonly ModelRef[],
) {
  const ownerlessIds: ConversationId[] = [];
  await harness.commit(async tx => {
    let cursor: Cursor | undefined;
    while (true) {
      const page = await tx.scanConversations({order: 'ascending'}, 200, cursor);
      for (const rec of page.items) {
        if (!rec.owner) ownerlessIds.push(rec.id);
      }
      if (!page.next) break;
      cursor = page.next;
    }
  }, ctx);

  const conversations: Conversation[] = [];
  for (const id of ownerlessIds) {
    const conv = await harness.conversation(id, ctx);
    if (!conv) continue;
    const existing = await conv.agent(ctx);
    if (existing.model && (existing.model.provider === 'faux') !== offline) {
      throw new Error('Cannot mix offline and real-model mode in the same --data directory; use a separate --data directory');
    }
    conversations.push(conv);
  }

  const startupKey = `${model.provider}/${model.modelId}`;
  const lastStartupKey = personalStore.getMeta('last_startup_model');
  const startupModelChanged = !offline && lastStartupKey !== undefined && lastStartupKey !== startupKey;
  const isLegacyNoMeta = !offline && lastStartupKey === undefined;

  for (const conv of conversations) {
    const existing = await conv.agent(ctx);
    const stored = existing.model;
    const sameModel = stored?.provider === model.provider && stored?.modelId === model.modelId;
    const storedStillSupported =
      stored !== undefined &&
      availableModels.some(candidate => candidate.provider === stored.provider && candidate.modelId === stored.modelId);
    const shouldSyncModel = !offline && !sameModel && (startupModelChanged || isLegacyNoMeta || !storedStillSupported);
    const shouldRefreshInstructions = existing.instructions !== instructions;

    if (shouldSyncModel || shouldRefreshInstructions) {
      await conv.commit(async tx => {
        await configure(tx, conv.id, {
          ...(shouldRefreshInstructions ? {instructions} : {}),
          ...(shouldSyncModel ? {model} : {}),
        });
        if (shouldSyncModel) {
          await tx.appendEntry(ModelChanged, conv.id, {
            data: {
              from: stored ?? null,
              to: model,
              reason: 'startup',
              changedAt: new Date(currentTimeMs()).toISOString(),
            },
          });
        }
      }, ctx);
    }
  }

  if (!offline) {
    personalStore.setMeta('last_startup_model', startupKey);
  }
}

const options = parseHostOptions();
// Test-only: pin "now" from a file (or literal ISO string). Production never passes this flag.
if (options.nowFile !== undefined) {
  const source = fs.existsSync(options.nowFile) ? fs.readFileSync(options.nowFile, 'utf8').trim() : options.nowFile;
  const fixed = Date.parse(source);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(source) || !Number.isFinite(fixed))
    throw new Error('Invalid --now-file: expected an ISO timestamp with Z or an explicit offset');
  setNowProvider(() => fixed);
}
const port = options.port;
const offline = options.mode === 'offline';
if (!offline) loadEnv();
if (!offline && !process.env.DEEPSEEK_API_KEY) throw new Error('Missing DEEPSEEK_API_KEY');
if (offline) {
  const deny = () => { throw new Error('Offline mode blocks outbound network'); };
  globalThis.fetch = deny;
  net.Socket.prototype.connect = deny;
  syncBuiltinESMExports();
}
const counts = {model: 0, tool: 0};
const event = (kind: keyof typeof counts) => { counts[kind]++; console.log(JSON.stringify({event: kind, count: counts[kind]})); };
const {models, model, availableModels} = configureModels(offline, event);

const folder = path.resolve(options.data ?? `.durable-mvp/${options.mode}`);
fs.mkdirSync(folder, {recursive: true});
// OS-level SQLite locking alone does not exclude two independent harness schedulers.
// A separate lock database holds an EXCLUSIVE transaction for the lifetime of this
// process. The write, not BEGIN alone, is what takes the lock; the transaction stays
// open, so the owner row is never committed. The OS releases the lock on exit or kill,
// so there is no stale pid file to reclaim.
const lockDb = new DatabaseSync(path.join(folder, 'host.lock.sqlite'));
try {
  lockDb.exec('PRAGMA locking_mode=EXCLUSIVE');
  lockDb.exec('PRAGMA busy_timeout=0');
  lockDb.exec('BEGIN EXCLUSIVE');
  lockDb.exec('CREATE TABLE IF NOT EXISTS host (pid INTEGER NOT NULL, started_at TEXT NOT NULL)');
  lockDb.exec('DELETE FROM host');
  lockDb.prepare('INSERT INTO host (pid, started_at) VALUES (?, ?)').run(process.pid, new Date().toISOString());
} catch (error) {
  // Only SQLITE_BUSY/SQLITE_LOCKED means another host holds this store; other failures
  // (corruption, permissions, disk) must keep their own message.
  if (error instanceof Error && 'errcode' in error && (error.errcode === 5 || error.errcode === 6)) throw new Error('Store is already in use: ' + error.message);
  throw error;
}

const personalStore = openPersonalStore(path.join(folder, 'personal.sqlite'), {now: currentTimeMs});
const extension = createAgentExtension(event, personalStore);
const registry = createRegistry();
registry.install(extension);
const storage = await openNodeSqliteStorage(path.join(folder, 'session.sqlite'));
const harness = await Harness.open(storage, {
  models,
  registry,
  settings: {retry: {maxRetries: 0}, toolExecution: 'sequential'},
  onReport: () => console.error('Durable reported a runtime error; inspect state before continuing.'),
}, ctx);

let root: Conversation;
try {
  root = await harness.root(ctx, {agent: defaultConversationAgent(model, extension)});
  await syncConversationsOnStartup(harness, personalStore, offline, model, availableModels);
} catch (error) {
  await harness.close(ctx).catch(() => {});
  personalStore.close();
  lockDb.close();
  throw error;
}

const server = createHttpServer(harness, root, {
  personalStore,
  extension,
  mode: options.mode,
  model,
  availableModels,
  counts,
});
// Resuming unfinished model/tool tasks can repeat paid calls in real mode.
harness.resume();
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address === 'object') console.log('DURABLE_MVP http://127.0.0.1:' + address.port);
});
async function stop() {
  server.close();
  await harness.close(ctx);
  personalStore.close();
  // Keep the lock connection reachable for the entire lifetime of the host.
  lockDb.close();
  process.exit(0);
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
