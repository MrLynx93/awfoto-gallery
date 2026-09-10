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
