/**
 * Renderizado de las plantillas de consentimiento (docs/09-consentimientos.md)
 * y estado de los consentimientos firmados de un paciente.
 *
 * FUNCIONES PURAS: sin disco ni red. El texto resultante es EL TEXTO EXACTO
 * que se imprime y del que se guarda el hash SHA-256 (`documento_firmado`).
 *
 * Reglas de seguridad:
 *  - Una variable sin valor NO se imprime en blanco: sale «⟦ruta⟧» y entra en
 *    `faltan`, lo que impide imprimir la versión definitiva.
 *  - Los valores se insertan tal cual en Markdown (no HTML), pero se les quitan
 *    los saltos de línea (no pueden abrir un título ni un párrafo nuevo) y se
 *    neutralizan `{{` y `}}` (nunca se re-evalúan ni llegan a otro renderizado).
 *  - Cada valor se limita a 300 caracteres, con aviso. Nada se corta en silencio.
 *  - Los comentarios HTML de la plantilla no se imprimen, pero si decían
 *    BORRADOR se devuelve `esBorrador` para marcarlo al imprimir.
 */

import { createHash } from 'node:crypto';

/** Variables que el programa sabe rellenar (docs/09 §9.4). Una plantilla con otra, falla el test. */
export const VARIABLES_DOCUMENTO: readonly string[] = [
  'farmacia.nombre', 'farmacia.titular', 'farmacia.nif', 'farmacia.direccion', 'farmacia.municipio',
  'farmacia.telefono', 'farmacia.email', 'farmacia.rgpd_contacto', 'farmacia.rgpd_dpd',
  'paciente.nombre_completo', 'paciente.dni_nie', 'paciente.fecha_nacimiento', 'paciente.direccion',
  'firmante.nombre', 'firmante.dni_nie', 'firmante.calidad',
  'fecha.hoy', 'fecha.efecto',
  'autorizado.nombre', 'autorizado.dni_nie', 'autorizado.parentesco', 'autorizado.telefono',
  'motivo',
  'tabla_envases_devueltos', 'tabla_envases_sigre',
  'documento.version', 'documento.id',
];

/** Variables que la propia plantilla marca como opcionales: vacías se imprimen «no indicado». */
export const VARIABLES_OPCIONALES: readonly string[] = ['motivo'];

/** Variables que son tablas de varias líneas: conservan los saltos de línea. */
export const VARIABLES_BLOQUE: readonly string[] = ['tabla_envases_devueltos', 'tabla_envases_sigre'];

export const LIMITE_VALOR = 300;
export const LIMITE_VALOR_BLOQUE = 3000;
export const TEXTO_OPCIONAL_VACIO = 'no indicado';

const RE_VARIABLE = /\{\{\s*([^{}\s][^{}]*?)\s*\}\}/g;
const RE_COMENTARIO = /<!--([\s\S]*?)-->[ \t]*\r?\n?/g;

export type ValorDocumento = string | number | null | undefined;

export interface DocumentoRenderizado {
  texto: string;
  /** Rutas sin valor (excepto las opcionales). Bloquean el definitivo. */
  faltan: string[];
  /** SHA-256 hex del texto resultante. */
  hash: string;
  /** Falta algún dato, queda un «[A COMPLETAR …]», llaves sin resolver o un valor se recortó → false. */
  imprimibleDefinitivo: boolean;
  /** La plantilla traía un comentario con la palabra BORRADOR: imprimir marcado «BORRADOR». */
  esBorrador: boolean;
  /** Fragmentos «[A COMPLETAR …]» que la farmacia debe rellenar en la plantilla. */
  sinCompletar: string[];
  /** Valores recortados, con saltos de línea quitados, etc. */
  avisos: string[];
}

function quitarComentarios(plantilla: string): { sinComentarios: string; esBorrador: boolean } {
  let esBorrador = false;
  const sinComentarios = plantilla.replace(RE_COMENTARIO, (_m, dentro: string) => {
    if (/BORRADOR/i.test(dentro)) esBorrador = true;
    return '';
  });
  return { sinComentarios, esBorrador };
}

/** Todas las variables distintas de la plantilla, en orden de aparición (ignora las de comentarios). */
export function variablesDe(plantilla: string): string[] {
  const { sinComentarios } = quitarComentarios(plantilla);
  const vistas = new Set<string>();
  for (const m of sinComentarios.matchAll(RE_VARIABLE)) vistas.add(m[1].trim());
  return [...vistas];
}

/**
 * Rompe TODA pareja de llaves consecutivas (también en «{{{» o «}}}», donde un
 * simple reemplazo de «{{» deja otra pareja nueva): cada llave seguida de otra
 * lleva un espacio detrás.
 */
const neutralizarLlaves = (s: string) => s.replace(/\{(?=\{)/g, '{ ').replace(/\}(?=\})/g, '} ');

/** Quita espacios, controles y caracteres de formato (U+200B, bidi, NUL…): lo que no se ve no es un valor. */
const sinInvisibles = (s: string) => s.replace(/[\p{Cc}\p{Cf}\p{Z}]/gu, '');

