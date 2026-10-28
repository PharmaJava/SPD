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

export type TipoBloque = 'texto' | 'tabla_tomas' | 'aparte' | 'codigo' | 'resumen_periodo';
/** Cómo pinta un bloque de tomas: tabla completa, resumen por medicamento o la que quepa (nunca recorta). */
export type ModoTabla = 'completa' | 'resumen' | 'auto';
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
  /** Sólo `tabla_tomas`. Por defecto «completa» (comportamiento histórico). «auto» = completa si cabe, si no resumen. */
  modo?: ModoTabla;
  /** Si es true y la plantilla imprime la descripción física, su ausencia es un dato faltante (bloquea). */
  exigirDescripcion?: boolean;
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
  /** true = fechas dd/mm/aaaa (caducidades mm/aaaa) y decimales con coma en lo IMPRESO. Los datos no se tocan. Por defecto false. */
  formato_es?: boolean;
  /** Como `Bloque.exigirDescripcion`, para toda la plantilla. */
  exigirDescripcion?: boolean;
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
  medicamentos: { nombre: string; unidades: number; lote: string; caducidad: string; descripcion?: string }[];
}

export interface FilaTomas {
  fecha: string;
  momento: string;
  medicamento: string;
  unidades: number;
  lote: string;
  caducidad: string;
  /** Descripción física (resumenDescripcion). Ausente si no se conoce. */
  descripcion?: string;
  /** true si falta lote o caducidad: la etiqueta no es imprimible. */
  faltaTraza: boolean;
}

export interface ResultadoRender {
  html: string;
  cabe: boolean;
  problemas: string[];
  faltan: string[];
  imprimible: boolean;
  /** Avisos NO bloqueantes (p. ej. tomas sin descripción física cuando no se exige). */
  avisos: string[];
  /** Modo con el que se pintó el último bloque de tomas (si lo hay). */
  modo?: 'completa' | 'resumen';
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

const TIPOS: readonly string[] = ['texto', 'tabla_tomas', 'aparte', 'codigo', 'resumen_periodo'];
const MODOS: readonly string[] = ['completa', 'resumen', 'auto'];
/** Texto impreso cuando una toma no tiene descripción física y no se exige. */
export const TEXTO_SIN_DESCRIPCION = 'sin descripción física';
const SIMBOLOGIAS: readonly string[] = ['qrcode', 'datamatrix', 'code128'];
const COLUMNAS_TABLA: readonly string[] = ['medicamento', 'descripcion', 'momentos', 'lote_caducidad'];
const TOL = 0.001;
/** Tamaño de letra máximo aceptado (pt): por encima no es una etiqueta, es un error de la plantilla. */
export const TAM_PT_MAXIMO = 200;

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
/** true si el texto no tiene nada visible (vacío, espacios, controles, U+200B, marcas bidi sueltas…). */
function sinContenido(t: string): boolean {
  return t.replace(/[\p{Cc}\p{Cf}\p{Z}]/gu, '') === '';
}
function textoDe(v: unknown): string {
  return typeof v === 'string' ? v : (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
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
  if (typeof actual === 'string') return sinContenido(actual) ? undefined : actual;
  if (typeof actual === 'number' && Number.isFinite(actual)) return String(actual);
  return undefined;
}

function resolver(texto: string, datos: Record<string, unknown>, escapar: boolean, formatear?: (v: string) => string): { texto: string; faltan: string[] } {
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
      const v = formatear ? formatear(valor) : valor;
      salida += escapar ? escaparHtml(v) : v;
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
  // Tope: un tam_pt absurdo (1e9) no debe convertir la reducción en medio millón de pasos.
  let pt = Math.min(tamPtInicial, TAM_PT_MAXIMO);
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
      const lote = sinContenido(textoDe(m.lote)) ? '' : textoDe(m.lote).trim();
      const cad = sinContenido(textoDe(m.caducidad)) ? '' : textoDe(m.caducidad).trim();
      const fila: FilaTomas = {
        fecha: t.fecha,
        momento: t.momentoNombre,
        medicamento: m.nombre,
        unidades: m.unidades,
        lote,
        caducidad: cad,
        faltaTraza: lote === '' || cad === '',
      };
      const desc = textoDe(m.descripcion);
      if (!sinContenido(desc)) fila.descripcion = desc.trim();
      filas.push(fila);
    }
  }
  return filas;
}

