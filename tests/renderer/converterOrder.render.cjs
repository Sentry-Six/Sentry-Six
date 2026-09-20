// Run with node_modules/electron/dist/electron.exe tests/renderer/converterOrder.render.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');

app.whenReady().then(async () => {
  let window;
  let scratch;
  let exitCode = 0;
  try {
    const renderer = path.resolve(__dirname, '../../src/renderer');
    const html = await fs.readFile(path.join(renderer, 'index.html'), 'utf8');
    const fieldset = html.match(/<fieldset class="converter-fieldset converter-order-fieldset">[\s\S]*?<\/fieldset>/)[0];
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-order-render-'));
    const fixture = path.join(scratch, 'index.html');
    await fs.writeFile(fixture, `<!doctype html><html><head><link rel="stylesheet" href="${pathToFileURL(path.join(renderer, 'style.css'))}"><link rel="stylesheet" href="${pathToFileURL(path.join(renderer, 'styles/footageConverter.css'))}"></head><body style="padding:24px;background:#171b1c"><div style="width:520px">${fieldset}</div></body></html>`);
    window = new BrowserWindow({ show: false, width: 600, height: 240, webPreferences: { offscreen: true } });
    await window.loadFile(fixture);
    const results = await window.webContents.executeJavaScript(`(async () => {
      await document.fonts.ready;
      return [...document.querySelectorAll('.converter-order-button')].map(button => {
        const icon = button.querySelector('.material-symbols-outlined');
        const b = button.getBoundingClientRect(), i = icon.getBoundingClientRect();
        return { label: button.getAttribute('aria-label'), width: b.width, iconWidth: i.width,
          contained: i.left >= b.left && i.right <= b.right,
          hit: document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest('button') === button };
      });
    })()`);
    const screenshot = path.join(os.tmpdir(), 'studio-converter-order.png');
    await fs.writeFile(screenshot, (await window.webContents.capturePage()).toPNG());
    assert.equal(results.length, 6);
    for (const result of results) {
      assert.ok(result.iconWidth <= result.width && result.contained, JSON.stringify(result));
      assert.ok(result.hit, `Button is obstructed: ${result.label}`);
    }
    console.log(`PASS: all six icons fit and all six button centers are clickable. Screenshot: ${screenshot}`);
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    window?.destroy();
    if (scratch) await fs.rm(scratch, { recursive: true, force: true });
  }
  app.exit(exitCode);
});
