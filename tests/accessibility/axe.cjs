// axe-core on the screens that load without a server: the login form and the form after a refused login.
// Known violations live in axe-baseline.json (node axe.cjs --update-baseline rewrites it); a new one fails the run.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { openApp } = require('./harness.cjs');

const BASELINE = path.join(__dirname, 'axe-baseline.json');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function runAxe(page) {
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  return page.evaluate(async (tags) => JSON.parse(JSON.stringify(await axe.run(document, { runOnly: { type: 'tag', values: tags } }))), TAGS);
}

async function main() {
  const app = await openApp();
  const errors = [];
  app.page.on('pageerror', (err) => errors.push(String(err && err.message || err)));
  const views = {};
  try {
    await app.page.goto(app.base + '/', { waitUntil: 'networkidle0' });
    await app.page.waitForSelector('form.form input[name=password]');
    views['login'] = await runAxe(app.page);

    await app.page.type('input[name=password]', 'not-a-real-password');
    await app.page.keyboard.press('Enter');
    await app.page.waitForFunction(() => document.querySelector('.err')?.textContent === 'Meno alebo heslo nesedí.');
    views['login-refused'] = await runAxe(app.page);
  } finally {
    await app.close();
  }

  const found = [];
  for (const [view, result] of Object.entries(views)) {
    for (const v of result.violations) {
      for (const node of v.nodes) found.push({ key: `${view} | ${v.id} | ${node.target.join(' ')}`, view, v, node });
    }
    console.log(`${view}: ${result.passes.length} passed, ${result.incomplete.length} incomplete, ${result.violations.length} violated rule(s)`);
  }
  const keys = [...new Set(found.map((f) => f.key))].sort();
  if (process.argv.includes('--update-baseline')) {
    fs.writeFileSync(BASELINE, JSON.stringify(keys, null, 2) + '\n', 'utf8');
    console.log(`baseline: ${keys.length} known problem(s) written to axe-baseline.json`);
    return 0;
  }
  const known = new Set(fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : []);
  const fresh = found.filter((f) => !known.has(f.key));
  for (const f of found) {
    console.log(`${known.has(f.key) ? 'known' : 'NEW  '} ${f.view} ${f.v.impact || '-'} ${f.v.id}: ${f.v.help} [${f.node.target.join(' ')}]`);
  }
  if (app.blocked.length) console.log(`FAIL: ${app.blocked.length} request(s) left the static server:\n  ${app.blocked.join('\n  ')}`);
  if (errors.length) console.log(`FAIL: uncaught page error(s):\n  ${errors.join('\n  ')}`);
  const fixed = [...known].filter((k) => !keys.includes(k));
  if (fixed.length) console.log(`${fixed.length} baseline entr(y/ies) no longer present: run with --update-baseline`);
  console.log(`${found.length} problem(s), ${found.length - fresh.length} in baseline, ${fresh.length} new`);
  return fresh.length || app.blocked.length || errors.length ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (err) => { console.error(err); process.exitCode = 2; });
