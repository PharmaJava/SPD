/**
 * Consumo de envases (cajas custodiadas) al preparar un SPD.
 *
 * Reglas:
 *  - FEFO: primero la caja que caduca antes; desempate: menos unidades
 *    restantes, después id menor.
 *  - Sólo se usan cajas `en_uso`, con unidades y con caducidad >= fin del
 *    periodo. Una caja que caduca a mitad del periodo NO se usa: se explica
 *    en los avisos y el farmacéutico decide.
 *  - Nunca se adivina: si faltan unidades, ok = false y se dice cuántas.
 *  - Las cantidades admiten fracciones de cuarto (0.5, 0.25). Internamente se
 *    trabaja en CUARTOS enteros para que no haya errores de coma flotante.
 *
 * FUNCIONES PURAS: sin disco, red ni reloj; fechas ISO AAAA-MM-DD.
 */
import type { Envase } from './tipos.ts';

export interface OpcionesReparto { fechaPreparacion: string; fechaFinPeriodo: string }
export interface Asignacion { envaseId: number; unidades: number }
export interface ResultadoReparto {
  ok: boolean;
  asignaciones: Asignacion[];
  faltan: number;
  avisos: string[];
  errores: string[];
}
export interface TomaPedida { fecha: string; momentoId: number; unidades: number }
export interface LineaToma { fecha: string; momentoId: number; envaseId: number; unidades: number }
export interface ResultadoTomas {
  ok: boolean;
  lineas: LineaToma[];
  faltan: number;
  avisos: string[];
  errores: string[];
}

const esFecha = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

