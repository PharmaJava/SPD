/**
 * Cobertura en días de las cajas en uso. Usa el calendario de la pauta
 * (calendario-pauta) y el reparto por caducidad (consumo-envases).
 *
 * Una caja deja de contar el día siguiente a su caducidad. Si la pauta es diaria
 * y constante se usa `diasDeCobertura` del dominio; si no (días de la semana,
 * cada N días, ciclos, cambios de versión futuros) se simula día a día con el
 * mismo criterio (primero la que caduca antes).
 */
import type { Db } from '../db.ts';
import type { Envase, Pauta } from '../../dominio/tipos.ts';
import { diasDeCobertura } from '../../dominio/consumo-envases.ts';
import { MAX_DIAS_PERIODO, pautaVigenteEn, tomasDelPeriodoVersiones } from '../../dominio/calendario-pauta.ts';
import { cargarPautas, pautaADominio } from './pautas.ts';
import { sumarDias } from './comun.ts';
import type { R } from './comun.ts';

const aCuartos = (u: number): number => Math.round(u * 4);

/** Días completos cubiertos; null si no se puede calcular (sin pauta vigente o «si precisa»). */
export function diasCobertura(versiones: Pauta[], envases: Envase[], hoy: string): number | null {
  const vigente = pautaVigenteEn(versiones, hoy);
  if (!vigente || vigente.patron === 'si_precisa') return null;
  const enUso = envases.filter((e) => e.estado === 'en_uso' && e.unidadesRestantes > 0);
  if (enUso.length === 0) return 0;

  const hayCambioFuturo = versiones.some((v) => v.vigenteDesde > hoy);
  if (vigente.patron === 'diario' && vigente.vigenteHasta == null && !hayCambioFuturo) {
    const porDia = vigente.dosis.reduce((s, d) => s + d.unidades, 0);
    return diasDeCobertura(envases, porDia, hoy).dias;
  }

  // Simulación día a día (hasta un año).
  const tomas = tomasDelPeriodoVersiones(versiones, hoy, sumarDias(hoy, MAX_DIAS_PERIODO - 1));
  const necesidad = new Map<string, number>();
  for (const t of tomas) necesidad.set(t.fecha, (necesidad.get(t.fecha) ?? 0) + aCuartos(t.unidades));
  const cajas = enUso
    .map((e) => ({ id: e.id, caducidad: e.caducidad, cuartos: aCuartos(e.unidadesRestantes) }))
    .sort((a, b) => (a.caducidad !== b.caducidad ? (a.caducidad < b.caducidad ? -1 : 1) : a.cuartos - b.cuartos || a.id - b.id));
  for (let d = 0; d < MAX_DIAS_PERIODO; d++) {
    const fecha = sumarDias(hoy, d);
    let pendiente = necesidad.get(fecha) ?? 0;
    for (const c of cajas) {
      if (pendiente === 0) break;
      if (c.caducidad < fecha || c.cuartos === 0) continue;
      const toma = Math.min(c.cuartos, pendiente);
      c.cuartos -= toma;
      pendiente -= toma;
    }
    if (pendiente > 0) return d;
  }
  return MAX_DIAS_PERIODO;
}

export interface CoberturaTratamiento { dias: number | null; cajas: number }

/** Envases en uso (con tratamiento asignado) en formato del dominio, agrupados por tratamiento. */
export function cargarEnvasesEnUso(db: Db, sqlWhere = '', params: (string | number)[] = []): Map<number, Envase[]> {
  const filas = db.all<R>(
    `SELECT id, tratamiento_id, cn, lote, caducidad, numero_serie, unidades_restantes, estado FROM envase
      WHERE estado = 'en_uso' AND tratamiento_id IS NOT NULL ${sqlWhere}`, params);
  const mapa = new Map<number, Envase[]>();
  for (const f of filas) {
    const e: Envase = {
      id: f.id, tratamientoId: f.tratamiento_id, cn: f.cn, lote: f.lote, caducidad: f.caducidad,
      ...(f.numero_serie ? { numeroSerie: f.numero_serie } : {}),
      unidadesRestantes: f.unidades_restantes, estado: f.estado,
    };
    const l = mapa.get(f.tratamiento_id) ?? [];
    l.push(e);
    mapa.set(f.tratamiento_id, l);
  }
  return mapa;
}

/** Cobertura de cada tratamiento dado (que se supone emblistable y vigente). */
export function coberturaDeTratamientos(db: Db, hoy: string, ids: number[]): Map<number, CoberturaTratamiento> {
  const pautas = cargarPautas(db, ids);
  const envases = cargarEnvasesEnUso(db);
  const salida = new Map<number, CoberturaTratamiento>();
  for (const id of ids) {
    const cajas = (envases.get(id) ?? []);
    const versiones = (pautas.get(id) ?? []).map(pautaADominio);
    let dias: number | null = null;
    try { dias = diasCobertura(versiones, cajas, hoy); } catch { dias = null; }
    salida.set(id, { dias, cajas: cajas.length });
  }
  return salida;
}

/**
 * Cobertura por paciente: el MÍNIMO de sus tratamientos emblistables activos que
 * tienen cajas en uso. null si ninguno tiene cajas (o no hay tratamientos).
 */
export function coberturaPorPaciente(db: Db, hoy: string): Map<number, number | null> {
  const trat = db.all<R>(
    `SELECT t.id, t.paciente_id FROM tratamiento t JOIN paciente p ON p.id = t.paciente_id
      WHERE t.finalizado_en IS NULL AND t.emblistable = 1 AND p.estado IN ('activo','pausado')`);
  const cob = coberturaDeTratamientos(db, hoy, trat.map((t) => t.id as number));
  const mapa = new Map<number, number | null>();
  for (const t of trat) {
    const c = cob.get(t.id)!;
    if (c.cajas === 0 || c.dias === null) { if (!mapa.has(t.paciente_id)) mapa.set(t.paciente_id, null); continue; }
    const previo = mapa.get(t.paciente_id);
    mapa.set(t.paciente_id, previo == null ? c.dias : Math.min(previo, c.dias));
  }
  return mapa;
}
