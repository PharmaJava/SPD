/**
 * Cliente de CIMA (AEMPS). SÓLO se usa desde el proceso principal.
 *
 * ⚠️ NO SE HA PODIDO PROBAR CONTRA LA API REAL (el proxy del entorno de desarrollo
 * bloquea cima.aemps.es). Lo que sigue son SUPOSICIONES sobre la API v1 que hay que
 * contrastar con el PDF oficial «CIMA REST API» y con respuestas reales antes de
 * fiarse de ellas (docs/05-aemps-cima.md). Por eso TODO lo recibido se valida y
 * cualquier respuesta rara se trata como `disponible:false` con aviso, nunca como dato.
 *
 * Rutas supuestas (base https://cima.aemps.es/cima/rest/):
 *  - GET medicamento?cn=NNNNNN  → objeto con, al menos, `nregistro` y `nombre`. Campos que se leen:
 *      nregistro, nombre, labtitular, labcomercializador, pactivos (texto) o principiosActivos[{nombre,cantidad,unidad}],
 *      formaFarmaceutica{nombre}, receta (bool), comerc (bool), psum (bool, problema de suministro),
 *      triangulo (bool), conduc (bool), cpresc (texto de condiciones de prescripción),
 *      presentaciones[{cn,nombre,comerc}], docs[{tipo (1 = ficha técnica, 2 = prospecto), url}].
 *    Un CN desconocido puede dar 404 o 204 sin cuerpo: ambos = «CIMA no lo conoce».
 *  - GET docSegmentado/contenido/1?nregistro=…&seccion=3 → sección 3 de la ficha técnica
 *    («Forma farmacéutica»), como HTML o como JSON ({contenido} o [{contenido}]). Se aceptan las dos formas.
 *
 * Reglas (CLAUDE.md):
 *  - A CIMA sólo viaja el CN (nunca un dato de paciente).
 *  - El dígito de control del CN NO se valida (sólo se descarta si hay 7 cifras).
 *  - Un 200 sin datos NO es un éxito. El campo `cn` de una lista de la AEMPS puede ser el nº de registro:
 *    aquí el CN sólo se compara contra `presentaciones[].cn`, y si la ficha trae presentaciones y ninguna
 *    es la pedida, se descarta (sería otro medicamento).
 *  - Lo que viene de CIMA es una PROPUESTA: la descripción física y la aptitud para SPD las confirma un
 *    farmacéutico. `ranurado` y `spdAptitud` quedan en null; la propuesta va aparte en `descripcion`/`aptitud`.
 *  - Longitudes acotadas y caracteres de control eliminados; los enlaces sólo se aceptan si son https de aemps.es.
 *  - Tiempo límite de 8 s por petición (incluida la lectura del cuerpo); un único reintento sólo ante error de
 *    red o 5xx (no tras un tiempo agotado, para no dejar 16 s esperando al usuario).
 */
import type { MedicamentoDto, RespuestaCima, Resultado } from './api.ts';
import { analizarDescripcion, resumenDescripcion } from '../dominio/descripcion-fisica.ts';
import type { PropuestaDescripcion } from '../dominio/descripcion-fisica.ts';
import { clasificarMedicamento } from '../dominio/aptitud-spd.ts';
import { ok, fallo } from './contexto.ts';

export const BASE_CIMA = 'https://cima.aemps.es/cima/rest/';
export const TIEMPO_LIMITE_CIMA_MS = 8000;
const MAX_CUERPO = 2_000_000;
const MAX_SECCION = 6000;

/** Lo mínimo de `fetch` que se usa (compatible con el global y fácil de simular). */
export interface RespuestaHttp {
  ok: boolean;
  status: number;
  headers: { get(nombre: string): string | null };
  text(): Promise<string>;
}
export type FetchLike = (url: string, init: { signal?: AbortSignal; headers?: Record<string, string>; redirect?: 'error' | 'follow' | 'manual' }) => Promise<RespuestaHttp>;

export interface OpcionesCima {
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Espera entre el intento y el reintento (inyectable para no esperar en pruebas). */
  esperar?: (ms: number) => Promise<void>;
}

