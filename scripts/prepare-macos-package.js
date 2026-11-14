const requireMacOSReleaseCredentials = require('./require-macos-release-credentials').default;

exports.default = async function prepareMacOSPackage(context) {
  await requireMacOSReleaseCredentials(context);
};
