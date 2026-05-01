/**
 * Install Playwright Chromium on hosts that need it (e.g. Render: RENDER=true).
 * Skips on local dev to avoid downloading browsers on every `npm install`.
 */
const { execSync } = require('child_process');

function truthy(name) {
  const v = String(process.env[name] || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

if (
  truthy('RENDER') ||
  truthy('CI') ||
  truthy('PLAYWRIGHT_INSTALL_ON_POSTINSTALL')
) {
  console.log('[postinstall] Installing Playwright Chromium…');
  // Bundle browsers inside node_modules so the deploy slug includes them (not only ~/.cache).
  execSync('npx playwright install chromium', {
    stdio: 'inherit',
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '0' },
  });
}
