/**
 * Actualizaciones online (proceso principal). Consulta SÓLO las releases públicas de PharmaJava/SPD por HTTPS.
 *
 * Reglas (todas con prueba en tests/principal-actualizaciones.test.ts):
 *  - NUNCA se descarga ni se instala sin que la persona acepte en un diálogo («Instalar ahora»).
 *  - La petición no lleva nada de la farmacia ni de pacientes: un GET con Accept y un nombre de cliente genérico.
 *  - Sólo HTTPS y sólo github.com / *.githubusercontent.com (también en las redirecciones, que se siguen a mano).
 *  - Nunca hacia atrás: sólo se ofrece una versión estrictamente mayor que la instalada.
 *  - El instalador se compara con SHA256SUMS de la MISMA release ANTES de lanzarlo; sin suma → no se instala.
 *  - Antes de lanzarlo: copia de seguridad «antes de actualizar a vX»; si falla, no se instala.
 *  - Un fallo de red es un mensaje claro; nunca bloquea el programa.
 * Todo lo que toca Electron o el disco entra por `DepsActualizador` (se prueba con dobles).
 */
import { createHash } from 'node:crypto';
import type { PreferenciasActualizaciones, ResultadoBusquedaActualizacion, Resultado } from '../servicios/api.ts';
import { fallo, ok } from '../servicios/contexto.ts';
import {
  URL_API_LISTA, URL_API_ULTIMA, coincideSuma, decidirActualizacion, esUrlDescargaPermitida, esUrlRedireccionPermitida,
  interpretarRelease, listarVersionesPublicadas, normalizarPreferencias, parsearSumas, sumaDe, PREFERENCIAS_POR_DEFECTO,
} from '../dominio/actualizaciones.ts';
import type { PreferenciasActualizacion, ReleasePublicada } from '../dominio/actualizaciones.ts';

export const TIEMPO_PETICION_MS = 10_000;
export const TIEMPO_DESCARGA_MS = 15 * 60_000;
export const MAX_JSON = 2_000_000;
export const MAX_SUMAS = 100_000;
export const MAX_INSTALADOR = 600_000_000;
export const MAX_SALTOS = 5;
const CLIENTE = 'SPD-actualizador';

export interface RespuestaHttp {
  status: number;
  headers: { get(n: string): string | null };
  text(): Promise<string>;
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null;
}
export type FetchHttp = (url: string, init: { redirect: 'manual'; headers: Record<string, string>; signal?: AbortSignal }) => Promise<RespuestaHttp>;

export type Decision = 'instalar' | 'luego' | 'ignorar';

export interface DepsActualizador {
  fetch: FetchHttp;
  plataforma: string;
  versionActual: string;
  /** Preferencias (fichero JSON fuera de la base: se necesitan antes de desbloquear). */
  prefs: { leer(): Promise<unknown>; guardar(p: PreferenciasActualizacion): Promise<void> };
  /** Diálogos del sistema. */
  preguntar(i: { versionActual: string; versionNueva: string; notas: string }): Promise<Decision>;
  confirmarCierre(versionNueva: string): Promise<boolean>;
  /** Copia obligatoria «antes de actualizar a vX». `ruta` null = no había datos. */
  copiaAntes(versionNueva: string): Promise<Resultado<{ ruta: string | null }>>;
  fs: {
    crearCarpetaTemporal(): Promise<string>;
    unir(...p: string[]): string;
    abrirEscritura(ruta: string): Promise<{ escribir(b: Uint8Array): Promise<void>; cerrar(): Promise<void> }>;
    borrarCarpeta(ruta: string): Promise<void>;
  };
  /** Vacía lo pendiente, lanza el instalador y sale del programa. */
  cerrarYLanzar(rutaInstalador: string): Promise<void>;
  ahora?: () => Date;
  registrar?: (m: string) => void;
}

