import { useCallback, useMemo } from 'react';
import { resolveKeybindings, shortcutLabel } from '../lib/keybindings.js';
import { isMac } from '../lib/platform.js';
import { useSettingsStore } from '../stores/settingsStore.js';

/**
 * The shortcuts in force, for anything that runs one or prints one.
 *
 * Every place that shows a chord has to read it from here rather than write it
 * beside the thing it labels: the keys are rebindable now, so a hardcoded
 * "Split Right (⌘D)" on a button becomes wrong the moment someone changes it,
 * and a tooltip nobody can correct is worse than no tooltip.
 *
 *   bindings    the resolved list, for whoever matches or enumerates them.
 *   shortcut()  the label for a command id, or '' when it is unbound — in
 *               which case show no shortcut rather than an empty bracket.
 */
export function useShortcuts() {
  const overrides = useSettingsStore((s) => s.keybindings);
  const bindings = useMemo(() => resolveKeybindings(overrides).bindings, [overrides]);
  const shortcut = useCallback((command) => shortcutLabel(command, bindings, { isMac }), [bindings]);
  return { bindings, shortcut };
}

export default useShortcuts;
