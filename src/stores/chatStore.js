import { create } from 'zustand';
import { invoke, listen } from '../lib/ipc.js';
import { DEFAULT_CHAT_MESSAGES } from '../lib/constants.js';

let unlisteners = [];
let listening = false;

export const useChatStore = create((set, get) => ({
  messages: JSON.parse(JSON.stringify(DEFAULT_CHAT_MESSAGES)),
  isStreaming: false,
  activeStreamingMessageId: null,
  cancelledMessageIds: new Set(),
  chatContext: null, // { title: string, content: string }
  isInitialized: false,

  // Event listeners are attached once and can be torn down (HMR, unmount)
  // without losing the bootstrap state.
  attachListeners: async () => {
    if (listening) return;
    listening = true;
    unlisteners.push(await listen('chat-token', (payload) => {
      const { message_id, token, done } = payload || {};
      if (!message_id) return;

      const state = get();
      if (state.cancelledMessageIds && state.cancelledMessageIds.has(message_id)) {
        // Discard incoming tokens and ensure isStreaming remains false
        set((s) => {
          const msgIndex = s.messages.findIndex((m) => m.id === message_id);
          if (msgIndex >= 0 && s.messages[msgIndex].isStreaming) {
            const updated = [...s.messages];
            updated[msgIndex] = { ...updated[msgIndex], isStreaming: false };
            return { messages: updated, isStreaming: false, activeStreamingMessageId: null };
          }
          return { isStreaming: false, activeStreamingMessageId: null };
        });
        return;
      }

      set((state) => {
        if (state.cancelledMessageIds && state.cancelledMessageIds.has(message_id)) {
          return { isStreaming: false, activeStreamingMessageId: null };
        }
        const msgIndex = state.messages.findIndex((m) => m.id === message_id);
        if (msgIndex >= 0) {
          const updated = [...state.messages];
          const target = updated[msgIndex];
          // If token streaming
          const currentText = target.text || '';
          // If the message already has the token, don't duplicate
          const newText = currentText.endsWith(token) ? currentText : currentText + token;
          updated[msgIndex] = {
            ...target,
            text: newText,
            isStreaming: !done,
          };
          return {
            messages: updated,
            isStreaming: !done,
            activeStreamingMessageId: done ? null : message_id,
          };
        }
        return state;
      });
    }));
  },

  dispose: () => {
    for (const off of unlisteners) {
      try {
        if (typeof off === 'function') off();
      } catch (_) {
        // listener already gone
      }
    }
    unlisteners = [];
    listening = false;
  },
  initChat: async () => {
    if (get().isInitialized) {
      await get().attachListeners();
      return;
    }


    set({ isInitialized: true });
  },

  sendMessage: async (agentId, text) => {
    const trimmed = (text || '').trim();
    if (!trimmed) return;

    const context = get().chatContext;
    let promptWithContext = trimmed;
    if (context) {
      promptWithContext = `[Context: ${context.title}]\n\`\`\`\n${context.content}\n\`\`\`\n\n${trimmed}`;
    }

    // Add user message optimistically with unique ID
    const userMsg = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-user`,
      sender: 'user',
      text: promptWithContext,
      timestamp: Date.now(),
    };

    set((state) => ({
      messages: [...state.messages, userMsg],
      isStreaming: true,
      chatContext: null, // Clear context after sending
    }));

    try {
      const asstReply = await invoke('chat_send_message', {
        agent_id: agentId || 'agent-architect-01',
        message: promptWithContext,
      });

      // Ensure assistant message is in thread
      set((state) => {
        // If user cancelled while invoke was in flight
        if (state.cancelledMessageIds && state.cancelledMessageIds.has(asstReply.id)) {
          const exists = state.messages.some((m) => m.id === asstReply.id);
          if (!exists) {
            return {
              messages: [...state.messages, { ...asstReply, isStreaming: false }],
              isStreaming: false,
            };
          }
          return { isStreaming: false };
        }

        const exists = state.messages.some((m) => m.id === asstReply.id);
        if (!exists) {
          return {
            messages: [...state.messages, { ...asstReply, isStreaming: false }],
            isStreaming: false,
          };
        }
        return state;
      });

      return asstReply;
      await get().attachListeners();
    } catch (err) {
      console.error('[ChatStore] Failed to send chat message:', err);
      set({ isStreaming: false, activeStreamingMessageId: null });
      throw err;
    }
  },

  // Clears the thread back to a blank conversation (header "New chat" action).
  // Does not touch initialization/listener state — safe to call repeatedly.
  newChat: () => {
    set({
      messages: [],
      isStreaming: false,
      activeStreamingMessageId: null,
      chatContext: null,
    });
  },

  attachContext: (context) => {
    set({ chatContext: context });
  },

  clearContext: () => {
    set({ chatContext: null });
  },

  stopGenerating: () => {
    set((state) => {
      let cancelled = new Set(state.cancelledMessageIds || []);
      if (state.activeStreamingMessageId) {
        cancelled.add(state.activeStreamingMessageId);
      }
      for (const m of state.messages) {
        if (m.isStreaming && m.id) {
          cancelled.add(m.id);
        }
      }
      if (cancelled.size > 500) {
        cancelled = new Set([...cancelled].slice(-200));
      }
      const updatedMessages = state.messages.map((m) =>
        m.isStreaming ? { ...m, isStreaming: false } : m
      );
      return {
        isStreaming: false,
        activeStreamingMessageId: null,
        cancelledMessageIds: cancelled,
        messages: updatedMessages,
      };
    });
  },
}));

export default useChatStore;
