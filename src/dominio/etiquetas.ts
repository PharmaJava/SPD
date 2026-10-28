/**
 * Motor de plantillas de etiqueta del SPD (doc 07, §7.3-7.4).
 *
 * FUNCIONES PURAS: sin DOM, sin disco. Generan cadenas (HTML con CSS en mm).
 * El código (QR, DataMatrix…) lo dibuja otra capa: aquí sólo se emite un
 * `<div data-codigo=...>` con su contenido y simbología.
 *
 * Reglas de seguridad (CLAUDE.md, regla 1):
 *  - Una variable SIN valor NUNCA se imprime en blanco: se marca «⟦ruta⟧» y se
 *    devuelve en `faltan`; la etiqueta deja de ser imprimible.
 *  - Un texto que no cabe NUNCA se corta: se reduce la letra hasta el mínimo y,
 *    si aun así no cabe, se marca y se bloquea la impresión definitiva.
 *  - Todo valor que entra en el HTML se escapa (el nombre «O'Brien <b>» no
 *    inyecta nada).
 *
 * Convención de coordenadas: x, y de cada bloque son relativas al área
 * interior (página menos márgenes). Márgenes: [superior, derecho, inferior,
 * izquierdo] en mm.
 */

// ───────────────────────── tipos ─────────────────────────

export type TipoBloque = 'texto' | 'tabla_tomas' | 'aparte' | 'codigo';
export type Simbologia = 'qrcode' | 'datamatrix' | 'code128';

export interface Bloque {
  tipo: TipoBloque;
  x: number;
  y: number;
  w: number;
  h: number;
  contenido?: string;
  negrita?: boolean;
  tam_pt?: number;
  columnas?: string[];
  simbologia?: Simbologia;
}

export interface Plancha {
  filas: number;
  columnas: number;
  ancho_etiqueta_mm: number;
  alto_etiqueta_mm: number;
  margen_sup_mm: number;
  margen_izq_mm: number;
  paso_h_mm: number;
  paso_v_mm: number;
  /** 1-based: primer hueco libre de una plancha empezada (por filas). */
  primera_libre?: number;
}

export interface Plantilla {
  pagina: { ancho_mm: number; alto_mm: number; orientacion?: 'vertical' | 'horizontal' };
  plancha: Plancha | null;
  margenes_mm: [number, number, number, number];
  fuente_base_pt: number;
  bloques: Bloque[];
}

export interface PosicionPlancha {
  /** 1-based. */
  fila: number;
  /** 1-based. */
  columna: number;
  xMm: number;
  yMm: number;
}

export interface TomaEntrada {
  fecha: string;
  momentoNombre: string;
  medicamentos: { nombre: string; unidades: number; lote: string; caducidad: string }[];
}

export interface FilaTomas {
  fecha: string;
  momento: string;
  medicamento: string;
  unidades: number;
  lote: string;
  caducidad: string;
  /** true si falta lote o caducidad: la etiqueta no es imprimible. */
  faltaTraza: boolean;
}

export interface ResultadoRender {
  html: string;
  cabe: boolean;
  problemas: string[];
  faltan: string[];
  imprimible: boolean;
}

// ───────────────────────── constantes ─────────────────────────

export const A4_ANCHO_MM = 210;
export const A4_ALTO_MM = 297;
export const PT_MM = 25.4 / 72;
/**
 * Ancho medio de un carácter = 0.5 × tamaño de letra (en pt, pasado a mm).
 * Aproximación conservadora para Arial/Helvetica en texto con mayúsculas y
 * dígitos; no sustituye a medir con la fuente real.
 */
export const ANCHO_CARACTER_EM = 0.5;
/** Interlineado = 1.2 × tamaño de letra. */
export const INTERLINEADO = 1.2;

export const VARIABLES_PERMITIDAS: readonly string[] = [
  'farmacia.nombre', 'farmacia.direccion', 'farmacia.telefono',
  'paciente.nombre_completo', 'paciente.id_corto',
  'preparacion.id_publico', 'preparacion.caducidad',
  'periodo.inicio', 'periodo.fin',
  'prep.iniciales', 'val.iniciales',
  'prescriptor.nombre',
];

