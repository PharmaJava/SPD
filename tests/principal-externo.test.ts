import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearExterno } from '../src/principal/externo.ts';
import type { DepsExterno, VentanaImpresion } from '../src/principal/externo.ts';

interface Traza { escritos: Record<string, string | Uint8Array>; borradas: string[]; ventanas: number; destruidas: number; impresiones: Record<string, unknown>[]; pdfs: Record<string, unknown>[]; guardar: unknown[] }

function doble(over: Partial<DepsExterno> & { imprimir?: VentanaImpresion['imprimir']; aPdf?: VentanaImpresion['aPdf']; cargar?: VentanaImpresion['cargarArchivo'] } = {}) {
  const t: Traza = { escritos: {}, borradas: [], ventanas: 0, destruidas: 0, impresiones: [], pdfs: [], guardar: [] };
  const deps: DepsExterno = {
    crearVentanaImpresion: () => {
      t.ventanas++;
      return {
        cargarArchivo: over.cargar ?? (async () => {}),
        imprimir: over.imprimir ?? (async (o) => { t.impresiones.push(o); return { ok: true }; }),
        aPdf: over.aPdf ?? (async (o) => { t.pdfs.push(o); return new Uint8Array(500).fill(1); }),
        destruir: () => { t.destruidas++; },
      };
    },
    impresoras: over.impresoras ?? (async () => [{ name: 'Zebra ZD220', isDefault: false }, { name: 'HP', isDefault: true }]),
    mostrarGuardar: over.mostrarGuardar ?? (async (o) => { t.guardar.push(o); return { cancelado: false, ruta: '/docs/Hoja.pdf' }; }),
    mostrarCarpeta: over.mostrarCarpeta ?? (async () => ({ cancelado: false, ruta: '/copias' })),
    carpetaDocumentos: () => '/docs',
    fs: {
      crearCarpetaTemporal: async () => '/tmp/spd-impresion-x',
      escribir: async (r, d) => { t.escritos[r] = d; },
      borrarCarpeta: async (r) => { t.borradas.push(r); },
    },
    unir: (...p) => p.join('/'),
    ...(over.fetch ? { fetch: over.fetch } : {}),
  };
  return { api: crearExterno(deps), t };
}

test('listarImpresoras: nombre y predeterminada', async () => {
  const { api } = doble();
  const r = await api.listarImpresoras();
  assert.deepEqual(r, { ok: true, datos: [{ nombre: 'Zebra ZD220', predeterminada: false }, { nombre: 'HP', predeterminada: true }] });
});

test('listarImpresoras: un fallo no se propaga', async () => {
  const { api } = doble({ impresoras: async () => { throw new Error('spooler parado'); } });
  const r = await api.listarImpresoras();
  assert.equal(r.ok, false);
});

test('imprimirHtml: escribe el temporal, imprime con los argumentos correctos y BORRA el temporal', async () => {
  const { api, t } = doble();
  const r = await api.imprimirHtml('<p>Etiqueta</p>', { impresora: 'Zebra ZD220', anchoMm: 100, altoMm: 150, silenciosa: true });
  assert.deepEqual(r, { ok: true, datos: null });
  assert.equal(t.escritos['/tmp/spd-impresion-x/documento.html'], '<p>Etiqueta</p>');
  assert.deepEqual(t.impresiones[0], { silent: true, printBackground: true, margins: { marginType: 'none' }, deviceName: 'Zebra ZD220', pageSize: { width: 100000, height: 150000 } });
  assert.deepEqual(t.borradas, ['/tmp/spd-impresion-x']);
  assert.equal(t.destruidas, 1);
});

test('imprimirHtml: impresora inexistente → fallo, no se imprime ni se crea ventana', async () => {
  const { api, t } = doble();
  const r = await api.imprimirHtml('<p>x</p>', { impresora: 'Otra' });
  assert.equal(r.ok, false); assert.equal((r as any).codigo, 'IMPRESORA_NO_ENCONTRADA');
  assert.equal(t.ventanas, 0); assert.equal(t.impresiones.length, 0);
});

test('imprimirHtml: entrada inválida → fallo sin tocar el disco', async () => {
  const { api, t } = doble();
  for (const [h, o] of [[5, {}], ['', {}], ['<p>x</p>', { anchoMm: 100 }], ['<p>x</p>', 'raro']] as [any, any][]) {
    const r = await api.imprimirHtml(h, o);
    assert.equal(r.ok, false);
  }
  assert.deepEqual(t.escritos, {}); assert.equal(t.ventanas, 0);
});

