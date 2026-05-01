/**
 * On Render/CI, `playwright install` runs with PLAYWRIGHT_BROWSERS_PATH=0 (see postinstall).
 * Set the same before importing `playwright` so launch finds bundled Chromium.
 */
declare function deployLike(): boolean;
//# sourceMappingURL=playwrightBrowsersPath.d.ts.map