import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { User, Bot } from 'lucide-react';
import { CodeBlock } from './CodeBlock.jsx';
import { formatTimestamp, cn } from '../../lib/utils.js';

export function ChatMessage({ message }) {
  const isUser = message.sender === 'user';

  return (
    <div
      className={cn(
        'flex items-start gap-2.5 px-3 py-2 border-b border-vsc-border',
        isUser ? 'bg-vsc-editor' : 'bg-vsc-sidebar'
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          'w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0',
          isUser ? 'bg-vsc-button-secondary text-vsc-fg' : 'bg-vsc-accent text-vsc-accent-fg'
        )}
      >
        {isUser ? <User size={14} /> : <Bot size={14} />}
      </div>

      {/* Message Body */}
      <div className="flex-1 min-w-0">
        {/* Header (Sender & Timestamp) */}
        <div className="flex items-baseline gap-2 select-none">
          <span className="text-ui font-semibold text-vsc-fg">
            {isUser ? 'You' : message.agentName || 'AI Architect'}
          </span>
          <span className="text-ui-sm text-vsc-muted">
            {formatTimestamp(message.timestamp)}
          </span>
        </div>

        {/* Content */}
        <div className="text-ui text-vsc-fg leading-relaxed break-words markdown-content mt-0.5">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code({ node, inline, className, children, ...props }) {
                const match = /language-(\w+)/.exec(className || '');
                const codeString = String(children).replace(/\n$/, '');

                if (!inline && (match || codeString.includes('\n'))) {
                  return (
                    <CodeBlock
                      language={match ? match[1] : 'plaintext'}
                      value={codeString}
                    />
                  );
                }

                return (
                  <code
                    className="px-1 rounded-sm bg-vsc-input font-mono text-code text-vsc-fg"
                    {...props}
                  >
                    {children}
                  </code>
                );
              },
              p({ children }) {
                return <p className="mb-2 last:mb-0">{children}</p>;
              },
              ul({ children }) {
                return <ul className="list-disc list-inside mb-2 space-y-1">{children}</ul>;
              },
              ol({ children }) {
                return <ol className="list-decimal list-inside mb-2 space-y-1">{children}</ol>;
              },
              h1({ children }) {
                return <h1 className="text-ui font-semibold text-vsc-fg-bright mb-1 mt-2">{children}</h1>;
              },
              h2({ children }) {
                return <h2 className="text-ui font-semibold text-vsc-fg-bright mb-1 mt-2">{children}</h2>;
              },
              h3({ children }) {
                return <h3 className="text-ui font-semibold text-vsc-fg-bright mb-1 mt-2">{children}</h3>;
              },
              a({ children, href }) {
                return (
                  <a href={href} target="_blank" rel="noreferrer" className="text-vsc-link hover:underline">
                    {children}
                  </a>
                );
              },
              strong({ children }) {
                return <strong className="font-semibold text-vsc-fg-bright">{children}</strong>;
              },
            }}
          >
            {message.text}
          </ReactMarkdown>

          {message.isStreaming && (
            <span className="inline-block w-1.5 h-3 ml-1 bg-vsc-accent animate-pulse align-middle" />
          )}
        </div>
      </div>
    </div>
  );
}

export default ChatMessage;
