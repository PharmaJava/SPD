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
    return '[' + valor.map((x, i) => serializarCanonico(x, `${ruta}[${i}]`)).join(',') + ']';
  }
  if (esObjetoPlano(valor)) {
    const claves = Object.keys(valor).sort();
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
      for (const k of Object.keys(v)) out[k] = ocultos.has(k) ? MASCARA : rec(v[k]);
      return out;
    }
    return v;
  };
  return rec(valor);
}

export function crearEntrada(datos: DatosEntrada, hashPrevio: string): EntradaAuditoria {
  if (!RE_MOMENTO.test(datos.momento)) {
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

function aplanar(v: unknown, ruta: string, salida: Map<string, unknown>): void {
  if (Array.isArray(v) && v.length > 0) {
    v.forEach((x, i) => aplanar(x, ruta ? `${ruta}.${i}` : String(i), salida));
  } else if (esObjetoPlano(v) && Object.keys(v).length > 0) {
    for (const k of Object.keys(v)) aplanar(v[k], ruta ? `${ruta}.${k}` : k, salida);
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
