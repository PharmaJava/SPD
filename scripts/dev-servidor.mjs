// Servidor de DESARROLLO del contrato (src/servicios/api.ts) por HTTP.
//
// Lo usan las pantallas Svelte mientras se desarrollan con `npm run dev:interfaz` (Vite proxifica /api → aquí)
// y las pruebas. En la aplicación real NO se usa: allí el contrato viaja por IPC (src/principal/).
//
//   npm run dev:servidor            → http://127.0.0.1:5174
//   SPD_DATOS=/ruta npm run dev:servidor   → usa (y conserva) esa carpeta de datos; por defecto una temporal nueva
//   SPD_DEV_PUERTO=5180 …           → otro puerto (sólo pruebas)
//
// Protocolo: POST /api/<metodo> con cuerpo JSON {"args":[...]} → el Resultado JSON del método.
//   · Un método fuera del contrato → 404. Cuerpo mal formado → 400. Tipo de contenido que no sea JSON → 415.
//   · Sólo escucha en 127.0.0.1 y sólo acepta Host/Origin locales (protege del «DNS rebinding» y de páginas web ajenas).
//   · CORS únicamente para http://127.0.0.1:5173 y http://localhost:5173 (Vite).
//   · Si un módulo de servicios aún no existe, el servidor arranca igualmente y esos métodos responden
//     {ok:false, error:'Módulo X pendiente'}.
//
// ⚠️ Es una herramienta de desarrollo: sin autenticación propia más allá de la sesión del programa. NO exponer a la red.
import http from 'node:http';
import { existsSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdirSync as _mk } from 'node:fs';
// Datos de pruebas siempre bajo /tmp/SPD/sp/datos (sin nombres de herramientas ni sesiones)
const baseDatos = () => { const b = join(tmpdir(), 'SPD', 'sp', 'datos'); _mk(b, { recursive: true }); return b; };
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PUERTO_POR_DEFECTO = 5174;
export const ORIGENES_PERMITIDOS = ['http://127.0.0.1:5173', 'http://localhost:5173'];
const MAX_CUERPO = 8 * 1024 * 1024;

const sub = (ruta) => pathToFileURL(join(RAIZ, ruta)).href;

/** Importa un módulo de servicios si existe. Devuelve {mod} o {pendiente:true} o {error}. */
async function cargar(ruta) {
  if (!existsSync(join(RAIZ, ruta))) return { pendiente: true };
  try { return { mod: await import(sub(ruta)) }; }
  catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}

const ok = (datos) => ({ ok: true, datos });
const fallo = (error, codigo) => ({ ok: false, error, ...(codigo ? { codigo } : {}) });

function nombreSeguro(n) {
  const base = String(n ?? 'documento').replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^\.+/, '').slice(0, 80);
  return base || 'documento';
}

/** Externo en modo desarrollo (sin Electron). */
function crearExternoDev({ cima, codigos, carpetaImpresos }) {
  let contador = 0;
  const guardar = (html, nombre) => {
    mkdirSync(carpetaImpresos, { recursive: true });
    const marca = new Date().toISOString().replace(/[:.]/g, '-');
    const ruta = join(carpetaImpresos, `${marca}-${++contador}-${nombreSeguro(nombre)}.html`);
    writeFileSync(ruta, String(html ?? ''), 'utf8');
    return ruta;
  };
  return {
    async consultarCima(cn) {
      if (!cima) return fallo('Módulo cima pendiente');
      try { return await cima.consultarCima(cn, { timeoutMs: 8000 }); }
      catch (e) { return ok({ disponible: false, aviso: 'No se pudo consultar CIMA: ' + (e instanceof Error ? e.message : String(e)) }); }
    },
    async listarImpresoras() { return ok([{ nombre: 'Impresora de pruebas (PDF)', predeterminada: true }]); },
    async imprimirHtml(html) {
      if (typeof html !== 'string') return fallo('El HTML a imprimir no es texto.');
      guardar(html, 'impresion'); return ok(null);
    },
    async exportarPdf(html, nombreSugerido) {
      if (typeof html !== 'string') return fallo('El HTML a exportar no es texto.');
      return ok({ ruta: guardar(html, nombreSugerido) });
    },
    async elegirCarpeta() { return ok(mkdtempSync(join(baseDatos(), 'spd-carpeta-'))); },
    async codigoSvg(texto, simbologia) {
      if (!codigos) return fallo('Módulo codigos pendiente');
      return codigos.generarCodigoSvg(texto, simbologia);
    },
  };
}

