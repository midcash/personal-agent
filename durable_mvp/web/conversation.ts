import type {State} from './api.js';
import {element, setText} from './dom.js';

const clock = new Intl.DateTimeFormat('zh-CN', {timeZone: 'Etc/GMT-8', timeStyle: 'short', hourCycle: 'h23'});
const labels = {user: '你', assistant: '助手', toolResult: '工具返回', system: '系统'} as const;

export function setupConversation(
  followConversation: () => void,
  onSelectConversation: (conversationId: number) => void,
) {
  let renderedMessages = '';
  let renderedConversations = '';
  let renderedModels = '';
  let renderedConversationId: number | undefined;

  return function render(state: State) {
    setText('mode', state.mode === 'offline' ? '离线演示 · 无模型费用' : `真实模型 · ${state.model.modelId}`);
    setText('description', state.mode === 'offline'
      ? '当前使用脚本化回显验证运行链路，不具备真实语言理解能力。会话、笔记和后台任务保存在本机。'
      : '由 pi-ai 接入 DeepSeek。提交消息和恢复未完成任务可能产生模型费用。');
    setText('status', state.busy ? '正在执行，可取消或刷新' : '就绪 · 已载入保存状态');

    const modelSelect = element('model-select', HTMLSelectElement);
    const showModelSelect = state.mode === 'deepseek' && state.availableModels.length > 1;
    modelSelect.hidden = !showModelSelect;
    const modelSignature = JSON.stringify({
      mode: state.mode,
      active: state.model.modelId,
      list: state.availableModels,
    });
    if (modelSignature !== renderedModels) {
      renderedModels = modelSignature;
      modelSelect.replaceChildren(...state.availableModels.map(candidate => {
        const option = document.createElement('option');
        option.value = candidate.modelId;
        option.textContent = candidate.modelId;
        return option;
      }));
      modelSelect.value = state.model.modelId;
    }

    const convSignature = JSON.stringify({
      active: state.conversationId,
      list: state.conversations,
    });
    if (convSignature !== renderedConversations) {
      renderedConversations = convSignature;
      const list = element('conversation-list');
      list.replaceChildren(...state.conversations.map(conv => {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'conversation-item' + (conv.id === state.conversationId ? ' active' : '');
        if (conv.id === state.conversationId) button.setAttribute('aria-current', 'true');
        button.dataset.conversationId = String(conv.id);
        const title = document.createElement('span');
        title.className = 'conversation-title';
        title.textContent = conv.title;
        button.append(title);
        if (conv.busy) {
          const dot = document.createElement('span');
          dot.className = 'conversation-busy';
          dot.title = '运行中';
          button.append(dot);
        }
        button.onclick = () => onSelectConversation(conv.id);
        li.append(button);
        return li;
      }));

      const compactSelect = element('conversation-select', HTMLSelectElement);
      compactSelect.replaceChildren(...state.conversations.map(conv => {
        const option = document.createElement('option');
        option.value = String(conv.id);
        option.textContent = conv.busy ? `${conv.title} · 执行中` : conv.title;
        return option;
      }));
      compactSelect.value = String(state.conversationId);
    }

    // The conversation is a live region: redraw only when its content or active conversation changed.
    const signature = JSON.stringify(state.messages);
    const switched = renderedConversationId !== undefined && renderedConversationId !== state.conversationId;
    renderedConversationId = state.conversationId;
    if (signature !== renderedMessages || switched) {
      const scroller = element('chat-scroll');
      const follow = switched || renderedMessages === '' || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
      renderedMessages = signature;
      const messages = element('messages');
      messages.replaceChildren();
      for (const message of state.messages) {
        if (!message.text && !message.calls.length) continue;
        const item = document.createElement('article');
        item.className = 'message ' + message.role;
        if (message.role === 'system') {
          const text = document.createElement('p');
          text.textContent = message.text;
          item.append(text);
          messages.append(item);
          continue;
        }
        const label = document.createElement('strong');
        label.textContent = labels[message.role];
        if (message.role !== 'toolResult') label.className = 'sr-only';
        const text = document.createElement('p');
        text.textContent = message.text;
        item.append(label, text);
        if (message.calls.length) {
          const calls = document.createElement('small');
          calls.textContent = '调用工具：' + message.calls.join(', ');
          item.append(calls);
        }
        if (state.mode === 'deepseek' && message.role === 'assistant' && message.model) {
          const meta = document.createElement('small');
          meta.className = 'message-meta';
          meta.textContent = message.model;
          item.append(meta);
        }
        messages.append(item);
      }
      if (follow) followConversation();
    }

    setText('note', state.note || '暂无笔记');
    setText('identity', `会话 ${state.conversationId} · ${state.model.provider} (${state.model.modelId})`);
    setText('counts', `本进程模型调用 ${state.counts.model} · 工具调用 ${state.counts.tool}`);
    element('timers').replaceChildren(...state.timers.map(timer => {
      const li = document.createElement('li');
      li.textContent = timer.state?.status === 'terminal' ? '计时完成' : '等待到期 · ' + clock.format(timer.until);
      return li;
    }));
  };
}
