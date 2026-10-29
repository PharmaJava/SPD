import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearManejadores, canalDe, remitenteValido, esResultado, MAX_ARGUMENTOS } from '../src/principal/ipc-nucleo.ts';
import type { Remitente } from '../src/principal/ipc-nucleo.ts';
import { METODOS } from '../src/servicios/metodos.ts';
import { ErrorSpd, ok } from '../src/servicios/contexto.ts';
import type { ApiSpd } from '../src/servicios/api.ts';

const propio: Remitente = { idWebContents: 7, esMarcoPrincipal: true, urlMarco: 'file:///app/dist/interfaz/index.html' };
const reglas = () => ({ idWebContentsPropio: 7, urlPropia: (u: string) => u.startsWith('file:///app/dist/interfaz/') });

function apiDoble(sobre: Record<string, unknown> = {}): ApiSpd {
  const a: Record<string, unknown> = {};
  for (const m of METODOS) a[m] = async (...args: unknown[]) => ok({ m, args });
  return Object.assign(a, sobre) as unknown as ApiSpd;
}

test('hay un canal por cada método del contrato, y ninguno más', () => {
  const mapa = crearManejadores({ api: apiDoble(), reglas });
  assert.equal(mapa.size, METODOS.length);
  for (const m of METODOS) assert.ok(mapa.has(canalDe(m)));
  for (const c of ['spd:eval', 'spd:sql', 'spd:constructor', 'spd:__proto__']) assert.equal(mapa.has(c), false);
});

test('llamada del remitente propio: pasa los argumentos y devuelve el Resultado', async () => {
  const mapa = crearManejadores({ api: apiDoble(), reglas });
  const r = await mapa.get('spd:obtenerPaciente')!(propio, 5);
  assert.deepEqual(r, { ok: true, datos: { m: 'obtenerPaciente', args: [5] } });
});

test('remitente ajeno: rechazado sin llegar al servicio', async () => {
  let llamadas = 0;
  const api = apiDoble({ listarPacientes: async () => { llamadas++; return ok([]); } });
  const mapa = crearManejadores({ api, reglas });
  const casos: (Remitente | null | undefined)[] = [
    null, undefined,
    { ...propio, idWebContents: 8 },
    { ...propio, esMarcoPrincipal: false },
    { ...propio, urlMarco: 'https://evil.com/' },
    { ...propio, urlMarco: 'file:///otro/index.html' },
  ];
  for (const c of casos) {
    const r = await mapa.get('spd:listarPacientes')!(c);
    assert.equal(r.ok, false); assert.equal((r as any).codigo, 'NO_AUTORIZADO');
  }
  assert.equal(llamadas, 0);
});

test('sin ventana propia (id null) nadie está autorizado', async () => {
  const mapa = crearManejadores({ api: apiDoble(), reglas: () => ({ idWebContentsPropio: null, urlPropia: () => true }) });
  assert.equal((await mapa.get('spd:estado')!(propio)).ok, false);
  assert.equal(remitenteValido(propio, { idWebContentsPropio: null, urlPropia: () => true }), false);
});

test('NUNCA propaga excepciones: ErrorSpd conserva su mensaje y código', async () => {
  const api = apiDoble({ validarPreparacion: async () => { throw new ErrorSpd('Sólo un farmacéutico puede validar.', 'PERMISO'); } });
  const r = await crearManejadores({ api, reglas }).get('spd:validarPreparacion')!(propio, 1);
  assert.deepEqual(r, { ok: false, error: 'Sólo un farmacéutico puede validar.', codigo: 'PERMISO' });
});

test('una excepción inesperada no filtra su mensaje (podría llevar rutas o SQL) y se registra sin datos', async () => {
  const log: string[] = [];
  const api = apiDoble({ guardarPaciente: async () => { throw new Error('SQLITE_ERROR en C:\\Users\\Ana\\spd.datos: paciente Juan Pérez'); } });
  const r = await crearManejadores({ api, reglas, registrar: m => log.push(m) }).get('spd:guardarPaciente')!(propio, {});
  assert.equal(r.ok, false); assert.equal((r as any).codigo, 'ERROR_INTERNO');
  assert.ok(!(r as any).error.includes('Juan') && !(r as any).error.includes('C:\\'));
  assert.ok(log.length === 1 && !log[0].includes('Juan'));
});

test('excepción que no es Error (cadena, null, objeto): sigue sin propagarse', async () => {
  for (const lanzado of ['texto', null, 42, { x: 1 }]) {
    const api = apiDoble({ estado: async () => { throw lanzado; } });
    const r = await crearManejadores({ api, reglas }).get('spd:estado')!(propio);
    assert.equal(r.ok, false);
  }
});

test('un servicio que devuelve basura (no es un Resultado) se convierte en fallo', async () => {
  for (const basura of [undefined, null, 5, 'ok', {}, { ok: true }, { ok: false }, { ok: 'sí', datos: 1 }, []]) {
    const api = apiDoble({ estado: async () => basura });
    const r = await crearManejadores({ api, reglas }).get('spd:estado')!(propio);
    assert.equal(r.ok, false, JSON.stringify(basura));
  }
});

test('un servicio ausente o no función: fallo NO_IMPLEMENTADO', async () => {
  const api = apiDoble({ panelHoy: undefined, estado: 'no soy función' });
  const mapa = crearManejadores({ api, reglas });
  assert.equal((await mapa.get('spd:panelHoy')!(propio) as any).codigo, 'NO_IMPLEMENTADO');
  assert.equal((await mapa.get('spd:estado')!(propio) as any).codigo, 'NO_IMPLEMENTADO');
});

test('demasiados argumentos: rechazado', async () => {
  const mapa = crearManejadores({ api: apiDoble(), reglas });
  const r = await mapa.get('spd:estado')!(propio, ...Array(MAX_ARGUMENTOS + 1).fill(1));
  assert.equal((r as any).codigo, 'ARGUMENTOS');
});

test('esResultado', () => {
  assert.equal(esResultado({ ok: true, datos: null }), true);
  assert.equal(esResultado({ ok: false, error: 'x' }), true);
  assert.equal(esResultado({ ok: true }), false);
});
