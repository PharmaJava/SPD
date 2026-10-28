/** Formato español para pantalla. Los datos siguen siendo ISO; esto sólo se usa al pintar. */
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const DIAS = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];

export function fecha(iso?: string | null): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}
export function fechaLarga(iso?: string | null): string {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  if (!m) return '—';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${DIAS[(d.getUTCDay() + 6) % 7]} ${+m[3]} ${MESES[+m[2] - 1]} ${m[1]}`;
}
export function mesAnio(iso?: string | null): string {
  const m = iso ? /^(\d{4})-(\d{2})/.exec(iso) : null;
  return m ? `${m[2]}/${m[1]}` : '—';
}
export function fechaHora(iso?: string | null): string {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso) : null;
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : fecha(iso);
}
export function numero(n?: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return String(Math.round(n * 100) / 100).replace('.', ',');
}
/** 0.5 → «½», 0.25 → «¼», 1.5 → «1½», 2 → «2». */
export function unidades(n: number): string {
  const ent = Math.trunc(n), fr = Math.round((n - ent) * 4);
  const f = ({ 0: '', 1: '¼', 2: '½', 3: '¾' } as Record<number, string>)[fr] ?? '';
  return `${ent === 0 && f ? '' : ent}${f}` || '0';
}
export function hoyIso(d = new Date()): string {
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function sumarDias(iso: string, dias: number): string {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + dias); return d.toISOString().slice(0, 10);
}
export function diasHasta(desde: string, hasta: string): number {
  return Math.round((Date.parse(hasta + 'T00:00:00Z') - Date.parse(desde + 'T00:00:00Z')) / 86400000);
}
export function mayuscula(s?: string | null): string { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
