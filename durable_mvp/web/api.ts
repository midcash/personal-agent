export interface CalendarEvent {
  title: string;
  start: string;
  end: string;
}

export interface PendingEvent {
  event: CalendarEvent;
  conflicts?: CalendarEvent[];
  updateId?: string;
  result?: unknown;
}

export interface ModelRef {
  modelId: string;
  provider: string;
}

export interface ConversationSummary {
  id: number;
  title: string;
  model?: ModelRef;
  busy: boolean;
  createdAt: string;
}

export interface Message {
  id?: number;
  role: 'user' | 'assistant' | 'toolResult' | 'system';
  kind?: 'model-changed';
  text: string;
  calls: string[];
  model?: string;
}

export interface State {
  conversationId: number;
  mode: 'offline' | 'deepseek';
  model: ModelRef;
  availableModels: ModelRef[];
  conversations: ConversationSummary[];
  messages: Message[];
  note: string;
  timers: {until: number; state?: {status: string}}[];
  calendar: {events: CalendarEvent[]; pending: Record<string, PendingEvent>};
  busy: boolean;
  counts: {model: number; tool: number};
}

export interface Prompt {
  text: string;
  requestId: string;
  conversationId?: number;
}

export class HttpStatusError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request(url: string, body?: object): Promise<unknown> {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : {'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const message = result && typeof result === 'object' && 'error' in result ? result.error : undefined;
    throw new HttpStatusError(response.status, typeof message === 'string' && message ? message : `HTTP ${response.status}`);
  }
  return result;
}

export async function loadState(conversationId?: number): Promise<State> {
  // The same-origin server owns the response schema.
  const query = conversationId !== undefined ? `?conversationId=${encodeURIComponent(String(conversationId))}` : '';
  return await request('/state' + query) as State;
}

export async function sendPrompt(prompt: Prompt): Promise<void> {
  await request('/prompt', prompt);
}

export async function sendAction(endpoint: '/abort' | '/timer', conversationId?: number): Promise<void> {
  await request(endpoint, endpoint === '/abort' && conversationId !== undefined ? {conversationId} : {});
}

export async function createConversation(title?: string): Promise<ConversationSummary> {
  return await request('/conversations', title ? {title} : {}) as ConversationSummary;
}

export async function switchModel(
  conversationId: number,
  modelId: string,
): Promise<{conversationId: number; model: ModelRef; changed: boolean}> {
  return await request('/model', {conversationId, modelId}) as {
    conversationId: number;
    model: ModelRef;
    changed: boolean;
  };
}
