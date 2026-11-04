/**
 * Modos de impresión de la etiqueta del SPD (doc 07, §7.6).
 *
 * FUNCIONES PURAS: sin DOM, sin disco, sin Electron. Cálculo en milímetros y generación de HTML con
 * `@page` y posiciones absolutas en mm: lo impreso NO depende de los márgenes de la impresora
 * (hay que imprimir con «Escala 100 %» / «sin ajustar al tamaño de la página»).
 *
 *  A) `rollo`      — impresora de etiquetas: una etiqueta del tamaño del rollo configurado.
 *  B) `hoja`       — folio A4 con hoja de etiquetas adhesivas: rejilla configurable, con «primera
 *                    etiqueta libre» para reutilizar hojas empezadas.
 *  C) `ajustable`  — la etiqueta sobre un folio A4 con escala (25–200 %) y desplazamiento X/Y para
 *                    calibrar a la hoja que tenga la farmacia.
 *
 * Reglas de seguridad (CLAUDE.md, regla 1): ante la duda se BLOQUEA. Una rejilla que no cabe en el
 * folio, una etiqueta que no tiene el tamaño de su celda o una etiqueta ajustable que se saldría de
 * la hoja NO se imprimen: se devuelve `html: ''` y el motivo en `problemas`.
 */
import { A4_ALTO_MM, A4_ANCHO_MM, posicionesPlancha, PLANTILLA_DOC07_RESUMIBLE, validarPlantilla } from './etiquetas.ts';
import type { Plancha, Plantilla } from './etiquetas.ts';

// ───────────────────────── tipos ─────────────────────────

export type ModoImpresion = 'rollo' | 'hoja' | 'ajustable';
export const MODOS_IMPRESION: readonly ModoImpresion[] = ['rollo', 'hoja', 'ajustable'];
export const NOMBRE_MODO: Record<ModoImpresion, string> = {
  rollo: 'Impresora de etiquetas (rollo)',
  hoja: 'Folio con hoja de etiquetas',
  ajustable: 'Ajustable (folio A4)',
};

export interface RejillaHoja {
  columnas: number;
  filas: number;
  anchoMm: number;
  altoMm: number;
  margenSupMm: number;
  margenIzqMm: number;
  separacionHMm: number;
  separacionVMm: number;
}

export interface PosicionLibre { fila: number; columna: number }

export interface ConfigImpresion {
  modo: ModoImpresion;
  rollo: { anchoMm: number; altoMm: number };
  hoja: RejillaHoja & { primeraLibre: PosicionLibre };
  ajustable: { escalaPct: number; dxMm: number; dyMm: number };
}

export interface PlantillaHoja { id: string; nombre: string; rejilla: RejillaHoja }

// ───────────────────────── constantes ─────────────────────────

export const ESCALA_MIN_PCT = 25;
export const ESCALA_MAX_PCT = 200;
/** Desplazamiento máximo (± mm) en el modo ajustable. */
export const DESPLAZAMIENTO_MAX_MM = 100;
export const COPIAS_MAX = 100;
export const ROLLO_MIN_MM = 20;
export const ROLLO_MAX_MM = 300;
export const TAM_ETIQUETA_POR_DEFECTO = { anchoMm: PLANTILLA_DOC07_RESUMIBLE.pagina.ancho_mm, altoMm: PLANTILLA_DOC07_RESUMIBLE.pagina.alto_mm };
const TOL = 0.01;

/**
 * Plantillas de hoja de etiquetas habituales (EDITABLES: son sólo valores de partida; las medidas
 * reales están en la caja de la hoja). Sin marcas comerciales.
 */
