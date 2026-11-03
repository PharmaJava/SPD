/**
 * Estado de los avisos de «Hoy» marcados como vistos o quitados (reglas en dominio/avisos.ts).
 * En memoria de la sesión; sólo los TIPOS de avisos generales (sin paciente) se recuerdan en el equipo, nunca nombres.
 */
import { writable, get } from 'svelte/store';
import type { AvisoBasico, EstadoAvisos } from '../../dominio/avisos.ts';
import { ESTADO_AVISOS_VACIO, marcarVisto, quitarAviso, quitarVistos, restaurarAvisos } from '../../dominio/avisos.ts';
import { guardarTiposAvisosQuitados, leerTiposAvisosQuitados } from '../componentes/util.ts';

export const estadoAvisos = writable<EstadoAvisos>({ ...ESTADO_AVISOS_VACIO, tiposQuitados: leerTiposAvisosQuitados() });

function cambiar(f: (e: EstadoAvisos) => EstadoAvisos): void {
  const antes = get(estadoAvisos);
  const despues = f(antes);
  if (despues === antes) return;
  estadoAvisos.set(despues);
  if (JSON.stringify(despues.tiposQuitados) !== JSON.stringify(antes.tiposQuitados)) guardarTiposAvisosQuitados(despues.tiposQuitados);
}

export const verAviso = (a: AvisoBasico): void => cambiar((e) => marcarVisto(e, a));
export const sacarAviso = (a: AvisoBasico): void => cambiar((e) => quitarAviso(e, a));
export const sacarVistos = (avisos: readonly AvisoBasico[]): void => cambiar((e) => quitarVistos(e, avisos));
export const mostrarQuitados = (): void => cambiar(() => restaurarAvisos());