// ───────────────────────── formato español ─────────────────────────

/**
 * Fecha ISO → dd/mm/aaaa; caducidad aaaa-mm → mm/aaaa. Cualquier otra cosa (incluida una fecha ISO
 * imposible como 2026-13-45) se devuelve TAL CUAL: un dato raro debe verse raro, no «arreglarse».
 */
export function formatearFechaEs(t: string): string {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (d) {
    const mes = Number(d[2]), dia = Number(d[3]);
    if (mes >= 1 && mes <= 12 && dia >= 1 && dia <= 31) return `${d[3]}/${d[2]}/${d[1]}`;
    return t;
  }
  const m = /^(\d{4})-(\d{2})$/.exec(t);
  if (m) {
    const mes = Number(m[2]);
    if (mes >= 1 && mes <= 12) return `${m[2]}/${m[1]}`;
  }
  return t;
}

/** Número con coma decimal (0.25 → «0,25»), hasta 4 decimales y sin ruido de coma flotante. */
export function formatearNumeroEs(n: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return String(n);
  return String(Math.round(n * 10000) / 10000).replace('.', ',');
}

const FRACCIONES: Record<number, string> = { 0.25: '¼', 0.5: '½', 0.75: '¾' };

/** Unidades legibles: «2», «0,25 (¼)», «1,5 (1½)», «3,3333». */
export function formatearUnidades(n: number): string {
  const base = formatearNumeroEs(n);
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return base;
  const r = Math.round(n * 10000) / 10000;
  const ent = Math.floor(r);
  const f = Math.round((r - ent) * 10000) / 10000;
  const sim = FRACCIONES[f];
  if (!sim) return base;
  return `${base} (${ent > 0 ? ent : ''}${sim})`;
}

interface OpcionesTexto {
  formatoEs: boolean;
  /** Se imprime la descripción física (columna incluida en la plantilla o resumen). */
  descripcion: boolean;
  exigirDescripcion: boolean;
}

function fechaImp(v: string, o: OpcionesTexto): string {
  return o.formatoEs ? formatearFechaEs(v) : v;
}

interface CeldasFila {
  fecha: string; momento: string; medicamento: string; unidades: string; lote: string; caducidad: string;
  descripcion: string; faltan: string[];
}

/** Celdas de una fila: ningún dato ausente se imprime en blanco ni como «undefined»/«NaN». */
function celdasFila(f: FilaTomas, o: OpcionesTexto = { formatoEs: false, descripcion: false, exigirDescripcion: false }): CeldasFila {
  const falta: string[] = [];
  const t = (v: unknown, marca: string, nombre: string) => {
    const x = textoDe(v);
    if (sinContenido(x)) { falta.push(nombre); return `⟦${marca}⟧`; }
    return x;
  };
  const unidadesOk = typeof f.unidades === 'number' && Number.isFinite(f.unidades) && f.unidades > 0;
  if (!unidadesOk) falta.push('unidades');
  let descripcion = '';
  if (o.descripcion) {
    if (f.descripcion !== undefined && !sinContenido(f.descripcion)) descripcion = f.descripcion;
    else if (o.exigirDescripcion) { falta.push('descripcion'); descripcion = '⟦descripcion⟧'; }
    else descripcion = TEXTO_SIN_DESCRIPCION;
  }
  const fecha = t(f.fecha, 'fecha', 'fecha');
  return {
    fecha: fechaImp(fecha, o),
    momento: t(f.momento, 'toma', 'momento'),
    medicamento: t(f.medicamento, 'medicamento', 'medicamento'),
    unidades: unidadesOk ? (o.formatoEs ? formatearUnidades(f.unidades) : String(f.unidades)) : '⟦unidades⟧',
    lote: f.lote || '⟦lote⟧',
    caducidad: f.caducidad ? fechaImp(f.caducidad, o) : '⟦caducidad⟧',
    descripcion,
    faltan: falta,
  };
}

