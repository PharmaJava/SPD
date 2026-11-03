import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crearActualizador } from '../src/principal/actualizaciones.ts';
import type { DepsActualizador, RespuestaHttp } from '../src/principal/actualizaciones.ts';
import { URL_API_ULTIMA, URL_API_LISTA } from '../src/dominio/actualizaciones.ts';
import { urlProyecto, decidirApertura } from '../src/principal/seguridad-ventana.ts';

const INST = new TextEncoder().encode('instalador-falso');
const SHA = createHash('sha256').update(INST).digest('hex');
const dl = (n: string) => `https://github.com/PharmaJava/SPD/releases/download/v1.1.0/${n}`;
const RELEASE = { tag_name: 'v1.1.0', name: 'SPD 1.1.0', body: 'Mejoras', published_at: '2026-10-01T00:00:00Z', assets: [
  { name: 'SPD-1.1.0-win-x64.exe', browser_download_url: dl('SPD-1.1.0-win-x64.exe'), size: 16 },
  { name: 'SHA256SUMS.txt', browser_download_url: dl('SHA256SUMS.txt'), size: 80 }] };

const resp = (status: number, cuerpo: Uint8Array | string = '', headers: Record<string, string> = {}): RespuestaHttp => {
  const b = typeof cuerpo === 'string' ? new TextEncoder().encode(cuerpo) : cuerpo;
  let leido = false;
  return { status, headers: { get: (n) => headers[n.toLowerCase()] ?? null }, text: async () => new TextDecoder().decode(b),
    body: { getReader: () => ({ read: async () => (leido ? { done: true } : (leido = true, { done: false, value: b })), cancel: async () => {} }) } };
};

function montar(opc: { sumas?: string; instalador?: Uint8Array; decision?: 'instalar' | 'luego' | 'ignorar'; cierre?: boolean; copia?: boolean; version?: string; redireccion?: string; plataforma?: string } = {}) {
  const log: string[] = []; const pedidas: { url: string; headers: Record<string, string> }[] = []; let prefs: unknown = null;
  const borradas: string[] = [];
  const deps: DepsActualizador = {
    plataforma: opc.plataforma ?? 'win32', versionActual: opc.version ?? '1.0.0',
    fetch: async (url, init) => {
      pedidas.push({ url, headers: init.headers });
      if (url === URL_API_ULTIMA) return resp(200, JSON.stringify(RELEASE));
      if (url === URL_API_LISTA) return resp(200, JSON.stringify([RELEASE]));
      if (url === dl('SHA256SUMS.txt')) return resp(200, opc.sumas ?? `${SHA}  SPD-1.1.0-win-x64.exe\n`);
      if (url === dl('SPD-1.1.0-win-x64.exe')) return opc.redireccion ? resp(302, '', { location: opc.redireccion }) : resp(200, opc.instalador ?? INST);
      if (url.startsWith('https://objects.githubusercontent.com/')) return resp(200, INST);
      return resp(404);
    },
    prefs: { leer: async () => prefs, guardar: async (p) => { prefs = p; } },
    preguntar: async () => { log.push('preguntar'); return opc.decision ?? 'instalar'; },
    confirmarCierre: async () => { log.push('confirmarCierre'); return opc.cierre ?? true; },
    copiaAntes: async (v) => { log.push('copia ' + v); return opc.copia === false ? { ok: false as const, error: 'disco lleno' } : { ok: true as const, datos: { ruta: 'x' } }; },
    fs: { crearCarpetaTemporal: async () => '/tmp/t', unir: (...p) => p.join('/'), abrirEscritura: async () => ({ escribir: async () => { log.push('escribe'); }, cerrar: async () => {} }), borrarCarpeta: async (r) => { borradas.push(r); } },
    cerrarYLanzar: async (r) => { log.push('lanza ' + r); },
  };
  return { a: crearActualizador(deps), log, pedidas, borradas, prefs: () => prefs };
}

test('flujo feliz: pregunta → sumas → descarga verificada → confirma cierre → copia → lanza (en ese orden)', async () => {
  const m = montar();
  const r = await m.a.buscar({ manual: true });
  assert.ok(r.ok && r.datos.estado === 'instalando');
  assert.deepEqual(m.log.filter(x => x !== 'escribe'), ['preguntar', 'confirmarCierre', 'copia 1.1.0', 'lanza /tmp/t/SPD-1.1.0-win-x64.exe']);
});

