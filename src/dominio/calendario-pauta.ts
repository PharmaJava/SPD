/**
 * Calendario de una pauta: qué días toca toma y cuántas unidades.
 *
 * FUNCIONES PURAS. Fechas ISO AAAA-MM-DD, aritmética en UTC (el cambio de
 * hora no afecta: se trabaja con números de día, no con horas).
 *
 * Decisiones:
 *   - cada_n_dias y ciclo se extienden también HACIA ATRÁS desde la ancla
 *     (la pauta es periódica); lo que limita es vigenteDesde/vigenteHasta.
 *   - Sin fechaAncla se usa vigenteDesde.
 *   - si_precisa NUNCA toca: no va al blíster.
 *   - Una pauta mal configurada LANZA error en diaToca/tomasDelPeriodo:
 *     nunca se adivina (regla 1 del proyecto).
 */

import type { Pauta, TomaDia } from './tipos.ts';

/** Tope defensivo de días por consulta. */
export const MAX_DIAS_PERIODO = 366;

const MS_DIA = 86_400_000;
const RE_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Número de día (desde 1970-01-01 UTC) o null si la fecha no es válida. */
function numeroDia(fecha: unknown): number | null {
  if (typeof fecha !== 'string') return null;
  const m = RE_FECHA.exec(fecha);
  if (!m) return null;
  const a = Number(m[1]), me = Number(m[2]), d = Number(m[3]);
  const t = Date.UTC(a, me - 1, d);
  const f = new Date(t);
  if (f.getUTCFullYear() !== a || f.getUTCMonth() !== me - 1 || f.getUTCDate() !== d) return null;
  return Math.round(t / MS_DIA);
}

function exigirDia(fecha: unknown, que: string): number {
  const n = numeroDia(fecha);
  if (n === null) throw new Error(`${que} no es una fecha válida AAAA-MM-DD: ${String(fecha)}`);
  return n;
}

function diaISO(n: number): string {
  if (n > 2_932_896) throw new Error('El periodo se sale del año 9999.'); // 9999-12-31
  return new Date(n * MS_DIA).toISOString().slice(0, 10);
}

/** 1 = lunes … 7 = domingo. */
function diaSemana(n: number): number {
  const d = new Date(n * MS_DIA).getUTCDay(); // 0 = domingo
  return d === 0 ? 7 : d;
}

function modulo(a: number, b: number): number {
  return ((a % b) + b) % b;
}

const esEnteroPositivo = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 1;

function anclaDe(pauta: Pauta): number {
  return exigirDia(pauta.fechaAncla ?? pauta.vigenteDesde, 'La fecha ancla');
}

/** ¿Toca toma ese día? Lanza error si el patrón está mal configurado. */
export function diaToca(pauta: Pauta, fecha: string): boolean {
  const n = exigirDia(fecha, 'La fecha');
  const desde = exigirDia(pauta.vigenteDesde, 'vigenteDesde');
  if (n < desde) return false;
  if (pauta.vigenteHasta != null) {
    const hasta = exigirDia(pauta.vigenteHasta, 'vigenteHasta');
    if (n > hasta) return false;
  }
  switch (pauta.patron) {
    case 'diario':
      return true;
    case 'dias_semana': {
      const ds = pauta.diasSemana;
      if (!Array.isArray(ds) || ds.length === 0) throw new Error('Pauta dias_semana sin diasSemana');
      if (ds.some((x) => !Number.isInteger(x) || x < 1 || x > 7)) throw new Error('diasSemana debe contener enteros de 1 (lunes) a 7 (domingo)');
      return ds.includes(diaSemana(n));
    }
    case 'cada_n_dias': {
      if (!esEnteroPositivo(pauta.cadaNDias)) throw new Error('Pauta cada_n_dias sin cadaNDias >= 1');
      return modulo(n - anclaDe(pauta), pauta.cadaNDias) === 0;
    }
    case 'ciclo': {
      const on = pauta.cicloOn, off = pauta.cicloOff;
      if (!esEnteroPositivo(on)) throw new Error('Pauta ciclo sin cicloOn >= 1');
      if (typeof off !== 'number' || !Number.isInteger(off) || off < 0) throw new Error('Pauta ciclo sin cicloOff >= 0');
      return modulo(n - anclaDe(pauta), on + off) < on;
    }
    case 'si_precisa':
      return false;
    default:
      throw new Error(`Patrón de pauta desconocido: ${String((pauta as { patron: unknown }).patron)}`);
  }
}

/** Todas las tomas del rango inclusive, ordenadas por fecha y momentoId. */
export function tomasDelPeriodo(pauta: Pauta, desde: string, hasta: string): TomaDia[] {
  const d = exigirDia(desde, 'desde');
  const h = exigirDia(hasta, 'hasta');
  if (h < d) throw new Error(`Rango invertido: ${desde} es posterior a ${hasta}`);
  if (h - d + 1 > MAX_DIAS_PERIODO) {
    throw new Error(`El periodo supera el máximo de ${MAX_DIAS_PERIODO} días (${h - d + 1})`);
  }
  const errores = validarPauta(pauta);
  if (errores.length > 0) throw new Error(`Pauta no válida: ${errores.join('; ')}`);
  const dosis = [...pauta.dosis].sort((a, b) => a.momentoId - b.momentoId);
  const tomas: TomaDia[] = [];
  for (let n = d; n <= h; n++) {
    const iso = diaISO(n);
    if (!diaToca(pauta, iso)) continue;
    for (const x of dosis) tomas.push({ fecha: iso, momentoId: x.momentoId, unidades: x.unidades });
  }
  return tomas;
}

