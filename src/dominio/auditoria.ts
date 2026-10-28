/**
 * Registro de auditoría inmutable con cadena de hash SHA-256.
 *
 * Cada entrada incluye el hash de la anterior: modificar, borrar, reordenar
 * o insertar una entrada rompe la cadena y `verificarCadena` lo detecta.
 *
 * Lo único no puro es `node:crypto` (createHash), que es determinista.
 * Sin disco, red ni interfaz: el momento entra por parámetro.
 *
 * Los secretos (p. ej. hash_clave) NO se guardan: se enmascaran como '***'
 * ANTES de calcular el hash, de modo que la auditoría nunca los contiene.
 */
import { createHash } from 'node:crypto';

/** Hash previo de la primera entrada de la cadena. */
export const HASH_GENESIS = '0'.repeat(64);

export const MASCARA = '***';

export interface EntradaAuditoria {
  momento: string;              // ISO UTC con milisegundos
  usuarioId: number | null;
  accion: string;
  entidad: string;
  entidadId: string | null;
  antes: unknown;
  despues: unknown;
  motivo: string | null;
  hashPrevio: string;
  hash: string;
}

export type EntradaSinHash = Omit<EntradaAuditoria, 'hash'>;

export interface DatosEntrada {
  momento: string;
  usuarioId: number | null;
  accion: string;
  entidad: string;
  entidadId: string | null;
  antes: unknown;
  despues: unknown;
  motivo: string | null;
  /** Claves que se enmascaran (a cualquier profundidad) antes de hashear. */
  camposOcultos?: string[];
}

export type MotivoError = 'hash_incorrecto' | 'cadena_rota' | 'orden_temporal' | 'genesis';

export interface ResultadoCadena {
  ok: boolean;
  primerError?: { indice: number; motivo: MotivoError };
}

export interface Diferencia {
  campo: string;
  antes: unknown;       // undefined si el campo no existía antes
  despues: unknown;     // undefined si el campo ya no existe
}

const RE_MOMENTO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Formato ISO con milisegundos Y fecha real (rechaza «2026-13-01» y «2026-02-31»). */
function momentoValido(m: string): boolean {
  if (typeof m !== 'string' || !RE_MOMENTO.test(m)) return false;
  const t = new Date(m).getTime();
  return Number.isFinite(t) && new Date(t).toISOString() === m;
}

function esObjetoPlano(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

/**
 * JSON determinista: claves ordenadas recursivamente (por punto de código),
 * sin espacios. Distingue null de ausente (la clave ausente no aparece).
 * Rechaza lo que no tiene representación inequívoca.
 */
export function serializarCanonico(valor: unknown, ruta = '$'): string {
  if (valor === null) return 'null';
  switch (typeof valor) {
    case 'string': return JSON.stringify(valor);
    case 'boolean': return valor ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(valor)) throw new Error(`Número no finito (${valor}) en ${ruta}: no se puede serializar`);
      return JSON.stringify(Object.is(valor, -0) ? 0 : valor);
    case 'undefined': throw new Error(`Valor undefined en ${ruta}: usa null o quita el campo`);
    case 'bigint': throw new Error(`BigInt en ${ruta}: conviértelo a cadena o número`);
    case 'function': throw new Error(`Función en ${ruta}: no se puede serializar`);
    case 'symbol': throw new Error(`Symbol en ${ruta}: no se puede serializar`);
  }
  if (Array.isArray(valor)) {
    // Array.from (no .map): los huecos de un array disperso se leen como undefined y lanzan,
    // en vez de producir «[1,,3]», que no es JSON válido.
    return '[' + Array.from(valor, (x, i) => serializarCanonico(x, `${ruta}[${i}]`)).join(',') + ']';
  }
  if (esObjetoPlano(valor)) {
    // Una clave con valor undefined se OMITE (igual que JSON.stringify): los resultados del
    // dominio la producen (p.ej. caducidadSpd en un rechazo) y justo lo rechazado hay que auditarlo.
    // En un array sí lanza: ahí un hueco cambiaría las posiciones.
    const claves = Object.keys(valor).filter(k => valor[k] !== undefined).sort();
    return '{' + claves.map(k => JSON.stringify(k) + ':' + serializarCanonico(valor[k], `${ruta}.${k}`)).join(',') + '}';
  }
  throw new Error(`Objeto no plano en ${ruta} (Date, Map, clase…): conviértelo antes`);
}

/** Cadena exacta que se hashea: el array COMPLETO de campos, sin separadores propios. */
function material(e: EntradaSinHash): string {
  return serializarCanonico([
    e.momento, e.usuarioId, e.accion, e.entidad, e.entidadId,
    e.antes, e.despues, e.motivo, e.hashPrevio,
  ]);
}

export function sha256Hex(texto: string): string {
  return createHash('sha256').update(texto, 'utf8').digest('hex');
}

export function calcularHash(entrada: EntradaSinHash): string {
  return sha256Hex(material(entrada));
}

