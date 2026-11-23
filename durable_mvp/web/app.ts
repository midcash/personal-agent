import {createConversation, HttpStatusError, loadState, sendAction, sendPrompt, switchModel} from './api.js';
import type {Prompt, State} from './api.js';
import {setupCalendar} from './calendar.js';
import {setupConversation} from './conversation.js';
import {element, errorMessage, setText} from './dom.js';
import {setupLayout} from './layout.js';

const pendingKey = 'durable-mvp-pending';
const conversationKey = 'personal-agent-conversation-id';
let pending = readPendingPrompt();
let activeConversationId = readSavedConversationId();
let sending = false;
let healthy = false;
let current: State | undefined;
let refreshId = 0;
let connectionError = false;

const composerText = element('text', HTMLTextAreaElement);
const calendar = setupCalendar(id => queuePrompt('确认重叠 ' + id));
const layout = setupLayout(calendar.resize);
const renderConversation = setupConversation(layout.followConversation, id => { void selectConversation(id); });

function readSavedConversationId(): number | undefined {
  try {
    const raw = localStorage.getItem(conversationKey);
    if (!raw || !/^[1-9]\d*$/.test(raw)) return undefined;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function saveConversationId(id: number | undefined): void {
  try {
    if (id === undefined) localStorage.removeItem(conversationKey);
    else localStorage.setItem(conversationKey, String(id));
  } catch {
    // Ignore storage unavailability.
  }
}

function readPendingPrompt(): Prompt | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(pendingKey) || 'null');
    if (value && typeof value === 'object' && 'text' in value && 'requestId' in value
        && typeof value.text === 'string' && typeof value.requestId === 'string') {
      const conversationId = 'conversationId' in value && typeof value.conversationId === 'number' &&
        Number.isSafeInteger(value.conversationId) && value.conversationId > 0
        ? value.conversationId
        : undefined;
      return {
        text: value.text,
        requestId: value.requestId,
        ...(conversationId !== undefined ? {conversationId} : {}),
      };
    }
  } catch {
    // Invalid session data cannot be retried.
  }
  return null;
}

function canQueuePrompt() {
  return healthy && !sending && !current?.busy && !pending;
}

function controls() {
  element('send', HTMLButtonElement).disabled = !canQueuePrompt();
  element('cancel', HTMLButtonElement).disabled = !healthy || !current?.busy;
  element('timer', HTMLButtonElement).disabled = !healthy || sending;

  const switchBlocked = !healthy || sending || !!pending;
  element('new-conversation', HTMLButtonElement).disabled = switchBlocked;
  element('new-conversation-compact', HTMLButtonElement).disabled = switchBlocked;
  element('conversation-select', HTMLSelectElement).disabled = switchBlocked;
  for (const button of element('conversation-list').querySelectorAll('button')) {
    button.disabled = switchBlocked;
  }

  const modelSelect = element('model-select', HTMLSelectElement);
  modelSelect.disabled = switchBlocked || !!current?.busy || current?.mode !== 'deepseek';

  const retry = element('retry', HTMLButtonElement);
  retry.hidden = !pending;
  retry.disabled = !healthy || sending;

  let confirmationStatus: string | undefined;
  if (!healthy) confirmationStatus = '连接中断，恢复后可确认。';
  else if (pending) confirmationStatus = '有未确认提交的请求，请先重试同一请求。';
  else if (sending || current?.busy) confirmationStatus = '正在处理会话，完成后可确认。';
  calendar.setConfirmationControls(!canQueuePrompt(), confirmationStatus, current?.calendar.pending);
}

