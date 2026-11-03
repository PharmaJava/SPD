/**
 * Cruce de las ALERGIAS registradas de un paciente con los principios activos de su tratamiento.
 *
 * REGLA (CLAUDE.md, 2): nada clínico se inventa. Este cruce es SÓLO por nombre normalizado
 * (sin tildes, mayúsculas, dosis ni signos; plural/singular): «penicilina» casa con «Penicilina V»,
 * «enalapril» con «Enalapril maleato 10 mg». NO conoce familias, reacciones cruzadas ni marcas
 * («penicilinas» NO casa con «amoxicilina»; «aspirina» NO casa con «ácido acetilsalicílico»):
 * eso lo decide un farmacéutico. Por eso el aviso lo dice, y que no haya coincidencia NO significa
 * que no haya riesgo.
 *
 * FUNCIÓN PURA: sin disco, red ni reloj.
 */
import { normalizar } from './aptitud-spd.ts';

export interface TratamientoParaAlergia { tratamientoId: number; nombre: string; principioActivo: string }
export interface CoincidenciaAlergia { tratamientoId: number; nombre: string; alergia: string }

/** Palabras que no identifican un fármaco por sí solas (dosis, sales, relleno de la frase «alergia a la…»). */
const RELLENO = new Set([
  'alergia', 'alergias', 'alergico', 'alergica', 'alergicos', 'alergicas', 'intolerancia', 'hipersensibilidad', 'reaccion', 'reacciones',
  'a', 'al', 'ante', 'de', 'del', 'la', 'las', 'el', 'los', 'por', 'con', 'y', 'o', 'e', 'en', 'tras', 'medicamento', 'medicamentos', 'farmaco', 'farmacos',
]);
const GENERICAS = new Set([
  'acido', 'sodio', 'sodico', 'potasio', 'potasico', 'calcio', 'magnesio', 'clorhidrato', 'hidrocloruro', 'maleato', 'sulfato', 'besilato',
  'fosfato', 'tartrato', 'succinato', 'mesilato', 'bromhidrato', 'nitrato', 'citrato', 'acetato', 'fumarato', 'comprimidos', 'comprimido',
  'capsulas', 'capsula', 'mg', 'g', 'mcg', 'ug', 'ml', 'ui', 'comp',
]);

/** Quita una «s» final de plural (>4 letras): «penicilinas» → «penicilina». */
const singular = (t: string): string => (t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t);

function tokens(texto: unknown): string[] {
  return normalizar(texto).replace(/[^a-z0-9ñ]+/g, ' ').split(' ').filter((t) => t !== '').map(singular);
}

const esNumerico = (t: string) => /^\d/.test(t);

/** Palabras que identifican el principio activo: sin dosis, números ni sales genéricas. */
function clavesPrincipio(principioActivo: string): string[] {
  return tokens(principioActivo).filter((t) => !esNumerico(t) && !GENERICAS.has(t) && t.length >= 4);
}

/** Palabras de la alergia que identifican algo: sin relleno ni genéricas. */
function clavesAlergia(alergia: string): string[] {
  return tokens(alergia).filter((t) => !RELLENO.has(t) && !GENERICAS.has(t) && !esNumerico(t) && t.length >= 4);
}

/**
 * Coincidencias alergia ↔ tratamiento: una palabra identificativa de la alergia es TAMBIÉN una palabra identificativa del
 * principio activo (palabra entera, nunca por trozos). Una coincidencia por tratamiento y alergia.
 */
export function cruzarAlergias(alergias: readonly string[], tratamientos: readonly TratamientoParaAlergia[]): CoincidenciaAlergia[] {
  const out: CoincidenciaAlergia[] = [];
  for (const alergia of alergias) {
    if (typeof alergia !== 'string') continue;
    const ca = clavesAlergia(alergia);
    if (ca.length === 0) continue;
    for (const t of tratamientos) {
      const cp = clavesPrincipio(t.principioActivo);
      if (ca.some((a) => cp.includes(a))) out.push({ tratamientoId: t.tratamientoId, nombre: t.nombre, alergia: alergia.trim() });
    }
  }
  return out;
}

/** Texto del aviso fuerte (siempre con las mismas palabras: «posible alergia»). */
export function textoPosibleAlergia(c: CoincidenciaAlergia): string {
  return `Posible alergia: ${c.nombre} coincide con la alergia registrada «${c.alergia}». Un farmacéutico debe confirmar que se puede preparar. (El programa sólo cruza por nombre del principio activo: no detecta alergias por familia o grupo.)`;
}
