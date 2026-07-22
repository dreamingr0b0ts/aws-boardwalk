// Screenshot a page with an emulated prefers-color-scheme via CDP.
// usage: node shot.mjs <url> <light|dark> <outfile> <width> <height> [evalFile]
const [url, scheme, outfile, width = '1440', height = '3000', evalFile] = process.argv.slice(2);

const list = await fetch('http://127.0.0.1:9223/json/new?about:blank', { method: 'PUT' }).then((r) => r.json());
const ws = new WebSocket(list.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

const loaded = new Promise((resolve) => {
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject: rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else if (msg.method === 'Page.loadEventFired') {
      resolve();
    }
  });
});

await new Promise((resolve) => ws.addEventListener('open', resolve));
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: Number(width),
  height: Number(height),
  deviceScaleFactor: 1,
  mobile: false,
});
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
await send('Page.navigate', { url });
await loaded;
await new Promise((r) => setTimeout(r, 3500)); // let the SPA fetch its data
if (evalFile) {
  const { readFileSync } = await import('node:fs');
  await send('Runtime.evaluate', { expression: readFileSync(evalFile, 'utf8') });
  await new Promise((r) => setTimeout(r, 400));
}
const shot = await send('Page.captureScreenshot', { format: 'png' });
const { writeFileSync } = await import('node:fs');
writeFileSync(outfile, Buffer.from(shot.data, 'base64'));
ws.close();
process.exit(0);