export interface Actualizador {
  estado(): Promise<Resultado<PreferenciasActualizaciones>>;
  guardarPreferencias(p: { comprobarAlArrancar?: boolean; versionIgnorada?: string | null }): Promise<Resultado<PreferenciasActualizaciones>>;
  buscar(opc?: { manual?: boolean }): Promise<Resultado<ResultadoBusquedaActualizacion>>;
  listarVersiones(): Promise<Resultado<ReturnType<typeof listarVersionesPublicadas>>>;
  /** Al arrancar: sólo si la preferencia está activada. Nunca muestra errores. */
  comprobarAlArrancar(): Promise<void>;
}

class ErrorRed extends Error { codigo: string; constructor(m: string, codigo: string) { super(m); this.codigo = codigo; } }

export function crearActualizador(deps: DepsActualizador): Actualizador {
  const ahora = deps.ahora ?? (() => new Date());
  let ocupado = false;

  async function cargarPrefs(): Promise<PreferenciasActualizacion> {
    try { return normalizarPreferencias(await deps.prefs.leer()); } catch { return { ...PREFERENCIAS_POR_DEFECTO }; }
  }
  async function guardarPrefs(p: PreferenciasActualizacion): Promise<void> { try { await deps.prefs.guardar(p); } catch (e) { deps.registrar?.('preferencias: ' + (e instanceof Error ? e.name : '')); } }
  const dto = (p: PreferenciasActualizacion): PreferenciasActualizaciones => ({ ...p, versionActual: deps.versionActual });

  /** GET con redirecciones a mano: cada salto tiene que seguir siendo https y de GitHub. */
  async function pedir(url: string, permitida: (u: string) => boolean, aceptar: string, tiempoMs: number): Promise<RespuestaHttp> {
    const señal = AbortSignal.timeout(tiempoMs);
    let actual = url;
    for (let salto = 0; salto <= MAX_SALTOS; salto++) {
      if (!permitida(actual)) throw new ErrorRed('Dirección no permitida.', 'URL_NO_PERMITIDA');
      let r: RespuestaHttp;
      try { r = await deps.fetch(actual, { redirect: 'manual', headers: { Accept: aceptar, 'User-Agent': CLIENTE }, signal: señal }); }
      catch { throw new ErrorRed('No se pudo conectar con el servidor de actualizaciones (¿sin conexión a internet?).', 'SIN_RED'); }
      if ([301, 302, 303, 307, 308].includes(r.status)) {
        const loc = r.headers.get('location');
        if (!loc) throw new ErrorRed('Respuesta no válida del servidor de actualizaciones.', 'RESPUESTA');
        let sig: string;
        try { sig = new URL(loc, actual).href; } catch { throw new ErrorRed('Redirección no válida.', 'RESPUESTA'); }
        if (!esUrlRedireccionPermitida(sig)) throw new ErrorRed('El servidor intentó redirigir a una dirección no permitida: se cancela.', 'URL_NO_PERMITIDA');
        actual = sig; continue;
      }
      if (r.status === 403 || r.status === 429) throw new ErrorRed('GitHub limita temporalmente las consultas. Inténtalo de nuevo dentro de un rato.', 'LIMITE');
      if (r.status === 404) throw new ErrorRed('No se encontró el recurso en el servidor de actualizaciones.', 'NO_ENCONTRADO');
      if (r.status < 200 || r.status >= 300) throw new ErrorRed(`El servidor de actualizaciones respondió con un error (${r.status}).`, 'HTTP');
      return r;
    }
    throw new ErrorRed('Demasiadas redirecciones.', 'RESPUESTA');
  }

  async function leerTexto(r: RespuestaHttp, max: number): Promise<string> {
    const b = await leerBytes(r, max);
    return new TextDecoder().decode(b.bytes);
  }
  async function leerBytes(r: RespuestaHttp, max: number, alTrozo?: (t: Uint8Array) => Promise<void>): Promise<{ bytes: Uint8Array }> {
    if (!r.body) { const t = await r.text(); if (t.length > max) throw new ErrorRed('Respuesta demasiado grande.', 'TAMANO'); return { bytes: new TextEncoder().encode(t) }; }
    const lector = r.body.getReader();
    const trozos: Uint8Array[] = []; let total = 0;
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > max) { await lector.cancel().catch(() => {}); throw new ErrorRed('Respuesta demasiado grande.', 'TAMANO'); }
      if (alTrozo) await alTrozo(value); else trozos.push(value);
    }
    return { bytes: alTrozo ? new Uint8Array(0) : Buffer.concat(trozos) };
  }

  const json = async (url: string): Promise<unknown> => {
    const r = await pedir(url, (u) => u === URL_API_ULTIMA || u === URL_API_LISTA || esUrlRedireccionPermitida(u) && u.startsWith('https://api.github.com/repos/'), 'application/vnd.github+json', TIEMPO_PETICION_MS);
    try { return JSON.parse(await leerTexto(r, MAX_JSON)); } catch (e) { if (e instanceof ErrorRed) throw e; throw new ErrorRed('Respuesta no válida del servidor de actualizaciones.', 'RESPUESTA'); }
  };
  const textoSumas = async (url: string): Promise<string> => {
    const r = await pedir(url, (u) => esUrlDescargaPermitida(u) || esUrlRedireccionPermitida(u), 'text/plain', TIEMPO_PETICION_MS);
    return leerTexto(r, MAX_SUMAS);
  };

  const msgError = (e: unknown): { texto: string; codigo: string } =>
    e instanceof ErrorRed ? { texto: e.message, codigo: e.codigo } : { texto: 'No se pudo completar la operación.', codigo: 'ERROR_ACTUALIZACION' };

  /** Descarga el instalador a una carpeta temporal nueva calculando el SHA-256 sobre la marcha. */
  async function descargar(url: string, nombre: string, esperada: string): Promise<string> {
    const carpeta = await deps.fs.crearCarpetaTemporal();
    const ruta = deps.fs.unir(carpeta, nombre);
    const limpiar = () => deps.fs.borrarCarpeta(carpeta).catch(() => {});
    try {
      const r = await pedir(url, (u) => esUrlDescargaPermitida(u) || esUrlRedireccionPermitida(u), 'application/octet-stream', TIEMPO_DESCARGA_MS);
      const hash = createHash('sha256');
      const f = await deps.fs.abrirEscritura(ruta);
      try { await leerBytes(r, MAX_INSTALADOR, async (t) => { hash.update(t); await f.escribir(t); }); }
      finally { await f.cerrar().catch(() => {}); }
      if (!coincideSuma(esperada, hash.digest('hex'))) throw new ErrorRed('La descarga no coincide con la suma SHA-256 publicada: se ha descartado y NO se instala.', 'SUMA');
      return ruta;
    } catch (e) { await limpiar(); throw e; }
  }

  async function buscar(opc: { manual?: boolean } = {}): Promise<Resultado<ResultadoBusquedaActualizacion>> {
    const manual = !!opc.manual;
    if (ocupado) return fallo('Ya hay una comprobación o instalación en curso.', 'OCUPADO');
    if (deps.plataforma !== 'win32') return fallo('Las actualizaciones automáticas sólo están disponibles en Windows.', 'PLATAFORMA');
    ocupado = true;
    try {
      const prefs = await cargarPrefs();
      let release: ReleasePublicada | null;
      try { release = interpretarRelease(await json(URL_API_ULTIMA)); }
      catch (e) { if (e instanceof ErrorRed && e.codigo === 'NO_ENCONTRADO') release = null; else throw e; }
      await guardarPrefs({ ...prefs, ultimaComprobacion: ahora().toISOString() });
      const d = decidirActualizacion({ actual: deps.versionActual, release, versionIgnorada: prefs.versionIgnorada, manual });
      if (d.estado === 'al_dia') return ok({ estado: 'al_dia', versionNueva: null, mensaje: `Tienes la última versión (${deps.versionActual}).` });
      if (d.estado === 'ignorada') return ok({ estado: 'ignorada', versionNueva: d.version, mensaje: `Hay una versión nueva (${d.version}), pero elegiste no volver a avisar de ella.` });
      if (d.estado === 'sin_instalador') return ok({ estado: 'sin_instalador', versionNueva: d.version, mensaje: `La versión ${d.version} está publicada pero aún no tiene instalador verificable (falta el instalador o SHA256SUMS). Inténtalo más tarde.` });

      const decision = await deps.preguntar({ versionActual: deps.versionActual, versionNueva: d.version!, notas: d.release!.notas });
      if (decision === 'ignorar') { await guardarPrefs({ ...(await cargarPrefs()), versionIgnorada: d.version }); return ok({ estado: 'cancelada', versionNueva: d.version, mensaje: `No se volverá a avisar de la versión ${d.version}.` }); }
      if (decision === 'luego') return ok({ estado: 'pospuesta', versionNueva: d.version, mensaje: 'De acuerdo: no se ha instalado nada.' });

      // La persona ha aceptado. 1) sumas  2) descarga y comprobación  3) confirmar el cierre  4) copia  5) lanzar.
      const sumas = parsearSumas(await textoSumas(d.sumas!.url));
      const esperada = sumaDe(sumas, d.instalador!.nombre);
      if (!esperada) return fallo('La release no publica la suma SHA-256 del instalador: por seguridad no se instala.', 'SUMA');
      const ruta = await descargar(d.instalador!.url, d.instalador!.nombre, esperada);
      const carpeta = ruta.slice(0, ruta.length - d.instalador!.nombre.length - 1);
      if (!(await deps.confirmarCierre(d.version!))) {
        await deps.fs.borrarCarpeta(carpeta).catch(() => {});
        return ok({ estado: 'pospuesta', versionNueva: d.version, mensaje: 'Descarga verificada y descartada: no se ha instalado nada.' });
      }
      const copia = await deps.copiaAntes(d.version!);
      if (!copia.ok) {
        await deps.fs.borrarCarpeta(carpeta).catch(() => {});
        return fallo(`No se instala: no se pudo hacer la copia de seguridad previa (${copia.error}).`, 'COPIA_PREVIA');
      }
      await deps.cerrarYLanzar(ruta);
      return ok({ estado: 'instalando', versionNueva: d.version, mensaje: 'Instalando… SPD se cerrará.' });
    } catch (e) {
      const m = msgError(e);
      deps.registrar?.('actualizaciones: ' + m.codigo);
      return fallo(m.texto, m.codigo);
    } finally { ocupado = false; }
  }

  return {
    async estado() { return ok(dto(await cargarPrefs())); },
    async guardarPreferencias(p) {
      const actual = await cargarPrefs();
      const nuevo = normalizarPreferencias({
        ...actual,
        ...(typeof p?.comprobarAlArrancar === 'boolean' ? { comprobarAlArrancar: p.comprobarAlArrancar } : {}),
        ...(p && 'versionIgnorada' in p ? { versionIgnorada: p.versionIgnorada } : {}),
      });
      await guardarPrefs(nuevo);
      return ok(dto(nuevo));
    },
    buscar,
    async listarVersiones() {
      try {
        const lista = await json(URL_API_LISTA);
        const releases = (Array.isArray(lista) ? lista : []).map(interpretarRelease).filter((x): x is ReleasePublicada => !!x);
        const sumasPorEtiqueta = new Map<string, Map<string, string>>();
        await Promise.all(releases.slice(0, 10).map(async (rel) => {
          const a = rel.assets.find(x => /^sha256sums(\.txt)?$/i.test(x.nombre));
          if (!a) return;
          try { sumasPorEtiqueta.set(rel.etiqueta, parsearSumas(await textoSumas(a.url))); } catch { /* sin suma: se dice «no disponible» */ }
        }));
        return ok(listarVersionesPublicadas(releases, deps.versionActual, sumasPorEtiqueta));
      } catch (e) { const m = msgError(e); return fallo(m.texto, m.codigo); }
    },
    async comprobarAlArrancar() {
      try {
        if (!(await cargarPrefs()).comprobarAlArrancar) return;
        await buscar({ manual: false });
      } catch { /* nunca bloquea el arranque */ }
    },
  };
}