test('la petición no lleva nada de la farmacia: sólo Accept y un nombre de cliente genérico, siempre https', async () => {
  const m = montar({ decision: 'luego' });
  await m.a.buscar({ manual: true });
  for (const p of m.pedidas) { assert.match(p.url, /^https:\/\//); assert.deepEqual(Object.keys(p.headers).sort(), ['Accept', 'User-Agent']); assert.equal(p.headers['User-Agent'], 'SPD-actualizador'); }
});

test('«Más tarde» y «No volver a avisar»: no se descarga nada; ignorar se recuerda y calla sólo el aviso automático', async () => {
  const m = montar({ decision: 'luego' });
  const r = await m.a.buscar({ manual: true });
  assert.ok(r.ok && r.datos.estado === 'pospuesta');
  assert.equal(m.pedidas.some(p => p.url.includes('/releases/download/')), false);
  const i = montar({ decision: 'ignorar' });
  await i.a.buscar({ manual: true });
  assert.equal((i.prefs() as { versionIgnorada: string }).versionIgnorada, '1.1.0');
  assert.equal(i.pedidas.some(p => p.url.includes('/releases/download/')), false);
  const auto = await i.a.buscar({ manual: false });
  assert.ok(auto.ok && auto.datos.estado === 'ignorada'); assert.equal(i.log.filter(x => x === 'preguntar').length, 1);
});

test('suma que no coincide: se descarta y NO se lanza; sin suma publicada: tampoco', async () => {
  const mal = montar({ instalador: new TextEncoder().encode('manipulado') });
  const r = await mal.a.buscar({ manual: true });
  assert.ok(!r.ok && r.codigo === 'SUMA'); assert.ok(!mal.log.some(x => x.startsWith('lanza'))); assert.deepEqual(mal.borradas, ['/tmp/t']);
  const sin = montar({ sumas: `${SHA}  otro.exe\n` });
  const r2 = await sin.a.buscar({ manual: true });
  assert.ok(!r2.ok && r2.codigo === 'SUMA'); assert.ok(!sin.log.some(x => x.startsWith('lanza') || x === 'escribe'));
});

test('si la copia previa falla NO se instala; si no se confirma el cierre, tampoco y se borra la descarga', async () => {
  const c = montar({ copia: false });
  const r = await c.a.buscar({ manual: true });
  assert.ok(!r.ok && r.codigo === 'COPIA_PREVIA'); assert.ok(!c.log.some(x => x.startsWith('lanza')));
  const n = montar({ cierre: false });
  const r2 = await n.a.buscar({ manual: true });
  assert.ok(r2.ok && r2.datos.estado === 'pospuesta'); assert.ok(!n.log.some(x => x.startsWith('copia') || x.startsWith('lanza'))); assert.deepEqual(n.borradas, ['/tmp/t']);
});

test('redirecciones: a GitHub se siguen; a otro host se cancelan', async () => {
  const bien = montar({ redireccion: 'https://objects.githubusercontent.com/abc' });
  const r = await bien.a.buscar({ manual: true });
  assert.ok(r.ok && r.datos.estado === 'instalando');
  for (const dest of ['https://evil.com/i.exe', 'http://objects.githubusercontent.com/abc']) {
    const mal = montar({ redireccion: dest });
    const x = await mal.a.buscar({ manual: true });
    assert.ok(!x.ok && x.codigo === 'URL_NO_PERMITIDA', dest); assert.ok(!mal.log.some(l => l.startsWith('lanza')));
  }
});

test('sin downgrade, sin Windows y fallo de red: mensajes claros, nunca excepción', async () => {
  const igual = montar({ version: '1.1.0' });
  const r = await igual.a.buscar({ manual: true });
  assert.ok(r.ok && r.datos.estado === 'al_dia'); assert.ok(!igual.log.includes('preguntar'));
  const linux = montar({ plataforma: 'linux' });
  assert.ok(!(await linux.a.buscar({ manual: true })).ok);
  const sinRed = crearActualizador({ plataforma: 'win32', versionActual: '1.0.0', fetch: async () => { throw new Error('ENOTFOUND'); },
    prefs: { leer: async () => null, guardar: async () => {} }, preguntar: async () => 'luego', confirmarCierre: async () => false, copiaAntes: async () => ({ ok: true as const, datos: { ruta: null } }),
    fs: {} as never, cerrarYLanzar: async () => {} });
  const e = await sinRed.buscar({ manual: true });
  assert.ok(!e.ok && e.codigo === 'SIN_RED' && /conexión/.test(e.error));
  await sinRed.comprobarAlArrancar();   // no lanza
});

test('comprobar al arrancar respeta la preferencia (desactivada → ni una petición)', async () => {
  const m = montar({ decision: 'luego' });
  await m.a.guardarPreferencias({ comprobarAlArrancar: false });
  await m.a.comprobarAlArrancar();
  assert.equal(m.pedidas.length, 0);
  await m.a.guardarPreferencias({ comprobarAlArrancar: true });
  await m.a.comprobarAlArrancar();
  assert.ok(m.pedidas.length > 0);
});

test('lista de versiones con SHA-256 leído de SHA256SUMS', async () => {
  const r = await montar().a.listarVersiones();
  assert.ok(r.ok); assert.equal(r.datos[0].instalador!.sha256, SHA);
});

test('enlaces externos: sólo la web del autor y las releases del proyecto', () => {
  assert.ok(urlProyecto('https://conveniodefarmacia.com'));
  assert.ok(decidirApertura('https://github.com/PharmaJava/SPD/releases/tag/v1.0.0').accion === 'abrirEnNavegador');
  for (const u of ['https://github.com/otro/SPD/releases', 'https://github.com/PharmaJava/SPD/issues', 'https://conveniodefarmacia.com.evil.com', 'http://conveniodefarmacia.com', 'https://github.com/PharmaJava/SPD-malo/releases']) assert.equal(urlProyecto(u), null, u);
});
