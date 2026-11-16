const requireMacOSReleaseCredentials = require('./require-macos-release-credentials').default;

exports.default = async function prepareMacOSPackage(context) {
  // Unsigned artifacts are permitted only through the explicit local test
  // command. The regular release commands must keep failing without Apple
  // notarization credentials.
  if (process.env.ALLOW_UNSIGNED_MACOS_RELEASE === '1') return;

  await requireMacOSReleaseCredentials(context);
};
