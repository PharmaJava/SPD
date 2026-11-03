/**
 * Avisos que la persona puede marcar como vistos o quitar de la pantalla «Hoy» (y del distintivo de copia atrasada).
 *
 * FUNCIONES PURAS. Dos reglas que no se tocan:
 *  1. Los avisos de SEGURIDAD de la preparación y la validación (bloqueos, alergia, caducidad, alerta de calidad) NUNCA se
 *     pueden marcar como vistos ni quitar: `esAvisoProtegido`. Ocultar uno no lo resuelve; sólo lo esconde.
 *  2. El estado de «visto/quitado» guarda SÓLO identificadores (tipo de aviso y número de paciente), jamás nombres ni texto:
 *     lo único que puede quedar en el equipo es el tipo de un aviso general (sin paciente), p. ej. «copia_atrasada».
 */

export type GravedadAviso = 'bloqueo' | 'atencion' | 'info';

export interface AvisoBasico { tipo: string; gravedad: GravedadAviso; pacienteId?: number | null }

/** Tipos de aviso que tocan la seguridad del paciente: nunca ocultables, aunque su gravedad cambie. */
export const TIPOS_DE_SEGURIDAD: readonly string[] = ['alerta_calidad', 'caja_caducada', 'caja_caduca', 'alergia_sin_confirmar'];

/** Un bloqueo (cualquier tipo) o un tipo de seguridad: no se puede ocultar. */
export function esAvisoProtegido(a: Pick<AvisoBasico, 'tipo' | 'gravedad'>): boolean {
  return a.gravedad === 'bloqueo' || TIPOS_DE_SEGURIDAD.includes(a.tipo);
}

/** Identifica un aviso concreto sin guardar ningún dato personal: sólo el tipo y el id del paciente. */
export const claveAviso = (a: Pick<AvisoBasico, 'tipo' | 'pacienteId'>): string => `${a.tipo}:${a.pacienteId ?? '-'}`;

/** Un aviso general (sin paciente) puede recordarse por su tipo entre sesiones; uno de un paciente concreto, no. */
export const esAvisoGeneral = (a: Pick<AvisoBasico, 'pacienteId'>): boolean => a.pacienteId === undefined || a.pacienteId === null;

export interface EstadoAvisos {
  /** Claves (`claveAviso`) marcadas como vistas en esta sesión: siguen en la lista, atenuadas. */
  vistos: readonly string[];
  /** Claves quitadas en esta sesión: ocultas. */
  quitados: readonly string[];
  /** Tipos de avisos GENERALES quitados que se recuerdan en este equipo (sólo ids de tipo). */
  tiposQuitados: readonly string[];
}
export const ESTADO_AVISOS_VACIO: EstadoAvisos = { vistos: [], quitados: [], tiposQuitados: [] };

export type AvisoConEstado<T extends AvisoBasico> = T & { visto: boolean; protegido: boolean };

/** Qué se enseña: los protegidos SIEMPRE (nunca vistos ni ocultos); el resto, salvo los quitados. `ocultos` los cuenta. */
export function aplicarEstado<T extends AvisoBasico>(avisos: readonly T[], e: EstadoAvisos): { visibles: AvisoConEstado<T>[]; ocultos: number } {
  const vistos = new Set(e.vistos), quitados = new Set(e.quitados), tipos = new Set(e.tiposQuitados);
  const visibles: AvisoConEstado<T>[] = [];
  let ocultos = 0;
  for (const a of avisos) {
    if (esAvisoProtegido(a)) { visibles.push({ ...a, visto: false, protegido: true }); continue; }
    const k = claveAviso(a);
    if (quitados.has(k) || (esAvisoGeneral(a) && tipos.has(a.tipo))) { ocultos++; continue; }
    visibles.push({ ...a, visto: vistos.has(k), protegido: false });
  }
  return { visibles, ocultos };
}

/** Marca como visto (si no es protegido). */
export function marcarVisto(e: EstadoAvisos, a: Pick<AvisoBasico, 'tipo' | 'gravedad' | 'pacienteId'>): EstadoAvisos {
  if (esAvisoProtegido(a)) return e;
  const k = claveAviso(a);
  return e.vistos.includes(k) ? e : { ...e, vistos: [...e.vistos, k] };
}

/** Quita el aviso (si no es protegido). Si es general, se recuerda por su tipo. */
export function quitarAviso(e: EstadoAvisos, a: Pick<AvisoBasico, 'tipo' | 'gravedad' | 'pacienteId'>): EstadoAvisos {
  if (esAvisoProtegido(a)) return e;
  const k = claveAviso(a);
  return {
    vistos: e.vistos.filter((x) => x !== k),
    quitados: e.quitados.includes(k) ? e.quitados : [...e.quitados, k],
    tiposQuitados: esAvisoGeneral(a) && !e.tiposQuitados.includes(a.tipo) ? [...e.tiposQuitados, a.tipo] : e.tiposQuitados,
  };
}

/** «Quitar todos los vistos»: lo ya marcado como visto pasa a quitado. Lo que no se marcó, no se toca. */
export function quitarVistos(e: EstadoAvisos, avisos: readonly AvisoBasico[]): EstadoAvisos {
  const vistos = new Set(e.vistos);
  let r = e;
  for (const a of avisos) if (!esAvisoProtegido(a) && vistos.has(claveAviso(a))) r = quitarAviso(r, a);
  return r;
}

/** «Mostrar de nuevo los quitados». */
export const restaurarAvisos = (): EstadoAvisos => ESTADO_AVISOS_VACIO;

/** Sólo texto de tipos conocidos como cadena corta: lo que llega de un almacenamiento externo no se da por bueno. */
export function tiposGuardadosValidos(valor: unknown): string[] {
  if (!Array.isArray(valor)) return [];
  return [...new Set(valor.filter((x): x is string => typeof x === 'string' && /^[a-z_]{3,40}$/.test(x)))].filter((t) => !TIPOS_DE_SEGURIDAD.includes(t));
}