/**
 * Crea el servidor (sin ponerlo a escuchar). Devuelve {servidor, api, cerrar}.
 * `opciones.rutaDatos`: carpeta de datos (por defecto, una temporal nueva).
 */
export async function crearServidorDev(opciones = {}) {
  const { GRUPO_DE_METODO, esMetodo } = await import(sub('src/servicios/metodos.ts'));
  const rutaDatos = opciones.rutaDatos ?? process.env.SPD_DATOS ?? mkdtempSync(join(baseDatos(), 'spd-dev-'));
  mkdirSync(rutaDatos, { recursive: true });
  const carpetaImpresos = opciones.carpetaImpresos ?? join(RAIZ, 'capturas', 'impresos');

  const [sis, base, prep, cima, codigos] = await Promise.all([
    cargar('src/servicios/sistema.ts'), cargar('src/servicios/clinica-base.ts'), cargar('src/servicios/clinica-preparacion.ts'),
    cargar('src/servicios/cima.ts'), cargar('src/servicios/codigos.ts'),
  ]);
  const estadoModulo = (m, nombre) => m.mod ? null : m.pendiente ? `Módulo ${nombre} pendiente` : `Módulo ${nombre} no se pudo cargar: ${m.error}`;

  let sistema = null, errorSistema = estadoModulo(sis, 'sistema');
  if (sis.mod) {
    try { sistema = await sis.mod.crearSistema({ rutaDatos, wasmPath: join(RAIZ, 'node_modules/sql.js/dist/sql-wasm.wasm') }); }
    catch (e) { errorSistema = 'Módulo sistema no arrancó: ' + (e instanceof Error ? e.message : String(e)); }
  }
  const externo = crearExternoDev({ cima: cima.mod, codigos: codigos.mod, carpetaImpresos });

  // Una sola API fusionada. Cada método sabe de qué módulo viene para decir cuál falta.
  const fuentes = { sistema: sistema?.api ?? null, clinicaBase: null, clinicaPrep: null, externa: externo };
  const errores = { sistema: errorSistema, clinicaBase: estadoModulo(base, 'clinica-base'), clinicaPrep: estadoModulo(prep, 'clinica-preparacion') };
  if (sistema && base.mod) { try { fuentes.clinicaBase = base.mod.crearClinicaBase(sistema.ctx); } catch (e) { errores.clinicaBase = 'Módulo clinica-base no arrancó: ' + (e instanceof Error ? e.message : String(e)); } }
  if (sistema && prep.mod) { try { fuentes.clinicaPrep = prep.mod.crearClinicaPreparacion(sistema.ctx); } catch (e) { errores.clinicaPrep = 'Módulo clinica-preparacion no arrancó: ' + (e instanceof Error ? e.message : String(e)); } }
  if (!sistema && !errores.clinicaBase) errores.clinicaBase = 'Módulo clinica-base pendiente (necesita el sistema)';
  if (!sistema && !errores.clinicaPrep) errores.clinicaPrep = 'Módulo clinica-preparacion pendiente (necesita el sistema)';

  async function llamar(metodo, args) {
    const grupo = GRUPO_DE_METODO[metodo];
    const candidatos = grupo === 'sistema' ? [['sistema', fuentes.sistema]]
      : grupo === 'externa' ? [['externa', fuentes.externa]]
      : [['clinicaBase', fuentes.clinicaBase], ['clinicaPrep', fuentes.clinicaPrep]];
    for (const [, fuente] of candidatos) {
      if (fuente && Object.hasOwn(fuente, metodo) && typeof fuente[metodo] === 'function') {
        try { return await fuente[metodo](...args); }
        catch (e) { return fallo(e instanceof Error ? e.message : String(e), 'ERROR_INTERNO'); }
      }
    }
    // Ningún módulo lo implementa: se dice cuál falta (no se inventa una respuesta).
    const clave = grupo === 'sistema' ? 'sistema' : grupo === 'externa' ? 'externa' : null;
    const msj = clave ? errores[clave] : (errores.clinicaBase || errores.clinicaPrep);
    return fallo(msj ?? `Método «${metodo}» no implementado todavía`, 'PENDIENTE');
  }

  const hostsOk = (h) => typeof h === 'string' && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h);
  const json = (res, estado, cuerpo, cabeceras = {}) => {
    const t = JSON.stringify(cuerpo);
    res.writeHead(estado, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...cabeceras });
    res.end(t);
  };

  const servidor = http.createServer((req, res) => {
    const origen = req.headers.origin;
    const cors = origen && ORIGENES_PERMITIDOS.includes(origen)
      ? { 'Access-Control-Allow-Origin': origen, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' }
      : {};
    if (!hostsOk(req.headers.host)) return json(res, 403, fallo('Host no permitido.'));
    if (origen !== undefined && !cors['Access-Control-Allow-Origin']) return json(res, 403, fallo('Origen no permitido.'));

    let ruta;
    try { ruta = new URL(req.url ?? '/', 'http://127.0.0.1').pathname; } catch { return json(res, 400, fallo('URL mal formada.'), cors); }

    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.method === 'GET' && ruta === '/salud') return json(res, 200, ok({ servidor: 'spd-dev', modulos: errores, rutaDatos }), cors);

    const m = /^\/api\/([A-Za-z0-9_]+)$/.exec(ruta);
    if (!m) return json(res, 404, fallo('Ruta no encontrada.'), cors);
    const metodo = m[1];
    if (!esMetodo(metodo)) return json(res, 404, fallo(`Método «${metodo}» fuera del contrato.`, 'METODO_DESCONOCIDO'), cors);
    if (req.method !== 'POST') return json(res, 405, fallo('Usa POST.'), { ...cors, Allow: 'POST' });
    if (!/^application\/json(\s*;|$)/i.test(req.headers['content-type'] ?? '')) return json(res, 415, fallo('El cuerpo debe ser application/json.'), cors);

    const trozos = []; let total = 0; let cortado = false;
    req.on('data', (t) => { total += t.length; if (total > MAX_CUERPO) { cortado = true; req.destroy(); } else trozos.push(t); });
    req.on('error', () => {});
    req.on('close', () => { if (cortado && !res.writableEnded) json(res, 413, fallo('Cuerpo demasiado grande.'), cors); });
    req.on('end', async () => {
      if (cortado) return;
      let args = [];
      const texto = Buffer.concat(trozos).toString('utf8');
      if (texto.trim()) {
        let cuerpo;
        try { cuerpo = JSON.parse(texto); } catch { return json(res, 400, fallo('JSON mal formado.'), cors); }
        if (cuerpo === null || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) return json(res, 400, fallo('El cuerpo debe ser un objeto {"args":[…]}.'), cors);
        if (cuerpo.args !== undefined) {
          if (!Array.isArray(cuerpo.args)) return json(res, 400, fallo('«args» debe ser una lista.'), cors);
          args = cuerpo.args;
        }
      }
      // undefined no existe en JSON: null → undefined en los opcionales sería ambiguo; se respeta tal cual.
      const r = await llamar(metodo, args);
      json(res, 200, r, cors);
    });
  });

  const cerrar = async () => {
    await new Promise((r) => servidor.close(() => r(undefined)));
    try { sistema?.cerrar?.(); } catch { /* ya cerrado */ }
  };
  return { servidor, api: { llamar }, errores, rutaDatos, cerrar };
}

// ── Arranque cuando se ejecuta directamente ──
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const puerto = Number(process.env.SPD_DEV_PUERTO ?? PUERTO_POR_DEFECTO);
  const dev = await crearServidorDev();
  dev.servidor.listen(puerto, '127.0.0.1', () => {
    console.log(`SPD servidor de desarrollo en http://127.0.0.1:${puerto}  (datos: ${dev.rutaDatos})`);
    for (const [k, v] of Object.entries(dev.errores)) if (v) console.log(`  ⚠ ${k}: ${v}`);
  });
  const salir = async () => { await dev.cerrar(); process.exit(0); };
  process.on('SIGINT', salir); process.on('SIGTERM', salir);
}
