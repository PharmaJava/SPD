/**
 * Ensambla el `ApiSpd` único a partir de las piezas: sistema (S1), clínica base (S2a), clínica de
 * preparación (S2b) y externo (Electron). Pura: no importa los servicios, los recibe (así se prueba con dobles).
 *
 * Reglas:
 *  - Cada método se toma del grupo que dicta `metodos.ts` (sistema → sistema, externa → externo,
 *    clínica → base o preparación).
 *  - Un método de clínica definido en las DOS piezas es un error de programación: se lanza al arrancar.
 *  - Un método que no define nadie NO inventa respuesta: devuelve un fallo `NO_IMPLEMENTADO` y se lista en `faltan`.
 *  - Un método que una pieza define pero no le corresponde (p. ej. `estado` en la clínica) se ignora.
 */
import type { ApiSpd, NombreMetodo, Resultado } from '../servicios/api.ts';
import { fallo } from '../servicios/contexto.ts';
import { GRUPO_DE_METODO, METODOS } from '../servicios/metodos.ts';

type Pieza = Partial<Record<NombreMetodo, (...args: any[]) => Promise<Resultado<any>>>>;

export interface Piezas { sistema?: Pieza | null; clinicaBase?: Pieza | null; clinicaPreparacion?: Pieza | null; externo?: Pieza | null }

const tiene = (p: Pieza | null | undefined, m: NombreMetodo): boolean => !!p && Object.hasOwn(p, m) && typeof p[m] === 'function';

export function ensamblarApi(piezas: Piezas): { api: ApiSpd; faltan: NombreMetodo[] } {
  const api: Record<string, unknown> = {};
  const faltan: NombreMetodo[] = [];
  for (const m of METODOS) {
    const grupo = GRUPO_DE_METODO[m];
    let origen: Pieza | null | undefined;
    if (grupo === 'sistema') origen = tiene(piezas.sistema, m) ? piezas.sistema : null;
    else if (grupo === 'externa') origen = tiene(piezas.externo, m) ? piezas.externo : null;
    else {
      const b = tiene(piezas.clinicaBase, m), p = tiene(piezas.clinicaPreparacion, m);
      if (b && p) throw new Error(`El método «${m}» está definido en clinica-base Y en clinica-preparacion.`);
      origen = b ? piezas.clinicaBase : p ? piezas.clinicaPreparacion : null;
    }
    if (origen) {
      const f = origen[m]!;
      api[m] = (...args: unknown[]) => f.apply(origen, args);
    } else {
      faltan.push(m);
      api[m] = async () => fallo(`«${m}» todavía no está disponible en esta versión.`, 'NO_IMPLEMENTADO');
    }
  }
  return { api: api as unknown as ApiSpd, faltan };
}