function limpiarValor(ruta: string, bruto: string, avisos: string[], estado: { recortado: boolean }): string {
  const esBloque = VARIABLES_BLOQUE.includes(ruta);
  let v = bruto;
  if (!v.isWellFormed()) {
    // Un sustituto suelto se codificaría como U+FFFD y dos textos distintos tendrían el mismo hash.
    avisos.push(`«${ruta}»: el valor tenía caracteres Unicode inválidos y se han sustituido por «\uFFFD».`);
    v = v.toWellFormed();
  }
  v = v.replace(/\r\n?/g, '\n');
  if (esBloque) {
    v = v.split('\n').map(l => l.replace(/[\u2028\u2029]/g, ' ').trimEnd()).join('\n').trim();
  } else {
    const plano = v.replace(/[\n\u2028\u2029]+/g, ' ').trim();
    if (plano !== v.trim()) avisos.push(`«${ruta}»: se han quitado saltos de línea del valor.`);
    v = plano;
  }
  if (/\{\{|\}\}/.test(v)) avisos.push(`«${ruta}»: el valor contenía «{{» o «}}» y se ha neutralizado.`);
  v = neutralizarLlaves(v);
  const limite = esBloque ? LIMITE_VALOR_BLOQUE : LIMITE_VALOR;
  if (v.length > limite) {
    avisos.push(`«${ruta}»: el valor tenía ${v.length} caracteres y se ha recortado a ${limite}.`);
    estado.recortado = true;
    const ultimo = v.charCodeAt(limite - 1);
    v = v.slice(0, ultimo >= 0xD800 && ultimo <= 0xDBFF ? limite - 1 : limite); // no partir un par sustituto
  }
  return v;
}

export function renderizarDocumento(
  plantilla: string,
  datos: Record<string, ValorDocumento>,
): DocumentoRenderizado {
  const { sinComentarios, esBorrador } = quitarComentarios(plantilla);
  const faltan: string[] = [];
  const avisos: string[] = [];
  const ya = new Set<string>();
  const avisados = new Set<string>();
  const estado = { recortado: false };
  const comentarioSinCerrar = sinComentarios.includes('<!--');

  // Una sola pasada sobre la PLANTILLA: lo insertado no se vuelve a evaluar.
  const texto = sinComentarios.replace(RE_VARIABLE, (_m, rutaCruda: string) => {
    const ruta = rutaCruda.trim();
    const bruto = Object.prototype.hasOwnProperty.call(datos, ruta) ? datos[ruta] : undefined;
    // Solo texto o números finitos son valores: un objeto, un booleano o NaN no se imprimen («[object Object]»).
    const crudo = typeof bruto === 'string' ? bruto : (typeof bruto === 'number' && Number.isFinite(bruto) ? String(bruto) : '');
    if (sinInvisibles(crudo) === '') {
      if (VARIABLES_OPCIONALES.includes(ruta)) return TEXTO_OPCIONAL_VACIO;
      if (!ya.has(ruta)) { ya.add(ruta); faltan.push(ruta); }
      return `⟦${ruta}⟧`;
    }
    const primera = !avisados.has(ruta);
    avisados.add(ruta);
    return limpiarValor(ruta, crudo, primera ? avisos : [], estado);
  });

  const sinCompletar = [...texto.matchAll(/\[\s*A\s+COMPLETAR[^\]]*\]?/gi)]
    .map(m => (m[0].endsWith(']') ? m[0] : `${m[0].slice(0, 80)}…`));
  // Los valores ya vienen sin «{{»/«}}»: lo que quede son llaves de la propia plantilla sin variable válida.
  for (const m of texto.matchAll(/\{\{|\}\}/g)) {
    const i = m.index ?? 0;
    sinCompletar.push(`[llaves sin resolver: «${texto.slice(Math.max(0, i - 12), i + 20).replace(/\s+/g, ' ')}»]`);
  }
  if (comentarioSinCerrar) sinCompletar.push('[comentario «<!--» sin cerrar en la plantilla]');
  return {
    texto,
    faltan,
    hash: createHash('sha256').update(texto, 'utf8').digest('hex'),
    imprimibleDefinitivo: faltan.length === 0 && sinCompletar.length === 0 && !estado.recortado,
    esBorrador,
    sinCompletar,
    avisos,
  };
}

// ── Estado de los consentimientos de un paciente ──────────────────────────

export interface ConsentimientoFirmado { codigo: string; version: number; revocadoEn?: string | null }
export interface PlantillaVigente { codigo: string; version: number }

export interface EstadoConsentimientos {
  completo: boolean;
  /** Nunca firmados (o sin plantilla vigente que firmar). */
  faltan: string[];
  /** Firmados, pero la plantilla vigente es una versión posterior. */
  desactualizados: string[];
  /** Su última versión firmada está revocada. */
  revocados: string[];
}

/** Sin estos vigentes y sin revocar NO se puede validar un SPD (docs/09 §9.1). */
export const REQUERIDOS_PARA_VALIDAR_SPD: readonly string[] = ['consentimiento_spd', 'info_rgpd'];

export function estadoConsentimientos(
  firmados: ConsentimientoFirmado[],
  plantillasVigentes: PlantillaVigente[],
  requeridos: string[],
): EstadoConsentimientos {
  const faltan: string[] = [];
  const desactualizados: string[] = [];
  const revocados: string[] = [];
  for (const codigo of [...new Set(requeridos)]) {
    const propios = firmados.filter(f => f.codigo === codigo);
    if (propios.length === 0) { faltan.push(codigo); continue; }
    const maxVersion = Math.max(...propios.map(f => f.version));
    const enMax = propios.filter(f => f.version === maxVersion);
    const revocado = (f: ConsentimientoFirmado) => f.revocadoEn !== null && f.revocadoEn !== undefined && f.revocadoEn !== '';
    if (enMax.every(revocado)) { revocados.push(codigo); continue; }
    const versiones = plantillasVigentes.filter(p => p.codigo === codigo);
    const vigente = versiones.length === 0 ? undefined : { codigo, version: Math.max(...versiones.map(p => p.version)) };
    if (!vigente) { faltan.push(codigo); continue; }          // no hay versión vigente que dar por buena
    if (maxVersion < vigente.version) desactualizados.push(codigo);
  }
  return {
    completo: faltan.length === 0 && desactualizados.length === 0 && revocados.length === 0,
    faltan, desactualizados, revocados,
  };
}