export const PLANTILLAS_HOJA: readonly PlantillaHoja[] = [
  { id: '3x7', nombre: '3×7 · 63,5×38,1 mm', rejilla: { columnas: 3, filas: 7, anchoMm: 63.5, altoMm: 38.1, margenSupMm: 15.15, margenIzqMm: 7.2, separacionHMm: 2.5, separacionVMm: 0 } },
  { id: '2x7', nombre: '2×7 · 99,1×38,1 mm', rejilla: { columnas: 2, filas: 7, anchoMm: 99.1, altoMm: 38.1, margenSupMm: 15.15, margenIzqMm: 4.65, separacionHMm: 2.5, separacionVMm: 0 } },
  { id: '2x4', nombre: '2×4 · 99,1×67,7 mm', rejilla: { columnas: 2, filas: 4, anchoMm: 99.1, altoMm: 67.7, margenSupMm: 13.1, margenIzqMm: 4.65, separacionHMm: 2.5, separacionVMm: 0 } },
  { id: '3x8', nombre: '3×8 · 70×36 mm', rejilla: { columnas: 3, filas: 8, anchoMm: 70, altoMm: 36, margenSupMm: 4.5, margenIzqMm: 0, separacionHMm: 0, separacionVMm: 0 } },
];

export const CONFIG_IMPRESION_POR_DEFECTO: ConfigImpresion = {
  modo: 'rollo',
  rollo: { ...TAM_ETIQUETA_POR_DEFECTO },
  hoja: { ...PLANTILLAS_HOJA[0].rejilla, primeraLibre: { fila: 1, columna: 1 } },
  ajustable: { escalaPct: 100, dxMm: 0, dyMm: 0 },
};

// ───────────────────────── utilidades ─────────────────────────

const redondear = (n: number): number => Math.round(n * 100) / 100;
const mm = (n: number): string => `${redondear(n)}mm`;
const esNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const esObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nombreMm = (n: number): string => String(redondear(n)).replace('.', ',');

// ───────────────────────── validación ─────────────────────────

/** Motivos por los que la rejilla no sirve (lista vacía = válida). Comprueba que cabe en el folio A4. */
export function validarRejilla(r: unknown): string[] {
  if (!esObj(r)) return ['La hoja de etiquetas no es válida.'];
  const e: string[] = [];
  const entero = (k: string, nombre: string, max: number) => {
    const v = r[k];
    if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > max) e.push(`${nombre}: debe ser un número entero entre 1 y ${max}.`);
  };
  entero('columnas', 'Columnas', 10); entero('filas', 'Filas', 30);
  for (const [k, n] of [['anchoMm', 'Ancho de la etiqueta'], ['altoMm', 'Alto de la etiqueta']] as const) {
    if (!esNum(r[k]) || r[k] < 5 || r[k] > A4_ALTO_MM) e.push(`${n}: debe estar entre 5 y ${A4_ALTO_MM} mm.`);
  }
  for (const [k, n] of [['margenSupMm', 'Margen superior'], ['margenIzqMm', 'Margen izquierdo'], ['separacionHMm', 'Separación horizontal'], ['separacionVMm', 'Separación vertical']] as const) {
    if (!esNum(r[k]) || r[k] < 0 || r[k] > 100) e.push(`${n}: debe estar entre 0 y 100 mm.`);
  }
  if (e.length) return e;
  const g = r as unknown as RejillaHoja;
  const finX = g.margenIzqMm + g.columnas * g.anchoMm + (g.columnas - 1) * g.separacionHMm;
  const finY = g.margenSupMm + g.filas * g.altoMm + (g.filas - 1) * g.separacionVMm;
  if (finX > A4_ANCHO_MM + TOL) e.push(`La hoja no cabe en el folio: ocupa ${nombreMm(finX)} mm de ancho y el A4 mide ${A4_ANCHO_MM} mm.`);
  if (finY > A4_ALTO_MM + TOL) e.push(`La hoja no cabe en el folio: ocupa ${nombreMm(finY)} mm de alto y el A4 mide ${A4_ALTO_MM} mm.`);
  return e;
}

export function validarPosicionLibre(p: unknown, r: Pick<RejillaHoja, 'filas' | 'columnas'>): string[] {
  if (!esObj(p) || !Number.isInteger(p.fila) || !Number.isInteger(p.columna)) return ['La primera etiqueta libre debe indicar fila y columna (números enteros).'];
  const e: string[] = [];
  if ((p.fila as number) < 1 || (p.fila as number) > r.filas) e.push(`La fila de la primera etiqueta libre debe estar entre 1 y ${r.filas}.`);
  if ((p.columna as number) < 1 || (p.columna as number) > r.columnas) e.push(`La columna de la primera etiqueta libre debe estar entre 1 y ${r.columnas}.`);
  return e;
}

