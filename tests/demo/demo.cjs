// The demo works on a fresh clone: `tools/demo` starts, Weft shows the made-up inbox, opens a chat, the calendar and
// Feed, Ctrl+K finds chats and messages without a filter bar, and Gmail and Matrix say beta in Settings and in Ctrl+N, which also starts Matrix chats.
// Not one request may leave 127.0.0.1. Screenshots go to OUT (default tests/demo/out, ignored by git).
//   npm ci --prefix tests/accessibility && node tests/demo/demo.cjs
// Env: CHROME_PATH (else the usual Chromium paths), OUT, PORT (default: a free one).
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const puppeteer = require(require.resolve('puppeteer-core', { paths: [path.join(__dirname, '../accessibility'), ...module.paths] }));

const ROOT = path.join(__dirname, '../..');
const OUT = process.env.OUT || path.join(__dirname, 'out');
const CHROME = process.env.CHROME_PATH || ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, pass, detail = '') => { results.push(pass); console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` (${typeof detail === 'string' ? detail : JSON.stringify(detail)})`}`); };

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const port = Number(process.env.PORT) || await freePort();
  const demo = spawn('python3', [path.join(ROOT, 'tools/demo'), '--port', String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  const base = await new Promise((resolve, reject) => {
    demo.stdout.on('data', (d) => { const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(String(d)); if (m) resolve(`http://127.0.0.1:${m[1]}`); });
    demo.on('exit', (code) => reject(new Error(`tools/demo ended (${code})`)));
  });
  ok('tools/demo starts and listens on 127.0.0.1', base.startsWith('http://127.0.0.1:'), base);
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4'], defaultViewport: { width: 1366, height: 768 } });
  const outside = [];
  try {
    const p = await browser.newPage();
    await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    const errors = [];
    p.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    // Every request is watched; one to anywhere but the demo is stopped and counted.
    await p.setRequestInterception(true);
    p.on('request', (r) => {
      const u = r.url();
      if (/^(data|blob):/.test(u) || u.startsWith(`${base}/`)) return r.continue();
      outside.push(u);
      r.abort();
    });
    const shot = (name) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
    const text = (sel) => p.$$eval(sel, (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));

    await p.goto(`${base}/demo`);
    await p.waitForSelector('.side .item', { timeout: 20000 });
    await sleep(1500);
    const rows = await text('.side .item');
    ok('inbox shows the made-up chats', ['Výlet na Kriváň', 'Lucia Králiková', 'Rodina', '#general'].every((t) => rows.some((r) => r.includes(t))), rows.length);
    const badges = await p.$$eval('.side .item img.badge', (els) => [...new Set(els.map((e) => e.getAttribute('src')))]);
    ok('chats come from every chat network', ['/edupage.png', '/messenger.ico', '/instagram.png', '/whatsapp.webp', '/discord.png', '/teams.png', '/matrix.svg'].every((b) => badges.includes(b)), badges);
    ok('the calendar is beside the inbox', (await p.$$eval('.calev', (els) => els.length)) > 3);
    await shot('01-inbox');

    // A chat opens with its messages; what you send comes back with an answer.
    const target = await p.evaluateHandle(() => [...document.querySelectorAll('.side .item')].find((e) => e.innerText.includes('Výlet na Kriváň')));
    await target.click();
    await p.waitForSelector('[data-scroll=chat] [data-event]', { timeout: 10000 });
    const msgs = await text('[data-scroll=chat] [data-event]');
    ok('a chat opens with its messages', msgs.some((m) => m.includes('čelovku')), msgs.length);
    await p.type('.ccompose textarea', 'Beriem aj termosku');
    await p.keyboard.press('Enter');
    await p.waitForFunction(() => [...document.querySelectorAll('[data-scroll=chat] [data-event]')].some((e) => e.innerText.includes('Beriem aj termosku')), { timeout: 8000 });
    ok('a sent message shows in the chat', true);
    await sleep(4500);
    await shot('02-chat');

    // Ctrl+K: chats and messages, no filter bar under the field.
    await p.keyboard.down('Control'); await p.keyboard.press('k'); await p.keyboard.up('Control');
    await p.waitForSelector('.cmdinput', { timeout: 5000 });
    await p.type('.cmdinput', 'kriv');
    await sleep(800);
    const found = await p.evaluate(() => {
      const box = document.querySelector('.cmdinput').closest('.cmd') || document.body;
      return { text: box.innerText, chips: box.querySelectorAll('.chips, .chip').length };
    });
    ok('Ctrl+K finds the chat', found.text.includes('Výlet na Kriváň'));
    ok('Ctrl+K finds messages', /Správy/.test(found.text) && found.text.includes('Kriváň'), found.text.slice(0, 120).replace(/\s+/g, ' '));
    ok('no filter bar under the search field', found.chips === 0 && !/Typ správy|Obdobie|Médiá/.test(found.text), found.chips);
    await shot('03-search');
    // Mail lives in the archive: Ctrl+K finds Gmail and Outlook threads by their subject.
    await p.$eval('.cmdinput', (e) => { e.value = ''; });
    await p.click('.cmdinput', { clickCount: 3 });
    await p.keyboard.press('Backspace');
    await p.type('.cmdinput', 'fotky');
    await sleep(800);
    const mail = await p.$eval('.results', (e) => [e.innerText, [...e.querySelectorAll('img')].map((i) => i.getAttribute('src'))]);
    ok('Ctrl+K finds a Gmail thread', mail[0].includes('Fotky z kurzu') && mail[1].includes('/gmail.ico'), mail[0].slice(0, 80).replace(/\s+/g, ' '));
    await p.keyboard.press('Escape');
    await sleep(300);

    // Settings → Účty: Gmail (beta).
    await p.keyboard.down('Control'); await p.keyboard.press(','); await p.keyboard.up('Control');
    await p.waitForSelector('.setnav [data-tab="accounts"]', { timeout: 5000 });
    await p.click('.setnav [data-tab="accounts"]');
    await sleep(800);
    const accounts = await text('.panel .acct');
    ok('Settings → Účty says Gmail (beta)', accounts.some((a) => a.startsWith('Gmail (beta)')), accounts.filter((a) => a.includes('Gmail')));
    ok('Settings → Účty shows Matrix (beta) and its account', accounts.some((a) => a.startsWith('Matrix (beta)') && a.includes('@ty:example.org')), accounts.filter((a) => a.includes('Matrix')));
    const gmailRow = await p.evaluateHandle(() => [...document.querySelectorAll('.panel .acct')].find((e) => e.innerText.startsWith('Gmail (beta)')));
    if (gmailRow.asElement()) await gmailRow.asElement().evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await shot('04-settings-gmail-beta');
    await p.keyboard.down('Control'); await p.keyboard.press(','); await p.keyboard.up('Control');
    await sleep(300);

    // Ctrl+N: Nový mail names Gmail (beta).
    await p.keyboard.down('Control'); await p.keyboard.press('n'); await p.keyboard.up('Control');
    await p.waitForSelector('.cmd.new .cmdinput', { timeout: 5000 });
    await sleep(500);
    const newChat = await p.$eval('.cmd.new', (e) => e.innerText);
    ok('Ctrl+N Nový mail says Gmail (beta)', /Nový mail[\s\S]*Gmail \(beta\)/.test(newChat), newChat.slice(0, 160).replace(/\s+/g, ' '));
    await shot('05-new-mail-gmail-beta');
    // …and, with a Matrix account, a new chat by @name:server and a room by #alias:server.
    ok('Ctrl+N offers a new Matrix chat', newChat.includes('Nový chat na Matrixe'));
    await p.type('.cmd.new .cmdinput', '@ana:example.org');
    await sleep(300);
    ok('…with the @name:server typed', (await p.$eval('.cmd.new', (e) => e.innerText)).includes('Nový chat na Matrixe s @ana:example.org'));
    await p.click('.cmd.new .cmdinput', { clickCount: 3 });
    await p.type('.cmd.new .cmdinput', '#weft:example.org');
    await sleep(300);
    ok('…and joins a room by #alias:server', (await p.$eval('.cmd.new', (e) => e.innerText)).includes('Vstúpiť do #weft:example.org'));
    await p.keyboard.press('Escape');
    await sleep(300);

    // Feed: its tiles, read in a reading window.
    await p.keyboard.down('Control'); await p.keyboard.down('Shift'); await p.keyboard.press('F'); await p.keyboard.up('Shift'); await p.keyboard.up('Control');
    await p.waitForSelector('.feed-tile', { timeout: 8000 });
    await sleep(1200);
    const tiles = await text('.feed-tile');
    ok('Feed opens with its items', tiles.some((t) => t.includes('domáci server')), tiles.length);
    await shot('06-feed');

    ok('no page errors', errors.length === 0, errors);
  } finally {
    await browser.close();
    demo.kill();
  }
  ok('no request left 127.0.0.1', outside.length === 0, outside);
  const failed = results.filter((r) => !r).length;
  console.log(failed ? `FAILED ${failed}` : `all ${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
