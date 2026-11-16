const fs = require('fs');
const path = require('path');

const installersDirectory = path.join(__dirname, '..', 'dist', 'installers');

for (const platformDirectory of ['mac-arm64', 'mac-x64', 'windows-x64']) {
  fs.mkdirSync(path.join(installersDirectory, platformDirectory), { recursive: true });
}