export function validarAjustable(a: unknown): string[] {
  if (!esObj(a)) return ['El ajuste no es válido.'];
  const e: string[] = [];
  if (!esNum(a.escalaPct) || a.escalaPct < ESCALA_MIN_PCT || a.escalaPct > ESCALA_MAX_PCT) e.push(`La escala debe estar entre ${ESCALA_MIN_PCT} % y ${ESCALA_MAX_PCT} %.`);
  for (const [k, n] of [['dxMm', 'El desplazamiento horizontal'], ['dyMm', 'El desplazamiento vertical']] as const) {
    if (!esNum(a[k]) || Math.abs(a[k]) > DESPLAZAMIENTO_MAX_MM) e.push(`${n} debe estar entre −${DESPLAZAMIENTO_MAX_MM} y ${DESPLAZAMIENTO_MAX_MM} mm.`);
  }
  return e;
}

export function validarRollo(r: unknown): string[] {
  if (!esObj(r)) return ['El tamaño del rollo no es válido.'];
  const e: string[] = [];
  for (const [k, n] of [['anchoMm', 'El ancho del rollo'], ['altoMm', 'El alto de la etiqueta']] as const) {
    if (!esNum(r[k]) || r[k] < ROLLO_MIN_MM || r[k] > ROLLO_MAX_MM) e.push(`${n} debe estar entre ${ROLLO_MIN_MM} y ${ROLLO_MAX_MM} mm.`);
  }
  return e;
}

/** Valida una configuración completa (lo que llega de Ajustes). */
export function validarConfigImpresion(c: unknown): string[] {
  if (!esObj(c)) return ['La configuración de impresión no es válida.'];
  const e: string[] = [];
  if (!MODOS_IMPRESION.includes(c.modo as ModoImpresion)) e.push('El modo de impresión no es válido.');
  e.push(...validarRollo(c.rollo));
  const h = c.hoja;
  const eh = validarRejilla(h);
  e.push(...eh);
  if (esObj(h) && eh.length === 0) e.push(...validarPosicionLibre(h.primeraLibre, h as unknown as RejillaHoja));
  e.push(...validarAjustable(c.ajustable));
  return e;
}

/**
 * Lee una configuración guardada con tolerancia: lo que falta o no vale vuelve al valor por defecto
 * (una configuración corrupta nunca impide imprimir; el modo por defecto es el rollo).
 */
export function normalizarConfigImpresion(raw: unknown): ConfigImpresion {
  const d = CONFIG_IMPRESION_POR_DEFECTO;
  if (!esObj(raw)) return structuredClone(d);
  const c: ConfigImpresion = {
    modo: MODOS_IMPRESION.includes(raw.modo as ModoImpresion) ? raw.modo as ModoImpresion : d.modo,
    rollo: esObj(raw.rollo) && validarRollo(raw.rollo).length === 0 ? { anchoMm: raw.rollo.anchoMm as number, altoMm: raw.rollo.altoMm as number } : { ...d.rollo },
    hoja: structuredClone(d.hoja),
    ajustable: esObj(raw.ajustable) && validarAjustable(raw.ajustable).length === 0
      ? { escalaPct: raw.ajustable.escalaPct as number, dxMm: raw.ajustable.dxMm as number, dyMm: raw.ajustable.dyMm as number } : { ...d.ajustable },
  };
  if (esObj(raw.hoja) && validarRejilla(raw.hoja).length === 0) {
    const h = raw.hoja as unknown as RejillaHoja & { primeraLibre?: unknown };
    const rej: RejillaHoja = { columnas: h.columnas, filas: h.filas, anchoMm: h.anchoMm, altoMm: h.altoMm, margenSupMm: h.margenSupMm, margenIzqMm: h.margenIzqMm, separacionHMm: h.separacionHMm, separacionVMm: h.separacionVMm };
    const pl = validarPosicionLibre(h.primeraLibre, rej).length === 0 ? h.primeraLibre as PosicionLibre : { fila: 1, columna: 1 };
    c.hoja = { ...rej, primeraLibre: { fila: pl.fila, columna: pl.columna } };
  }
  return c;
}

// ───────────────────────── rejilla ─────────────────────────

