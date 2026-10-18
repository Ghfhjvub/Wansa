// دوال مساعدة بلا اعتماد على Firebase.

export const COUNTRIES = [
  { n: 'السودان', c: '249', min: 9, max: 9, lead: /^[19]/ },
  { n: 'السعودية', c: '966', min: 9, max: 9, lead: /^5/ },
  { n: 'مصر', c: '20', min: 10, max: 10, lead: /^1/ },
  { n: 'الإمارات', c: '971', min: 9, max: 9, lead: /^5/ },
  { n: 'قطر', c: '974', min: 8, max: 8 },
  { n: 'الكويت', c: '965', min: 8, max: 8 },
  { n: 'عُمان', c: '968', min: 8, max: 8 },
  { n: 'البحرين', c: '973', min: 8, max: 8 },
  { n: 'الأردن', c: '962', min: 9, max: 9, lead: /^7/ },
  { n: 'العراق', c: '964', min: 10, max: 10, lead: /^7/ },
  { n: 'لبنان', c: '961', min: 7, max: 8 },
  { n: 'ليبيا', c: '218', min: 9, max: 9, lead: /^9/ },
  { n: 'تونس', c: '216', min: 8, max: 8 },
  { n: 'الجزائر', c: '213', min: 9, max: 9 },
  { n: 'المغرب', c: '212', min: 9, max: 9 },
  { n: 'اليمن', c: '967', min: 9, max: 9 },
  { n: 'سوريا', c: '963', min: 9, max: 9 },
  { n: 'فلسطين', c: '970', min: 9, max: 9 },
  { n: 'جنوب السودان', c: '211', min: 9, max: 9 },
  { n: 'تشاد', c: '235', min: 8, max: 8 },
  { n: 'إريتريا', c: '291', min: 7, max: 7 },
  { n: 'إثيوبيا', c: '251', min: 9, max: 9 },
  { n: 'المملكة المتحدة', c: '44', min: 10, max: 10 },
  { n: 'الولايات المتحدة', c: '1', min: 10, max: 10 }
];

export const COLORS = ['#B8432F', '#1F7A6B', '#5B4BB5', '#A8327A', '#2F66B3', '#8A6A00'];

const AR_DIGITS = /[٠-٩۰-۹]/g;

/** يحوّل الأرقام العربية والفارسية إلى لاتينية */
export const latin = s =>
  String(s).replace(AR_DIGITS, ch => {
    const n = ch.charCodeAt(0);
    return String(n >= 0x06F0 ? n - 0x06F0 : n - 0x0660);
  });

export const esc = s =>
  String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const pad = n => String(n).padStart(2, '0');
export const hm = ts => { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
export const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

function fmtDate(ts, opts) {
  try { return new Intl.DateTimeFormat('ar-u-nu-latn', opts).format(ts); }
  catch (e) { return new Date(ts).toLocaleDateString(); }
}
export const dayLabel = ts =>
  sameDay(ts, Date.now()) ? 'اليوم' :
  sameDay(ts, Date.now() - 864e5) ? 'أمس' :
  fmtDate(ts, { weekday: 'long', day: 'numeric', month: 'long' });
export const listTime = ts =>
  sameDay(ts, Date.now()) ? hm(ts) :
  sameDay(ts, Date.now() - 864e5) ? 'أمس' :
  fmtDate(ts, { day: 'numeric', month: 'numeric' });
export const seenLabel = ts =>
  'آخر ظهور ' + (sameDay(ts, Date.now()) ? 'اليوم ' : sameDay(ts, Date.now() - 864e5) ? 'أمس ' : '') + hm(ts);

export const initial = n => {
  const ch = [...String(n || '').trim()][0];
  return ch && /[\p{L}\p{N}]/u.test(ch) ? ch : '؟';
};

/** 249912345678 -> +249 912 345 678 */
export const fmtFull = d => '+' + String(d).replace(/(\d{3})(?=\d)/g, '$1 ');

/** يتحقق من رقم محلي لدولة معيّنة ويرجع الرقم الدولي بدون + */
export function checkNumber(country, raw) {
  let d = latin(raw).replace(/\D/g, '');
  if (d.startsWith(country.c) && d.length > country.max) d = d.slice(country.c.length);
  d = d.replace(/^0+/, '');
  if (!d) return { ok: false, error: 'اكتب رقم الجوال.' };
  const len = country.min === country.max ? String(country.min) : country.min + ' إلى ' + country.max;
  if (d.length < country.min || d.length > country.max)
    return { ok: false, error: 'يتكون رقم ' + country.n + ' من ' + len + ' أرقام بدون الصفر في البداية.' };
  if (country.lead && !country.lead.test(d))
    return { ok: false, error: 'هذا الرقم غير صحيح لدولة ' + country.n + '. راجع أول رقم.' };
  return { ok: true, digits: d, full: country.c + d };
}
