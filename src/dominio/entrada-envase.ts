/**
 * Validación de la ENTRADA de un envase (docs/04-flujos.md §4.2).
 *
 * DECISIÓN DE ANTONIO: el DataMatrix es OPCIONAL (y con él el nº de serie),
 * pero LOTE y CADUCIDAD son OBLIGATORIOS. Sin lector, la entrada manual pasa
 * por los mismos controles.
 *
 * FUNCIONES PURAS: sin disco, red ni interfaz. «Hoy» y todo el contexto
 * (envases ya registrados, catálogo, alertas) entran por parámetro.
 *
 * Reglas de seguridad:
 *  - NUNCA adivina un lote, una caducidad ni un CN: lo que falta o no se
 *    entiende bloquea y se pregunta.
 *  - Si hay lectura del DataMatrix y el teclado la contradice, gana el CÓDIGO
 *    (lo imprimió el fabricante) y se avisa.
 *  - Si la lectura es ambigua (el lector se comió el separador GS) se pide
 *    confirmar: no se usa ninguna de las interpretaciones.
 *  - El lote sólo se toca para quitar espacios sobrantes (y se avisa);
 *    mayúsculas y minúsculas se conservan tal cual.
 */

import { normalizarCN, parsearGS1 } from './gs1.ts';

export interface Aviso { codigo: string; texto: string }

export interface EntradaEnvase {
  /** Cualquier forma que normalice `gs1.normalizarCN` (puede venir vacío si hay DataMatrix). */
  cn: string;
  lote?: string;
  /** AAAA-MM-DD, MM/AAAA o MM/AA (en estos dos, el último día del mes). */
  caducidad?: string;
  numeroSerie?: string;
  lecturaDatamatrix?: string;
  unidades: number;
  /** Hoy, AAAA-MM-DD. */
  hoy: string;
}

export interface EnvaseExistente {
  cn: string;
  numeroSerie?: string;
  lote: string;
  estado: string;
}

export interface AlertaCalidad {
  /** Si no trae CN, la alerta es por lote en cualquier medicamento. */
  cn?: string;
  /** Si no trae lote, afecta a todos los lotes de ese CN. */
  lote?: string;
  referencia: string;
}

export interface ContextoEntrada {
  envasesExistentes: EnvaseExistente[];
  /** CN (6 dígitos) del catálogo local. */
  cnConocidos: Set<string>;
  cnUltimoDeLaLinea?: string;
  alertasCalidad: AlertaCalidad[];
  /** Por defecto 60. */
  diasAvisoCaducidad?: number;
  /** Fin previsto del periodo de uso (AAAA-MM-DD): no debe caducar antes. */
  finPrevistoPeriodo?: string;
}

export interface EnvaseNormalizado {
  cn: string;
  lote: string;
  caducidad: string;
  numeroSerie?: string;
  origenLectura: 'datamatrix' | 'manual';
  unidades: number;
}

export interface ResultadoEntrada {
  ok: boolean;
  bloqueos: Aviso[];
  atencion: Aviso[];
  info: Aviso[];
  /** Sólo si ok: lo que se puede guardar. */
  envaseNormalizado?: EnvaseNormalizado;
}

export const DIAS_AVISO_CADUCIDAD_POR_DEFECTO = 60;

const MS_DIA = 86_400_000;

function fechaIsoValida(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [a, mes, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mes < 1 || mes > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(a, mes, 0)).getUTCDate();
}

/**
 * AAAA-MM-DD | MM/AAAA | MM/AA → AAAA-MM-DD (último día del mes en los dos
 * últimos formatos). null si no se entiende: no se adivina.
 */
export function parsearCaducidad(texto: string): string | null {
  const t = texto.trim();
  if (fechaIsoValida(t)) return t;
  const m = /^(\d{1,2})\s*[/-]\s*(\d{4}|\d{2})$/.exec(t);
  if (!m) return null;
  const mes = Number(m[1]);
  if (mes < 1 || mes > 12) return null;
  const anio = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  return `${anio}-${String(mes).padStart(2, '0')}-${String(ultimo).padStart(2, '0')}`;
}

function diasEntre(desde: string, hasta: string): number {
  return Math.round((Date.parse(hasta + 'T00:00:00Z') - Date.parse(desde + 'T00:00:00Z')) / MS_DIA);
}

const claveLote = (l: string) => l.trim().replace(/\s+/g, ' ').toLowerCase();