export interface PosicionHoja { fila: number; columna: number; xMm: number; yMm: number }

const aPlancha = (r: RejillaHoja): Plancha => ({
  filas: r.filas, columnas: r.columnas, ancho_etiqueta_mm: r.anchoMm, alto_etiqueta_mm: r.altoMm,
  margen_sup_mm: r.margenSupMm, margen_izq_mm: r.margenIzqMm, paso_h_mm: r.anchoMm + r.separacionHMm, paso_v_mm: r.altoMm + r.separacionVMm,
});

/** Todas las posiciones de una hoja (por filas), en mm desde la esquina superior izquierda del folio. */
export function posicionesHoja(r: RejillaHoja): PosicionHoja[] {
  return posicionesPlancha(aPlancha(r), { todas: true });
}

/** Número de huecos de una hoja. */
export const huecosPorHoja = (r: Pick<RejillaHoja, 'filas' | 'columnas'>): number => r.filas * r.columnas;

/** Índice 0-based de la posición (fila y columna 1-based). */
export const indiceDePosicion = (r: Pick<RejillaHoja, 'columnas'>, p: PosicionLibre): number => (p.fila - 1) * r.columnas + (p.columna - 1);

export function posicionDeIndice(r: Pick<RejillaHoja, 'columnas'>, i: number): PosicionLibre {
  return { fila: Math.floor(i / r.columnas) + 1, columna: (i % r.columnas) + 1 };
}

export interface RepartoHojas { hojas: PosicionHoja[][]; siguiente: PosicionLibre }

/**
 * Reparte `copias` etiquetas en hojas: la primera hoja desde `primeraLibre`; las siguientes, desde el
 * hueco 1 (hoja nueva). `siguiente` es la primera posición libre tras imprimir (si la última hoja
 * queda llena, vuelve a 1,1: la próxima impresión necesita una hoja nueva).
 */
export function repartirEnHojas(r: RejillaHoja, primera: PosicionLibre, copias: number): RepartoHojas {
  const todas = posicionesHoja(r);
  const n = huecosPorHoja(r);
  const inicio = indiceDePosicion(r, primera);
  const hojas: PosicionHoja[][] = [];
  let resto = Math.max(0, Math.floor(copias));
  let desde = inicio;
  while (resto > 0) {
    const hoja = todas.slice(desde, desde + resto);
    hojas.push(hoja);
    resto -= hoja.length;
    desde = 0;
  }
  const usadasTotal = inicio + Math.max(0, Math.floor(copias));
  return { hojas, siguiente: posicionDeIndice(r, usadasTotal % n) };
}

/** Primera posición libre después de imprimir `usadas` etiquetas empezando en `primera`. */
export const siguientePosicionLibre = (r: RejillaHoja, primera: PosicionLibre, usadas: number): PosicionLibre =>
  repartirEnHojas(r, primera, usadas).siguiente;

/** Cuántas etiquetas libres quedan en la primera hoja desde `primera` (incluida). */
export const libresDesde = (r: RejillaHoja, primera: PosicionLibre): number => huecosPorHoja(r) - indiceDePosicion(r, primera);

// ───────────────────────── plantilla para un tamaño dado ─────────────────────────

const esTamanoEstandar = (ancho: number, alto: number): boolean =>
  Math.abs(ancho - TAM_ETIQUETA_POR_DEFECTO.anchoMm) < TOL && Math.abs(alto - TAM_ETIQUETA_POR_DEFECTO.altoMm) < TOL;

/**
 * Plantilla de etiqueta para un tamaño distinto del estándar (100×150): la MISMA estructura (nombre,
 * paciente, tomas «auto», aparte, código a la hoja A4, pie) pensada para el espacio disponible. El
 * código se mantiene cuadrado. NO recorta: si lo que hay que decir no cabe, el motor de etiquetas lo
 * marca y la etiqueta no es imprimible.
 */
