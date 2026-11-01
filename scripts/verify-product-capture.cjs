const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

app.whenReady().then(async () => {
  const keepAlive = setInterval(() => undefined, 1_000);
  const { captureProductWebsite } = await import('../desktop/services/video-product-capture.ts');
  const outputRoot = process.env.SYDNEY_SMOKE_OUTPUT || path.join(os.tmpdir(), 'sydney-product-smoke');
  const targetUrl = process.env.SYDNEY_SMOKE_URL || process.argv[2] || 'https://example.com';
  fs.mkdirSync(outputRoot, { recursive: true });
  const output = path.join(outputRoot, `capture-${Date.now()}`);
  try {
    const capture = await captureProductWebsite(targetUrl, output, message => console.log(message));
    const result = {
      title: capture.title,
      screenshotCount: capture.screenshots.length,
      allScreenshotsExist: capture.screenshots.every(file => fs.existsSync(file) && fs.statSync(file).size > 1000),
      hasBodyText: Boolean(capture.bodyText.trim()),
      output
    };
    console.log(JSON.stringify(result));
  } finally {
    if (process.env.SYDNEY_SMOKE_KEEP !== '1') fs.rmSync(output, { recursive: true, force: true });
    clearInterval(keepAlive);
    app.quit();
  }
}).catch(error => {
  console.error(error);
  app.quit();
  process.exitCode = 1;
});
