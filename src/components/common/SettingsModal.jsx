import React, { useState } from 'react';
import { X, Eye, EyeOff, Check, ShieldCheck } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { AI_MODELS } from '../../lib/constants.js';

export function SettingsModal() {
  const isSettingsModalOpen = useSettingsStore((s) => s.isSettingsModalOpen);
  const setSettingsModalOpen = useSettingsStore((s) => s.setSettingsModalOpen);
  const byokKeys = useSettingsStore((s) => s.byokKeys);
  const setApiKey = useSettingsStore((s) => s.setApiKey);
  const modelPreference = useSettingsStore((s) => s.modelPreference);
  const setModelPreference = useSettingsStore((s) => s.setModelPreference);

  const [openaiKey, setOpenaiKey] = useState(byokKeys.openaiKey || '');
  const [claudeKey, setClaudeKey] = useState(byokKeys.claudeKey || '');
  const [geminiKey, setGeminiKey] = useState(byokKeys.geminiKey || '');
  const [ollamaUrl, setOllamaUrl] = useState(byokKeys.ollamaUrl || 'http://localhost:11434');

  const [showOpenai, setShowOpenai] = useState(false);
  const [showClaude, setShowClaude] = useState(false);
  const [showGemini, setShowGemini] = useState(false);
  const [savedToast, setSavedToast] = useState(false);

  if (!isSettingsModalOpen) return null;

  const handleSave = (e) => {
    e.preventDefault();
    setApiKey('openaiKey', openaiKey);
    setApiKey('claudeKey', claudeKey);
    setApiKey('geminiKey', geminiKey);
    setApiKey('ollamaUrl', ollamaUrl);

    setSavedToast(true);
    setTimeout(() => {
      setSavedToast(false);
      setSettingsModalOpen(false);
    }, 1000);
  };

  const inputClass =
    'w-full px-2.5 h-[26px] rounded-[3px] bg-vsc-input border border-vsc-input-border text-vsc-fg placeholder:text-vsc-placeholder focus:border-vsc-focus outline-none text-ui font-mono';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="relative w-[520px] max-w-[92vw] bg-vsc-widget border border-vsc-widget-border shadow-widget rounded-[3px] overflow-hidden">
        {/* Title row */}
        <div className="flex items-center justify-between h-panel-header px-4 border-b border-vsc-border">
          <h2 className="text-ui font-semibold text-vsc-fg">
            BYOK API Settings
          </h2>

          <button
            type="button"
            onClick={() => setSettingsModalOpen(false)}
            className="p-1 rounded-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSave} className="p-4 space-y-3.5 text-ui max-h-[70vh] overflow-y-auto">
          {/* OpenAI Key */}
          <div className="space-y-1">
            <label className="block text-ui-sm text-vsc-muted uppercase tracking-wide">
              OpenAI API Key
            </label>
            <div className="relative">
              <input
                type={showOpenai ? 'text' : 'password'}
                value={openaiKey}
                onChange={(e) => setOpenaiKey(e.target.value)}
                placeholder="sk-proj-..."
                className={`${inputClass} pr-9`}
              />
              <button
                type="button"
                onClick={() => setShowOpenai(!showOpenai)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded-sm text-vsc-muted hover:text-vsc-fg"
              >
                {showOpenai ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          {/* Anthropic (Claude) Key */}
          <div className="space-y-1">
            <label className="block text-ui-sm text-vsc-muted uppercase tracking-wide">
              Anthropic Claude API Key
            </label>
            <div className="relative">
              <input
                type={showClaude ? 'text' : 'password'}
                value={claudeKey}
                onChange={(e) => setClaudeKey(e.target.value)}
                placeholder="sk-ant-..."
                className={`${inputClass} pr-9`}
              />
              <button
                type="button"
                onClick={() => setShowClaude(!showClaude)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded-sm text-vsc-muted hover:text-vsc-fg"
              >
                {showClaude ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          {/* Google Gemini Key */}
          <div className="space-y-1">
            <label className="block text-ui-sm text-vsc-muted uppercase tracking-wide">
              Google Gemini API Key
            </label>
            <div className="relative">
              <input
                type={showGemini ? 'text' : 'password'}
                value={geminiKey}
                onChange={(e) => setGeminiKey(e.target.value)}
                placeholder="AIzaSy..."
                className={`${inputClass} pr-9`}
              />
              <button
                type="button"
                onClick={() => setShowGemini(!showGemini)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded-sm text-vsc-muted hover:text-vsc-fg"
              >
                {showGemini ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          {/* Local Ollama URL */}
          <div className="space-y-1">
            <label className="block text-ui-sm text-vsc-muted uppercase tracking-wide">
              Local Ollama Endpoint
            </label>
            <input
              type="text"
              value={ollamaUrl}
              onChange={(e) => setOllamaUrl(e.target.value)}
              placeholder="http://localhost:11434"
              className={inputClass}
            />
          </div>

          {/* Default Model */}
          <div className="space-y-1">
            <label className="block text-ui-sm text-vsc-muted uppercase tracking-wide">
              Default Chat Model
            </label>
            <select
              value={modelPreference}
              onChange={(e) => setModelPreference(e.target.value)}
              className={inputClass}
            >
              {AI_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.provider})
                </option>
              ))}
            </select>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-between pt-3 border-t border-vsc-border">
            <div className="flex items-center gap-1.5 text-ui-sm text-vsc-ok">
              <ShieldCheck size={14} />
              <span>Keys never leave your local machine</span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSettingsModalOpen(false)}
                className="h-[26px] px-3 rounded-[3px] bg-vsc-button-secondary text-vsc-fg text-ui hover:brightness-110 transition"
              >
                Cancel
              </button>

              <button
                type="submit"
                className="flex items-center gap-1.5 h-[26px] px-3 rounded-[3px] bg-vsc-accent hover:bg-vsc-accent-hover text-vsc-accent-fg text-ui font-medium transition"
              >
                {savedToast ? <Check size={14} /> : null}
                <span>{savedToast ? 'Saved!' : 'Save Keys'}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

export default SettingsModal;
