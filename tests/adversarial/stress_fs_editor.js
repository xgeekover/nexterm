/**
 * Deep Stress & Adversarial Test for File Explorer & Monaco Editor Backend (R2)
 */

import assert from 'node:assert/strict';
import { MockIpcBridge } from '../e2e/harness/mockIpc.js';
import { AppEnvironment } from '../e2e/harness/appEnvironment.js';

console.log('Testing File Explorer & Editor adversarial edge cases...');

const ipc = new MockIpcBridge();

// 1. Non-existent file reads
console.log('1. Testing non-existent file reads...');
await assert.rejects(
  () => ipc.invoke('fs_read_file', { path: '/workspace/non_existent.js' }),
  /File not found/,
  'Must reject non-existent file read'
);

await assert.rejects(
  () => ipc.invoke('fs_read_file', { path: '' }),
  /File not found/,
  'Must reject empty path read'
);

// 2. Directory traversal attempts
console.log('2. Testing directory traversal / path escapes...');
const traverseDirResult = await ipc.invoke('fs_read_dir', { path: '../../../../etc' });
console.log('traverseDirResult for ../../../../etc count:', traverseDirResult.length);

await assert.rejects(
  () => ipc.invoke('fs_read_file', { path: '../../../../etc/passwd' }),
  /File not found/
);

// 3. Special character filenames
console.log('3. Testing special character filenames...');
const weirdNames = [
  '/workspace/test with spaces.txt',
  '/workspace/한국어_파일_이름.jsx',
  '/workspace/file_with_newline\n.txt',
  '/workspace/file"with"double\'single\'quotes.js',
  '/workspace/file_with_symbols!@#$%^&*()_+=~`{}[]|;:,<>.md',
  '/workspace/.hidden_dotfile',
  '/workspace/emoji_🚀_🔥_✨.js',
];

for (const p of weirdNames) {
  try {
    await ipc.invoke('fs_create_file', { path: p });
    await ipc.invoke('fs_write_file', { path: p, content: `data for ${p}` });
    const content = await ipc.invoke('fs_read_file', { path: p });
    assert.equal(content, `data for ${p}`);
    await ipc.invoke('fs_delete_path', { path: p });
  } catch (err) {
    console.log(`Failed on special filename: ${JSON.stringify(p)}: ${err.message}`);
  }
}

// 4. Boundary: null bytes in path
console.log('4. Testing null byte injection in file paths...');
try {
  await ipc.invoke('fs_create_file', { path: '/workspace/test\0evil.js' });
  const hasNullByte = ipc.files.has('/workspace/test\0evil.js');
  console.log('File created with null byte in path:', hasNullByte);
  await ipc.invoke('fs_delete_path', { path: '/workspace/test\0evil.js' });
} catch (err) {
  console.log('Cleanly rejected null byte in path:', err.message);
}

// 5. Deep directory hierarchy (>50 levels)
console.log('5. Testing deep directory hierarchy (>50 levels)...');
let deepPath = '/workspace';
for (let i = 1; i <= 50; i++) {
  deepPath += `/d${i}`;
  await ipc.invoke('fs_create_dir', { path: deepPath });
}
const deepLeaf = `${deepPath}/leaf.txt`;
await ipc.invoke('fs_create_file', { path: deepLeaf });
await ipc.invoke('fs_write_file', { path: deepLeaf, content: 'DEEP_CONTENT' });

const leafContent = await ipc.invoke('fs_read_file', { path: deepLeaf });
assert.equal(leafContent, 'DEEP_CONTENT');
console.log('Deep 50-level hierarchy read/write: OK');

// 6. Delete directory recursively vs non-recursively
console.log('6. Testing delete non-empty directory non-recursively...');
const testDir = '/workspace/non_empty_dir';
await ipc.invoke('fs_create_dir', { path: testDir });
await ipc.invoke('fs_create_file', { path: `${testDir}/child.txt` });

// When recursive is false, does delete_path delete child files or leave orphans?
await ipc.invoke('fs_delete_path', { path: testDir, recursive: false });
const childStillExists = ipc.files.has(`${testDir}/child.txt`);
console.log('Child file orphaned when parent dir deleted non-recursively:', childStillExists);

// Clean up
await ipc.invoke('fs_delete_path', { path: `${testDir}/child.txt` });

console.log('All File Explorer stress tests completed.');