function sumarDias(fecha: string, dias: number): string {
  const d = new Date(fecha + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function diasEntre(desde: string, hasta: string): number {
  return Math.round((Date.parse(hasta + 'T00:00:00Z') - Date.parse(desde + 'T00:00:00Z')) / 86400000);
}

/** Unidades → cuartos enteros; null si no es un múltiplo de 0.25 válido (>= 0). */
function aCuartos(u: number): number | null {
  if (typeof u !== 'number' || !Number.isFinite(u) || u < 0) return null;
  const c = Math.round(u * 4);
  if (Math.abs(u * 4 - c) > 1e-9) return null;
  return c;
}

const deCuartos = (c: number): number => c / 4;

/** Orden FEFO: caduca antes → menos restantes → id menor. */
function ordenFefo(a: CajaInterna, b: CajaInterna): number {
  if (a.caducidad !== b.caducidad) return a.caducidad < b.caducidad ? -1 : 1;
  if (a.cuartos !== b.cuartos) return a.cuartos - b.cuartos;
  return a.id - b.id;
}

interface CajaInterna { id: number; lote: string; caducidad: string; cuartos: number }

interface Preparadas { cajas: CajaInterna[]; avisos: string[]; errores: string[] }

/** Validación común y selección de cajas utilizables, ya en orden FEFO. */
function prepararCajas(envases: Envase[], op: OpcionesReparto): Preparadas {
  const avisos: string[] = [];
  const errores: string[] = [];
  if (!esFecha(op.fechaPreparacion)) errores.push(`Fecha de preparación no válida: ${op.fechaPreparacion}`);
  if (!esFecha(op.fechaFinPeriodo)) errores.push(`Fecha de fin de periodo no válida: ${op.fechaFinPeriodo}`);
  if (errores.length === 0 && op.fechaFinPeriodo < op.fechaPreparacion) {
    errores.push('El fin del periodo es anterior a la preparación');
  }

  const ids = new Set<number>();
  for (const e of envases) {
    if (ids.has(e.id)) errores.push(`Envase con id repetido: ${e.id}`);
    ids.add(e.id);
  }

  const enUso = envases.filter((e) => e.estado === 'en_uso');
  const lotes = new Set<string>();
  for (const e of enUso) {
    if (lotes.has(e.lote)) errores.push(`Lote repetido entre las cajas en uso: ${e.lote}`);
    lotes.add(e.lote);
  }
  if (new Set(enUso.map((e) => e.tratamientoId)).size > 1) {
    errores.push('Las cajas pertenecen a tratamientos distintos');
  }

  const cajas: CajaInterna[] = [];
  for (const e of enUso) {
    const c = aCuartos(e.unidadesRestantes);
    if (c === null) {
      errores.push(`Unidades restantes no válidas en la caja ${e.id} (lote ${e.lote}): ${e.unidadesRestantes}`);
      continue;
    }
    if (!esFecha(e.caducidad)) {
      errores.push(`Caducidad no válida en la caja ${e.id} (lote ${e.lote}): ${e.caducidad}`);
      continue;
    }
    if (c === 0) {
      avisos.push(`La caja ${e.id} (lote ${e.lote}) está en uso pero sin unidades: se ignora.`);
      continue;
    }
    if (errores.length === 0 && e.caducidad < op.fechaFinPeriodo) {
      avisos.push(
        `La caja ${e.id} (lote ${e.lote}) caduca el ${e.caducidad}, antes del fin del periodo (${op.fechaFinPeriodo}): no se usa.`,
      );
      continue;
    }
    cajas.push({ id: e.id, lote: e.lote, caducidad: e.caducidad, cuartos: c });
  }
  cajas.sort(ordenFefo);
  return { cajas, avisos, errores };
}

export function repartirUnidades(
  envases: Envase[],
  unidadesNecesarias: number,
  opciones: OpcionesReparto,
): ResultadoReparto {
  const { cajas, avisos, errores } = prepararCajas(envases, opciones);
  const necesarias = aCuartos(unidadesNecesarias);
  if (necesarias === null) errores.push(`Unidades necesarias no válidas: ${unidadesNecesarias}`);
  if (errores.length > 0 || necesarias === null) {
    return { ok: false, asignaciones: [], faltan: typeof unidadesNecesarias === 'number' && necesarias !== null ? unidadesNecesarias : 0, avisos, errores };
  }

  const asignaciones: Asignacion[] = [];
  let pendiente = necesarias;
  for (const c of cajas) {
    if (pendiente === 0) break;
    const toma = Math.min(c.cuartos, pendiente);
    asignaciones.push({ envaseId: c.id, unidades: deCuartos(toma) });
    pendiente -= toma;
  }
  if (pendiente > 0) {
    avisos.push(`No alcanzan las unidades: faltan ${deCuartos(pendiente)}. Hay que abrir otra caja o reducir el periodo.`);
  }
  return { ok: pendiente === 0, asignaciones, faltan: deCuartos(pendiente), avisos, errores };
}

export function repartirTomas(
  envases: Envase[],
  tomas: TomaPedida[],
  opciones: OpcionesReparto,
): ResultadoTomas {
  const { cajas, avisos, errores } = prepararCajas(envases, opciones);
  const pedidas: { t: TomaPedida; c: number; orden: number }[] = [];
  tomas.forEach((t, orden) => {
    const c = aCuartos(t.unidades);
    if (!esFecha(t.fecha)) errores.push(`Fecha de toma no válida: ${t.fecha}`);
    else if (c === null) errores.push(`Unidades de toma no válidas (${t.fecha}, momento ${t.momentoId}): ${t.unidades}`);
    else pedidas.push({ t, c, orden });
  });
  if (errores.length > 0) return { ok: false, lineas: [], faltan: 0, avisos, errores };

  // Orden cronológico (estable: a igual fecha, el orden de entrada).
  pedidas.sort((a, b) => (a.t.fecha < b.t.fecha ? -1 : a.t.fecha > b.t.fecha ? 1 : a.orden - b.orden));

  const lineas: LineaToma[] = [];
  let faltanC = 0;
  let i = 0; // caja actual
  const restante = cajas.map((c) => c.cuartos);
  for (const { t, c } of pedidas) {
    if (c === 0) continue;
    let pendiente = c;
    let usadas = 0;
    while (pendiente > 0 && i < cajas.length) {
      if (restante[i] === 0) { i++; continue; }
      const toma = Math.min(restante[i], pendiente);
      lineas.push({ fecha: t.fecha, momentoId: t.momentoId, envaseId: cajas[i].id, unidades: deCuartos(toma) });
      restante[i] -= toma;
      pendiente -= toma;
      usadas++;
    }
    if (usadas > 1) avisos.push(`Toma con dos lotes: ${t.fecha}, momento ${t.momentoId}.`);
    if (pendiente > 0) faltanC += pendiente;
  }
  if (faltanC > 0) avisos.push(`No alcanzan las unidades: faltan ${deCuartos(faltanC)}.`);
  return { ok: faltanC === 0, lineas, faltan: deCuartos(faltanC), avisos, errores };
}

/**
 * Días completos que cubren las unidades en uso, contando desde `hoy` (día 0).
 * Una caja deja de contar el día siguiente a su caducidad.
 * @throws si unidadesPorDia no es un múltiplo positivo de 0.25 o `hoy` no es fecha.
 */
export function diasDeCobertura(
  envases: Envase[],
  unidadesPorDia: number,
  hoy: string,
): { dias: number; hasta: string | null } {
  const porDia = aCuartos(unidadesPorDia);
  if (porDia === null || porDia <= 0) throw new Error(`unidadesPorDia debe ser > 0 (múltiplo de 0.25): ${unidadesPorDia}`);
  if (!esFecha(hoy)) throw new Error(`Fecha no válida: ${hoy}`);

  const cajas: CajaInterna[] = [];
  for (const e of envases) {
    if (e.estado !== 'en_uso' || !esFecha(e.caducidad)) continue;
    const c = aCuartos(e.unidadesRestantes);
    if (c === null || c === 0) continue;
    cajas.push({ id: e.id, lote: e.lote, caducidad: e.caducidad, cuartos: c });
  }
  cajas.sort(ordenFefo);
  const total = cajas.reduce((s, c) => s + c.cuartos, 0);
  const maxDias = Math.floor(total / porDia);
  let dias = 0;
  for (let d = 0; d < maxDias; d++) {
    const fecha = sumarDias(hoy, d);
    let pendiente = porDia;
    for (const c of cajas) {
      if (pendiente === 0) break;
      if (c.caducidad < fecha || c.cuartos === 0) continue;
      const toma = Math.min(c.cuartos, pendiente);
      c.cuartos -= toma;
      pendiente -= toma;
    }
    if (pendiente > 0) break;
    dias++;
  }
  return { dias, hasta: dias > 0 ? sumarDias(hoy, dias - 1) : null };
}

export function avisosCajas(envases: Envase[], hoy: string, umbralDias = 30): string[] {
  if (!esFecha(hoy)) throw new Error(`Fecha no válida: ${hoy}`);
  const avisos: string[] = [];
  for (const e of envases) {
    if (e.estado !== 'en_uso') continue;
    const nombre = `caja ${e.id} (lote ${e.lote})`;
    if (esFecha(e.caducidad)) {
      if (e.caducidad < hoy) avisos.push(`La ${nombre} está caducada desde el ${e.caducidad}.`);
      else {
        const d = diasEntre(hoy, e.caducidad);
        if (d <= umbralDias) avisos.push(`La ${nombre} caduca el ${e.caducidad} (en ${d} días).`);
      }
    } else avisos.push(`La ${nombre} tiene una caducidad no válida: ${e.caducidad}.`);
    if (!(e.unidadesRestantes > 0)) {
      avisos.push(`La ${nombre} figura en uso pero sin unidades: inconsistencia, revisar.`);
    }
  }
  return avisos;
}

/**
 * Devuelve COPIAS con las unidades descontadas; `agotado` al llegar a 0.
 * @throws si una línea apunta a un envase inexistente o no en uso, trae
 *         cantidades no válidas o pide más de lo que hay.
 */
export function aplicarConsumo(
  envases: Envase[],
  lineas: { envaseId: number; unidades: number }[],
): Envase[] {
  const gasto = new Map<number, number>();
  for (const l of lineas) {
    const c = aCuartos(l.unidades);
    if (c === null) throw new Error(`Cantidad no válida para el envase ${l.envaseId}: ${l.unidades}`);
    gasto.set(l.envaseId, (gasto.get(l.envaseId) ?? 0) + c);
  }
  const ids = new Set(envases.map((e) => e.id));
  for (const id of gasto.keys()) {
    if (!ids.has(id)) throw new Error(`Envase inexistente: ${id}`);
  }
  return envases.map((e) => {
    const g = gasto.get(e.id);
    if (g === undefined || g === 0) return { ...e };
    if (e.estado !== 'en_uso') throw new Error(`El envase ${e.id} no está en uso (${e.estado})`);
    const resto = aCuartos(e.unidadesRestantes);
    if (resto === null) throw new Error(`Unidades restantes no válidas en el envase ${e.id}`);
    if (g > resto) throw new Error(`Se piden ${deCuartos(g)} del envase ${e.id} y sólo quedan ${deCuartos(resto)}`);
    const queda = resto - g;
    return { ...e, unidadesRestantes: deCuartos(queda), estado: queda === 0 ? 'agotado' : e.estado };
  });
}