// ───────────────────────── Saneado ─────────────────────────

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** Texto acotado y sin caracteres de control; null si no es texto o queda vacío. */
export function textoSeguro(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

/** Enlace permitido: https y dominio de la AEMPS. Cualquier otra cosa → null. */
export function urlAemps(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 600) return null;
  let u: URL;
  try { u = new URL(v.trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const h = u.hostname.toLowerCase();
  if (h !== 'aemps.es' && !h.endsWith('.aemps.es') && h !== 'aemps.gob.es' && !h.endsWith('.aemps.gob.es')) return null;
  return u.toString();
}

/** CN a consultar: 6 cifras (si llegan 7 se descarta la última, sin validarla). */
export function normalizarCnCima(cn: unknown): string | null {
  if (typeof cn !== 'string') return null;
  const t = cn.trim();
  if (/^\d{6}$/.test(t)) return t;
  if (/^\d{7}$/.test(t)) return t.slice(0, 6);
  return null;
}

const ENTIDADES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', uuml: 'ü', ordm: 'º', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”' };

/** HTML de la ficha técnica → texto plano (sin ejecutar nada: sólo se quitan etiquetas). */
export function htmlATexto(html: string): string {
  const corto = html.length > 300_000 ? html.slice(0, 300_000) : html;
  const sinBloques = corto.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const sinEtiquetas = sinBloques.replace(/<\/(p|div|li|tr|h\d)\s*>|<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' ');
  const decod = sinEtiquetas.replace(/&(#x?[0-9a-f]{1,6}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 31 && n < 0x10ffff ? String.fromCodePoint(n) : ' ';
    }
    return ENTIDADES[e] ?? ENTIDADES[e.toLowerCase()] ?? m;
  });
  return decod.replace(CONTROL, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

// ───────────────────────── Red ─────────────────────────

class ErrorRed extends Error {
  tipo: 'tiempo' | 'red' | 'http' | 'grande';
  status?: number;
  constructor(tipo: ErrorRed['tipo'], mensaje: string, status?: number) { super(mensaje); this.tipo = tipo; this.status = status; }
}

async function pedirUnaVez(fetchFn: FetchLike, url: string, timeoutMs: number): Promise<{ status: number; cuerpo: string }> {
  const ac = new AbortController();
  let vencido = false;
  const t = setTimeout(() => { vencido = true; ac.abort(); }, timeoutMs);
  // El tiempo límite corta tanto la petición como la lectura del cuerpo, aunque `fetch` ignore la señal.
  const cortar = new Promise<never>((_, rej) => { ac.signal.addEventListener('abort', () => rej(new ErrorRed('tiempo', 'tiempo agotado'))); });
  cortar.catch(() => {});
  try {
    const r = await Promise.race([fetchFn(url, { signal: ac.signal, headers: { Accept: 'application/json, text/html;q=0.8' }, redirect: 'error' }), cortar]);
    if (!r || typeof r.status !== 'number' || typeof r.text !== 'function') throw new ErrorRed('red', 'respuesta no válida');
    if (r.status >= 500) throw new ErrorRed('http', `CIMA respondió ${r.status}`, r.status);
    const cuerpo = await Promise.race([r.text(), cortar]);
    if (typeof cuerpo !== 'string') throw new ErrorRed('red', 'cuerpo no válido');
    if (cuerpo.length > MAX_CUERPO) throw new ErrorRed('grande', 'respuesta demasiado grande');
    return { status: r.status, cuerpo };
  } catch (e) {
    if (e instanceof ErrorRed) throw e;
    if (vencido || (e instanceof Error && e.name === 'AbortError')) throw new ErrorRed('tiempo', 'tiempo agotado');
    throw new ErrorRed('red', e instanceof Error ? e.message : String(e));
  } finally { clearTimeout(t); }
}

async function pedir(url: string, o: Required<Pick<OpcionesCima, 'fetch' | 'timeoutMs' | 'esperar'>>): Promise<{ status: number; cuerpo: string }> {
  try { return await pedirUnaVez(o.fetch, url, o.timeoutMs); }
  catch (e) {
    // Un único reintento, sólo ante error de red o 5xx (nunca tras un tiempo agotado).
    if (e instanceof ErrorRed && (e.tipo === 'red' || e.tipo === 'http')) {
      await o.esperar(300);
      return await pedirUnaVez(o.fetch, url, o.timeoutMs);
    }
    throw e;
  }
}

// ───────────────────────── Lectura de la ficha ─────────────────────────

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function nombreDe(v: unknown): string | null {
  if (typeof v === 'string') return textoSeguro(v, 200);
  if (esObjeto(v)) return textoSeguro(v.nombre, 200);
  return null;
}

function principiosActivos(m: Record<string, unknown>): string | null {
  if (Array.isArray(m.principiosActivos)) {
    const partes = m.principiosActivos.slice(0, 20).map(p => {
      if (!esObjeto(p)) return null;
      const n = textoSeguro(p.nombre, 120);
      if (!n) return null;
      const c = textoSeguro(typeof p.cantidad === 'number' ? String(p.cantidad) : p.cantidad, 30);
      const u = textoSeguro(p.unidad, 20);
      return [n, c, u].filter(Boolean).join(' ');
    }).filter((x): x is string => !!x);
    if (partes.length) return textoSeguro(partes.join(' + '), 500);
  }
  return textoSeguro(m.pactivos, 500);
}

/** Unidades del envase si el nombre de la presentación lo dice sin ambigüedad («…, 30 comprimidos»). */
export function unidadesDePresentacion(nombre: string | null): number | null {
  if (!nombre) return null;
  const cola = nombre.split(',').pop()!.trim();
  const m = /^(\d{1,4})\s+\p{L}[\p{L} ]*$/u.exec(cola);
  if (!m) return null;
  if (/\b(blisteres?|blísteres?|envases?|viales?|x)\b/i.test(cola)) return null;
  const n = parseInt(m[1], 10);
  return n > 0 ? n : null;
}

interface FichaLeida { medicamento: MedicamentoDto; nregistro: string | null; avisos: string[]; forma: string | null; pa: string | null }

function leerFicha(cn: string, bruto: unknown): { ficha: FichaLeida } | { error: string } {
  if (!esObjeto(bruto)) return { error: 'CIMA devolvió una respuesta que no es una ficha de medicamento.' };
  const nombre = textoSeguro(bruto.nombre, 300);
  if (!nombre) return { error: 'CIMA devolvió una ficha sin nombre de medicamento: no se usa.' };

  const avisos: string[] = [];
  let presentacionNombre: string | null = null;
  if (Array.isArray(bruto.presentaciones)) {
    const pres = bruto.presentaciones.filter(esObjeto);
    const propia = pres.find(p => typeof p.cn === 'string' && p.cn.trim().slice(0, 6) === cn);
    if (pres.length > 0 && !propia) return { error: 'La ficha que devuelve CIMA no incluye ese código nacional: no se usa (podría ser otro medicamento).' };
    if (propia) {
      presentacionNombre = textoSeguro(propia.nombre, 300);
      if (propia.comerc === false) avisos.push('Esta presentación figura como NO comercializada en CIMA.');
    }
  } else {
    avisos.push('No se pudo comprobar que la presentación coincide con el CN pedido: revisar.');
  }

  let nregistro: string | null = null;
  if (typeof bruto.nregistro === 'string' && /^[0-9A-Za-z]{3,12}$/.test(bruto.nregistro.trim())) nregistro = bruto.nregistro.trim();
  else if (typeof bruto.nregistro === 'number' && Number.isInteger(bruto.nregistro) && bruto.nregistro > 0) nregistro = String(bruto.nregistro);

  const forma = nombreDe(bruto.formaFarmaceutica);
  const pa = principiosActivos(bruto);
  const cpresc = textoSeguro(bruto.cpresc, 400);
  const norm = (cpresc ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const estupefaciente = norm.includes('estupefaciente');
  const psicotropo = norm.includes('psicotropo');
  if (cpresc === null) avisos.push('CIMA no indica las condiciones de prescripción: comprobar a mano si es estupefaciente o psicótropo.');

  if (bruto.comerc === false && !avisos.some(a => a.includes('NO comercializada'))) avisos.push('Medicamento NO comercializado según CIMA.');
  if (bruto.psum === true) avisos.push('CIMA indica un problema de suministro.');
  if (bruto.triangulo === true) avisos.push('Medicamento con triángulo negro (seguimiento adicional).');
  if (bruto.conduc === true) avisos.push('Puede afectar a la capacidad de conducir.');

  let urlFicha: string | null = null, urlProspecto: string | null = null;
  if (Array.isArray(bruto.docs)) {
    for (const d of bruto.docs.slice(0, 20)) {
      if (!esObjeto(d)) continue;
      const u = urlAemps(d.urlHtml) ?? urlAemps(d.url);
      if (d.tipo === 1 && !urlFicha) urlFicha = u;
      if (d.tipo === 2 && !urlProspecto) urlProspecto = u;
    }
  }

  const med: MedicamentoDto = {
    cn,
    nombre,
    nregistro,
    principiosActivos: pa,
    laboratorio: textoSeguro(bruto.labtitular, 200) ?? textoSeguro(bruto.labcomercializador, 200),
    formaFarmaceutica: forma,
    unidadesEnvase: unidadesDePresentacion(presentacionNombre),
    receta: typeof bruto.receta === 'boolean' ? bruto.receta : null,
    estupefaciente, psicotropo,
    descripcionFisica: null, color: null, forma: null, marcasGrabado: null,
    ranurado: null,               // «divisible en dosis iguales»: sólo lo marca el farmacéutico
    descripcionEstado: 'sin_datos',
    spdAptitud: null, spdMotivo: null,   // la propuesta va aparte; no se aplica sola
    urlFichaTecnica: urlFicha, urlProspecto,
    creadoManual: false,
  };
  return { ficha: { medicamento: med, nregistro, avisos, forma, pa } };
}

/** Texto de la sección 3 a partir de la respuesta (HTML o JSON). null si no hay texto utilizable. */
export function textoSeccion3(cuerpo: string): string | null {
  const t = cuerpo.trim();
  if (!t) return null;
  let html = t;
  if (t[0] === '[' || t[0] === '{') {
    try {
      const j: unknown = JSON.parse(t);
      const partes = (Array.isArray(j) ? j : [j]).slice(0, 10).map(x => esObjeto(x) && typeof x.contenido === 'string' ? x.contenido : '');
      html = partes.join('\n');
    } catch { return null; }
  }
  const plano = htmlATexto(html);
  if (plano.length < 15) return null;
  return plano.length > MAX_SECCION ? plano.slice(0, MAX_SECCION) : plano;
}

// ───────────────────────── Consulta ─────────────────────────

export async function consultarCima(cn: string, opciones: OpcionesCima = {}): Promise<Resultado<RespuestaCima>> {
  const cnOk = normalizarCnCima(cn);
  if (!cnOk) return fallo('El código nacional debe tener 6 cifras (o 7 con el dígito de control).', 'CN_NO_VALIDO');

  const f: FetchLike | undefined = opciones.fetch ?? (typeof globalThis.fetch === 'function' ? (globalThis.fetch as unknown as FetchLike) : undefined);
  if (!f) return ok({ disponible: false, aviso: 'Este equipo no puede consultar CIMA.' });
  const o = {
    fetch: f,
    timeoutMs: Math.max(1, opciones.timeoutMs ?? TIEMPO_LIMITE_CIMA_MS),
    esperar: opciones.esperar ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms))),
  };

  let respuesta: { status: number; cuerpo: string };
  try {
    respuesta = await pedir(`${BASE_CIMA}medicamento?cn=${cnOk}`, o);
  } catch (e) {
    const t = e instanceof ErrorRed ? e.tipo : 'red';
    const aviso = t === 'tiempo' ? 'CIMA no respondió a tiempo. Se puede dar de alta el medicamento a mano.'
      : t === 'grande' ? 'CIMA devolvió una respuesta anómala (demasiado grande): no se usa.'
      : 'No hay conexión con CIMA ahora mismo. Se puede dar de alta el medicamento a mano.';
    return ok({ disponible: false, aviso });
  }

  if (respuesta.status === 404 || respuesta.status === 204 || (respuesta.status === 200 && !respuesta.cuerpo.trim())) {
    return ok({ disponible: false, aviso: 'CIMA no tiene ningún medicamento con ese código nacional (o no devolvió datos).' });
  }
  if (respuesta.status !== 200) {
    return ok({ disponible: false, aviso: `CIMA respondió con el estado ${respuesta.status}: no se usa.` });
  }

  let bruto: unknown;
  try { bruto = JSON.parse(respuesta.cuerpo); }
  catch { return ok({ disponible: false, aviso: 'CIMA devolvió algo que no es JSON (¿una página de error?): no se usa.' }); }

  const leida = leerFicha(cnOk, bruto);
  if ('error' in leida) return ok({ disponible: false, aviso: leida.error });
  const { medicamento, nregistro, avisos, forma, pa } = leida.ficha;

  // Sección 3 de la ficha técnica → propuesta de descripción física (opcional).
  let descripcion: PropuestaDescripcion | undefined;
  if (nregistro) {
    try {
      const r3 = await pedir(`${BASE_CIMA}docSegmentado/contenido/1?nregistro=${encodeURIComponent(nregistro)}&seccion=3`, o);
      const texto = r3.status === 200 ? textoSeccion3(r3.cuerpo) : null;
      if (texto) {
        descripcion = analizarDescripcion(texto);
        const resumen = resumenDescripcion(descripcion);
        const hayDatos = !!resumen || descripcion.colores.length > 0 || descripcion.forma !== null || descripcion.marcas.length > 0;
        if (hayDatos) {
          medicamento.descripcionFisica = resumen || null;
          medicamento.color = descripcion.colores.length ? textoSeguro(descripcion.colores.join(' y '), 80) : null;
          medicamento.forma = textoSeguro(descripcion.forma, 120);
          medicamento.marcasGrabado = descripcion.marcas.length ? textoSeguro(descripcion.marcas.join('; '), 120) : null;
          medicamento.descripcionEstado = 'propuesta';
        }
      } else {
        avisos.push('No se pudo leer la sección 3 de la ficha técnica: la descripción física hay que escribirla a mano.');
      }
    } catch {
      avisos.push('No se pudo descargar la sección 3 de la ficha técnica: la descripción física hay que escribirla a mano.');
    }
  } else {
    avisos.push('CIMA no dio número de registro: no se pudo pedir la ficha técnica.');
  }

  const aptitud = clasificarMedicamento({ nombre: medicamento.nombre, formaFarmaceutica: forma ?? undefined, principioActivo: pa ?? undefined });
  const res: RespuestaCima = { disponible: true, medicamento, descripcion, aptitud: aptitud ?? null };
  if (avisos.length) res.aviso = avisos.join(' · ');
  return ok(res);
}
