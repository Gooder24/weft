// Weft's icons: pixelarticons (Copyright (c) 2019 Gerrit Halfmann, MIT, license in pixelarticons-LICENSE,
// github.com/halfmage/pixelarticons), the glyphs of KarchiOS's "Karchi Pixel Icons" font. Filled cells on the 24 grid,
// drawn only at 24 px (48 px where something is big, e.g. play over a video), in the colour of their text.
// A new icon: copy its path from the pixelarticons package under the same name; draw one only if pixelarticons has none,
// on the same grid with 2 px lines. Names are pixelarticons' own. DESIGN.md says where icons go.
export const ICONS = {
  'alarm-clock': 'M8 5h8v2H8zm0 14h8v2H8zM6 7h2v2H6zm0 10h2v2H6zM16 7h2v2h-2zm0 10h2v2h-2zM4 9h2v8H4zm14 0h2v8h-2zM4 2h2v2H4zm0 17h2v2H4zm14 0h2v2h-2zm0-17h2v2h-2zM2 4h2v2H2zm18 0h2v2h-2zm-9 5h2v4h-2zm2 4h2v2h-2z',
  'archive': 'M3 2h18v2H3zm0 5h18v2H3zM1 4h2v3H1zm20 0h2v3h-2zm-2 5h2v11h-2zM3 9h2v11H3zm2 11h14v2H5zm4-9h6v2H9z',
  'arrow-down': 'M13 12h6v2h-2v2h-2v2h-2v2h-2v-2H9v-2H7v-2H5v-2h6V4h2v8Z',
  'arrow-right': 'M4 11v2h16v-2zm12 2v2h2v-2zm-2 2v2h2v-2zm-2 2v2h2v-2zm4-6V9h2v2z M14 15V7h2v8zm-2 2V5h2v12z',
  'arrow-up': 'M11 20h2V4h-2zm2-12h2V6h-2zm2 2h2V8h-2zm2 2h2v-2h-2zm-6-4H9V6h2z M15 10H7V8h8zm2 2H5v-2h12z',
  'arrows-horizontal': 'M13 13v-2h10v2zm6 2v-2h2v2zm-2 2v-2h2v2zm2-6V9h2v2z M17 15V7h2v8zm-6-2v-2H1v2zm-6 2v-2H3v2zm2 2v-2H5v2zm-2-6V9H3v2z M7 15V7H5v8z',
  'bell': 'M9 2h6v2H9zM7 4h2v2H7zm8 0h2v2h-2zM5 6h2v7H5zm12 0h2v7h-2zM3 13h2v4H3zm16 0h2v4h-2z M3 15h18v2H3zm5 3h2v2H8zm6 0h2v2h-2zm-4 2h4v2h-4z',
  'bell-off': 'M9 2h6v2H9zm6 2h2v2h-2zM5 6h2v7H5zm12 0h2v6h-2zM3 13h2v4H3z M3 15h14v2H3zm5 3h2v2H8zm6 0h2v2h-2zm-4 2h4v2h-4zM5 4h2v2H5zm2 2h2v2H7zm2 2h2v2H9zm2 2h2v2h-2zm2 2h2v2h-2z M15 14h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zM3 2h2v2H3z',
  'book-open': 'M2 3h9v2H2zM0 19h11v2H0zM13 3h9v2h-9zm0 16h11v2H13zM11 5h2v18h-2zM0 5h2v14H0zm22 0h2v14h-2zm-7 2h5v2h-5zm0 4h5v2h-5zm0 4h2v2h-2z',
  'briefcase': 'M2 8h2v12H2zm18 0h2v12h-2zM4 6h16v2H4zm0 14h16v2H4zM8 4h2v2H8zm2-2h4v2h-4zm4 2h2v2h-2z',
  'calendar': 'M5 4h14v2H5zm0 16h14v2H5zM3 10h2v10H3zm0-4h2v2H3zm16 0h2v2h-2zm0 4h2v10h-2zM3 8h18v2H3zm12-6h2v2h-2zM7 2h2v2H7z',
  'check': 'M10 18H8v-2h2v2Zm-2-2H6v-2h2v2Zm4-2v2h-2v-2h2Zm-6 0H4v-2h2v2Zm8 0h-2v-2h2v2Zm2-2h-2v-2h2v2Zm2-2h-2V8h2v2Zm2-2h-2V6h2v2Z',
  'chevron-left': 'M8 13v-2h2v2H8Zm2-2V9h2v2h-2Zm0 4v-2h2v2h-2Zm2-6V7h2v2h-2Zm0 8v-2h2v2h-2Zm2-10V5h2v2h-2Zm0 12v-2h2v2h-2Z',
  'chevron-right': 'M16 13v-2h-2v2h2Zm-2-2V9h-2v2h2Zm0 4v-2h-2v2h2Zm-2-6V7h-2v2h2Zm0 8v-2h-2v2h2ZM10 7V5H8v2h2Zm0 12v-2H8v2h2Z',
  'clipboard-note': 'M20 12h2v8h-2zm-8-2h8v2h-8zm0 10h8v2h-8zm-2-8h2v8h-2zM6 2h8v2H6zm0 4h8v2H6zm0-2h2v2H6zm6 0h2v2h-2zm2 0h2v2h-2z M16 6h2v5h-2zM4 4h2v2H4zM2 6h2v12H2zm2 12h6v2H4zm2-8h4v2H6zm0 4h2v2H6zm11 2h5v2h-5z M16 16h2v6h-2z',
  'close': 'M7 19H5V17H7V19ZM19 19H17V17H19V19ZM9 15V17H7V15H9ZM17 17H15V15H17V17ZM11 15H9V13H11V15ZM15 15H13V13H15V15ZM13 13H11V11H13V13ZM11 11H9V9H11V11ZM15 11H13V9H15V11ZM9 9H7V7H9V9ZM17 9H15V7H17V9ZM7 7H5V5H7V7ZM19 7H17V5H19V7Z',
  'coins': 'M6 2h6v2H6zM4 4h2v2H4zm8 0h2v2h-2zm-8 8h2v2H4zm8 0h2v2h-2zm-6 2h6v2H6zM2 6h2v6H2zm12 0h2v6h-2z M14 8h4v2h-4zm-4 10h2v2h-2zm8-8h2v2h-2zm-6 10h2v2h-2zm6-2h2v2h-2z M12 20h6v2h-6zm-4-6h2v4H8zm12-2h2v6h-2zM7 6h4v2H7z M9 6h2v6H9zm6 8h2v4h-2zm-1-2h3v2h-3z',
  'download': 'M21 15v4h-2v-4zm-2 4v2H5v-2zM5 15v4H3v-4zm8-12v14h-2V3z M7 11v2h10v-2zm2 2v2h2v-2zm4 0v2h2v-2z M15 11v2h2v-2z',
  'eye': 'M16 20H8v-2h8v2Zm-8-2H4v-2h4v2Zm12 0h-4v-2h4v2ZM4 16H2v-2h2v2Zm10-6h-2v2h2v-2h2v4h-2v2h-4v-2H8v-4h2V8h4v2Zm8 6h-2v-2h2v2ZM2 14H0v-4h2v4Zm22 0h-2v-4h2v4ZM4 10H2V8h2v2Zm18 0h-2V8h2v2ZM8 8H4V6h4v2Zm12 0h-4V6h4v2Zm-4-2H8V4h8v2Z',
  'file': 'M6 4H4v16h2zm10-2H6v2h10zm4 4h-2v14h2zm-2 14H6v2h12zM16 4h2v2h-2zm-4 0h2v6h-2z M12 8h6v2h-6z',
  'flag': 'M4 2h2v20H4z M4 4h16v2H4zm12 2h2v2h-2zm-2 2h2v2h-2zm2 2h2v2h-2zM4 12h16v2H4z',
  'forward': 'M2 11h2v6H2zm2 6h2v2H4zm2-2h4v2H6zm0-8h4v2H6zm4 8h2v6h-2zm0-12h2v6h-2zm2 16h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm-2-2h2v2h-2zm-2-2h2v2h-2zm-2-2h2v2h-2zm-2-2h2v2h-2zM4 9h2v2H4z',
  'images': 'M7 2h14v2H7zm0 14h14v2H7zm-4 4h14v2H3zM5 4h2v12H5zM1 8h2v12H1zm20-4h2v12h-2zm-4 6h2v2h-2zm2 2h2v2h-2zm-4 0h2v2h-2zm-2 2h2v2h-2zm-2-8h2v2h-2zM9 8h2v2H9zm2 2h2v2h-2zm2-2h2v2h-2zM3 6h2v2H3zm14 12h2v2h-2z',
  'label': 'M16 22h-4v-2h4v2Zm-4-2h-2v-2h2v2Zm6 0h-2v-2h2v2Zm-8-2H8v-2h2v2Zm10 0h-2v-2h2v2ZM8 16H6v-2h2v2Zm14 0h-2v-4h2v4ZM6 14H4v-2h2v2Zm-2-2H2V4h2v8Zm16 0h-2v-2h2v2Zm-2-2h-2V8h2v2ZM8 8H6V6h2v2Zm8 0h-2V6h2v2Zm-2-2h-2V4h2v2Zm-2-2H4V2h8v2Z',
  'link': 'M4 6h7v2H4zm0 10h7v2H4zM2 8h2v8H2zm18-2h-7v2h7zm0 10h-7v2h7zm2-8h-2v8h2zM7 11h10v2H7z',
  'mail': 'M6 8h2v2H6zm2 2h2v2H8zm10-2h-2v2h2zm-2 2h-2v2h2zm-6 2h4v2h-4zM2 6h2v12H2zm18 0h2v12h-2zM4 4h16v2H4zm0 14h16v2H4z',
  'mail-open': 'M4 8h2V6H4zm2 4h2v2H6zm-2-2h2v2H4zm14 0h2v2h-2zM6 6h2V4H6zm2 8h8v2H8zm12-6h-2V6h2zm-2 4h-2v2h2zm0-6h-2V4h2zM8 4h8V2H8zM2 8h2v12H2zm18 0h2v12h-2zM4 20h16v2H4z',
  'mic': 'M10 2h4v2h-4zM8 4h2v10H8zm2 10h4v2h-4zm4-10h2v10h-2zM4 10h2v6H4zm2 6h2v2H6zm2 2h8v2H8zm8-2h2v2h-2zm2-6h2v6h-2zm-7 10h2v2h-2z',
  'more-horizontal': 'M3 9h2v2H3zm8 0h2v2h-2zm8 0h2v2h-2zM1 11h2v2H1zm8 0h2v2H9zm8 0h2v2h-2zM3 13h2v2H3zm8 0h2v2h-2zm8 0h2v2h-2zM5 11h2v2H5zm8 0h2v2h-2zm8 0h2v2h-2z',
  'pause': 'M10 20H4V4h6v16Zm8-16v16h-6V4h6Zm-4 2v12h2V6h-2ZM6 18h2V6H6v12Z',
  'pencil': 'M4 16H6V18H8V20H10V22H2V14H4V16ZM12 20H10V18H12V20ZM14 18H12V16H14V18ZM10 16H8V14H10V16ZM16 16H14V14H16V16ZM6 14H4V12H6V14ZM12 14H10V12H12V14ZM18 14H16V12H18V14ZM8 12H6V10H8V12ZM14 12H12V10H14V12ZM20 12H18V10H20V12ZM10 10H8V8H10V10ZM18 10H16V8H18V10ZM22 10H20V8H22V10ZM12 8H10V6H12V8ZM16 8H14V6H16V8ZM20 8H18V6H20V8ZM14 6H12V4H14V6ZM18 6H16V4H18V6ZM16 4H14V2H16V4Z',
  'phone': 'M4 1h5v2H4zm5 2h2v4H9zM7 7h2v4H7zm-3 5h2v2H4zM2 3h2v9H2zm7 8h2v2H9zm2 2h2v2h-2zm2 2h4v2h-4zm4-2h4v2h-4zm4 2h2v5h-2zM6 14h2v2H6zm2 2h2v2H8zm2 2h2v2h-2zm2 2h9v2h-9z',
  'play': 'M15 11h-2V9h2zm0 4h-2v-2h2zm-2 2h-2v-2h2zm0-8h-2V7h2zm-2-2H9V5h2zM9 21H7V3h2zm6-8h2v-2h-2zm-6 4h2v2H9z',
  'plus': 'M13 11h7v2h-7v7h-2v-7H4v-2h7V4h2v7Z',
  'search': 'M22 22h-2v-2h2v2Zm-2-2h-2v-2h2v2Zm-6-2H6v-2h8v2Zm4 0h-2v-2h2v2ZM6 16H4v-2h2v2Zm10 0h-2v-2h2v2ZM4 14H2V6h2v8Zm14 0h-2V6h2v8ZM6 6H4V4h2v2Zm10 0h-2V4h2v2Zm-2-2H6V2h8v2Z',
  'sliders': 'M8 14H7v6H5v-6H2v-2h6v2Zm5 6h-2V10h2v10Zm9-2h-3v2h-2v-2h-1v-2h6v2Zm-3-4h-2V4h2v10ZM7 10H5V4h2v6Zm6-4h2v2H9V6h2V4h2v2Z',
  'smile': 'M6 20h12v2H6zM6 2h12v2H6zm12 2h2v2h-2zM4 4h2v2H4zm0 14h2v2H4zm14 0h2v2h-2zM2 6h2v12H2zm18 0h2v12h-2zM7 13h2v2H7zm2 2h6v2H9zm6-2h2v2h-2zM8 8h2v2H8zm6 0h2v2h-2z',
  'square-alert': 'M4 2h16v2H4zm0 18h16v2H4zM20 4h2v16h-2zM2 4h2v16H2zm9 2h2v8h-2zm0 10h2v2h-2z',
  'star': 'M5 20H8V22H3V16H5V20ZM21 22H16V20H19V16H21V22ZM10 20H8V18H10V20ZM16 20H14V18H16V20ZM14 18H10V16H14V18ZM7 16H5V13H7V16ZM19 16H17V13H19V16ZM5 13H3V11H5V13ZM21 13H19V11H21V13ZM9 9H3V11H1V7H9V9ZM23 11H21V9H15V7H23V11ZM11 7H9V3H11V7ZM15 7H13V3H15V7ZM13 3H11V1H13V3Z',
  'trash': 'M18 22H6V20H18V22ZM9 6H15V4H17V6H22V8H20V20H18V8H6V20H4V8H2V6H7V4H9V6ZM15 4H9V2H15V4Z',
  'undo': 'M18 20h-6v-2h6v2Zm2-2h-2v-8h2v8Zm-10-4H8v-2H6v-2H4V8h2V6h2V4h2v4h8v2h-8v4Z',
  'unlink': 'M4 6h5v2H4zm11 0h5v2h-5zm0 10h5v2h-5zM4 16h5v2H4zm16-8h2v8h-2zM2 8h2v8H2zm9-4h2v16h-2z',
  'user': 'M15 2H9v2H7v6h2V4h6V2zm0 8H9v2h6v-2zm0-6h2v6h-2V4zM4 16h2v-2h12v2H6v4h12v-4h2v6H4v-6z',
  'users': 'M5 2h6v2H5zm10 0h4v2h-4zM5 10h6v2H5zm10 0h4v2h-4zm4-6h2v6h-2zm-8 0h2v6h-2zM3 4h2v6H3zM0 18h2v4H0zm14 0h2v4h-2zm8 0h2v4h-2zM4 14h8v2H4zm12 0h4v2h-4zM2 16h2v2H2zm10 0h2v2h-2zm8 0h2v2h-2z',
  'video': 'M20 17V7h2v10zm-2-2V9h2v6zM2 7h2v10H2zm14 0h2v10h-2zM4 5h12v2H4zm0 12h12v2H4z',
};
const made = new Map();
/** A fresh <svg> for an icon; `size` is 24 or 48. */
export function icon(name, size = 24) {
  const key = `${name}@${size}`;
  let el = made.get(key);
  if (!el) {
    if (!ICONS[name]) throw new Error(`no icon ${name}`);
    el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [k, v] of [['width', size], ['height', size], ['viewBox', '0 0 24 24'], ['fill', 'currentColor'], ['shape-rendering', 'crispEdges'], ['aria-hidden', 'true'], ['class', 'px']]) el.setAttribute(k, String(v));
    el.innerHTML = `<path d="${ICONS[name]}"/>`; // constant markup above, no user data
    made.set(key, el);
  }
  return el.cloneNode(true);
}
