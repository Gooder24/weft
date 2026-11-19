# Accessibility

Weft is one inbox for a person's chats and mail. People who use only a keyboard, a screen reader, zoom or high
contrast must be able to read it and act on what they read. This document says what we aim for, what is tested,
what is not, and how to report a barrier.

## Priorities

- **Conformance target:** WCAG 2.2 Level AA where it is feasible. Weft has not been audited or certified.
- **Keyboard:** every control can be reached, used and left with the keyboard, with a visible focus indicator and
  a logical order.
- **Screen readers:** controls have names, the page declares its language (`lang="sk"`), and messages that appear on
  their own (errors, status) are announced.
- **Readable:** Slovak text in plain words, enough contrast from the colour tokens at the top of `app/app.css`, and
  colour is never the only signal.

## Contributor expectations

Changes are proposed as pull requests. The pull request template has an accessibility checklist; complete each item
that applies.

- **UI changes:** `npm test --prefix tests/accessibility` passes (axe-core and the keyboard test). Go through the
  changed flow with the keyboard only before merging.
- **New controls and messages:** a visible label or accessible name; icon-only buttons have `aria-label`; new errors
  and status messages sit in an element with `role="alert"` or `aria-live`.
- **Focus:** do not remove an outline without a visible replacement. `app/app.css` has `:focus-visible` rules to reuse.
- **Documentation:** `python3 .github/scripts/check-docs.py` passes (heading order, image alt text, descriptive link text).
- **Continuous integration:** `.github/workflows/accessibility.yml` runs both checks on every pull request. A new
  problem fails the run. Known problems are listed in `.github/a11y-baseline.json`, `tests/accessibility/axe-baseline.json`
  and the `KNOWN` list in `tests/accessibility/keyboard.cjs`; each one has an issue labelled `accessibility`.

## Reporting a barrier

Open an issue with the **Accessibility barrier** template (label `accessibility`). Include, when you can:

- what you were trying to do and what went wrong;
- the screen, for example the login form or the inbox;
- your browser and assistive technology, with versions;
- the severity (below).

Do not attach screenshots of private chats, mail or calendar entries. You do not have to disclose a disability to
report a barrier.

### Severity

- **Critical:** a core task cannot be completed at all, for example signing in or reading a conversation.
- **Serious:** the task can be completed, but only with significant difficulty or a workaround.
- **Moderate:** the task works, but the experience is inconsistent or awkward.
- **Minor:** a small issue with little effect on the task.

### How reports are handled

- The owner reads each report, sets its severity and labels, and writes the next step in the issue.
- Problems found by the automated checks are recorded as issues in the same way.
- Response and fix times are not set yet. Until they are, the owner states the next step, not a date.
- Where possible the owner suggests a workaround while a fix is pending, and asks the reporter to confirm the fix
  before the issue is closed.

## Ownership

The accessibility owner is **Karchi**, the repository owner. The owner:

- triages accessibility reports and sets their labels;
- keeps the baselines and the `KNOWN` list up to date when a problem is fixed;
- keeps this document current.

## Interface requirements

These apply to new and changed screens in `app/`:

- every input has a `<label>`, and every button has text or an `aria-label`;
- keyboard order follows the visual order, and focus never gets trapped;
- a focus indicator is visible on every control;
- errors and status messages are announced (`role="alert"` or `aria-live`);
- the screen keeps working at 200% zoom and 400% reflow (not yet tested, see below);
- colour comes from the tokens in `app/app.css`, and meaning is never given by colour alone.

## Testing

| Check | How it runs | Status |
|---|---|---|
| axe-core on the login form and on the form after a refused login | `tests/accessibility/axe.cjs`, in CI | Passes, no known violations |
| Keyboard-only smoke test of the login form | `tests/accessibility/keyboard.cjs`, in CI | 13 checks pass, no known problems |
| Documentation checks | `.github/scripts/check-docs.py`, in CI | Passes, no known problems |
| Screen reader spot check | Not run. Needs a person with NVDA, JAWS, VoiceOver, Orca or TalkBack | Not done |
| Manual checks: zoom 200%, reflow 400%, plain language, colour use | Not run | Not done |
| Inbox, conversation, calendar and feed | Not covered: they need the server side, which the checks do not run | Not tested |

The checks start the client from `app/` on a local address. Every request that is not to that address is blocked,
and every write is answered with a fake, so no message, login or other request leaves the test.

### Manual and screen reader checks (not run yet, to be done by a person)

- **Screen reader spot check:** with NVDA (Windows), VoiceOver (macOS or iOS), TalkBack (Android) or Orca (Linux), open
  the sign-in form. Check that each field's name is read, that the error after a wrong password is read, and that
  focus is not lost. The automated checks cover focus retention and alert semantics; actual spoken announcements still need this spot check. Record the browser, the
  screen reader and their versions.
- **Zoom:** set the browser to 200%. Every control on the sign-in form and the inbox stays readable and reachable.
- **Reflow:** narrow the window to 320 CSS pixels (400%). No information or control is lost.
- **Language:** labels and error messages say what to do, in plain Slovak, without unexplained abbreviations.
- **Colour:** where a screen shows a state (for example selected, unread, error or offline), the state is also shown with
  text or shape, not colour alone.

## Supported environments

Tested, by the automated checks only:

- Chromium 156 (headless) on Debian 13, on a local run.

Not tested:

- other browsers (Firefox, Safari, Edge, Chrome on Windows or macOS) and mobile browsers;
- screen readers (NVDA, JAWS, VoiceOver, TalkBack, Orca);
- the desktop shell in `desktop/`, and the old demo in `next/`.

The CI run uses the Chrome installed on the GitHub runner; that has not been confirmed yet.

## Known limitations

No known barriers in the automated login checks. Focus retention and the refused-login alert (issues #1 and #2)
are covered by regression checks. Screen reader announcements have not been checked with assistive technology.

## Dependencies

- The client has no build step and no npm packages. Third-party files in `app/`: `qrcode.js` (qrcode-generator 2.0.4,
  MIT, loaded only for a QR sign-in) and the Departure Mono font (SIL Open Font License 1.1, in `app/fonts/`). `kalendarix-colors.js` comes from
  Kalendarix (MIT, see `app/kalendarix-LICENSE`). `emoji.json` is built from Unicode and CLDR data by `tools/make-emoji.py`, and
  the network icons (`discord.png`, `edupage.png`, `gmail.ico`, `instagram.png`, `messenger.ico`, `whatsapp.webp`)
  belong to their services.
- Test-only packages in `tests/accessibility` (`axe-core`, `puppeteer-core`) are not shipped with the client.
- A new dependency is checked before it is added: the screens it touches go through the checks above, and the result
  is written in the pull request.
- No upstream accessibility blockers are recorded. Dependencies have not been reviewed for accessibility beyond the
  automated checks.

## Community

- **Contributions:** the repository is private, so there are no public contribution opportunities yet. The owner decides
  whether it becomes public.
- **Labels:** `accessibility` for every accessibility issue; `good first issue` for small, well-scoped tasks;
  `help wanted` where expert help is needed.
- **Code of conduct:** none adopted yet. The owner decides.
- **Accommodations:** a request goes to the owner privately; it does not have to be public or explained.
- **Recognition:** contributions are recognised only with the contributor's consent.
- **Progress:** completed, open and known barriers are recorded in the `accessibility` issues. Progress is not
  published outside the repository yet.
