#!/usr/bin/env node
/**
 * Checks a built nexterm-cli.exe the way only the binary can be checked
 * (CI, build job, Windows):
 *
 * - Subsystem 3, a console program. With 2 (a GUI program, like NexTerm.exe
 *   must be) cmd and PowerShell would neither wait for it nor show what it
 *   prints, and a hook would get nothing back.
 * - No VCRUNTIME140.dll (or MSVCP) among its imports: the C runtime is linked
 *   in (.cargo/config.toml), as Tauri links the app's, so a PC without the
 *   Visual C++ redistributable still runs it.
 *
 *   node src-tauri/cli/check-windows-exe.mjs path\to\nexterm-cli.exe
 *
 * Prints the subsystem and the imported DLLs; exits 1 on a failed check.
 */
import { readFileSync } from 'node:fs';

/** `{ subsystem, imports }` of a PE image (PE32 or PE32+). */
function inspect(b) {
  const fail = (why) => {
    throw new Error(why);
  };
  if (b.length < 0x40 || b.toString('latin1', 0, 2) !== 'MZ') fail('not a PE file (no MZ header)');
  const pe = b.readUInt32LE(0x3c);
  if (b.toString('latin1', pe, pe + 4) !== 'PE\0\0') fail('not a PE file (no PE signature)');
  const sections = b.readUInt16LE(pe + 6);
  const optSize = b.readUInt16LE(pe + 20);
  const opt = pe + 24;
  const magic = b.readUInt16LE(opt);
  if (magic !== 0x10b && magic !== 0x20b) fail(`unknown optional header magic 0x${magic.toString(16)}`);
  const subsystem = b.readUInt16LE(opt + 68);
  // The data directories follow the fixed fields: 96 bytes of them in PE32,
  // 112 in PE32+. Entry 1 is the import table.
  const dirs = opt + (magic === 0x20b ? 112 : 96);
  const importRva = b.readUInt32LE(dirs + 8);
  const toOffset = (rva) => {
    for (let i = 0; i < sections; i++) {
      const s = opt + optSize + 40 * i;
      const va = b.readUInt32LE(s + 12);
      const size = Math.max(b.readUInt32LE(s + 8), b.readUInt32LE(s + 16));
      if (rva >= va && rva < va + size) return rva - va + b.readUInt32LE(s + 20);
    }
    return fail(`RVA 0x${rva.toString(16)} is in no section`);
  };
  const imports = [];
  if (importRva !== 0) {
    // IMAGE_IMPORT_DESCRIPTORs, 20 bytes each, up to an all-zero one; the
    // DLL's name is at +12.
    for (let d = toOffset(importRva); b.readUInt32LE(d + 12) !== 0; d += 20) {
      const name = toOffset(b.readUInt32LE(d + 12));
      imports.push(b.toString('latin1', name, b.indexOf(0, name)));
    }
  }
  return { subsystem, imports };
}

if (process.argv.length !== 3) {
  console.error('usage: node check-windows-exe.mjs <file.exe>');
  process.exit(2);
}
const file = process.argv[2];
const { subsystem, imports } = inspect(readFileSync(file));
console.log(`${file}: Subsystem = ${subsystem} (2 = WINDOWS_GUI, 3 = WINDOWS_CUI)`);
console.log(`imports: ${imports.join(', ')}`);
const problems = [];
if (subsystem !== 3) problems.push(`Subsystem=${subsystem}, not a console program: cmd and PowerShell would show nothing it prints`);
const crt = imports.filter((dll) => /^(vcruntime|msvcp)\d/i.test(dll));
if (crt.length) problems.push(`it loads ${crt.join(', ')}: a PC without the Visual C++ redistributable could not run it`);
for (const p of problems) console.log(`::error::${file}: ${p}`);
process.exit(problems.length ? 1 : 0);