export function plantillaParaTamano(anchoMm: number, altoMm: number): Plantilla {
  if (esTamanoEstandar(anchoMm, altoMm)) return structuredClone(PLANTILLA_DOC07_RESUMIBLE);
  const m = anchoMm >= 80 && altoMm >= 55 ? 3 : 2;
  const w = redondear(anchoMm - 2 * m);
  const h = redondear(altoMm - 2 * m);
  const q = redondear(Math.min(20, Math.max(8, Math.min(w * 0.25, h * 0.25))));
  const pie = h >= 40 ? 8 : 6;
  const cabecera = h >= 40 ? 5 : 4;
  const paciente = h >= 40 ? 6 : 5;
  const yTomas = cabecera + paciente + 0.5;
  const yFooter = redondear(h - pie - q - 0.5);
  const hTomas = redondear(Math.max(1, yFooter - yTomas - 0.5));
  return {
    pagina: { ancho_mm: anchoMm, alto_mm: altoMm, orientacion: anchoMm > altoMm ? 'horizontal' : 'vertical' },
    plancha: null,
    margenes_mm: [m, m, m, m],
    fuente_base_pt: 6,
    formato_es: true,
    bloques: [
      { tipo: 'texto', x: 0, y: 0, w, h: cabecera, contenido: '{{farmacia.nombre}} · {{farmacia.telefono}}', negrita: true },
      { tipo: 'texto', x: 0, y: cabecera, w, h: paciente, contenido: '{{paciente.nombre_completo}}', tam_pt: h >= 40 ? 9 : 8, negrita: true },
      { tipo: 'tabla_tomas', modo: 'auto', x: 0, y: yTomas, w, h: hTomas, columnas: ['medicamento', 'descripcion', 'momentos', 'lote_caducidad'] },
      { tipo: 'aparte', x: 0, y: yFooter, w: redondear(w - q - 1), h: q },
      { tipo: 'codigo', simbologia: 'qrcode', x: redondear(w - q), y: yFooter, w: q, h: q, contenido: '{{preparacion.id_publico}}' },
      { tipo: 'texto', x: 0, y: redondear(h - pie), w, h: pie,
        contenido: 'Del {{periodo.inicio}} al {{periodo.fin}} · Caduca {{preparacion.caducidad}} · Prep. {{prep.iniciales}} / Val. {{val.iniciales}}' },
    ],
  };
}

/** Errores de la plantilla compacta para un tamaño (vacío = geométricamente válida). */
export const erroresPlantillaParaTamano = (ancho: number, alto: number): string[] => validarPlantilla(plantillaParaTamano(ancho, alto));

/**
 * Tamaño de etiqueta que hay que pedir al servicio según el modo: el rollo, la celda de la hoja o el
 * tamaño estándar (modo ajustable: se escala después).
 */
export function tamanoDeEtiqueta(c: ConfigImpresion, modo: ModoImpresion = c.modo): { anchoMm: number; altoMm: number } {
  if (modo === 'rollo') return { anchoMm: c.rollo.anchoMm, altoMm: c.rollo.altoMm };
  if (modo === 'hoja') return { anchoMm: c.hoja.anchoMm, altoMm: c.hoja.altoMm };
  return { ...TAM_ETIQUETA_POR_DEFECTO };
}

// ───────────────────────── composición del HTML ─────────────────────────

export interface PartesDocumento {
  estilos: string;
  /** Contenido de la etiqueta (sin la marca de agua). */
  etiqueta: string;
  /** Marca de agua («SIN VALIDAR», «ANULADA») si la lleva. */
  marca: string | null;
  anchoMm: number;
  altoMm: number;
}

const RE_MARCA = /<div class="marca-agua">[\s\S]*?<\/div>/;

/** Separa el documento de etiqueta que genera el motor en estilos, cuerpo, marca de agua y tamaño de página. */
export function partesDocumento(html: string): PartesDocumento | null {
  if (typeof html !== 'string') return null;
  const tam = /@page\{size:([\d.]+)mm ([\d.]+)mm;margin:0\}/.exec(html);
  const cuerpo = /<body>([\s\S]*)<\/body>/.exec(html);
  if (!tam || !cuerpo) return null;
  const estilos = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((x) => x[1].replace(/@page\{[^}]*\}/g, '')).join('');
  const marca = RE_MARCA.exec(cuerpo[1]);
  return {
    estilos,
    etiqueta: cuerpo[1].replace(RE_MARCA, ''),
    marca: marca ? marca[0] : null,
    anchoMm: Number(tam[1]),
    altoMm: Number(tam[2]),
  };
}

