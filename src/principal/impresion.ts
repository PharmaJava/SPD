/**
 * Ayudas PURAS de impresión (sin Electron): conversiones y validación de lo que llega de la interfaz.
 * Se prueban solas; externo.ts las usa con Electron.
 */
export const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MIN_MM = 10;
const MAX_MM = 1000;

export interface OpcionesImpresion { impresora?: string; anchoMm?: number; altoMm?: number; silenciosa?: boolean }

/** Milímetros → micras (lo que pide `webContents.print({ pageSize })`). */
export const mmAMicras = (mm: number): number => Math.round(mm * 1000);
/** Milímetros → pulgadas (lo que pide `printToPDF({ pageSize })`). */
export const mmAPulgadas = (mm: number): number => mm / 25.4;

const medidaValida = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= MIN_MM && v <= MAX_MM;

/** Valida el HTML que llega de la interfaz: texto, no vacío y de tamaño razonable. Devuelve el motivo del rechazo o null. */
export function motivoHtmlInvalido(html: unknown): string | null {
  if (typeof html !== 'string') return 'El documento a imprimir no es texto.';
  if (!html.trim()) return 'El documento a imprimir está vacío.';
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) return 'El documento a imprimir es demasiado grande.';
  return null;
}

/** Normaliza y valida las opciones. Un tamaño sólo vale si vienen ancho Y alto, ambos en un rango sensato. */
export function normalizarOpciones(o: unknown): { ok: true; opciones: OpcionesImpresion } | { ok: false; error: string } {
  if (o === undefined || o === null) return { ok: true, opciones: {} };
  if (typeof o !== 'object' || Array.isArray(o)) return { ok: false, error: 'Las opciones de impresión no son válidas.' };
  const r = o as Record<string, unknown>;
  const salida: OpcionesImpresion = {};
  if (r.impresora !== undefined && r.impresora !== null && r.impresora !== '') {
    if (typeof r.impresora !== 'string' || r.impresora.length > 256) return { ok: false, error: 'El nombre de la impresora no es válido.' };
    salida.impresora = r.impresora;
  }
  const hayAncho = r.anchoMm !== undefined && r.anchoMm !== null, hayAlto = r.altoMm !== undefined && r.altoMm !== null;
  if (hayAncho !== hayAlto) return { ok: false, error: 'Hay que indicar el ancho y el alto del papel, o ninguno.' };
  if (hayAncho) {
    if (!medidaValida(r.anchoMm) || !medidaValida(r.altoMm)) return { ok: false, error: `El tamaño del papel debe estar entre ${MIN_MM} y ${MAX_MM} mm.` };
    salida.anchoMm = r.anchoMm; salida.altoMm = r.altoMm as number;
  }
  if (r.silenciosa !== undefined) {
    if (typeof r.silenciosa !== 'boolean') return { ok: false, error: 'La opción «silenciosa» no es válida.' };
    salida.silenciosa = r.silenciosa;
  }
  return { ok: true, opciones: salida };
}

/** Argumentos de `webContents.print` para unas opciones ya validadas. */
export function argumentosPrint(o: OpcionesImpresion) {
  return {
    silent: o.silenciosa === true,
    printBackground: true,
    margins: { marginType: 'none' as const },
    ...(o.impresora ? { deviceName: o.impresora } : {}),
    ...(o.anchoMm && o.altoMm ? { pageSize: { width: mmAMicras(o.anchoMm), height: mmAMicras(o.altoMm) } } : {}),
  };
}

/** Argumentos de `webContents.printToPDF`. La página que declara su `@page` manda (preferCSSPageSize). */
export function argumentosPdf(o: { anchoMm?: number; altoMm?: number } | undefined) {
  const t = o && medidaValida(o.anchoMm) && medidaValida(o.altoMm) ? { width: mmAPulgadas(o.anchoMm), height: mmAPulgadas(o.altoMm) } : null;
  return {
    printBackground: true,
    preferCSSPageSize: true,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    ...(t ? { pageSize: t } : { pageSize: 'A4' as const }),
  };
}

/** Nombre de fichero seguro (sin rutas ni caracteres raros), con extensión. */
export function nombreFicheroSeguro(sugerido: unknown, extension: string): string {
  let n = typeof sugerido === 'string' ? sugerido : 'documento';
  n = n.replace(/[\\/]+/g, '_').replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/\.{2,}/g, '.').replace(/^[. ]+/, '').trim().slice(0, 100);
  n = n.replace(new RegExp('\\.' + extension + '$', 'i'), '');
  if (!n) n = 'documento';
  return `${n}.${extension}`;
}

/** ¿Está la impresora pedida entre las instaladas? (comparación exacta: no se adivina otra). */
export function impresoraInstalada(nombre: string, lista: { name: string }[]): boolean {
  return lista.some(i => i.name === nombre);
}