function textoFila(f: FilaTomas, o?: OpcionesTexto): string {
  const c = celdasFila(f, o);
  return `${c.fecha} ${c.momento} · ${c.medicamento} ×${c.unidades}${c.descripcion ? ` · ${c.descripcion}` : ''} · Lote ${c.lote} · Cad ${c.caducidad}`;
}

// ───────────────────────── resumen por medicamento ─────────────────────────

export interface GrupoResumen {
  medicamento: string;
  /** Suma de unidades de todas las filas del medicamento (sólo las válidas). */
  unidadesTotales: number;
  /** Días distintos con toma. */
  dias: number;
  /** Unidades por día si es la MISMA todos los días; null si la pauta varía. */
  porDia: number | null;
  /** TODOS los lotes con su caducidad, sin repetir el par; en orden de aparición. */
  lotes: { lote: string; caducidad: string }[];
  descripciones: string[];
  /** Posición (1-based) en `filas` de cada fila del grupo. */
  filas: number[];
}

/**
 * Agrupa las filas por medicamento (nombre exacto). NUNCA descarta un lote: cada par lote+caducidad
 * distinto del medicamento aparece una vez; un lote con otra caducidad es otro par.
 */
export function resumirTomas(filas: FilaTomas[]): GrupoResumen[] {
  const grupos = new Map<string, GrupoResumen & { _porFecha: Map<string, number> }>();
  filas.forEach((f, k) => {
    const nombre = textoDe(f.medicamento).trim();
    let g = grupos.get(nombre);
    if (!g) {
      g = { medicamento: nombre, unidadesTotales: 0, dias: 0, porDia: null, lotes: [], descripciones: [], filas: [], _porFecha: new Map() };
      grupos.set(nombre, g);
    }
    g.filas.push(k + 1);
    const u = typeof f.unidades === 'number' && Number.isFinite(f.unidades) && f.unidades > 0 ? f.unidades : 0;
    g.unidadesTotales += u;
    const fecha = textoDe(f.fecha).trim();
    g._porFecha.set(fecha, (g._porFecha.get(fecha) ?? 0) + u);
    if (!g.lotes.some((l) => l.lote === f.lote && l.caducidad === f.caducidad)) g.lotes.push({ lote: f.lote, caducidad: f.caducidad });
    if (f.descripcion !== undefined && !sinContenido(f.descripcion) && !g.descripciones.includes(f.descripcion)) g.descripciones.push(f.descripcion);
  });
  return [...grupos.values()].map((g) => {
    const valores = [...g._porFecha.values()].map((v) => Math.round(v * 10000) / 10000);
    const iguales = valores.length > 0 && valores.every((v) => v === valores[0]) && valores[0] > 0;
    const { _porFecha, ...limpio } = g;
    void _porFecha;
    return { ...limpio, unidadesTotales: Math.round(g.unidadesTotales * 10000) / 10000, dias: valores.length, porDia: iguales ? valores[0] : null };
  });
}

/** Una línea por medicamento: «Metformina 850 mg — 2 al día — lotes: L1 (cad 05/2028), L2 (cad 11/2027) — Comprimido blanco». */
function lineaResumen(g: GrupoResumen, o: OpcionesTexto): string {
  const u = (n: number) => (o.formatoEs ? formatearUnidades(n) : String(n));
  const nombre = g.medicamento === '' ? '⟦medicamento⟧' : g.medicamento;
  const pauta = g.porDia !== null
    ? `${u(g.porDia)} al día`
    : `${u(g.unidadesTotales)} en ${g.dias} día${g.dias === 1 ? '' : 's'} (pauta variable)`;
  const lotes = g.lotes.map((l) => `${l.lote || '⟦lote⟧'} (cad ${l.caducidad ? fechaImp(l.caducidad, o) : '⟦caducidad⟧'})`).join(', ');
  const partes = [nombre, pauta, `${g.lotes.length === 1 ? 'lote' : 'lotes'}: ${lotes}`];
  if (g.descripciones.length > 0) partes.push(g.descripciones.join(' / '));
  else if (o.exigirDescripcion) partes.push('⟦descripcion⟧');
  else partes.push(TEXTO_SIN_DESCRIPCION);
  return partes.join(' — ');
}

