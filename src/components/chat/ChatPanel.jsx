import React, { useRef, useEffect } from 'react';
import { Plus, Settings } from 'lucide-react';
import { useChatStore } from '../../stores/chatStore.js';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { ChatMessage } from './ChatMessage.jsx';
import { ChatInput } from './ChatInput.jsx';
import { SettingsModal } from './SettingsModal.jsx';

export function ChatPanel() {
  const messages = useChatStore((s) => s.messages);
  const initChat = useChatStore((s) => s.initChat);
  const newChat = useChatStore((s) => s.newChat);
  const setSettingsModalOpen = useSettingsStore((s) => s.setSettingsModalOpen);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    initChat();
  }, [initChat]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, messages[messages.length - 1]?.text]);

  return (
    <div className="flex flex-col h-full w-full bg-vsc-sidebar overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between h-panel-header px-3 border-b border-vsc-border select-none flex-shrink-0">
        <h2 className="text-ui-sm uppercase tracking-wide text-vsc-fg font-semibold">
          AI Chat
        </h2>

        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => newChat?.()}
            className="p-1 rounded-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover transition-colors"
            title="New chat"
          >
            <Plus size={16} />
          </button>
          <button
            type="button"
            onClick={() => setSettingsModalOpen(true)}
            className="p-1 rounded-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover transition-colors"
            title="Settings"
          >
            <Settings size={16} />
          </button>
        </div>
      </div>

      {/* Messages Thread */}
      <div className="flex-1 overflow-y-auto">
        {messages.map((msg) => (
          <ChatMessage key={msg.id} message={msg} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Chat Input */}
      <ChatInput />

      {/* Settings Modal */}
      <SettingsModal />
    </div>
  );
}

export default ChatPanel;
