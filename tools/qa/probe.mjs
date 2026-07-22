// Probe a live page's theme state under emulated prefers-color-scheme.
// usage: node probe.mjs <url> <light|dark|none> [port]
const [url, scheme = 'none', port = '9223'] = process.argv.slice(2);

const list = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
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
    } else if (msg.method === 'Page.loadEventFired') resolve();
  });
});
await new Promise((resolve) => ws.addEventListener('open', resolve));
await send('Page.enable');
if (scheme !== 'none') {
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
}
await send('Page.navigate', { url });
await loaded;
await new Promise((r) => setTimeout(r, 1500));
const res = await send('Runtime.evaluate', {
  returnByValue: true,
  expression: `(() => {
    const bar = document.querySelector('body div.bg-pine-950') || document.querySelector('header')?.previousElementSibling;
    return {
      htmlClass: document.documentElement.className,
      storedTheme: (() => { try { return localStorage.getItem('theme'); } catch { return 'n/a'; } })(),
      mediaDark: matchMedia('(prefers-color-scheme: dark)').matches,
      pineVar: getComputedStyle(document.documentElement).getPropertyValue('--color-pine-950').trim(),
      barBg: bar ? getComputedStyle(bar).backgroundColor : 'no-bar',
      bodyBg: getComputedStyle(document.body).backgroundColor,
    };
  })()`,
});
console.log(scheme, JSON.stringify(res.result.value));
ws.close();
process.exit(0);
