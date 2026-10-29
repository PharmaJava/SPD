/**
 * Lectura de pautas desde la base, conversión al dominio y texto legible.
 */
import type { Db } from '../db.ts';
import type { PautaDto } from '../api.ts';
import type { Pauta } from '../../dominio/tipos.ts';
import { marcadores, porTrozos } from './comun.ts';
import type { R } from './comun.ts';

export interface MomentoFila { id: number; nombre: string; orden: number }

export function cargarMomentos(db: Db): MomentoFila[] {
  return db.all<R>('SELECT id, nombre, orden FROM momento_toma ORDER BY orden, id') as MomentoFila[];
}

/** Todas las versiones de pauta (con dosis) de los tratamientos dados, por tratamiento y en orden de versión. */
export function cargarPautas(db: Db, tratamientoIds: number[]): Map<number, PautaDto[]> {
  const mapa = new Map<number, PautaDto[]>();
  if (tratamientoIds.length === 0) return mapa;
  const versiones = porTrozos(tratamientoIds, (t) =>
    db.all<R>(`SELECT * FROM pauta_version WHERE tratamiento_id IN (${marcadores(t.length)}) ORDER BY tratamiento_id, version`, t));
  const dosisPorVersion = new Map<number, { momentoId: number; unidades: number }[]>();
  const idsVersion = versiones.map((v) => v.id as number);
  const dosis = porTrozos(idsVersion, (t) =>
    db.all<R>(`SELECT pauta_version_id, momento_id, unidades FROM pauta_dosis WHERE pauta_version_id IN (${marcadores(t.length)}) ORDER BY momento_id`, t));
  for (const d of dosis) {
    const l = dosisPorVersion.get(d.pauta_version_id) ?? [];
    l.push({ momentoId: d.momento_id, unidades: d.unidades });
    dosisPorVersion.set(d.pauta_version_id, l);
  }
  for (const v of versiones) {
    const dto: PautaDto = {
      id: v.id, version: v.version, vigenteDesde: v.vigente_desde, vigenteHasta: v.vigente_hasta ?? null,
      patron: v.patron,
      ...(v.dias_semana ? { diasSemana: String(v.dias_semana).split(',').map(Number) } : {}),
      ...(v.cada_n_dias != null ? { cadaNDias: v.cada_n_dias } : {}),
      ...(v.ciclo_on != null ? { cicloOn: v.ciclo_on } : {}),
      ...(v.ciclo_off != null ? { cicloOff: v.ciclo_off } : {}),
      ...(v.fecha_ancla ? { fechaAncla: v.fecha_ancla } : {}),
      instrucciones: v.instrucciones ?? null,
      origen: v.origen, origenDetalle: v.origen_detalle ?? null,
      dosis: dosisPorVersion.get(v.id) ?? [],
    };
    const l = mapa.get(v.tratamiento_id) ?? [];
    l.push(dto);
    mapa.set(v.tratamiento_id, l);
  }
  return mapa;
}

export function pautaADominio(p: PautaDto): Pauta {
  return {
    vigenteDesde: p.vigenteDesde,
    vigenteHasta: p.vigenteHasta ?? null,
    patron: p.patron,
    ...(p.diasSemana ? { diasSemana: p.diasSemana } : {}),
    ...(p.cadaNDias != null ? { cadaNDias: p.cadaNDias } : {}),
    ...(p.cicloOn != null ? { cicloOn: p.cicloOn } : {}),
    ...(p.cicloOff != null ? { cicloOff: p.cicloOff } : {}),
    ...(p.fechaAncla ? { fechaAncla: p.fechaAncla } : {}),
    dosis: p.dosis.map((d) => ({ momentoId: d.momentoId, unidades: d.unidades })),
  };
}

const DIAS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

export const fmtUnidades = (u: number): string => String(u).replace('.', ',');

function lista(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

/** «1 desayuno + 1 cena, a diario» · «lunes: 1 desayuno» · «1 cena, cada 3 días». */
export function textoPauta(p: PautaDto, momentos: MomentoFila[]): string {
  const orden = new Map(momentos.map((m) => [m.id, m]));
  const dosis = [...p.dosis]
    .sort((a, b) => (orden.get(a.momentoId)?.orden ?? 999) - (orden.get(b.momentoId)?.orden ?? 999) || a.momentoId - b.momentoId)
    .map((d) => `${fmtUnidades(d.unidades)} ${(orden.get(d.momentoId)?.nombre ?? `momento ${d.momentoId}`).toLowerCase()}`)
    .join(' + ');
  switch (p.patron) {
    case 'diario': return `${dosis}, a diario`;
    case 'dias_semana': {
      const ds = [...new Set(p.diasSemana ?? [])].sort((a, b) => a - b);
      if (ds.length === 7) return `${dosis}, a diario`;
      return `${lista(ds.map((d) => DIAS[d - 1] ?? `día ${d}`))}: ${dosis}`;
    }
    case 'cada_n_dias':
      return p.cadaNDias === 1 ? `${dosis}, a diario` : `${dosis}, cada ${p.cadaNDias} días`;
    case 'ciclo':
      return p.cicloOff === 0 ? `${dosis}, a diario` : `${dosis}, ${p.cicloOn} días con toma y ${p.cicloOff} de descanso`;
    case 'si_precisa':
      return `si precisa: ${dosis}`;
    default:
      return dosis;
  }
}
