/**
 * A distributable macOS build must never silently skip notarization.
 * electron-builder otherwise logs a warning when credentials are absent and
 * can leave a Developer ID-signed, but Gatekeeper-blocked, artifact behind.
 */
exports.default = async function requireMacOSReleaseCredentials(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const required = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length) {
    throw new Error(
      `Refusing to create a macOS release without notarization credentials. Missing: ${missing.join(', ')}. ` +
      'Set the App Store Connect API-key values from .env.notarize.example in the build environment.'
    );
  }
};