export interface HtmlComponer {
  /** HTML listo para imprimir o guardar en PDF. Vacío si hay problemas bloqueantes. */
  html: string;
  /** Tamaño de página (mm) con el que hay que imprimir o exportar: el mismo para vista previa, impresión y PDF. */
  anchoMm: number;
  altoMm: number;
  paginas: number;
  etiquetas: number;
  problemas: string[];
  avisos: string[];
  /** Sólo modo hoja: primera posición libre tras imprimir. */
  siguiente?: PosicionLibre;
}

const vacio = (problemas: string[]): HtmlComponer => ({ html: '', anchoMm: 0, altoMm: 0, paginas: 0, etiquetas: 0, problemas, avisos: [] });

const CSS_PAGINA = (ancho: number, alto: number) =>
  `@page{size:${mm(ancho)} ${mm(alto)};margin:0}html,body{margin:0;padding:0}` +
  `.pg{position:relative;width:${mm(ancho)};height:${mm(alto)};overflow:hidden;break-after:page;page-break-after:always}` +
  `.pg:last-child{break-after:auto;page-break-after:auto}.cel{position:absolute;overflow:hidden}`;

const documento = (titulo: string, ancho: number, alto: number, estilos: string, extra: string, cuerpo: string): string =>
  `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${titulo}</title><style>${estilos}${CSS_PAGINA(ancho, alto)}${extra}</style></head><body>${cuerpo}</body></html>`;

const tamCoincide = (p: PartesDocumento, ancho: number, alto: number) => Math.abs(p.anchoMm - ancho) < 0.05 && Math.abs(p.altoMm - alto) < 0.05;

function copiasValidas(copias: number): string | null {
  return Number.isInteger(copias) && copias >= 1 && copias <= COPIAS_MAX ? null : `El número de copias debe ser un entero entre 1 y ${COPIAS_MAX}.`;
}

/**
 * Compone la página (o páginas) a imprimir a partir del documento de UNA etiqueta que genera el motor.
 * `copias` = cuántas etiquetas iguales se quieren (rollo: una página cada una; hoja: huecos
 * consecutivos; ajustable: siempre una).
 */
