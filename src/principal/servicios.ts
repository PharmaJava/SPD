/**
 * Ensamblado REAL de los servicios del programa: sistema (S1) + clínica base (S2a) + clínica de preparación (S2b)
 * + externo (Electron) en un único `ApiSpd`. La lógica de ensamblado está en ensamblar.ts (probada con dobles).
 */
import type { ApiExterna, ApiSpd, EstadoSistema, Resultado } from '../servicios/api.ts';
import type { NombreMetodo } from '../servicios/api.ts';
import { crearSistema } from '../servicios/sistema.ts';
import { crearClinicaBase } from '../servicios/clinica-base.ts';
import { crearClinicaPreparacion } from '../servicios/clinica-preparacion.ts';
import { ensamblarApi } from './ensamblar.ts';

export interface OpcionesServicios {
  rutaDatos: string;
  wasmPath?: string;
  version?: string;
  externo: ApiExterna;
}

export interface ServiciosApp {
  api: ApiSpd;
  /** Métodos del contrato que ninguna pieza implementa todavía (debería estar vacío). */
  faltan: NombreMetodo[];
  bloquearPorInactividad(): Promise<Resultado<EstadoSistema>>;
  crearCopiaAutomatica(): Promise<Resultado<{ ruta: string }>>;
  cerrar(): Promise<void>;
}

export function crearServiciosApp(op: OpcionesServicios): ServiciosApp {
  const sistema = crearSistema({ rutaDatos: op.rutaDatos, wasmPath: op.wasmPath, version: op.version });
  const base = crearClinicaBase(sistema.ctx);
  const preparacion = crearClinicaPreparacion(sistema.ctx);
  const { api, faltan } = ensamblarApi({
    sistema: sistema.api as never, clinicaBase: base as never, clinicaPreparacion: preparacion as never, externo: op.externo as never,
  });
  return {
    api, faltan,
    bloquearPorInactividad: () => sistema.bloquearPorInactividad(),
    crearCopiaAutomatica: () => sistema.crearCopiaAutomatica(),
    cerrar: () => sistema.cerrar(),
  };
}
