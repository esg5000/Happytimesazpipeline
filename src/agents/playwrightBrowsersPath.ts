/**
 * On Render/CI, `playwright install` runs with PLAYWRIGHT_BROWSERS_PATH=0 (see postinstall).
 * Set the same before importing `playwright` so launch finds bundled Chromium.
 */
function deployLike(): boolean {
  const t = (v: string | undefined) =>
    ['true', '1', 'yes'].includes(String(v || '').toLowerCase());
  return t(process.env.RENDER) || t(process.env.CI);
}

if (deployLike() && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
}