export function componerImpresion(htmlEtiqueta: string, c: ConfigImpresion, modo: ModoImpresion = c.modo, copias = 1): HtmlComponer {
  const p = partesDocumento(htmlEtiqueta);
  if (!p) return vacio(['No se pudo leer la etiqueta que hay que colocar en la página.']);
  const errCopias = copiasValidas(copias);
  if (errCopias) return vacio([errCopias]);
  const marca = p.marca ?? '';

  if (modo === 'rollo') {
    const e = validarRollo(c.rollo);
    if (e.length) return vacio(e);
    if (!tamCoincide(p, c.rollo.anchoMm, c.rollo.altoMm)) return vacio([`La etiqueta (${nombreMm(p.anchoMm)}×${nombreMm(p.altoMm)} mm) no tiene el tamaño del rollo (${nombreMm(c.rollo.anchoMm)}×${nombreMm(c.rollo.altoMm)} mm).`]);
    const paginas = Array.from({ length: copias }, () => `<section class="pg">${p.etiqueta}</section>`).join('');
    return {
      html: documento('Etiqueta', c.rollo.anchoMm, c.rollo.altoMm, p.estilos, '', paginas + marca),
      anchoMm: c.rollo.anchoMm, altoMm: c.rollo.altoMm, paginas: copias, etiquetas: copias, problemas: [], avisos: [],
    };
  }

  if (modo === 'hoja') {
    const e = [...validarRejilla(c.hoja)];
    if (!e.length) e.push(...validarPosicionLibre(c.hoja.primeraLibre, c.hoja));
    if (e.length) return vacio(e);
    if (!tamCoincide(p, c.hoja.anchoMm, c.hoja.altoMm)) return vacio([`La etiqueta (${nombreMm(p.anchoMm)}×${nombreMm(p.altoMm)} mm) no tiene el tamaño de la etiqueta de la hoja (${nombreMm(c.hoja.anchoMm)}×${nombreMm(c.hoja.altoMm)} mm).`]);
    const reparto = repartirEnHojas(c.hoja, c.hoja.primeraLibre, copias);
    const paginas = reparto.hojas.map((hoja) =>
      `<section class="pg">${hoja.map((pos) => `<div class="cel" data-fila="${pos.fila}" data-columna="${pos.columna}" style="left:${mm(pos.xMm)};top:${mm(pos.yMm)};width:${mm(c.hoja.anchoMm)};height:${mm(c.hoja.altoMm)}">${p.etiqueta}</div>`).join('')}</section>`).join('');
    return {
      html: documento('Etiquetas en hoja', A4_ANCHO_MM, A4_ALTO_MM, p.estilos, '', paginas + marca),
      anchoMm: A4_ANCHO_MM, altoMm: A4_ALTO_MM, paginas: reparto.hojas.length, etiquetas: copias, problemas: [], avisos: [], siguiente: reparto.siguiente,
    };
  }

  // ajustable
  const e = validarAjustable(c.ajustable);
  if (e.length) return vacio(e);
  const s = c.ajustable.escalaPct / 100;
  const x = c.ajustable.dxMm, y = c.ajustable.dyMm;
  const w = p.anchoMm * s, h = p.altoMm * s;
  const salidas: string[] = [];
  if (x < -TOL) salidas.push('izquierda'); if (y < -TOL) salidas.push('arriba');
  if (x + w > A4_ANCHO_MM + TOL) salidas.push('derecha'); if (y + h > A4_ALTO_MM + TOL) salidas.push('abajo');
  if (salidas.length) return vacio([`Con esta escala y este desplazamiento la etiqueta se saldría de la hoja por ${salidas.join(' y ')}: no se imprime para no cortarla.`]);
  const cel = `<div class="cel" style="left:${mm(x)};top:${mm(y)};width:${mm(p.anchoMm)};height:${mm(p.altoMm)};transform:scale(${redondear(s * 10000) / 10000});transform-origin:0 0;overflow:visible">${p.etiqueta}</div>`;
  return {
    html: documento('Etiqueta ajustada', A4_ANCHO_MM, A4_ALTO_MM, p.estilos, '', `<section class="pg">${cel}</section>` + marca),
    anchoMm: A4_ANCHO_MM, altoMm: A4_ALTO_MM, paginas: 1, etiquetas: 1, problemas: [],
    avisos: s < 0.85 ? [`Escala del ${c.ajustable.escalaPct} %: la letra más pequeña se ve a ${redondear(6 * s)} pt. Comprueba que se lee bien.`] : [],
  };
}

// ───────────────────────── hoja de prueba ─────────────────────────

const ESTILO_PRUEBA =
  'body{font-family:Arial,Helvetica,sans-serif;color:#000}.r{position:absolute;box-sizing:border-box;border:0.3mm solid #000}' +
  '.t{position:absolute;font-size:6pt;line-height:1}.u{background:#ddd}.p{border-width:0.8mm}' +
  '.lin{position:absolute;background:#000}';

/** Marcas de regla cada 10 mm en los bordes superior e izquierdo del folio (para comprobar que se imprime a escala 100 %). */
function reglas(): string {
  let s = '';
  for (let v = 0; v <= 200; v += 10) {
    const largo = v % 50 === 0 ? 4 : 2;
    s += `<div class="lin" style="left:${mm(v)};top:0;width:0.2mm;height:${mm(largo)}"></div>`;
    if (v % 50 === 0 && v > 0) s += `<div class="t" style="left:${mm(v + 0.6)};top:4.5mm">${v}</div>`;
  }
  for (let v = 10; v <= 290; v += 10) {
    const largo = v % 50 === 0 ? 4 : 2;
    s += `<div class="lin" style="top:${mm(v)};left:0;height:0.2mm;width:${mm(largo)}"></div>`;
    if (v % 50 === 0) s += `<div class="t" style="top:${mm(v + 0.6)};left:4.5mm">${v}</div>`;
  }
  return s;
}

/**
 * Hoja de prueba SIN datos de nadie, para comprobar la alineación antes de gastar etiquetas:
 *  - rollo: marco del tamaño del rollo con diagonales;
 *  - hoja: todos los huecos con su borde y su número (los ya usados, en gris) y la primera libre en negrita;
 *  - ajustable: el recuadro de la etiqueta (tamaño estándar) con la escala y el desplazamiento actuales.
 * Tamaño de página igual al de la impresión real.
 */
