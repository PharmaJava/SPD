import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
// @ts-expect-error módulo .mjs sin tipos
import { crearServidorDev, ORIGENES_PERMITIDOS } from '../scripts/dev-servidor.mjs';

let dev: any, puerto: number, carpetaImpresos: string, datos: string;
before(async () => {
  carpetaImpresos = mkdtempSync(join(tmpdir(), 'spd-test-impresos-'));
  datos = mkdtempSync(join(tmpdir(), 'spd-test-datos-'));
  dev = await crearServidorDev({ rutaDatos: datos, carpetaImpresos });
  await new Promise<void>(r => dev.servidor.listen(0, '127.0.0.1', () => r()));
  puerto = (dev.servidor.address() as AddressInfo).port;
});
after(async () => { await dev.cerrar(); rmSync(carpetaImpresos, { recursive: true, force: true }); rmSync(datos, { recursive: true, force: true }); });

async function post(metodo: string, args: unknown[] = [], extra: { headers?: Record<string, string>; cuerpo?: string } = {}) {
  const r = await fetch(`http://127.0.0.1:${puerto}/api/${metodo}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...extra.headers }, body: extra.cuerpo ?? JSON.stringify({ args }),
  });
  return { estado: r.status, cuerpo: await r.json() as any, cabeceras: r.headers };
}

test('método fuera del contrato: 404', async () => {
  for (const m of ['rm', 'constructor', '__proto__', 'toString', 'Estado']) {
    const r = await post(m);
    assert.equal(r.estado, 404, m); assert.equal(r.cuerpo.ok, false);
  }
});

test('ruta que no es /api/<metodo>: 404', async () => {
  for (const ruta of ['/', '/api', '/api/', '/api/estado/x', '/api/../etc/passwd', '/otra']) {
    const r = await fetch(`http://127.0.0.1:${puerto}${ruta}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 404, ruta);
  }
});

test('sólo POST y sólo JSON', async () => {
  const g = await fetch(`http://127.0.0.1:${puerto}/api/estado`);
  assert.equal(g.status, 405);
  const t = await fetch(`http://127.0.0.1:${puerto}/api/estado`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(t.status, 415);
});

test('cuerpo mal formado: 400', async () => {
  for (const cuerpo of ['{roto', '[1,2]', '"x"', '{"args":5}', '{"args":{"a":1}}']) {
    const r = await post('estado', [], { cuerpo });
    assert.equal(r.estado, 400, cuerpo);
  }
});

test('Host no local: 403 (anti «DNS rebinding»)', async () => {
  const estado = await new Promise<number>((resolver, rechazar) => {
    const rq = http.request({ host: '127.0.0.1', port: puerto, path: '/api/codigoSvg', method: 'POST', headers: { 'Content-Type': 'application/json', Host: 'evil.example.com' } },
      (res) => { res.resume(); resolver(res.statusCode ?? 0); });
    rq.on('error', rechazar); rq.end('{"args":["x","qrcode"]}');
  });
  assert.equal(estado, 403);
});

test('Origen ajeno: 403 y sin cabeceras CORS; origen de Vite: permitido', async () => {
  const mal = await post('codigoSvg', ['x', 'qrcode'], { headers: { Origin: 'http://evil.com' } });
  assert.equal(mal.estado, 403); assert.equal(mal.cabeceras.get('access-control-allow-origin'), null);
  for (const o of ORIGENES_PERMITIDOS) {
    const b = await post('codigoSvg', ['x', 'qrcode'], { headers: { Origin: o } });
    assert.equal(b.estado, 200); assert.equal(b.cabeceras.get('access-control-allow-origin'), o);
  }
  const otroPuerto = await post('codigoSvg', ['x', 'qrcode'], { headers: { Origin: 'http://localhost:5174' } });
  assert.equal(otroPuerto.estado, 403);
});

test('preflight OPTIONS: sólo para orígenes permitidos', async () => {
  const ok = await fetch(`http://127.0.0.1:${puerto}/api/estado`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(ok.status, 204); assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const mal = await fetch(`http://127.0.0.1:${puerto}/api/estado`, { method: 'OPTIONS', headers: { Origin: 'http://evil.com' } });
  assert.equal(mal.status, 403);
});

test('codigoSvg: real, con bwip-js', async () => {
  const r = await post('codigoSvg', ['SPD-1', 'datamatrix']);
  assert.equal(r.estado, 200); assert.equal(r.cuerpo.ok, true); assert.ok(r.cuerpo.datos.startsWith('<svg'));
  const mala = await post('codigoSvg', ['x', 'code128']);
  assert.equal(mala.cuerpo.ok, false);
});

test('consultarCima valida el CN sin llamar a la red', async () => {
  const r = await post('consultarCima', ['abc']);
  assert.equal(r.cuerpo.ok, false); assert.equal(r.cuerpo.codigo, 'CN_NO_VALIDO');
});

test('listarImpresoras: la impresora de pruebas', async () => {
  const r = await post('listarImpresoras');
  assert.deepEqual(r.cuerpo, { ok: true, datos: [{ nombre: 'Impresora de pruebas (PDF)', predeterminada: true }] });
});

test('imprimirHtml y exportarPdf guardan el HTML en la carpeta de impresos', async () => {
  const a = await post('imprimirHtml', ['<h1>Etiqueta</h1>', {}]);
  assert.deepEqual(a.cuerpo, { ok: true, datos: null });
  const b = await post('exportarPdf', ['<h1>Hoja ../../malo</h1>', 'Hoja ../../malo.pdf']);
  assert.equal(b.cuerpo.ok, true);
  const ruta: string = b.cuerpo.datos.ruta;
  assert.ok(ruta.startsWith(carpetaImpresos), 'el nombre sugerido no puede sacar el fichero de la carpeta');
  assert.equal(readFileSync(ruta, 'utf8'), '<h1>Hoja ../../malo</h1>');
  assert.equal(readdirSync(carpetaImpresos).length, 2);
  const mala = await post('imprimirHtml', [{ no: 'texto' }, {}]);
  assert.equal(mala.cuerpo.ok, false);
});

test('elegirCarpeta devuelve una carpeta temporal', async () => {
  const r = await post('elegirCarpeta', ['Elige']);
  assert.equal(r.cuerpo.ok, true); assert.ok(typeof r.cuerpo.datos === 'string' && r.cuerpo.datos.length > 3);
});

test('un método de un módulo ausente responde ok:false, no cae', async () => {
  // Con o sin los módulos de sistema/clínica, nunca debe responder 5xx ni lanzar.
  for (const m of ['estado', 'listarPacientes', 'validarPreparacion']) {
    const r = await post(m, []);
    assert.equal(r.estado, 200, m);
    assert.equal(typeof r.cuerpo.ok, 'boolean');
  }
});

test('/salud informa del estado de los módulos', async () => {
  const r = await fetch(`http://127.0.0.1:${puerto}/salud`);
  const j = await r.json() as any;
  assert.equal(j.ok, true); assert.ok('sistema' in j.datos.modulos);
});