export function validarEntradaEnvase(entrada: EntradaEnvase, contexto: ContextoEntrada): ResultadoEntrada {
  if (!fechaIsoValida(entrada.hoy)) throw new RangeError('«hoy» debe ser AAAA-MM-DD');
  const bloqueos: Aviso[] = [];
  const atencion: Aviso[] = [];
  const info: Aviso[] = [];
  const bloquear = (codigo: string, texto: string) => bloqueos.push({ codigo, texto });
  const atender = (codigo: string, texto: string) => atencion.push({ codigo, texto });

  // ── 1. Lectura del DataMatrix (opcional) ───────────────────────────────
  let origen: 'datamatrix' | 'manual' = 'manual';
  let cnCodigo: string | undefined;
  let loteCodigo: string | undefined;
  let caducidadCodigo: string | undefined;
  let serieCodigo: string | undefined;
  let lecturaAmbigua = false;

  if (entrada.lecturaDatamatrix && entrada.lecturaDatamatrix.trim() !== '') {
    const l = parsearGS1(entrada.lecturaDatamatrix, { hoy: new Date(entrada.hoy + 'T00:00:00Z') });
    if (l.gtin === undefined) {
      atender('LECTURA_NO_VALIDA', 'El DataMatrix no se ha podido leer: se usan los datos tecleados. Comprueba lote y caducidad con la caja.');
    } else if (l.ambiguo) {
      lecturaAmbigua = true;
      bloquear('LECTURA_AMBIGUA', 'La lectura del DataMatrix es ambigua (el lector no envió el separador entre lote y serie). Confirma el lote y el nº de serie mirando la caja y vuelve a introducirlos.');
    } else {
      origen = 'datamatrix';
      cnCodigo = l.cn;
      loteCodigo = l.lote;
      caducidadCodigo = l.caducidad;
      serieCodigo = l.serie;
      for (const a of l.avisos) atender('LECTURA_AVISO', a);
    }
  }

  // ── 2. CN ──────────────────────────────────────────────────────────────
  const cnTeclado = entrada.cn && entrada.cn.trim() !== '' ? normalizarCN(entrada.cn) : null;
  let cn: string | null = null;
  if (cnCodigo) {
    cn = cnCodigo;
    if (cnTeclado && cnTeclado !== cnCodigo) {
      atender('CN_CONTRADICE_CODIGO', `El CN tecleado (${cnTeclado}) no coincide con el del DataMatrix (${cnCodigo}). Se usa el del código: comprueba que la caja es la que crees.`);
    } else if (!cnTeclado && entrada.cn && entrada.cn.trim() !== '') {
      atender('CN_TECLEADO_NO_VALIDO', `El CN tecleado no es válido; se usa el del DataMatrix (${cnCodigo}).`);
    }
  } else if (cnTeclado) {
    cn = cnTeclado;
  } else {
    bloquear('CN_INVALIDO', 'El código nacional no es válido: debe tener 6 dígitos (con o sin dígito de control) o ser un EAN-13 español.');
  }

  // ── 3. Lote ────────────────────────────────────────────────────────────
  const limpiarLote = (l: string) => l.trim().replace(/\s+/g, ' ');
  let lote: string | undefined;
  const loteTecleadoCrudo = entrada.lote ?? '';
  const loteTeclado = limpiarLote(loteTecleadoCrudo);
  if (loteCodigo !== undefined && loteCodigo !== '') {
    lote = loteCodigo;
    if (loteTeclado !== '' && loteTeclado !== loteCodigo) {
      atender('LOTE_CONTRADICE_CODIGO', `El lote tecleado («${loteTeclado}») no coincide con el del DataMatrix («${loteCodigo}»). Se usa el del código.`);
    }
  } else if (loteTeclado !== '' && !/[\p{L}\p{N}]/u.test(loteTeclado)) {
    // «,,,» o «-» no son un lote: es como no haberlo leído.
    bloquear('LOTE_INVALIDO', `El lote «${loteTeclado}» no contiene letras ni cifras. Es obligatorio: léelo en la caja.`);
  } else if (loteTeclado !== '') {
    lote = loteTeclado;
    if (loteTeclado !== loteTecleadoCrudo) {
      atender('LOTE_NORMALIZADO', `Se han quitado espacios sobrantes del lote: «${loteTecleadoCrudo}» → «${loteTeclado}». Comprueba que es el de la caja.`);
    }
    if (/[a-z]/.test(loteTeclado)) {
      info.push({ codigo: 'LOTE_CON_MINUSCULAS', texto: 'El lote lleva minúsculas; se guarda tal cual. Los lotes suelen ir en mayúsculas: compruébalo con la caja.' });
    }
  } else if (!lecturaAmbigua) {
    bloquear('FALTA_LOTE', 'Falta el lote. Es obligatorio: léelo en la caja.');
  }

  // ── 4. Caducidad ───────────────────────────────────────────────────────
  let caducidad: string | undefined;
  const cadTecleadaTxt = (entrada.caducidad ?? '').trim();
  const cadTeclada = cadTecleadaTxt !== '' ? parsearCaducidad(cadTecleadaTxt) : null;
  if (caducidadCodigo) {
    caducidad = caducidadCodigo;
    if (cadTeclada && cadTeclada !== caducidadCodigo) {
      atender('CADUCIDAD_CONTRADICE_CODIGO', `La caducidad tecleada (${cadTeclada}) no coincide con la del DataMatrix (${caducidadCodigo}). Se usa la del código.`);
    } else if (cadTecleadaTxt !== '' && !cadTeclada) {
      atender('CADUCIDAD_TECLEADA_NO_VALIDA', `La caducidad tecleada («${cadTecleadaTxt}») no se entiende; se usa la del DataMatrix (${caducidadCodigo}).`);
    }
  } else if (cadTecleadaTxt === '') {
    if (!lecturaAmbigua) bloquear('FALTA_CADUCIDAD', 'Falta la caducidad. Es obligatoria: léela en la caja.');
  } else if (!cadTeclada) {
    bloquear('CADUCIDAD_INVALIDA', `La caducidad «${cadTecleadaTxt}» no es válida. Usa AAAA-MM-DD, MM/AAAA o MM/AA.`);
  } else {
    caducidad = cadTeclada;
    if (!fechaIsoValida(cadTecleadaTxt)) {
      info.push({ codigo: 'CADUCIDAD_FIN_DE_MES', texto: `«${cadTecleadaTxt}» se interpreta como el último día del mes: ${cadTeclada}.` });
    }
  }

  if (caducidad) {
    if (caducidad < entrada.hoy) {
      bloquear('CADUCADO', `El envase está caducado (${caducidad}).`);
    } else {
      const dias = diasEntre(entrada.hoy, caducidad);
      const limite = contexto.diasAvisoCaducidad ?? DIAS_AVISO_CADUCIDAD_POR_DEFECTO;
      if (dias <= limite) {
        atender('CADUCA_PRONTO', `Caduca en ${dias} día${dias === 1 ? '' : 's'} (${caducidad}). Confírmalo antes de admitirlo.`);
      }
      if (dias > 3650) {
        atender('CADUCIDAD_LEJANA', `La caducidad (${caducidad}) está a más de 10 años: probablemente es un error al teclear el año. Compárala con la caja.`);
      }
      if (contexto.finPrevistoPeriodo && caducidad < contexto.finPrevistoPeriodo) {
        atender('CADUCA_ANTES_DEL_PERIODO', `Caduca (${caducidad}) antes del fin previsto del periodo (${contexto.finPrevistoPeriodo}).`);
      }
    }
  }

  // ── 5. Nº de serie ─────────────────────────────────────────────────────
  const serie = (serieCodigo ?? entrada.numeroSerie ?? '').trim() || undefined;
  if (serieCodigo && entrada.numeroSerie && entrada.numeroSerie.trim() !== '' && entrada.numeroSerie.trim() !== serieCodigo) {
    atender('SERIE_CONTRADICE_CODIGO', `El nº de serie tecleado no coincide con el del DataMatrix («${serieCodigo}»). Se usa el del código.`);
  }
  if (serie && cn) {
    const dup = contexto.envasesExistentes.find(e => e.cn === cn && e.numeroSerie === serie);
    if (dup) {
      bloquear('SERIE_REPETIDA', `Ese nº de serie ya está registrado para el CN ${cn} (lote ${dup.lote}, estado ${dup.estado}): caja duplicada.`);
    }
  }

  // ── 6. Alertas de calidad ──────────────────────────────────────────────
  if (cn && lote) {
    for (const a of contexto.alertasCalidad) {
      const cnAlerta = a.cn ? normalizarCN(a.cn) : null;
      if (a.cn && !cnAlerta) continue;                       // alerta mal formada: no casa
      if (!a.cn && !a.lote) continue;                        // sin CN ni lote no identifica nada
      if (cnAlerta && cnAlerta !== cn) continue;
      if (a.lote && claveLote(a.lote) !== claveLote(lote)) continue;
      bloquear('LOTE_CON_ALERTA', `Lote con alerta de calidad (${a.referencia}). No se admite: apártalo.`);
    }
  }

  // ── 7. CN respecto al catálogo y a la línea ────────────────────────────
  if (cn) {
    if (!contexto.cnConocidos.has(cn)) {
      atender('CN_DESCONOCIDO', `El CN ${cn} no está en el catálogo local: hay que consultarlo en CIMA y guardarlo antes de usarlo.`);
    }
    const ultimo = contexto.cnUltimoDeLaLinea ? normalizarCN(contexto.cnUltimoDeLaLinea) : null;
    if (ultimo && ultimo !== cn) {
      atender('CN_DISTINTO_DE_LA_LINEA', `Es un CN distinto del último usado en esta línea (${ultimo}): puede cambiar el aspecto. Confirma la descripción física.`);
    }
  }

  // ── 8. Unidades ────────────────────────────────────────────────────────
  const u = entrada.unidades;
  if (typeof u !== 'number' || !Number.isFinite(u) || u <= 0) {
    bloquear('UNIDADES_INVALIDAS', 'Las unidades del envase deben ser mayores que cero.');
  } else if (Math.abs(u * 4 - Math.round(u * 4)) > 1e-9) {
    bloquear('UNIDADES_NO_MULTIPLO', 'Las unidades deben ser múltiplo de 0,25 (cuartos de comprimido).');
  }

  const ok = bloqueos.length === 0;
  const res: ResultadoEntrada = { ok, bloqueos, atencion, info };
  if (ok && cn && lote && caducidad) {
    res.envaseNormalizado = {
      cn, lote, caducidad,
      ...(serie ? { numeroSerie: serie } : {}),
      origenLectura: origen,
      unidades: u,
    };
  }
  return res;
}