export const CABECERA_RESUMEN = 'RESUMEN DEL PERIODO · detalle de cada toma en la hoja A4 (código)';

function lineasResumen(filas: FilaTomas[], o: OpcionesTexto): string[] {
  return [CABECERA_RESUMEN, ...resumirTomas(filas).map((g) => lineaResumen(g, { ...o, descripcion: true }))];
}

function textoCompleto(filas: FilaTomas[], o: OpcionesTexto): string {
  return filas.map((f) => textoFila(f, o)).join('\n');
}

/** ¿Alguna fila lleva descripción? Si ninguna y no se exige, la columna no se imprime (se avisa aparte). */
function opcionesDe(def: Plantilla, b: Bloque, filas: FilaTomas[]): OpcionesTexto {
  const exigir = b.exigirDescripcion === true || def.exigirDescripcion === true;
  const pide = b.tipo === 'resumen_periodo' || (Array.isArray(b.columnas) && b.columnas.includes('descripcion'));
  const hay = filas.some((f) => f.descripcion !== undefined);
  return { formatoEs: def.formato_es === true, descripcion: pide && (hay || exigir), exigirDescripcion: exigir };
}

export interface DecisionModo {
  modo: 'completa' | 'resumen';
  /** La tabla completa cabe (letra ≥ mínimo legible). */
  cabeCompleta: boolean;
  /** El resumen cabe. Sólo se evalúa si la completa no cabe. */
  cabeResumen: boolean;
  /** El modo elegido cabe: si es false, NO se puede imprimir (ni se recorta). */
  cabe: boolean;
  /** El resumen exige un bloque `codigo` (QR a la hoja A4) y la plantilla no lo tiene. */
  sinCodigo: boolean;
  motivo: string;
}

function decidirModo(def: Plantilla, b: Bloque, filas: FilaTomas[]): DecisionModo {
  const o = opcionesDe(def, b, filas);
  const pt0 = b.tam_pt ?? def.fuente_base_pt;
  const hayCodigo = def.bloques.some((x) => x.tipo === 'codigo');
  const forzado: ModoTabla = b.tipo === 'resumen_periodo' ? 'resumen' : (b.modo ?? 'completa');
  const completa = ajustarTexto(textoCompleto(filas, o), b.w, b.h, pt0);
  if (forzado === 'completa' || (forzado === 'auto' && completa.cabe)) {
    return { modo: 'completa', cabeCompleta: completa.cabe, cabeResumen: false, cabe: completa.cabe, sinCodigo: false,
      motivo: completa.cabe ? 'la tabla completa cabe' : 'la tabla completa no cabe y el bloque no admite resumen' };
  }
  const res = ajustarTexto(lineasResumen(filas, o).join('\n'), b.w, b.h, pt0);
  return {
    modo: 'resumen', cabeCompleta: completa.cabe, cabeResumen: res.cabe, cabe: res.cabe, sinCodigo: !hayCodigo,
    motivo: forzado === 'resumen' ? 'modo resumen pedido' : 'la tabla completa no cabe: se pasa al resumen por medicamento',
  };
}

/**
 * Decide qué modo de etiqueta usar: tabla completa si cabe; si no, resumen por medicamento (con todos los
 * lotes y el código a la hoja A4). NUNCA recorta: si ni el resumen cabe, `cabe:false` y la etiqueta no
 * es imprimible. Mira el primer bloque de tomas de la plantilla.
 */