/** Sustituye por '***' el valor de las claves indicadas, a cualquier profundidad. No muta. */
export function enmascarar(valor: unknown, camposOcultos: readonly string[] = []): unknown {
  if (camposOcultos.length === 0) return valor;
  const ocultos = new Set(camposOcultos);
  const rec = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(rec);
    if (esObjetoPlano(v)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v)) {
        // defineProperty: `out['__proto__'] = x` (clave propia que viene de JSON.parse) cambiaría
        // el prototipo y haría desaparecer la clave en lugar de copiarla.
        Object.defineProperty(out, k, { value: ocultos.has(k) ? MASCARA : rec(v[k]), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    return v;
  };
  return rec(valor);
}

export function crearEntrada(datos: DatosEntrada, hashPrevio: string): EntradaAuditoria {
  if (!momentoValido(datos.momento)) {
    throw new Error(`Momento inválido «${datos.momento}»: se espera ISO UTC con milisegundos (AAAA-MM-DDThh:mm:ss.mmmZ)`);
  }
  if (!/^[0-9a-f]{64}$/.test(hashPrevio)) throw new Error('hashPrevio debe ser un SHA-256 en hexadecimal minúscula (64 caracteres)');
  const sinHash: EntradaSinHash = {
    momento: datos.momento,
    usuarioId: datos.usuarioId,
    accion: datos.accion,
    entidad: datos.entidad,
    entidadId: datos.entidadId,
    antes: enmascarar(datos.antes, datos.camposOcultos),
    despues: enmascarar(datos.despues, datos.camposOcultos),
    motivo: datos.motivo,
    hashPrevio,
  };
  return { ...sinHash, hash: calcularHash(sinHash) };
}

export function verificarCadena(entradas: EntradaAuditoria[]): ResultadoCadena {
  for (let i = 0; i < entradas.length; i++) {
    const e = entradas[i];
    if (e === null || typeof e !== 'object' || typeof e.hash !== 'string') {
      return { ok: false, primerError: { indice: i, motivo: 'hash_incorrecto' } };
    }
    if (i === 0) {
      if (e.hashPrevio !== HASH_GENESIS) return { ok: false, primerError: { indice: i, motivo: 'genesis' } };
    } else if (e.hashPrevio !== entradas[i - 1].hash) {
      return { ok: false, primerError: { indice: i, motivo: 'cadena_rota' } };
    }
    let recalculado: string;
    try {
      const { hash: _hash, ...resto } = e;
      recalculado = calcularHash(resto);
    } catch {
      return { ok: false, primerError: { indice: i, motivo: 'hash_incorrecto' } };
    }
    if (recalculado !== e.hash) return { ok: false, primerError: { indice: i, motivo: 'hash_incorrecto' } };
    if (i > 0 && e.momento < entradas[i - 1].momento) {
      return { ok: false, primerError: { indice: i, motivo: 'orden_temporal' } };
    }
  }
  return { ok: true };
}

function escaparClave(k: string): string {
  return k.replace(/[\\.]/g, m => '\\' + m);
}

function aplanar(v: unknown, ruta: string, salida: Map<string, unknown>): void {
  if (Array.isArray(v) && v.length > 0) {
    v.forEach((x, i) => aplanar(x, ruta ? `${ruta}.${i}` : String(i), salida));
  } else if (esObjetoPlano(v) && Object.keys(v).length > 0) {
    // Se escapan «\» y «.» de la clave: sin ello {a:{b:1}} y {'a.b':1} comparten ruta y un cambio se pierde.
    for (const k of Object.keys(v)) aplanar(v[k], ruta ? `${ruta}.${escaparClave(k)}` : escaparClave(k), salida);
  } else if (ruta === '' && (Array.isArray(v) || esObjetoPlano(v))) {
    // raíz vacía: no hay campos
  } else {
    salida.set(ruta, v);   // hoja (también [] y {} vacíos anidados)
  }
}

/**
 * Diff plano por ruta («a.b.0.c») entre dos valores. Enmascara antes de comparar,
 * así un secreto cambiado sale como '***' → '***' y no se detecta (ni se filtra).
 * Un lado `null`/`undefined` equivale a «no existía».
 */
export function diferencias(antes: unknown, despues: unknown, camposOcultos: readonly string[] = []): Diferencia[] {
  const a = new Map<string, unknown>();
  const d = new Map<string, unknown>();
  if (antes != null) aplanar(enmascarar(antes, camposOcultos), '', a);
  if (despues != null) aplanar(enmascarar(despues, camposOcultos), '', d);
  const rutas = [...new Set([...a.keys(), ...d.keys()])].sort();
  const res: Diferencia[] = [];
  for (const campo of rutas) {
    const x = a.get(campo);
    const y = d.get(campo);
    const hayX = a.has(campo), hayY = d.has(campo);
    if (hayX && hayY && serializarCanonico(x) === serializarCanonico(y)) continue;
    res.push({ campo, antes: hayX ? x : undefined, despues: hayY ? y : undefined });
  }
  return res;
}