test('imprimirHtml: la impresión falla → fallo con el motivo, y se limpia igualmente', async () => {
  const { api, t } = doble({ imprimir: async () => ({ ok: false, motivo: 'Sin papel' }) });
  const r = await api.imprimirHtml('<p>x</p>', {});
  assert.equal(r.ok, false); assert.match((r as any).error, /Sin papel/);
  assert.deepEqual(t.borradas, ['/tmp/spd-impresion-x']); assert.equal(t.destruidas, 1);
});

test('imprimirHtml: la carga lanza → fallo y limpieza (el temporal con datos de pacientes no queda)', async () => {
  const { api, t } = doble({ cargar: async () => { throw new Error('no carga'); } });
  const r = await api.imprimirHtml('<p>x</p>', {});
  assert.equal(r.ok, false);
  assert.deepEqual(t.borradas, ['/tmp/spd-impresion-x']); assert.equal(t.destruidas, 1);
});

test('imprimirHtml sin impresora: usa la predeterminada del sistema (no hay deviceName)', async () => {
  const { api, t } = doble();
  await api.imprimirHtml('<p>x</p>', { silenciosa: true });
  assert.ok(!('deviceName' in t.impresiones[0]));
});

test('exportarPdf: diálogo, PDF escrito en la ruta elegida, temporal borrado', async () => {
  const { api, t } = doble();
  const r = await api.exportarPdf('<p>Hoja</p>', 'Hoja de Ana.pdf');
  assert.deepEqual(r, { ok: true, datos: { ruta: '/docs/Hoja.pdf' } });
  assert.equal((t.guardar[0] as any).rutaSugerida, '/docs/Hoja de Ana.pdf');
  assert.equal((t.escritos['/docs/Hoja.pdf'] as Uint8Array).length, 500);
  assert.deepEqual(t.borradas, ['/tmp/spd-impresion-x']);
});

test('exportarPdf: si el usuario cancela, devuelve ok(null) y no genera nada', async () => {
  const { api, t } = doble({ mostrarGuardar: async () => ({ cancelado: true }) });
  assert.deepEqual(await api.exportarPdf('<p>x</p>', 'a'), { ok: true, datos: null });
  assert.equal(t.ventanas, 0);
});

test('exportarPdf: añade .pdf si falta, y rechaza un PDF vacío', async () => {
  const { api, t } = doble({ mostrarGuardar: async () => ({ cancelado: false, ruta: '/docs/sin-ext' }) });
  const r = await api.exportarPdf('<p>x</p>', 'a');
  assert.deepEqual(r, { ok: true, datos: { ruta: '/docs/sin-ext.pdf' } });
  assert.ok('/docs/sin-ext.pdf' in t.escritos);
  const v = doble({ aPdf: async () => new Uint8Array(0) });
  assert.equal((await v.api.exportarPdf('<p>x</p>', 'a')).ok, false);
});

test('exportarPdf: el nombre sugerido nunca saca el fichero de la carpeta de documentos', async () => {
  const { api, t } = doble();
  await api.exportarPdf('<p>x</p>', '../../Windows/System32/x');
  const ruta = (t.guardar[0] as any).rutaSugerida as string;
  assert.ok(ruta.startsWith('/docs/') && !ruta.includes('..'));
});

test('elegirCarpeta: ruta, null si cancela, título acotado', async () => {
  assert.deepEqual(await doble().api.elegirCarpeta('Copias'), { ok: true, datos: '/copias' });
  assert.deepEqual(await doble({ mostrarCarpeta: async () => ({ cancelado: true }) }).api.elegirCarpeta('x'), { ok: true, datos: null });
  let titulo = '';
  await doble({ mostrarCarpeta: async (t) => { titulo = t; return { cancelado: true }; } }).api.elegirCarpeta('x'.repeat(500));
  assert.ok(titulo.length <= 120);
});

test('codigoSvg: real', async () => {
  const r = await doble().api.codigoSvg('SPD-1', 'qrcode');
  assert.ok(r.ok && r.datos.startsWith('<svg'));
  assert.equal((await doble().api.codigoSvg('', 'qrcode')).ok, false);
});

test('consultarCima: usa el fetch inyectado y devuelve disponible:false si no hay datos', async () => {
  let url = '';
  const { api } = doble({ fetch: async (u) => { url = u; return { ok: true, status: 404, headers: { get: () => null }, text: async () => '' }; } });
  const r = await api.consultarCima('654321');
  assert.ok(r.ok && !r.datos.disponible);
  assert.equal(url, 'https://cima.aemps.es/cima/rest/medicamento?cn=654321');
});