export function elegirModoEtiqueta(plantilla: Plantilla, tomas: TomaEntrada[]): DecisionModo {
  const b = Array.isArray(plantilla?.bloques) ? plantilla.bloques.find((x) => x.tipo === 'tabla_tomas' || x.tipo === 'resumen_periodo') : undefined;
  if (!b) {
    return { modo: 'completa', cabeCompleta: false, cabeResumen: false, cabe: false, sinCodigo: false, motivo: 'la plantilla no tiene bloque de tomas' };
  }
  const filas = filasTablaTomas(Array.isArray(tomas) ? tomas : []);
  return decidirModo(plantilla, b, filas);
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
  if (!esNum(def.fuente_base_pt) || def.fuente_base_pt <= 0 || def.fuente_base_pt > TAM_PT_MAXIMO) e.push(`fuente_base_pt: debe ser un número entre 0 y ${TAM_PT_MAXIMO}`);
  if (def.plancha !== null && def.plancha !== undefined) {
    e.push(...validarPlancha(def.plancha, esObjeto(pg) ? pg : null));
  }
  if (def.formato_es !== undefined && typeof def.formato_es !== 'boolean') e.push('formato_es: debe ser true o false');
  if (def.exigirDescripcion !== undefined && typeof def.exigirDescripcion !== 'boolean') e.push('exigirDescripcion: debe ser true o false');
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
    if (b.tam_pt !== undefined && (!esNum(b.tam_pt) || b.tam_pt <= 0 || b.tam_pt > TAM_PT_MAXIMO)) e.push(`${id}: tam_pt debe ser un número entre 0 y ${TAM_PT_MAXIMO}`);
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
    if (b.modo !== undefined && (typeof b.modo !== 'string' || !MODOS.includes(b.modo))) e.push(`${id}: modo desconocido «${String(b.modo)}»`);
    if (b.modo !== undefined && b.tipo !== 'tabla_tomas') e.push(`${id}: «modo» sólo es válido en tabla_tomas`);
    if (b.exigirDescripcion !== undefined && typeof b.exigirDescripcion !== 'boolean') e.push(`${id}: exigirDescripcion debe ser true o false`);
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

// ───────────────────────── plantilla de partida (doc 07) ─────────────────────────

/**
 * Plantilla de docs/07 (100×150 mm) con las tres mejoras activadas: modo «auto» (tabla completa si
 * cabe, si no resumen por medicamento + código a la hoja A4), formato español y descripción física.
 * Es una plantilla de PARTIDA: la definitiva la guarda el usuario en `plantilla_etiqueta`.
 */
export const PLANTILLA_DOC07_RESUMIBLE: Plantilla = {
  pagina: { ancho_mm: 100, alto_mm: 150, orientacion: 'vertical' },
  plancha: null,
  margenes_mm: [3, 3, 3, 3],
  fuente_base_pt: 7,
  formato_es: true,
  bloques: [
    { tipo: 'texto', x: 0, y: 0, w: 94, h: 8, contenido: '{{farmacia.nombre}} · {{farmacia.telefono}}', negrita: true },
    { tipo: 'texto', x: 0, y: 9, w: 94, h: 6, contenido: '{{paciente.nombre_completo}}', tam_pt: 10 },
    { tipo: 'tabla_tomas', modo: 'auto', x: 0, y: 16, w: 94, h: 80, columnas: ['medicamento', 'descripcion', 'momentos', 'lote_caducidad'] },
    { tipo: 'aparte', x: 0, y: 98, w: 70, h: 20 },
    { tipo: 'codigo', simbologia: 'qrcode', x: 74, y: 98, w: 20, h: 20, contenido: '{{preparacion.id_publico}}' },
    { tipo: 'texto', x: 0, y: 120, w: 94, h: 20,
      contenido: 'Del {{periodo.inicio}} al {{periodo.fin}} · Caduca {{preparacion.caducidad}} · Prep. {{prep.iniciales}} / Val. {{val.iniciales}}' },
  ],
};

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
  '.b{position:absolute;box-sizing:border-box;overflow:visible;line-height:1.2;white-space:pre-wrap;overflow-wrap:anywhere}' +
  '.b.nocabe{outline:0.3mm solid #d00}' +
  '.hoja{position:relative;width:210mm;height:297mm;overflow:hidden;page-break-after:always}' +
  '.hoja>.etq{position:absolute}' +
  'table.tomas{border-collapse:collapse;width:100%}table.tomas td{vertical-align:top;padding:0 0.5mm}';

interface Fragmento {
  fragmento: string;
  cabe: boolean;
  problemas: string[];
  faltan: string[];
  avisos: string[];
  /** true si hay un bloqueo que no es un dato faltante (unidades esperadas, resumen sin código…). */
  bloqueado: boolean;
  modo?: 'completa' | 'resumen';
}

function renderFragmento(def: Plantilla, datos: Record<string, unknown>): Fragmento {
  const problemas: string[] = [];
  const faltan: string[] = [];
  let cabe = true;
  const [ms, , , mi] = def.margenes_mm;
  const partes: string[] = [];
  const anotarFaltan = (fs: string[]) => { for (const f of fs) if (!faltan.includes(f)) faltan.push(f); };
  const avisos: string[] = [];
  let bloqueado = false;
  let modoUsado: 'completa' | 'resumen' | undefined;
  const fmt = def.formato_es === true ? formatearFechaEs : undefined;
  const tomasDatos = Array.isArray(datos.tomas) ? (datos.tomas as TomaEntrada[]) : [];
  let hayBloqueTomas = false;

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
        const crudo = resolver(b.contenido ?? '', datos, false, fmt);
        anotarFaltan(crudo.faltan);
        plano = crudo.texto;
        html = resolver(b.contenido ?? '', datos, true, fmt).texto;
      } else {
        // Lo que no es una lista de textos (o trae elementos que no son texto) se señala: un medicamento
        // «aparte» descartado en silencio es un medicamento que falta en la etiqueta.
        const bruto = Array.isArray(datos.aparte) ? (datos.aparte as unknown[]) : undefined;
        if (bruto === undefined || bruto.some((x) => x !== null && x !== undefined && typeof x !== 'string')) anotarFaltan(['aparte']);
        const aparte = (bruto ?? []).filter((x): x is string => typeof x === 'string' && !sinContenido(x));
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
      // tabla_tomas / resumen_periodo
      hayBloqueTomas = true;
      const tomas = tomasDatos;
      const filas = filasTablaTomas(tomas);
      if (filas.length === 0) {
        faltan.push('tomas');
      }
      const dec = decidirModo(def, b, filas);
      const o = opcionesDe(def, b, filas);
      modoUsado = dec.modo;
      filas.forEach((f, k) => {
        if (f.faltaTraza) anotarFaltan([`tomas[${k + 1}].lote_caducidad`]);
        for (const x of celdasFila(f, o).faltan) anotarFaltan([`tomas[${k + 1}].${x}`]);
      });
      // Descripción física: se avisa (sin bloquear) si la plantilla la pide y falta; con exigirDescripcion bloquea (arriba).
      const pideDesc = b.tipo === 'resumen_periodo' || (Array.isArray(b.columnas) && b.columnas.includes('descripcion'));
      if (pideDesc && !o.exigirDescripcion) {
        const sin = [...new Set(filas.filter((f) => f.descripcion === undefined).map((f) => f.medicamento))];
        if (sin.length > 0) avisos.push(`sin descripción física: ${sin.join('; ')}`);
      }
      if (dec.modo === 'resumen') {
        if (dec.sinCodigo) {
          bloqueado = true;
          problemas.push(`${id}: el modo resumen necesita un bloque «codigo» con el enlace a la hoja A4`);
        }
        const lineas = lineasResumen(filas, o);
        medida = lineas.join('\n');
        const cab = `<div><b>${escaparHtml(lineas[0])}</b></div>`;
        interior = cab + lineas.slice(1).map((l) => `<div>${escaparHtml(l)}</div>`).join('');
      } else {
        medida = textoCompleto(filas, o);
        const trs = filas.map((f) => {
          const c = celdasFila(f, o);
          return `<tr><td>${escaparHtml(c.fecha)}</td><td>${escaparHtml(c.momento)}</td><td>${escaparHtml(c.medicamento)} ×${escaparHtml(c.unidades)}</td>` +
            (o.descripcion ? `<td>${escaparHtml(c.descripcion)}</td>` : '') +
            `<td>Lote ${escaparHtml(c.lote)} · Cad ${escaparHtml(c.caducidad)}</td></tr>`;
        }).join('');
        interior = `<table class="tomas"><tbody>${trs}</tbody></table>`;
      }
    }

    const aj = ajustarTexto(medida, b.w, b.h, pt0);
    if (!aj.cabe) {
      cabe = false;
      problemas.push(`${id}: el texto no cabe ni con ${aj.tamPt} pt`);
    }
    partes.push(`<div class="b${aj.cabe ? '' : ' nocabe'}" style="${pos};font-size:${aj.tamPt}pt;${extra}">${interior}</div>`);
  });

  // Unidades esperadas (lo que dice la pauta): una etiqueta con tomas ausentes NO es imprimible.
  if (datos.unidadesEsperadas !== undefined) {
    const esp = datos.unidadesEsperadas;
    if (typeof esp !== 'number' || !Number.isFinite(esp) || esp < 0) {
      bloqueado = true;
      problemas.push('unidadesEsperadas no es un número válido');
    } else if (!hayBloqueTomas) {
      bloqueado = true;
      problemas.push('hay unidades esperadas pero la plantilla no tiene bloque de tomas: no se puede comprobar');
    } else {
      const reales = filasTablaTomas(tomasDatos).reduce((s, f) => s + (typeof f.unidades === 'number' && Number.isFinite(f.unidades) && f.unidades > 0 ? f.unidades : 0), 0);
      if (Math.abs(reales - esp) > 1e-6) {
        bloqueado = true;
        problemas.push(`las tomas de la etiqueta suman ${formatearNumeroEs(Math.round(reales * 10000) / 10000)} unidades y la pauta esperaba ${formatearNumeroEs(esp)}: ${reales < esp ? 'faltan tomas' : 'sobran tomas'}`);
      }
    }
  }
  for (const f of faltan) problemas.push(`falta el dato «${f}»`);
  const estilo = `width:${mm(def.pagina.ancho_mm)};height:${mm(def.pagina.alto_mm)}`;
  return { fragmento: `<div class="etq" style="${estilo}">${partes.join('')}</div>`, cabe, problemas, faltan, avisos, bloqueado, modo: modoUsado };
}

