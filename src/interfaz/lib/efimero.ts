/**
 * Estado EFÍMERO de la interfaz: sólo en memoria del renderer. Nada de datos de pacientes en localStorage/sessionStorage
 * (quedan en claro en el disco, en el perfil de Chromium). Se vacía al bloquear y al cerrar sesión (App.svelte).
 */
const memoria = new Map<string, string>();

export function leerEfimero<T>(clave: string, defecto: T): T {
  const t = memoria.get(clave);
  if (t === undefined) return defecto;
  try { return JSON.parse(t) as T; } catch { return defecto; }
}
export function guardarEfimero(clave: string, valor: unknown): void { memoria.set(clave, JSON.stringify(valor)); }
export function borrarEfimero(clave: string): void { memoria.delete(clave); }

/** Claves antiguas (versiones anteriores las guardaban en claro en localStorage). */
const PREFIJOS_HEREDADOS = ['spd.cajas.', 'spd.preparar.', 'spd.llenado.', 'spd.docs.'];

/** Borra lo efímero, los pasos entre pantallas (sessionStorage `spd.*`) y los restos heredados de localStorage. */
export function limpiarEfimero(): void {
  memoria.clear();
  for (const almacen of ['sessionStorage', 'localStorage'] as const) {
    try {
      const a = window[almacen];
      for (const k of Object.keys(a)) {
        if (almacen === 'sessionStorage' ? k.startsWith('spd.') : PREFIJOS_HEREDADOS.some(p => k.startsWith(p))) a.removeItem(k);
      }
    } catch { /* sin almacenamiento */ }
  }
}
