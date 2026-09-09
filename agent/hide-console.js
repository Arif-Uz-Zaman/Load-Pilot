'use strict';
/**
 * Flip a Windows PE exe from the CONSOLE subsystem (3) to GUI (2) so it runs
 * with NO console window — the agent then runs invisibly in the background,
 * with nothing to accidentally close. (Node itself needs no console; output is
 * already tee'd to agent.log.)
 *
 * Usage: node hide-console.js <path-to-exe>
 */
const fs = require('fs');

const file = process.argv[2];
if (!file) { console.error('usage: node hide-console.js <exe>'); process.exit(1); }

const buf = fs.readFileSync(file);
if (buf.readUInt16LE(0) !== 0x5a4d) { console.error('not a PE/exe (no MZ header)'); process.exit(1); }

const peOff = buf.readUInt32LE(0x3c);            // e_lfanew -> PE header
if (buf.readUInt32LE(peOff) !== 0x00004550) { console.error('bad PE signature'); process.exit(1); }

// Optional header starts at peOff + 4 (sig) + 20 (COFF header). Subsystem is at
// offset 68 (0x44) into the optional header.
const subsystemOff = peOff + 4 + 20 + 68;
const current = buf.readUInt16LE(subsystemOff);
if (current === 2) { console.log('already GUI subsystem (windowless).'); process.exit(0); }
if (current !== 3) { console.error(`unexpected subsystem ${current} (expected 3=console)`); process.exit(1); }

buf.writeUInt16LE(2, subsystemOff);              // 2 = Windows GUI
fs.writeFileSync(file, buf);
console.log(`patched ${file}: console (3) -> GUI (2) — runs windowless.`);
