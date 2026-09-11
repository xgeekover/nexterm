import assert from 'node:assert/strict';
import { useTerminalStore } from '../../src/stores/terminalStore.js';
import { mockBridge } from '../../src/lib/ipc.js';

console.log('Testing useTerminalStore directly...');

// Initialize store
await useTerminalStore.getState().init();

const state = useTerminalStore.getState();
console.log('Initial tabs:', state.tabs.length);
assert.equal(state.tabs.length, 1);

// Test Rapid Sequential Commands on the real store
console.log('Dispatching rapid sequential commands (echo 1, echo 2, ls)...');
const p1 = state.executeCommand('echo 1');
const p2 = state.executeCommand('echo 2');
const p3 = state.executeCommand('ls');

await Promise.all([p1, p2, p3]);

const finalTabs = useTerminalStore.getState().tabs;
const activeTab = finalTabs[0];
console.log('Active tab blocks count:', activeTab.blocks.length);

for (let i = 0; i < activeTab.blocks.length; i++) {
  const b = activeTab.blocks[i];
  console.log(`Block ${i + 1} (${b.command}): status=${b.status}, exitCode=${b.exitCode}, output=${JSON.stringify(b.output)}`);
}

// Test command with failure exit code
console.log('\nDispatching nonexistent_command_xyz...');
const bFail = await state.executeCommand('nonexistent_command_xyz');
console.log(`nonexistent_command_xyz: status=${bFail.status}, exitCode=${bFail.exitCode}, output=${JSON.stringify(bFail.output)}`);

const updatedFail = useTerminalStore.getState().tabs[0].blocks.find(b => b.id === bFail.id);
console.log(`nonexistent_command_xyz in store: status=${updatedFail.status}, exitCode=${updatedFail.exitCode}`);