const TIPOS: readonly string[] = ['texto', 'tabla_tomas', 'aparte', 'codigo'];
const SIMBOLOGIAS: readonly string[] = ['qrcode', 'datamatrix', 'code128'];
const COLUMNAS_TABLA: readonly string[] = ['medicamento', 'descripcion', 'momentos', 'lote_caducidad'];
const TOL = 0.001;

// ───────────────────────── utilidades ─────────────────────────

function redondear(n: number): number {
  return Math.round(n * 100) / 100;
}
function mm(n: number): string {
  return `${redondear(n)}mm`;
}
function esNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function esObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function escaparHtml(t: string): string {
  return t
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const RE_VAR = /\{\{\s*([^{}]*?)\s*\}\}/g;

function variablesDe(texto: string): string[] {
  const r: string[] = [];
  for (const m of texto.matchAll(RE_VAR)) r.push(m[1]);
  return r;
}

function valorEnRuta(datos: Record<string, unknown>, ruta: string): string | undefined {
  let actual: unknown = datos;
  for (const parte of ruta.split('.')) {
    if (!esObjeto(actual) || !Object.prototype.hasOwnProperty.call(actual, parte)) return undefined;
    actual = actual[parte];
  }
  if (typeof actual === 'string') return actual.trim() === '' ? undefined : actual;
  if (typeof actual === 'number' && Number.isFinite(actual)) return String(actual);
  return undefined;
}

function resolver(texto: string, datos: Record<string, unknown>, escapar: boolean): { texto: string; faltan: string[] } {
  const faltan: string[] = [];
  let salida = '';
  let ultimo = 0;
  for (const m of texto.matchAll(RE_VAR)) {
    const idx = m.index ?? 0;
    const lit = texto.slice(ultimo, idx);
    salida += escapar ? escaparHtml(lit) : lit;
    ultimo = idx + m[0].length;
    const ruta = m[1];
    const valor = VARIABLES_PERMITIDAS.includes(ruta) ? valorEnRuta(datos, ruta) : undefined;
    if (valor === undefined) {
      if (!faltan.includes(ruta)) faltan.push(ruta);
      const marca = `⟦${ruta}⟧`;
      salida += escapar ? escaparHtml(marca) : marca;
    } else {
      salida += escapar ? escaparHtml(valor) : valor;
    }
  }
  const resto = texto.slice(ultimo);
  salida += escapar ? escaparHtml(resto) : resto;
  return { texto: salida, faltan };
}

/**
 * Sustituye {{ruta.con.puntos}}. El resultado YA está escapado para HTML
 * (literales y valores). Las variables sin valor (o fuera de la lista
 * blanca) no se imprimen en blanco: dejan «⟦ruta⟧» y se listan en `faltan`.
 */
export function resolverVariables(texto: string, datos: Record<string, unknown>): { texto: string; faltan: string[] } {
  return resolver(texto, datos, true);
}

// ───────────────────────── ajuste de texto ─────────────────────────

function contarLineas(texto: string, anchoMm: number, tamPt: number): number {
  const anchoCar = tamPt * PT_MM * ANCHO_CARACTER_EM;
  const maxCar = Math.max(1, Math.floor(anchoMm / anchoCar + 1e-9));
  let total = 0;
  for (const parrafo of texto.split('\n')) {
    const palabras = parrafo.split(/\s+/).filter((p) => p.length > 0);
    if (palabras.length === 0) { total += 1; continue; }
    let lineas = 1;
    let usado = 0;
    for (const p of palabras) {
      const largo = [...p].length;
      if (usado === 0) {
        if (largo > maxCar) { lineas += Math.ceil(largo / maxCar) - 1; usado = largo % maxCar || maxCar; }
        else usado = largo;
      } else if (usado + 1 + largo <= maxCar) {
        usado += 1 + largo;
      } else {
        lineas += 1;
        if (largo > maxCar) { lineas += Math.ceil(largo / maxCar) - 1; usado = largo % maxCar || maxCar; }
        else usado = largo;
      }
    }
    total += lineas;
  }
  return total;
}

/**
 * Estima si el texto cabe en anchoMm × altoMm y reduce la letra (pasos de
 * 0.5 pt) hasta tamPtMinimo. NUNCA recorta: si no cabe, `cabe:false` con el
 * tamaño mínimo.
 */
export function ajustarTexto(
  texto: string, anchoMm: number, altoMm: number, tamPtInicial: number, tamPtMinimo = 6,
): { tamPt: number; cabe: boolean; lineas: number } {
  const minimo = Math.min(tamPtMinimo, tamPtInicial);
  if (!(anchoMm > 0) || !(altoMm > 0) || !(tamPtInicial > 0)) {
    return { tamPt: Math.max(minimo, 0), cabe: false, lineas: contarLineas(texto, Math.max(anchoMm, 0.0001), Math.max(minimo, 0.1)) };
  }
  let pt = tamPtInicial;
  for (;;) {
    const lineas = contarLineas(texto, anchoMm, pt);
    if (lineas * pt * PT_MM * INTERLINEADO <= altoMm + 1e-9) return { tamPt: pt, cabe: true, lineas };
    if (pt <= minimo) return { tamPt: minimo, cabe: false, lineas: contarLineas(texto, anchoMm, minimo) };
    pt = Math.max(minimo, redondear(pt - 0.5));
  }
}

// ───────────────────────── tabla de tomas ─────────────────────────

/**
 * Una fila por medicamento y toma. Los lotes múltiples de un mismo
 * medicamento (misma toma o distinta) son entradas distintas y se listan
 * TODOS; no se fusionan ni se omite ninguno.
 */
export function filasTablaTomas(tomas: TomaEntrada[]): FilaTomas[] {
  const filas: FilaTomas[] = [];
  for (const t of tomas) {
    for (const m of t.medicamentos) {
      const lote = (m.lote ?? '').trim();
      const cad = (m.caducidad ?? '').trim();
      filas.push({
        fecha: t.fecha,
        momento: t.momentoNombre,
        medicamento: m.nombre,
        unidades: m.unidades,
        lote,
        caducidad: cad,
        faltaTraza: lote === '' || cad === '',
      });
    }
  }
  return filas;
}

function textoFila(f: FilaTomas): string {
  return `${f.fecha} ${f.momento} · ${f.medicamento} ×${f.unidades} · Lote ${f.lote || '⟦lote⟧'} · Cad ${f.caducidad || '⟦caducidad⟧'}`;
}

// ───────────────────────── validación ─────────────────────────

function validarPlancha(p: unknown, pagina: { ancho_mm?: unknown; alto_mm?: unknown } | null): string[] {
  const e: string[] = [];
  if (!esObjeto(p)) return ['plancha: debe ser un objeto o null'];
  for (const k of ['ancho_etiqueta_mm', 'alto_etiqueta_mm', 'paso_h_mm', 'paso_v_mm']) {
    if (!esNum(p[k]) || (p[k] as number) <= 0) e.push(`plancha.${k}: debe ser un número > 0`);
  }
  for (const k of ['margen_sup_mm', 'margen_izq_mm']) {
    if (!esNum(p[k]) || (p[k] as number) < 0) e.push(`plancha.${k}: debe ser un número >= 0`);
  }
  for (const k of ['filas', 'columnas']) {
    if (!Number.isInteger(p[k]) || (p[k] as number) < 1) e.push(`plancha.${k}: debe ser un entero >= 1`);
  }
  if (e.length > 0) return e;
  const pl = p as unknown as Plancha;
  if (pl.primera_libre !== undefined) {
    if (!Number.isInteger(pl.primera_libre) || pl.primera_libre < 1 || pl.primera_libre > pl.filas * pl.columnas) {
      e.push(`plancha.primera_libre: debe ser un entero entre 1 y ${pl.filas * pl.columnas}`);
    }
  }
  if (pl.paso_h_mm + TOL < pl.ancho_etiqueta_mm && pl.columnas > 1) e.push('plancha: paso_h_mm menor que el ancho de la etiqueta (se solaparían)');
  if (pl.paso_v_mm + TOL < pl.alto_etiqueta_mm && pl.filas > 1) e.push('plancha: paso_v_mm menor que el alto de la etiqueta (se solaparían)');
  const finX = pl.margen_izq_mm + (pl.columnas - 1) * pl.paso_h_mm + pl.ancho_etiqueta_mm;
  const finY = pl.margen_sup_mm + (pl.filas - 1) * pl.paso_v_mm + pl.alto_etiqueta_mm;
  if (finX > A4_ANCHO_MM + TOL) e.push(`plancha: las etiquetas no caben en A4 (ancho ${redondear(finX)} mm > ${A4_ANCHO_MM} mm)`);
  if (finY > A4_ALTO_MM + TOL) e.push(`plancha: las etiquetas no caben en A4 (alto ${redondear(finY)} mm > ${A4_ALTO_MM} mm)`);
  if (pagina && esNum(pagina.ancho_mm) && esNum(pagina.alto_mm)) {
    if (Math.abs(pagina.ancho_mm - pl.ancho_etiqueta_mm) > 0.01 || Math.abs(pagina.alto_mm - pl.alto_etiqueta_mm) > 0.01) {
      e.push('plancha: el tamaño de la página de la plantilla no coincide con el de la etiqueta de la plancha');
    }
  }
  return e;
}

/** Errores que impiden usar la plantilla. Vacío = válida. */
export function validarPlantilla(def: unknown): string[] {
  const e: string[] = [];
  if (!esObjeto(def)) return ['la plantilla debe ser un objeto'];
  const pg = def.pagina;
  let ancho = NaN;
  let alto = NaN;
  if (!esObjeto(pg)) e.push('pagina: falta');
  else {
    if (!esNum(pg.ancho_mm) || pg.ancho_mm <= 0) e.push('pagina.ancho_mm: debe ser un número > 0');
    else ancho = pg.ancho_mm;
    if (!esNum(pg.alto_mm) || pg.alto_mm <= 0) e.push('pagina.alto_mm: debe ser un número > 0');
    else alto = pg.alto_mm;
    if (pg.orientacion !== undefined && pg.orientacion !== 'vertical' && pg.orientacion !== 'horizontal') {
      e.push('pagina.orientacion: debe ser «vertical» u «horizontal»');
    }
  }
  const mar = def.margenes_mm;
  let ms = 0, md = 0, mb = 0, mi = 0;
  if (!Array.isArray(mar) || mar.length !== 4 || !mar.every((n) => esNum(n) && n >= 0)) {
    e.push('margenes_mm: debe ser [sup, der, inf, izq] con números >= 0');
  } else {
    [ms, md, mb, mi] = mar as number[];
  }
  const anchoUtil = ancho - mi - md;
  const altoUtil = alto - ms - mb;
  if (Number.isFinite(anchoUtil) && (anchoUtil <= 0 || altoUtil <= 0)) e.push('margenes_mm: no dejan área útil');
  if (!esNum(def.fuente_base_pt) || def.fuente_base_pt <= 0) e.push('fuente_base_pt: debe ser un número > 0');
  if (def.plancha !== null && def.plancha !== undefined) {
    e.push(...validarPlancha(def.plancha, esObjeto(pg) ? pg : null));
  }
  if (!Array.isArray(def.bloques)) {
    e.push('bloques: debe ser una lista');
    return e;
  }
  def.bloques.forEach((b: unknown, i: number) => {
    const id = `bloque ${i + 1}`;
    if (!esObjeto(b)) { e.push(`${id}: debe ser un objeto`); return; }
    if (typeof b.tipo !== 'string' || !TIPOS.includes(b.tipo)) { e.push(`${id}: tipo desconocido «${String(b.tipo)}»`); return; }
    let geomOk = true;
    for (const k of ['x', 'y']) {
      if (!esNum(b[k]) || (b[k] as number) < 0) { e.push(`${id}: ${k} debe ser un número >= 0`); geomOk = false; }
    }
    for (const k of ['w', 'h']) {
      if (!esNum(b[k]) || (b[k] as number) <= 0) { e.push(`${id}: ${k} debe ser un número > 0`); geomOk = false; }
    }
    if (geomOk && Number.isFinite(anchoUtil)) {
      if ((b.x as number) + (b.w as number) > anchoUtil + TOL) e.push(`${id}: se sale de la página por la derecha (x+w = ${redondear((b.x as number) + (b.w as number))} > ${redondear(anchoUtil)} mm útiles)`);
      if ((b.y as number) + (b.h as number) > altoUtil + TOL) e.push(`${id}: se sale de la página por abajo (y+h = ${redondear((b.y as number) + (b.h as number))} > ${redondear(altoUtil)} mm útiles)`);
    }
    if (b.tam_pt !== undefined && (!esNum(b.tam_pt) || b.tam_pt <= 0)) e.push(`${id}: tam_pt debe ser un número > 0`);
    if (b.tipo === 'texto' || b.tipo === 'codigo') {
      if (typeof b.contenido !== 'string' || b.contenido === '') e.push(`${id}: falta contenido`);
      else {
        for (const v of variablesDe(b.contenido)) {
          if (!VARIABLES_PERMITIDAS.includes(v)) e.push(`${id}: variable desconocida «${v}»`);
        }
      }
    }
    if (b.tipo === 'codigo' && (typeof b.simbologia !== 'string' || !SIMBOLOGIAS.includes(b.simbologia))) {
      e.push(`${id}: simbología desconocida «${String(b.simbologia)}»`);
    }
    if (b.tipo === 'tabla_tomas' && b.columnas !== undefined) {
      if (!Array.isArray(b.columnas)) e.push(`${id}: columnas debe ser una lista`);
      else for (const c of b.columnas) if (typeof c !== 'string' || !COLUMNAS_TABLA.includes(c)) e.push(`${id}: columna desconocida «${String(c)}»`);
    }
  });
  return e;
}

/** Avisos NO bloqueantes: bloques que se solapan. */
export function avisosPlantilla(def: unknown): string[] {
  const a: string[] = [];
  if (!esObjeto(def) || !Array.isArray(def.bloques)) return a;
  const bs = def.bloques.filter((b: unknown): b is Record<string, number> =>
    esObjeto(b) && ['x', 'y', 'w', 'h'].every((k) => esNum(b[k])));
  for (let i = 0; i < bs.length; i++) {
    for (let j = i + 1; j < bs.length; j++) {
      const p = bs[i], q = bs[j];
      const ox = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x);
      const oy = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
      if (ox > TOL && oy > TOL) a.push(`los bloques ${i + 1} y ${j + 1} se solapan`);
    }
  }
  return a;
}