export function hojaDePrueba(c: ConfigImpresion, modo: ModoImpresion = c.modo): HtmlComponer {
  if (modo === 'rollo') {
    const e = validarRollo(c.rollo);
    if (e.length) return vacio(e);
    const { anchoMm: w, altoMm: h } = c.rollo;
    const diag = (a: number) => `<div class="lin" style="left:0;top:0;width:${mm(Math.hypot(w, h))};height:0.2mm;transform-origin:0 0;transform:${a === 1 ? `rotate(${redondear(Math.atan2(h, w) * 180 / Math.PI)}deg)` : `translateY(${mm(h)}) rotate(${redondear(-Math.atan2(h, w) * 180 / Math.PI)}deg)`}"></div>`;
    const cuerpo = `<section class="pg"><div class="r p" style="left:0;top:0;width:${mm(w)};height:${mm(h)}"></div>${diag(1)}${diag(2)}` +
      `<div class="t" style="left:2mm;top:2mm;font-size:7pt">Prueba · ${nombreMm(w)}×${nombreMm(h)} mm</div></section>`;
    return { html: documento('Hoja de prueba', w, h, ESTILO_PRUEBA, '', cuerpo), anchoMm: w, altoMm: h, paginas: 1, etiquetas: 0, problemas: [], avisos: [] };
  }
  if (modo === 'hoja') {
    const e = [...validarRejilla(c.hoja)];
    if (!e.length) e.push(...validarPosicionLibre(c.hoja.primeraLibre, c.hoja));
    if (e.length) return vacio(e);
    const libre = indiceDePosicion(c.hoja, c.hoja.primeraLibre);
    const celdas = posicionesHoja(c.hoja).map((pos, i) => {
      const usada = i < libre;
      return `<div class="r${usada ? ' u' : ''}" style="left:${mm(pos.xMm)};top:${mm(pos.yMm)};width:${mm(c.hoja.anchoMm)};height:${mm(c.hoja.altoMm)}">` +
        `<div class="t" style="left:1.5mm;top:1.5mm;font-size:7pt${i === libre ? ';font-weight:bold' : ''}">${pos.fila},${pos.columna}${usada ? ' · usada' : i === libre ? ' · primera libre' : ''}</div></div>`;
    }).join('');
    const cuerpo = `<section class="pg">${reglas()}${celdas}</section>`;
    return { html: documento('Hoja de prueba', A4_ANCHO_MM, A4_ALTO_MM, ESTILO_PRUEBA, '', cuerpo), anchoMm: A4_ANCHO_MM, altoMm: A4_ALTO_MM, paginas: 1, etiquetas: 0, problemas: [], avisos: [] };
  }
  const e = validarAjustable(c.ajustable);
  if (e.length) return vacio(e);
  const s = c.ajustable.escalaPct / 100;
  const w = TAM_ETIQUETA_POR_DEFECTO.anchoMm * s, h = TAM_ETIQUETA_POR_DEFECTO.altoMm * s;
  const x = c.ajustable.dxMm, y = c.ajustable.dyMm;
  if (x < -TOL || y < -TOL || x + w > A4_ANCHO_MM + TOL || y + h > A4_ALTO_MM + TOL) return vacio(['Con esta escala y este desplazamiento la etiqueta se saldría de la hoja.']);
  const cuerpo = `<section class="pg">${reglas()}<div class="r p" style="left:${mm(x)};top:${mm(y)};width:${mm(w)};height:${mm(h)}"></div>` +
    `<div class="t" style="left:${mm(x + 2)};top:${mm(y + 2)};font-size:7pt">Escala ${redondear(c.ajustable.escalaPct)} % · X ${redondear(x)} mm · Y ${redondear(y)} mm</div></section>`;
  return { html: documento('Hoja de prueba', A4_ANCHO_MM, A4_ALTO_MM, ESTILO_PRUEBA, '', cuerpo), anchoMm: A4_ANCHO_MM, altoMm: A4_ALTO_MM, paginas: 1, etiquetas: 0, problemas: [], avisos: [] };
}
