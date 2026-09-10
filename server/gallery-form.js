/**
 * The one description of what a gallery's details are, and what counts as a
 * valid one.
 *
 * Both the create and the update endpoint validate the same three fields, and
 * the editor renders the same expiry choices, so the list and the rules live
 * here rather than being restated in each place and drifting apart. The error
 * messages are in Polish because they are shown verbatim -- there is no
 * translation layer and no stack trace she should ever see.
 */

export const EXPIRY_CHOICES = [
  { days: 14, label: '14 dni' },
  { days: 30, label: '30 dni' },
  { days: 60, label: '60 dni' },
  { days: 90, label: '90 dni' },
];

export const DEFAULT_EXPIRY_DAYS = 30;

/** client_name is VARCHAR(120); truncating silently would rename a session. */
const NAME_LIMIT = 120;

const ALLOWED_DAYS = new Set(EXPIRY_CHOICES.map((choice) => choice.days));

/**
 * Reads the three fields out of a parsed JSON body.
 *
 * Returns `{ error }` or `{ values }`, never throws, and only includes a field
 * in `values` when the body actually carried it: the editor sends the expiry
 * only when she changed it, and an absent key has to mean "leave this alone"
 * rather than "set it to the default". Resetting a countdown because she fixed
 * a spelling mistake would be a surprise.
 *
 * @param {Record<string, unknown>} body
 * @param {{ requireName?: boolean }} options
 */
export function readGalleryDetails(body, { requireName = true } = {}) {
  /** @type {{ clientName?: string, shootDate?: string, expiryDays?: number }} */
  const values = {};

  if (body.clientName !== undefined || requireName) {
    const clientName = String(body.clientName ?? '').trim();
    if (!clientName) {
      return { error: 'Wpisz nazwę sesji — będzie widoczna na stronie ze zdjęciami.' };
    }
    if (clientName.length > NAME_LIMIT) {
      return { error: `Nazwa sesji jest za długa (najwyżej ${NAME_LIMIT} znaków).` };
    }
    values.clientName = clientName;
  }

  if (body.shootDate !== undefined) {
    const shootDate = String(body.shootDate ?? '').trim();
    if (shootDate && !isCalendarDate(shootDate)) {
      return { error: 'Data sesji jest nieprawidłowa. Wybierz ją z kalendarza.' };
    }
    values.shootDate = shootDate;
  }

  // An empty string is how the editor says "don't touch the expiry", which is
  // the normal case when she is only correcting a name.
  if (body.expiryDays !== undefined && body.expiryDays !== null && body.expiryDays !== '') {
    const expiryDays = Number(body.expiryDays);
    if (!ALLOWED_DAYS.has(expiryDays)) {
      return { error: 'Wybierz jeden z podanych terminów.' };
    }
    values.expiryDays = expiryDays;
  }

  return { values };
}

/**
 * `new Date('2026-02-31')` is not an error -- it rolls over into March -- so the
 * round-trip is the check. Without it a typed-in date lands in MySQL as a
 * different day, or as a strict-mode error five lines deeper.
 */
function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Whole days from now until `expiresAt`, rounded up, so "expires tomorrow
 * evening" reads as 1 rather than 0. Negative once the gallery is past its
 * term. Shared by the dashboard and by the editor, which offers "leave it as it
 * is (N days left)" alongside the fixed choices.
 */
export function daysUntil(expiresAt) {
  if (!expiresAt) return null;
  return Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
}