// ───────────────────────── plancha ─────────────────────────

/**
 * Huecos libres de la PRIMERA hoja, por filas, respetando primera_libre
 * (1-based). Con `{ todas: true }` devuelve los de una hoja completa.
 * fila y columna son 1-based; coordenadas en mm redondeadas a 0.01.
 */
export function posicionesPlancha(plancha: Plancha, opciones: { todas?: boolean } = {}): PosicionPlancha[] {
  const r: PosicionPlancha[] = [];
  for (let f = 0; f < plancha.filas; f++) {
    for (let c = 0; c < plancha.columnas; c++) {
      r.push({
        fila: f + 1,
        columna: c + 1,
        xMm: redondear(plancha.margen_izq_mm + c * plancha.paso_h_mm),
        yMm: redondear(plancha.margen_sup_mm + f * plancha.paso_v_mm),
      });
    }
  }
  if (opciones.todas) return r;
  const saltar = Math.max(0, (plancha.primera_libre ?? 1) - 1);
  return r.slice(saltar);
}

// ───────────────────────── render ─────────────────────────

const ESTILO_BASE =
  'html,body{margin:0;padding:0}body{font-family:Arial,Helvetica,sans-serif;color:#000}' +
  '.etq{position:relative;overflow:hidden;box-sizing:border-box}' +
  '.b{position:absolute;box-sizing:border-box;overflow:visible;line-height:1.2;white-space:pre-wrap}' +
  '.b.nocabe{outline:0.3mm solid #d00}' +
  '.hoja{position:relative;width:210mm;height:297mm;overflow:hidden;page-break-after:always}' +
  '.hoja>.etq{position:absolute}' +
  'table.tomas{border-collapse:collapse;width:100%}table.tomas td{vertical-align:top;padding:0 0.5mm}';

