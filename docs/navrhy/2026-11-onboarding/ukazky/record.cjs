// Records every path of onboarding.html as <path>.gif beside it.
//   NODE_PATH=/tmp/acc-test/node_modules tools/browser-slot node docs/navrhy/2026-11-onboarding/ukazky/record.cjs [path…]
// Needs ffmpeg. Frames go to a temporary folder that is removed afterwards. The pre-push scan reads GIF bytes too and a
// short private string can turn up in them by chance: then re-encode that GIF with fewer colours (palettegen max_colors).
const puppeteer = require('puppeteer-core');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const here = __dirname;
const page_url = `file://${path.join(here, 'onboarding.html')}`;

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--allow-file-access-from-files'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 680, height: 500, deviceScaleFactor: 2 });
    await page.goto(page_url);
    await page.evaluate(() => document.fonts.load("11px 'Departure Mono'").then(() => document.fonts.ready));
    const names = process.argv.slice(2).length ? process.argv.slice(2) : await page.evaluate(() => Object.keys(window.PATHS));
    for (const name of names) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `weft-gif-${name}-`));
      try {
        const count = await page.evaluate(n => window.PATHS[n].frames.length, name);
        const list = [];
        for (let i = 0; i < count; i++) {
          const { hold } = await page.evaluate((n, k) => window.draw(n, k), name, i);
          await page.evaluate(() => Promise.all([...document.images].map(img => img.decode().catch(() => {}))));
          const file = path.join(dir, `${String(i).padStart(3, '0')}.png`);
          await (await page.$('#stage')).screenshot({ path: file });
          list.push(`file '${file}'`, `duration ${(hold / 1000).toFixed(2)}`);
        }
        list.push(list[list.length - 2]); // the concat demuxer drops the last duration without a repeated file
        fs.writeFileSync(path.join(dir, 'list.txt'), `${list.join('\n')}\n`);
        const out = path.join(here, `${name}.gif`);
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'),
          '-vf', 'scale=1020:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=full[p];[b][p]paletteuse=dither=none',
          '-loop', '0', out]);
        console.log(`${name}.gif ${count} frames ${(fs.statSync(out).size / 1024).toFixed(0)} kB`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
