// Synthetic heartbeat: load every live plank and fail loudly on anything
// that isn't a clean 200. Runs on the syn-nodejs-puppeteer runtime.

const synthetics = require('Synthetics');
const log = require('SyntheticsLogger');

const handler = async () => {
  const urls = (process.env.MONITORED_URLS || '').split(',').filter(Boolean);
  if (urls.length === 0) throw new Error('MONITORED_URLS is empty');

  const page = await synthetics.getPage();

  for (const url of urls) {
    const step = new URL(url).hostname;
    await synthetics.executeStep(step, async () => {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const status = resp ? resp.status() : 0;
      log.info(`${url} → ${status}`);
      if (status !== 200) throw new Error(`${url} returned ${status}`);
    });
  }
};

exports.handler = handler;