interface Fragmento {
  fragmento: string;
  cabe: boolean;
  problemas: string[];
  faltan: string[];
}

function renderFragmento(def: Plantilla, datos: Record<string, unknown>): Fragmento {
  const problemas: string[] = [];
  const faltan: string[] = [];
  let cabe = true;
  const [ms, , , mi] = def.margenes_mm;
  const partes: string[] = [];
  const anotarFaltan = (fs: string[]) => { for (const f of fs) if (!faltan.includes(f)) faltan.push(f); };

  def.bloques.forEach((b, i) => {
    const id = `bloque ${i + 1}`;
    const pt0 = b.tam_pt ?? def.fuente_base_pt;
    const pos = `left:${mm(mi + b.x)};top:${mm(ms + b.y)};width:${mm(b.w)};height:${mm(b.h)}`;
    let medida: string;
    let interior: string;
    let extra = '';

    if (b.tipo === 'texto' || b.tipo === 'aparte') {
      let plano: string;
      let html: string;
      if (b.tipo === 'texto') {
        const crudo = resolver(b.contenido ?? '', datos, false);
        anotarFaltan(crudo.faltan);
        plano = crudo.texto;
        html = resolver(b.contenido ?? '', datos, true).texto;
      } else {
        const aparte = Array.isArray(datos.aparte) ? (datos.aparte as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
        plano = aparte.length > 0 ? `ADMINISTRAR APARTE: ${aparte.join('; ')}` : '';
        html = escaparHtml(plano);
      }
      medida = plano;
      interior = html;
      if (b.negrita) extra += 'font-weight:bold;';
    } else if (b.tipo === 'codigo') {
      const crudo = resolver(b.contenido ?? '', datos, false);
      anotarFaltan(crudo.faltan);
      const html = resolver(b.contenido ?? '', datos, true).texto;
      const sim = escaparHtml(String(b.simbologia));
      partes.push(`<div class="b" data-codigo="${html}" data-simbologia="${sim}" style="${pos}"></div>`);
      return;
    } else {
      // tabla_tomas
      const tomas = Array.isArray(datos.tomas) ? (datos.tomas as TomaEntrada[]) : [];
      const filas = filasTablaTomas(tomas);
      if (filas.length === 0) {
        faltan.push('tomas');
      }
      filas.forEach((f, k) => {
        if (f.faltaTraza && !faltan.includes(`tomas[${k + 1}].lote_caducidad`)) faltan.push(`tomas[${k + 1}].lote_caducidad`);
      });
      medida = filas.map(textoFila).join('\n');
      const trs = filas.map((f) =>
        `<tr><td>${escaparHtml(f.fecha)}</td><td>${escaparHtml(f.momento)}</td><td>${escaparHtml(f.medicamento)} ×${escaparHtml(String(f.unidades))}</td>` +
        `<td>Lote ${escaparHtml(f.lote || '⟦lote⟧')} · Cad ${escaparHtml(f.caducidad || '⟦caducidad⟧')}</td></tr>`).join('');
      interior = `<table class="tomas"><tbody>${trs}</tbody></table>`;
    }

    const aj = ajustarTexto(medida, b.w, b.h, pt0);
    if (!aj.cabe) {
      cabe = false;
      problemas.push(`${id}: el texto no cabe ni con ${aj.tamPt} pt`);
    }
    partes.push(`<div class="b${aj.cabe ? '' : ' nocabe'}" style="${pos};font-size:${aj.tamPt}pt;${extra}">${interior}</div>`);
  });

  for (const f of faltan) problemas.push(`falta el dato «${f}»`);
  const estilo = `width:${mm(def.pagina.ancho_mm)};height:${mm(def.pagina.alto_mm)}`;
  return { fragmento: `<div class="etq" style="${estilo}">${partes.join('')}</div>`, cabe, problemas, faltan };
}

function documento(tamAncho: number, tamAlto: number, cuerpo: string): string {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Etiqueta</title>` +
    `<style>@page{size:${mm(tamAncho)} ${mm(tamAlto)};margin:0}${ESTILO_BASE}</style></head><body>${cuerpo}</body></html>`;
}

/** HTML autocontenido de una etiqueta. `imprimible` exige: válida, cabe, sin faltantes. */
export function renderizarEtiqueta(def: Plantilla, datos: Record<string, unknown>): ResultadoRender {
  const errores = validarPlantilla(def);
  if (errores.length > 0) return { html: '', cabe: false, problemas: errores, faltan: [], imprimible: false };
  const r = renderFragmento(def, datos);
  return {
    html: documento(def.pagina.ancho_mm, def.pagina.alto_mm, r.fragmento),
    cabe: r.cabe,
    problemas: r.problemas,
    faltan: r.faltan,
    imprimible: r.cabe && r.faltan.length === 0,
  };
}

export interface ResultadoPlancha extends ResultadoRender {
  hojas: number;
  etiquetas: number;
}

/**
 * Coloca una etiqueta por cada elemento de listaDatos en la plancha, desde
 * primera_libre, y pagina en hojas A4 cuando faltan huecos.
 */
export function renderizarPlancha(def: Plantilla, listaDatos: Record<string, unknown>[], plancha: Plancha): ResultadoPlancha {
  const errores = validarPlantilla({ ...def, plancha });
  if (errores.length > 0) return { html: '', cabe: false, problemas: errores, faltan: [], imprimible: false, hojas: 0, etiquetas: 0 };
  const completa = posicionesPlancha(plancha, { todas: true });
  const primera = posicionesPlancha(plancha);
  const problemas: string[] = [];
  const faltan: string[] = [];
  let cabe = true;
  const hojasHtml: string[] = [];
  let n = 0;
  let hoja: string[] = [];
  let idxHoja = 0;
  while (n < listaDatos.length) {
    const huecos = idxHoja === 0 ? primera : completa;
    hoja = [];
    for (const h of huecos) {
      if (n >= listaDatos.length) break;
      const r = renderFragmento(def, listaDatos[n]);
      n++;
      if (!r.cabe) cabe = false;
      for (const p of r.problemas) problemas.push(`Etiqueta ${n}: ${p}`);
      for (const f of r.faltan) if (!faltan.includes(f)) faltan.push(f);
      const marco = r.fragmento.replace('class="etq" style="', `class="etq" style="left:${mm(h.xMm)};top:${mm(h.yMm)};`);
      hoja.push(marco);
    }
    hojasHtml.push(`<section class="hoja">${hoja.join('')}</section>`);
    idxHoja++;
  }
  if (listaDatos.length === 0) problemas.push('no hay etiquetas que imprimir');
  return {
    html: documento(A4_ANCHO_MM, A4_ALTO_MM, hojasHtml.join('')),
    cabe,
    problemas,
    faltan,
    imprimible: listaDatos.length > 0 && cabe && faltan.length === 0,
    hojas: hojasHtml.length,
    etiquetas: listaDatos.length,
  };
}
