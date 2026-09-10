/**
 * Sizes, as she reads them.
 *
 * Two scales, on purpose. A session is quoted in **megabytes**: an ordinary
 * shoot is 240 MB and rounds to "0.2 GB", which tells her nothing about
 * whether it is a big one. The disk budget stays in **gigabytes**, because
 * that is the number the host gives her -- 12 GB -- and "1 350 MB z 12 288 MB"
 * is arithmetic, not an answer.
 */

/** No decimals, thin-spaced thousands: "240 MB", "12 800 MB". */
export function megabytes(bytes) {
  const mb = Math.round(Number(bytes || 0) / 1024 ** 2);
  // Grouped by hand rather than through Intl: the host's locale is C and this
  // must not depend on which ICU the installed Node happens to carry.
  return `${String(mb).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} MB`;
}

/** One decimal, for the budget bar: "1.4 GB". */
export function gigabytes(bytes) {
  return `${(Number(bytes || 0) / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Polish counts, because "3 zdjęcia" and "5 zdjęć" are different words and a
 * list that says "1 zdjęcia" reads as broken to the only person who uses it.
 *
 * The rule: 1 takes the singular; 2-4 take the plural-few, except the teens
 * (12-14), which take the plural-many along with everything else.
 */
function few(n) {
  const last = n % 10;
  const teen = n % 100;
  return last >= 2 && last <= 4 && !(teen >= 12 && teen <= 14);
}

export function photoCount(count) {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  if (n === 1) return '1 zdjęcie';
  return `${n} ${few(n) ? 'zdjęcia' : 'zdjęć'}`;
}

export function dayCount(days) {
  const n = Math.max(0, Math.trunc(Number(days) || 0));
  // "dzień" only in the singular; every other count takes "dni", teens
  // included -- unlike zdjęcie, this word has no separate plural-few form.
  return n === 1 ? '1 dzień' : `${n} dni`;
}
