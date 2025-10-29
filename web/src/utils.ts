export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function americanToDecimal(price: number): number {
  if (!Number.isFinite(price)) return 1;
  return price > 0 ? (1 + price / 100) : (1 + 100 / Math.abs(price));
}

export function decimalToAmerican(decimal: number): number {
  if (!Number.isFinite(decimal) || decimal <= 1) return 0;
  return decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1));
}

export function formatCurrency(n: number, currency = 'USD'): string {
  const v = Number(n) || 0;
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(v);
}

export async function fetchJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export function clampDate(dateStr: string, min?: string, max?: string): string {
  const d = new Date(dateStr);
  if (min && d < new Date(min)) return min;
  if (max && d > new Date(max)) return max;
  return dateStr;
}

