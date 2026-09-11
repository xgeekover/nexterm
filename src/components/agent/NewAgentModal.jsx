import React, { useState } from 'react';
import { X } from 'lucide-react';
import { useAgentStore } from '../../stores/agentStore.js';
import { AI_MODELS, AGENT_ROLES } from '../../lib/constants.js';

export function NewAgentModal() {
  const isNewAgentModalOpen = useAgentStore((s) => s.isNewAgentModalOpen);
  const setNewAgentModalOpen = useAgentStore((s) => s.setNewAgentModalOpen);
  const createAgent = useAgentStore((s) => s.createAgent);
  const agents = useAgentStore((s) => s.agents);

  const [name, setName] = useState('');
  const [role, setRole] = useState(AGENT_ROLES[0]?.name || 'System Architect');
  const [model, setModel] = useState(AI_MODELS[0]?.name || 'Claude 3.7 Sonnet');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [dependency, setDependency] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isNewAgentModalOpen) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!name.trim()) {
      setError('Agent name is required');
      return;
    }
    if (!model) {
      setError('Agent model is required');
      return;
    }

    setIsSubmitting(true);
    try {
      await createAgent({
        name: name.trim(),
        role,
        model,
        systemPrompt: systemPrompt.trim(),
        dependency: dependency || null,
      });
      setName('');
      setSystemPrompt('');
      setDependency('');
      setNewAgentModalOpen(false);
    } catch (err) {
      setError(err.message || 'Failed to create agent');
    } finally {
      setIsSubmitting(false);
    }
  };

  const inputClass =
    'w-full px-2.5 h-[26px] rounded-[3px] bg-vsc-input border border-vsc-input-border text-vsc-fg placeholder:text-vsc-placeholder focus:border-vsc-focus outline-none text-ui';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="relative w-[520px] max-w-[92vw] bg-vsc-widget border border-vsc-widget-border shadow-widget rounded-[3px] overflow-hidden">
        {/* Title row */}
        <div className="flex items-center justify-between h-panel-header px-4 border-b border-vsc-border">
          <h2 className="text-ui font-semibold text-vsc-fg">
            Deploy New Agent
          </h2>

          <button
            type="button"
            onClick={() => setNewAgentModalOpen(false)}
            className="p-1 rounded-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Error message */}
        {error && (
          <div className="mx-4 mt-3 px-3 py-2 rounded-[3px] bg-vsc-input border border-vsc-error text-vsc-error text-ui-sm">
            {error}
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-4 space-y-3.5 text-ui max-h-[70vh] overflow-y-auto">
          {/* Agent Name */}
          <div className="space-y-1">
            <label className="block text-ui-sm text-vsc-muted uppercase tracking-wide">
              Agent Name <span className="text-vsc-error">*</span>
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Database Migrator, Performance Profiler"
              className={inputClass}
            />
          </div>

          {/* Role & Model Row */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="block text-ui-sm text-vsc-muted uppercase tracking-wide">
                Role Archetype
              </label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className={inputClass}
              >
                {AGENT_ROLES.map((r) => (
                  <option key={r.id} value={r.name}>
                    {r.icon} {r.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="block text-ui-sm text-vsc-muted uppercase tracking-wide">
                Assigned LLM <span className="text-vsc-error">*</span>
              </label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className={inputClass}
              >
                {AI_MODELS.map((m) => (
                  <option key={m.id} value={m.name}>
                    {m.name} ({m.provider})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Dependency Chaining */}
          <div className="space-y-1">
            <label className="block text-ui-sm text-vsc-muted uppercase tracking-wide">
              Dependency Chaining (Optional)
            </label>
            <select
              value={dependency}
              onChange={(e) => setDependency(e.target.value)}
              className={inputClass}
            >
              <option value="">None (Independent Agent)</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  Wait for {a.name} ({a.role})
                </option>
              ))}
            </select>
            <p className="text-ui-sm text-vsc-muted">
              If selected, this agent will enter "Waiting" status until the predecessor completes.
            </p>
          </div>

          {/* System Prompt / Goal */}
          <div className="space-y-1">
            <label className="block text-ui-sm text-vsc-muted uppercase tracking-wide">
              Agent Goal / Mission Instructions
            </label>
            <textarea
              rows={3}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="Describe the agent's objective, responsibilities, and success criteria..."
              className="w-full px-2.5 py-2 rounded-[3px] bg-vsc-input border border-vsc-input-border text-vsc-fg placeholder:text-vsc-placeholder focus:border-vsc-focus outline-none text-ui resize-none"
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-vsc-border">
            <button
              type="button"
              onClick={() => setNewAgentModalOpen(false)}
              className="h-[26px] px-3 rounded-[3px] bg-vsc-button-secondary text-vsc-fg text-ui hover:brightness-110 transition"
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={isSubmitting}
              className="h-[26px] px-3 rounded-[3px] bg-vsc-accent hover:bg-vsc-accent-hover text-vsc-accent-fg text-ui font-medium transition disabled:opacity-50"
            >
              {isSubmitting ? 'Deploying...' : 'Deploy Agent'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default NewAgentModal;