/** Errores de configuración de la pauta. Vacía si es válida. */
export function validarPauta(pauta: Pauta): string[] {
  const e: string[] = [];
  const desde = numeroDia(pauta.vigenteDesde);
  if (desde === null) e.push('vigenteDesde no es una fecha válida');
  if (pauta.vigenteHasta != null) {
    const hasta = numeroDia(pauta.vigenteHasta);
    if (hasta === null) e.push('vigenteHasta no es una fecha válida');
    else if (desde !== null && hasta < desde) e.push('vigenteHasta es anterior a vigenteDesde');
  }
  if (pauta.fechaAncla != null && numeroDia(pauta.fechaAncla) === null) e.push('fechaAncla no es una fecha válida');
  switch (pauta.patron) {
    case 'diario':
    case 'si_precisa':
      break;
    case 'dias_semana':
      if (!Array.isArray(pauta.diasSemana) || pauta.diasSemana.length === 0) e.push('dias_semana requiere diasSemana');
      else if (pauta.diasSemana.some((x) => !Number.isInteger(x) || x < 1 || x > 7)) e.push('diasSemana debe ir de 1 (lunes) a 7 (domingo)');
      else if (new Set(pauta.diasSemana).size !== pauta.diasSemana.length) e.push('diasSemana tiene días repetidos');
      break;
    case 'cada_n_dias':
      if (!esEnteroPositivo(pauta.cadaNDias)) e.push('cada_n_dias requiere cadaNDias entero >= 1');
      break;
    case 'ciclo':
      if (!esEnteroPositivo(pauta.cicloOn)) e.push('ciclo requiere cicloOn entero >= 1');
      if (typeof pauta.cicloOff !== 'number' || !Number.isInteger(pauta.cicloOff) || pauta.cicloOff < 0) e.push('ciclo requiere cicloOff entero >= 0');
      break;
    default:
      e.push(`patrón desconocido: ${String((pauta as { patron: unknown }).patron)}`);
  }
  if (!Array.isArray(pauta.dosis) || pauta.dosis.length === 0) {
    e.push('la pauta no tiene dosis');
  } else {
    const vistos = new Set<number>();
    for (const x of pauta.dosis) {
      if (vistos.has(x.momentoId)) e.push(`momentoId repetido: ${x.momentoId}`);
      vistos.add(x.momentoId);
      if (typeof x.unidades !== 'number' || !Number.isFinite(x.unidades) || x.unidades <= 0) {
        e.push(`unidades inválidas en el momento ${x.momentoId}: deben ser > 0`);
      } else if (!Number.isInteger(x.unidades * 4)) {
        e.push(`unidades inválidas en el momento ${x.momentoId}: deben ser múltiplo de 0,25`);
      }
    }
  }
  return e;
}

/** Avisos de seguridad (no bloquean). */
export function avisosPauta(pauta: Pauta, nombrePrincipioActivo?: string): string[] {
  const a: string[] = [];
  const med = nombrePrincipioActivo ? ` (${nombrePrincipioActivo})` : '';
  const semanal =
    (pauta.patron === 'dias_semana' && Array.isArray(pauta.diasSemana) && pauta.diasSemana.length === 1) ||
    (pauta.patron === 'cada_n_dias' && typeof pauta.cadaNDias === 'number' && pauta.cadaNDias >= 7);
  if (semanal) {
    a.push(`PAUTA SEMANAL${med}: comprueba que no se prepara a diario. Un error de frecuencia en un medicamento de toma semanal puede ser grave.`);
  }
  if (Array.isArray(pauta.dosis) && pauta.dosis.some((x) => typeof x.unidades === 'number' && !Number.isInteger(x.unidades))) {
    a.push(`Hay fracciones de unidad${med}: solo si el medicamento es divisible (comprueba la ficha técnica).`);
  }
  if (pauta.patron === 'ciclo') {
    a.push(`Pauta por ciclos${med}: comprueba los días de toma y de descanso y la fecha de inicio del ciclo.`);
  }
  return a;
}

/** Suma de unidades del periodo (en cuartos, sin error de coma flotante). */
export function unidadesTotales(pauta: Pauta, desde: string, hasta: string): number {
  let cuartos = 0;
  for (const t of tomasDelPeriodo(pauta, desde, hasta)) cuartos += Math.round(t.unidades * 4);
  return cuartos / 4;
}

/** De varias versiones, la que aplica ese día (la de vigenteDesde más reciente). */
export function pautaVigenteEn(versiones: Pauta[], fecha: string): Pauta | null {
  const n = exigirDia(fecha, 'La fecha');
  let mejor: Pauta | null = null;
  let mejorDesde = -Infinity;
  for (const v of versiones) {
    const desde = exigirDia(v.vigenteDesde, 'vigenteDesde');
    if (desde > n) continue;
    if (v.vigenteHasta != null && exigirDia(v.vigenteHasta, 'vigenteHasta') < n) continue;
    if (desde >= mejorDesde) { mejor = v; mejorDesde = desde; } // empate: la posterior en la lista
  }
  return mejor;
}
