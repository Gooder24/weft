// Keyboard-only smoke test for the login form, in headless Chromium. Only key presses are used: no clicks, no
// focus() calls. Checks focus order, a visible focus indicator, that focus can leave the form, reverse order, and
// that Enter submits. A failure listed in KNOWN (with its tracking issue) is reported but does not fail the run.
'use strict';
const { openApp } = require('./harness.cjs');

const KNOWN = {};
const USER = 'input[name=user]';
const PASSWORD = 'input[name=password]';
const SUBMIT = 'form.form button[type=submit]';
const BACK = 'form.form button[type=button]';

const focusedName = (page) => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return 'body';
  return el.name || el.type || el.tagName.toLowerCase();
});
const insideForm = (page) => page.evaluate(() => !!document.activeElement?.closest('form.form'));
const looks = (page, sel) => page.$eval(sel, (el) => {
  const s = getComputedStyle(el);
  return { outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, outlineColor: s.outlineColor, boxShadow: s.boxShadow,
    borderColor: s.borderColor, focused: el === document.activeElement };
});
function hasFocusIndicator(off, on) {
  const outlined = on.outlineStyle !== 'none' && on.outlineWidth !== '0px';
  return outlined || on.boxShadow !== 'none' || on.borderColor !== off.borderColor || on.outlineStyle !== off.outlineStyle;
}

async function main() {
  const app = await openApp();
  const results = [];
  const check = (id, ok, evidence) => results.push({ id, ok: !!ok, evidence });
  try {
    // A device that chose its language before opens on the login form (the welcome screen is axe.cjs's).
    await app.page.evaluateOnNewDocument(() => localStorage.setItem('ep_lang', 'sk'));
    await app.page.goto(app.base + '/', { waitUntil: 'networkidle0' });
    await app.page.waitForSelector(PASSWORD);
    const page = app.page;
    const unfocused = {};
    for (const sel of [USER, PASSWORD, SUBMIT, BACK]) unfocused[sel] = await looks(page, sel);
    check('start-unfocused', (await focusedName(page)) === 'body', `focus starts on ${await focusedName(page)}`);

    const order = [];
    const indicators = [];
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Tab');
      order.push(await focusedName(page));
      const sel = [USER, PASSWORD, SUBMIT, BACK][i];
      indicators.push(hasFocusIndicator(unfocused[sel], await looks(page, sel)));
    }
    check('tab-order', order.join(' > ') === 'user > password > submit > button', `Tab order: ${order.join(' > ')}`);
    check('focus-indicator', indicators.every(Boolean), `visible focus indicator on each control: ${indicators.join(', ')}`);

    await page.keyboard.press('Tab');
    check('no-keyboard-trap', !(await insideForm(page)), `after the last control Tab goes to: ${await focusedName(page)}`);

    const reverse = [];
    for (let i = 0; i < 4; i++) {
      await page.keyboard.down('Shift');
      await page.keyboard.press('Tab');
      await page.keyboard.up('Shift');
      reverse.push(await focusedName(page));
    }
    check('reverse-order', reverse.join(' > ') === 'button > submit > password > user', `Shift+Tab order: ${reverse.join(' > ')}`);

    await page.keyboard.press('Tab');
    check('refocus-password', (await focusedName(page)) === 'password', `focus is on: ${await focusedName(page)}`);
    await page.keyboard.type('not-a-real-password');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.err')?.textContent === 'Meno alebo heslo nesedí.');
    const message = await page.$eval('.err', (el) => el.textContent.trim());
    check('enter-submits-and-shows-error', message === 'Meno alebo heslo nesedí.', `error shown: "${message}"`);
    check('focus-kept-after-error', (await focusedName(page)) === 'password', `focus after the error is on: ${await focusedName(page)}`);
    const live = await page.$eval('.err', (el) => ({ role: el.getAttribute('role'), live: el.getAttribute('aria-live') }));
    check('error-announced', live.role === 'alert' || live.live === 'polite' || live.live === 'assertive',
      `error element has role=${live.role || '-'} aria-live=${live.live || '-'}`);
    await page.keyboard.press('Tab');
    check('retry-button-reachable', (await focusedName(page)) === 'submit', `Tab after refusal: ${await focusedName(page)}`);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.err')?.textContent === 'Meno alebo heslo nesedí.');
    check('retry-focus', (await focusedName(page)) === 'password', `focus after retry: ${await focusedName(page)}`);
    check('password-retained', await page.$eval(PASSWORD, (el) => el.value === 'not-a-real-password'), 'password remains editable after refusal');
    if (app.blocked.length) check('nothing-left-the-server', false, app.blocked.join('; '));
    else check('nothing-left-the-server', true, 'no request left the static server');
  } finally {
    await app.close();
  }

  let failing = 0;
  for (const r of results) {
    const known = KNOWN[r.id];
    if (r.ok) console.log(known ? `FIXED ${r.id}: passes now, remove it from KNOWN (${known})` : `PASS ${r.id}: ${r.evidence}`);
    else if (known) console.log(`KNOWN ${r.id}: ${r.evidence} (${known})`);
    else { failing++; console.log(`FAIL ${r.id}: ${r.evidence}`); }
  }
  const known = results.filter((r) => !r.ok && KNOWN[r.id]).length;
  console.log(`${results.length} keyboard checks: ${results.length - failing - known} passed, ${known} known, ${failing} failing`);
  return failing ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (err) => { console.error(err); process.exitCode = 2; });
