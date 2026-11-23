const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const appPath = process.argv[2];
if (process.platform !== 'darwin' || !appPath || !fs.existsSync(path.join(appPath, 'Contents', 'Info.plist'))) {
  console.error('Usage on macOS: npm run verify:universal -- "dist/mac-universal/Кружок.app"');
  process.exit(64);
}
const magicNumbers = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);
const binaries = [];
function verify(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { verify(file); continue; }
    if (!entry.isFile()) continue;
    const header = Buffer.alloc(4);
    const fd = fs.openSync(file, 'r');
    let bytes;
    try { bytes = fs.readSync(fd, header, 0, 4, 0); } finally { fs.closeSync(fd); }
    if (bytes !== 4 || !magicNumbers.has(header.readUInt32BE())) continue;
    execFileSync('/usr/bin/lipo', [file, '-verify_arch', 'arm64', 'x86_64'], { stdio: 'pipe' });
    binaries.push(path.relative(appPath, file));
  }
}
verify(appPath);
if (!binaries.some(file => file.startsWith('Contents/MacOS/'))) throw new Error('Application executable not found');
console.log(`PASS: ${binaries.length} Mach-O binaries contain both arm64 and x86_64.`);
for (const file of binaries) console.log(file);