async function refresh() {
  const id = ++refreshId;
  try {
    let state: State;
    try {
      state = await loadState(activeConversationId);
    } catch (error) {
      if (error instanceof HttpStatusError && error.status === 404 && activeConversationId !== undefined) {
        activeConversationId = undefined;
        saveConversationId(undefined);
        state = await loadState();
      } else {
        throw error;
      }
    }
    if (id !== refreshId) return;
    healthy = true;
    current = state;
    activeConversationId = state.conversationId;
    saveConversationId(state.conversationId);
    renderConversation(state);
    calendar.render(state.calendar);
    calendar.retryIfFailed();
    if (connectionError) {
      setText('error', '');
      connectionError = false;
      calendar.refetch();
    }
  } catch (error) {
    if (id !== refreshId) return;
    healthy = false;
    connectionError = true;
    setText('status', '连接中断，等待服务恢复');
    setText('error', errorMessage(error));
  }
  controls();
}

async function selectConversation(id: number) {
  if (!healthy || sending || pending || id === activeConversationId) return;
  activeConversationId = id;
  saveConversationId(id);
  setText('error', '');
  if (location.hash === '#/notes') location.hash = '#/chat';
  await refresh();
}

async function handleCreateConversation() {
  if (!healthy || sending || pending) return;
  sending = true;
  controls();
  setText('error', '');
  try {
    const created = await createConversation();
    activeConversationId = created.id;
    saveConversationId(created.id);
    if (location.hash === '#/notes') location.hash = '#/chat';
  } catch (error) {
    setText('error', errorMessage(error));
  } finally {
    sending = false;
    await refresh();
  }
}

async function handleSwitchModel(modelId: string) {
  if (!healthy || sending || pending || !current || current.busy || current.mode !== 'deepseek') return;
  if (modelId === current.model.modelId) return;
  sending = true;
  controls();
  setText('error', '');
  try {
    await switchModel(current.conversationId, modelId);
  } catch (error) {
    setText('error', errorMessage(error));
  } finally {
    sending = false;
    await refresh();
  }
}

function queuePrompt(text: string) {
  if (!canQueuePrompt() || !text.trim()) return;
  const conversationId = current?.conversationId ?? activeConversationId;
  pending = {
    text,
    requestId: crypto.randomUUID(),
    ...(conversationId !== undefined ? {conversationId} : {}),
  };
  sessionStorage.setItem(pendingKey, JSON.stringify(pending));
  void submit(pending);
}

async function submit(prompt: Prompt) {
  sending = true;
  controls();
  setText('error', '');
  try {
    await sendPrompt(prompt);
    if (composerText.value === prompt.text) {
      composerText.value = '';
      composerText.style.height = '';
    }
    pending = null;
    sessionStorage.removeItem(pendingKey);
  } catch (error) {
    setText('error', errorMessage(error) + '。请求未确认，可用相同 ID 重试。');
  } finally {
    sending = false;
    await refresh();
  }
}

element('composer').addEventListener('submit', event => {
  event.preventDefault();
  queuePrompt(composerText.value);
});
element('retry').onclick = () => { if (pending) void submit(pending); };
element('new-conversation').onclick = () => { void handleCreateConversation(); };
element('new-conversation-compact').onclick = () => { void handleCreateConversation(); };
element('conversation-select', HTMLSelectElement).onchange = event => {
  const select = event.currentTarget as HTMLSelectElement;
  const parsed = Number(select.value);
  if (Number.isSafeInteger(parsed) && parsed > 0) void selectConversation(parsed);
};
element('model-select', HTMLSelectElement).onchange = event => {
  const select = event.currentTarget as HTMLSelectElement;
  void handleSwitchModel(select.value);
};

element('cancel').onclick = async () => {
  sending = true;
  controls();
  setText('error', '');
  try {
    await sendAction('/abort', current?.conversationId ?? activeConversationId);
  } catch (error) {
    setText('error', errorMessage(error));
  } finally {
    sending = false;
    await refresh();
  }
};

element('timer').onclick = async () => {
  sending = true;
  controls();
  setText('error', '');
  try {
    await sendAction('/timer');
  } catch (error) {
    setText('error', errorMessage(error));
  } finally {
    sending = false;
    await refresh();
  }
};

async function poll() {
  await refresh();
  setTimeout(poll, 700);
}
void poll();
