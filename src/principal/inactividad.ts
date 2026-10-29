/**
 * Bloqueo por inactividad: cada actividad en la ventana reinicia un reloj; si pasan `bloqueoMinutos`
 * sin actividad se llama a `alBloquear`. Sin Electron ni temporizadores globales: se inyectan (pruebas).
 *
 * ⚠️ Nunca se puede desactivar: un valor ausente, no numérico o < 1 usa el valor por defecto, y el máximo es 120.
 */
export const BLOQUEO_POR_DEFECTO_MIN = 5;
export const BLOQUEO_MAXIMO_MIN = 120;

export function minutosValidos(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 1) return BLOQUEO_POR_DEFECTO_MIN;
  return Math.min(Math.floor(v), BLOQUEO_MAXIMO_MIN);
}

export interface Temporizadores {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  ahora(): number;
}
export const temporizadoresReales: Temporizadores = {
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  ahora: () => Date.now(),
};

export interface Vigilante {
  /** Llamar con cada acción del usuario (teclado, ratón, toque). */
  actividad(): void;
  /** Cambia el plazo (minutos) y reinicia el reloj. */
  configurar(minutos: unknown): void;
  parar(): void;
  readonly minutos: number;
}

export function crearVigilanteInactividad(
  opciones: { minutos?: unknown; alBloquear: () => void; t?: Temporizadores; unaVezPorSegundo?: boolean },
): Vigilante {
  const t = opciones.t ?? temporizadoresReales;
  let minutos = minutosValidos(opciones.minutos);
  let id: unknown = null;
  let ultimo = -Infinity;
  let parado = false;

  const armar = () => {
    if (id !== null) t.clearTimeout(id);
    id = t.setTimeout(() => { id = null; if (!parado) { try { opciones.alBloquear(); } catch { /* nunca debe romper el reloj */ } } }, minutos * 60_000);
  };
  armar();
  return {
    actividad() {
      if (parado) return;
      const n = t.ahora();
      // Con ráfagas de eventos (mover el ratón) sólo se rearma una vez por segundo.
      if (opciones.unaVezPorSegundo !== false && n - ultimo < 1000 && id !== null) return;
      ultimo = n; armar();
    },
    configurar(m) { minutos = minutosValidos(m); ultimo = -Infinity; if (!parado) armar(); },
    parar() { parado = true; if (id !== null) t.clearTimeout(id); id = null; },
    get minutos() { return minutos; },
  };
}