function documento(tamAncho: number, tamAlto: number, cuerpo: string): string {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Etiqueta</title>` +
    `<style>@page{size:${mm(tamAncho)} ${mm(tamAlto)};margin:0}${ESTILO_BASE}</style></head><body>${cuerpo}</body></html>`;
}

/** HTML autocontenido de una etiqueta. `imprimible` exige: válida, cabe, sin faltantes. */
export function renderizarEtiqueta(def: Plantilla, datos: Record<string, unknown>): ResultadoRender {
  const errores = validarPlantilla(def);
  if (errores.length > 0) return { html: '', cabe: false, problemas: errores, faltan: [], imprimible: false, avisos: [] };
  const r = renderFragmento(def, datos);
  return {
    html: documento(def.pagina.ancho_mm, def.pagina.alto_mm, r.fragmento),
    cabe: r.cabe,
    problemas: r.problemas,
    faltan: r.faltan,
    imprimible: r.cabe && r.faltan.length === 0 && !r.bloqueado,
    avisos: r.avisos,
    modo: r.modo,
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
  if (errores.length > 0) return { html: '', cabe: false, problemas: errores, faltan: [], imprimible: false, avisos: [], hojas: 0, etiquetas: 0 };
  const completa = posicionesPlancha(plancha, { todas: true });
  const primera = posicionesPlancha(plancha);
  const problemas: string[] = [];
  const faltan: string[] = [];
  let cabe = true;
  let bloqueada = false;
  const avisos: string[] = [];
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
      if (r.bloqueado) bloqueada = true;
      for (const a of r.avisos) avisos.push(`Etiqueta ${n}: ${a}`);
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
    imprimible: listaDatos.length > 0 && cabe && faltan.length === 0 && !bloqueada,
    avisos,
    hojas: hojasHtml.length,
    etiquetas: listaDatos.length,
  };
}
