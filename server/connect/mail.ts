// The archive keeps a mail as its subject on the first line and the rest as text pulled out of the HTML, <style>
// blocks included. This turns it into the subject and one line of readable text.

export function flatten(body: string) {
  const nl = body.indexOf('\n');
  const subject = (nl < 0 ? body : body.slice(0, nl)).trim();
  const rest = (nl < 0 ? '' : body.slice(nl + 1))
    .replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, ' ') // @media { .a { … } .b { … } }
    .replace(/[^\n{}]*\{[^{}]*\}/g, ' '); // .rule { … }
  return { subject, text: rest.replace(/\s+/g, ' ').trim() };
}

/** The text between the first of `after` and the first of `before` that follow it ('' when `after` is missing). */
export function between(text: string, after: RegExp, before: RegExp) {
  const start = text.match(after);
  if (!start || start.index === undefined) return '';
  const rest = text.slice(start.index + start[0].length);
  const end = rest.search(before);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

/** Strips the quotes mails put around an item's name ("…“, „…“). */
export const unquote = (s: string) => s.replace(/^["“”„']+|["“”„']+$/g, '').trim();
