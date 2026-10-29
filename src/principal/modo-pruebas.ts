/**
 * Modo de pruebas para las capturas de pantalla (scripts/capturas.mjs).
 *
 * ⚠️ SOLO se activa si se cumplen las TRES cosas: la variable `SPD_CAPTURAS=1`, la aplicación NO está empaquetada
 * y hay una carpeta de datos de pruebas (`SPD_DATOS_PRUEBAS`). En la versión instalada no existe ningún camino que
 * lo active, ni poniendo la variable. Sin el modo, `leerModoPruebas` devuelve null y main.ts se comporta
 * exactamente como siempre (lo comprueba tests/principal-modo-pruebas.test.ts).
 *
 * Qué cambia en el modo: datos en la carpeta de pruebas, sin bloqueo por inactividad, sin «un solo ejemplar»,
 * ventana visible (hay pantalla virtual) y herramientas de desarrollo permitidas. Nada más.
 */
export interface ModoPruebas { rutaDatos: string }

export function leerModoPruebas(env: Record<string, string | undefined>, empaquetada: boolean): ModoPruebas | null {
  if (empaquetada) return null;
  if (env.SPD_CAPTURAS !== '1') return null;
  const ruta = env.SPD_DATOS_PRUEBAS;
  if (!ruta || ruta.trim() === '') return null;
  return { rutaDatos: ruta };
}
