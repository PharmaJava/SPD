import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validarPlantilla, renderizarEtiqueta, renderizarPlancha, filasTablaTomas, elegirModoEtiqueta, resumirTomas,
  formatearFechaEs, formatearNumeroEs, formatearUnidades, PLANTILLA_DOC07_RESUMIBLE, TEXTO_SIN_DESCRIPCION,
} from '../src/dominio/etiquetas.ts';
import type { Plantilla, TomaEntrada, Bloque } from '../src/dominio/etiquetas.ts';

const clonar = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const plantilla = (): Plantilla => clonar(PLANTILLA_DOC07_RESUMIBLE);
function conTabla(cambios: Partial<Bloque>, raiz: Partial<Plantilla> = {}): Plantilla {
  const p = plantilla();
  const b = p.bloques.find((x) => x.tipo === 'tabla_tomas')!;
  Object.assign(b, cambios);
  return Object.assign(p, raiz);
}

const dia = (n: number) => `2026-11-${String(n).padStart(2, '0')}`;

/** n días, 2 tomas al día; metformina 1 ud por toma (2 al día), con dos lotes; alendronato opcional. */
function tomas(n: number, opc: { alendronato?: boolean; descripcion?: boolean } = {}): TomaEntrada[] {
  const r: TomaEntrada[] = [];
  for (let d = 1; d <= n; d++) {
    for (const m of ['Desayuno', 'Cena']) {
      const meds = [{
        nombre: 'Metformina 850 mg', unidades: 1, lote: d <= 7 ? 'L1' : 'L2', caducidad: d <= 7 ? '2028-05' : '2027-11',
        ...(opc.descripcion === false ? {} : { descripcion: 'Comprimido blanco, redondo' }),
      }];
      if (opc.alendronato && m === 'Desayuno') meds.push({ nombre: 'Alendronato 70 mg', unidades: 0.25, lote: 'A9', caducidad: '2027-03' });
      r.push({ fecha: dia(d), momentoNombre: m, medicamentos: meds });
    }
  }
  return r;
}

function datos(t: TomaEntrada[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    farmacia: { nombre: 'Farmacia Ñandú', telefono: '954 000 000' },
    paciente: { nombre_completo: 'María Peña Núñez' },
    preparacion: { id_publico: 'SPD-8F3K', caducidad: '2026-12-01' },
    periodo: { inicio: '2026-11-01', fin: '2026-11-14' },
    prep: { iniciales: 'AB' }, val: { iniciales: 'CD' },
    tomas: t, aparte: [], ...extra,
  };
}

// ───────────────────────── (a) unidades esperadas ─────────────────────────

test('(a) unidadesEsperadas que coincide: imprimible', () => {
  const r = renderizarEtiqueta(plantilla(), datos(tomas(3), { unidadesEsperadas: 6 }));
  assert.equal(r.imprimible, true, r.problemas.join('|'));
});
test('(a) faltan unidades: no imprimible y lo dice', () => {
  const r = renderizarEtiqueta(plantilla(), datos(tomas(3).slice(0, 5), { unidadesEsperadas: 6 }));
  assert.equal(r.imprimible, false);
  assert.ok(r.problemas.some((p) => /faltan tomas/.test(p) && p.includes('5') && p.includes('6')));
});
test('(a) sobran unidades: no imprimible', () => {
  const r = renderizarEtiqueta(plantilla(), datos(tomas(3), { unidadesEsperadas: 5 }));
  assert.equal(r.imprimible, false);
  assert.ok(r.problemas.some((p) => /sobran tomas/.test(p)));
});
test('(a) sin unidadesEsperadas todo sigue igual (retrocompatible)', () => {
  const r = renderizarEtiqueta(plantilla(), datos(tomas(3).slice(0, 5)));
  assert.equal(r.imprimible, true);
});
test('(a) unidadesEsperadas inválido bloquea (NaN, negativo, texto)', () => {
  for (const v of [NaN, -1, '6', null, Infinity]) {
    const r = renderizarEtiqueta(plantilla(), datos(tomas(3), { unidadesEsperadas: v }));
    assert.equal(r.imprimible, false, String(v));
    assert.ok(r.problemas.some((p) => p.includes('unidadesEsperadas')), String(v));
  }
});
test('(a) fracciones: 0.1+0.2 cuadra con 0.3 (sin ruido de coma flotante)', () => {
  const t: TomaEntrada[] = [{ fecha: dia(1), momentoNombre: 'Desayuno', medicamentos: [
    { nombre: 'X', unidades: 0.1, lote: 'L', caducidad: '2027-01' }, { nombre: 'Y', unidades: 0.2, lote: 'L', caducidad: '2027-01' }] }];
  assert.equal(renderizarEtiqueta(plantilla(), datos(t, { unidadesEsperadas: 0.3 })).imprimible, true);
  assert.equal(renderizarEtiqueta(plantilla(), datos(t, { unidadesEsperadas: 0.35 })).imprimible, false);
});
test('(a) plantilla sin bloque de tomas no puede comprobar lo esperado: bloquea', () => {
  const p = plantilla();
  p.bloques = p.bloques.filter((b) => b.tipo !== 'tabla_tomas');
  const r = renderizarEtiqueta(p, datos(tomas(3), { unidadesEsperadas: 6 }));
  assert.equal(r.imprimible, false);
  assert.ok(r.problemas.some((x) => /no tiene bloque de tomas/.test(x)));
});
test('(a) también en modo resumen se comprueba lo esperado', () => {
  const ok = renderizarEtiqueta(plantilla(), datos(tomas(14), { unidadesEsperadas: 28 }));
  assert.equal(ok.modo, 'resumen');
  assert.equal(ok.imprimible, true, ok.problemas.join('|'));
  const mal = renderizarEtiqueta(plantilla(), datos(tomas(14).slice(0, 27), { unidadesEsperadas: 28 }));
  assert.equal(mal.modo, 'resumen');
  assert.equal(mal.imprimible, false);
});
test('(a) en plancha, una etiqueta con tomas ausentes bloquea toda la tanda', () => {
  const p = plantilla();
  p.pagina = { ancho_mm: 99.1, alto_mm: 38.1 };
  p.bloques = [{ tipo: 'tabla_tomas', modo: 'auto', x: 0, y: 0, w: 90, h: 30, columnas: ['medicamento'] }];
  const plancha = { filas: 7, columnas: 2, ancho_etiqueta_mm: 99.1, alto_etiqueta_mm: 38.1, margen_sup_mm: 15.1, margen_izq_mm: 4.65, paso_h_mm: 101.6, paso_v_mm: 38.1 };
  const ok = renderizarPlancha(p, [datos(tomas(1), { unidadesEsperadas: 2 })], plancha);
  assert.equal(ok.imprimible, true, ok.problemas.join('|'));
  const mal = renderizarPlancha(p, [datos(tomas(1), { unidadesEsperadas: 2 }), datos(tomas(1), { unidadesEsperadas: 3 })], plancha);
  assert.equal(mal.imprimible, false);
  assert.ok(mal.problemas.some((x) => x.startsWith('Etiqueta 2')));
});

// ───────────────────────── (b) elegir modo + resumen ─────────────────────────

test('(b) elegirModoEtiqueta: 3 días caben en tabla completa', () => {
  const d = elegirModoEtiqueta(plantilla(), tomas(3));
  assert.equal(d.modo, 'completa');
  assert.equal(d.cabe, true);
});
test('(b) elegirModoEtiqueta: 14 días pasan a resumen y el resumen cabe', () => {
  const d = elegirModoEtiqueta(plantilla(), tomas(14, { alendronato: true }));
  assert.equal(d.modo, 'resumen');
  assert.equal(d.cabeCompleta, false);
  assert.equal(d.cabeResumen, true);
  assert.equal(d.cabe, true);
  assert.equal(d.sinCodigo, false);
});
test('(b) la plantilla de docs/07 con modo auto: 14 días son imprimibles (con QR)', () => {
  const r = renderizarEtiqueta(plantilla(), datos(tomas(14, { alendronato: true }), { unidadesEsperadas: 28 + 3.5 }));
  assert.equal(r.modo, 'resumen');
  assert.equal(r.imprimible, true, r.problemas.join('|'));
  assert.match(r.html, /data-codigo="SPD-8F3K" data-simbologia="qrcode"/);
  assert.match(r.html, /RESUMEN DEL PERIODO/);
});
test('(b) sin modo (histórico) la misma plantilla NO admite 14 días y no recorta', () => {
  const p = plantilla();
  delete p.bloques.find((b) => b.tipo === 'tabla_tomas')!.modo;
  const r = renderizarEtiqueta(p, datos(tomas(14)));
  assert.equal(r.modo, 'completa');
  assert.equal(r.cabe, false);
  assert.equal(r.imprimible, false);
});
test('(b) el resumen lleva TODOS los lotes con su caducidad (dd/mm/aaaa)', () => {
  const r = renderizarEtiqueta(plantilla(), datos(tomas(14)));
  assert.match(r.html, /Metformina 850 mg — 2 al día — lotes: L1 \(cad 05\/2028\), L2 \(cad 11\/2027\)/);
});
test('(b) un mismo lote con otra caducidad es otro par: no se fusiona', () => {
  const t = tomas(14);
  t[27].medicamentos[0] = { ...t[27].medicamentos[0], lote: 'L1', caducidad: '2026-12' };
  const g = resumirTomas(filasTablaTomas(t))[0];
  assert.deepEqual(g.lotes.map((l) => `${l.lote}/${l.caducidad}`), ['L1/2028-05', 'L2/2027-11', 'L1/2026-12']);
  const r = renderizarEtiqueta(plantilla(), datos(t));
  assert.match(r.html, /L1 \(cad 05\/2028\), L2 \(cad 11\/2027\), L1 \(cad 12\/2026\)/);
});
test('(b) la descripción física va en el resumen y, si falta, se dice', () => {
  const r = renderizarEtiqueta(plantilla(), datos(tomas(14, { alendronato: true })));
  assert.match(r.html, /Comprimido blanco, redondo/);
  assert.match(r.html, new RegExp(`Alendronato 70 mg — [^<]*— ${TEXTO_SIN_DESCRIPCION}`));
  assert.ok(r.avisos.some((a) => a.includes('Alendronato')));
});
test('(b) pauta variable: no inventa un «al día»', () => {
  const t = tomas(14);
  t[0].medicamentos[0] = { ...t[0].medicamentos[0], unidades: 2 };
  const g = resumirTomas(filasTablaTomas(t))[0];
  assert.equal(g.porDia, null);
  assert.equal(g.dias, 14);
  assert.equal(g.unidadesTotales, 29);
  const r = renderizarEtiqueta(plantilla(), datos(t));
  assert.match(r.html, /29 en 14 días \(pauta variable\)/);
});
test('(b) lote o caducidad ausentes en el resumen: marca y no imprimible', () => {
  const t = tomas(14);
  t[3].medicamentos[0] = { ...t[3].medicamentos[0], lote: '' };
  const r = renderizarEtiqueta(plantilla(), datos(t));
  assert.equal(r.imprimible, false);
  assert.match(r.html, /⟦lote⟧/);
  assert.ok(r.faltan.some((f) => f.includes('lote_caducidad')));
});
test('(b) resumen sin bloque «codigo»: bloquea (la hoja A4 no sería alcanzable)', () => {
  const p = plantilla();
  p.bloques = p.bloques.filter((b) => b.tipo !== 'codigo');
  assert.equal(elegirModoEtiqueta(p, tomas(14)).sinCodigo, true);
  const r = renderizarEtiqueta(p, datos(tomas(14)));
  assert.equal(r.imprimible, false);
  assert.ok(r.problemas.some((x) => /codigo/.test(x)));
  // con 1 día no hace falta resumen ni código
  assert.equal(renderizarEtiqueta(p, datos(tomas(1))).imprimible, true);
});
test('(b) nunca recorta: si ni el resumen cabe, cabe:false y no imprimible', () => {
  const p = conTabla({ h: 6 });
  const d = elegirModoEtiqueta(p, tomas(14, { alendronato: true }));
  assert.equal(d.modo, 'resumen');
  assert.equal(d.cabe, false);
  const r = renderizarEtiqueta(p, datos(tomas(14, { alendronato: true })));
  assert.equal(r.imprimible, false);
  assert.match(r.html, /nocabe/);
  assert.match(r.html, /L2 \(cad 11\/2027\)/, 'el texto sigue completo aunque no quepa');
});
test('(b) modo «resumen» forzado y tipo resumen_periodo, aunque la tabla quepa', () => {
  const forzado = renderizarEtiqueta(conTabla({ modo: 'resumen' }), datos(tomas(2)));
  assert.equal(forzado.modo, 'resumen');
  const p = plantilla();
  const bt = p.bloques.find((b) => b.tipo === 'tabla_tomas')!;
  delete bt.modo;
  bt.tipo = 'resumen_periodo';
  assert.deepEqual(validarPlantilla(p), []);
  assert.equal(renderizarEtiqueta(p, datos(tomas(2))).modo, 'resumen');
});
test('(b) elegirModoEtiqueta sin bloque de tomas no puede imprimir', () => {
  const p = plantilla();
  p.bloques = p.bloques.filter((b) => b.tipo === 'texto');
  const d = elegirModoEtiqueta(p, tomas(1));
  assert.equal(d.cabe, false);
  assert.match(d.motivo, /bloque de tomas/);
});
test('(b) el nombre del medicamento se escapa en el resumen', () => {
  const t = tomas(14);
  for (const x of t) x.medicamentos[0].nombre = 'Evil <img src=x onerror=1>';
  const r = renderizarEtiqueta(plantilla(), datos(t));
  assert.ok(!r.html.includes('<img'));
  assert.ok(r.html.includes('&lt;img'));
});
test('(b) resumirTomas: unidades totales y días de cada medicamento', () => {
  const gs = resumirTomas(filasTablaTomas(tomas(14, { alendronato: true })));
  assert.deepEqual(gs.map((g) => g.medicamento), ['Metformina 850 mg', 'Alendronato 70 mg']);
  assert.equal(gs[0].unidadesTotales, 28);
  assert.equal(gs[1].unidadesTotales, 3.5);
  assert.equal(gs[1].porDia, 0.25);
  assert.equal(gs[1].dias, 14);
});
test('(b) validarPlantilla: modo desconocido o en un bloque que no es de tomas', () => {
  const p = conTabla({ modo: 'raro' as never });
  assert.ok(validarPlantilla(p).some((e) => e.includes('modo desconocido')));
  const q = plantilla();
  q.bloques[0].modo = 'auto';
  assert.ok(validarPlantilla(q).some((e) => e.includes('sólo es válido en tabla_tomas')));
});

// ───────────────────────── (c) descripción física ─────────────────────────

test('(c) filasTablaTomas conserva la descripción y no inventa la clave si falta', () => {
  const f = filasTablaTomas(tomas(1, { alendronato: true }));
  assert.equal(f[0].descripcion, 'Comprimido blanco, redondo');
  assert.ok(!('descripcion' in f[1]));
  assert.ok(!('descripcion' in filasTablaTomas([{ fecha: dia(1), momentoNombre: 'D', medicamentos: [{ nombre: 'A', unidades: 1, lote: 'l', caducidad: '2027-01', descripcion: '   ' }] }])[0]));
});
test('(c) la columna «descripcion» se imprime en la tabla completa', () => {
  const r = renderizarEtiqueta(plantilla(), datos(tomas(2)));
  assert.equal(r.modo, 'completa');
  assert.match(r.html, /<td>Comprimido blanco, redondo<\/td>/);
});
test('(c) sin ninguna descripción y sin exigirla: la columna no sale, se avisa y no bloquea', () => {
  const r = renderizarEtiqueta(plantilla(), datos(tomas(2, { descripcion: false })));
  assert.equal(r.imprimible, true);
  assert.ok(!r.html.includes(TEXTO_SIN_DESCRIPCION));
  assert.ok(r.avisos.some((a) => a.includes('Metformina')));
});
test('(c) exigirDescripcion en el bloque: la ausencia es dato faltante y bloquea', () => {
  const r = renderizarEtiqueta(conTabla({ exigirDescripcion: true }), datos(tomas(2, { descripcion: false })));
  assert.equal(r.imprimible, false);
  assert.ok(r.faltan.some((f) => f.endsWith('.descripcion')));
  assert.match(r.html, /⟦descripcion⟧/);
});
test('(c) exigirDescripcion en la plantilla entera, y también en el resumen', () => {
  const p = conTabla({}, { exigirDescripcion: true });
  assert.equal(renderizarEtiqueta(p, datos(tomas(14, { descripcion: false }))).imprimible, false);
  assert.equal(renderizarEtiqueta(p, datos(tomas(14))).imprimible, true);
});
test('(c) exigirDescripcion sólo importa si la plantilla incluye la columna', () => {
  const p = conTabla({ columnas: ['medicamento', 'lote_caducidad'], exigirDescripcion: true });
  const r = renderizarEtiqueta(p, datos(tomas(2, { descripcion: false })));
  assert.equal(r.imprimible, true, r.problemas.join('|'));
  assert.deepEqual(r.avisos, []);
});
test('(c) mezcla con y sin descripción: «sin descripción física», sin bloquear', () => {
  const r = renderizarEtiqueta(plantilla(), datos(tomas(2, { alendronato: true })));
  assert.equal(r.imprimible, true);
  assert.match(r.html, new RegExp(`<td>${TEXTO_SIN_DESCRIPCION}</td>`));
});
test('(c) la descripción se escapa', () => {
  const t = tomas(1);
  t[0].medicamentos[0].descripcion = '<b>x</b>';
  const r = renderizarEtiqueta(plantilla(), datos(t));
  assert.ok(!r.html.includes('<b>x</b>'));
});
test('(c) exigirDescripcion de tipo incorrecto no valida', () => {
  const p = conTabla({ exigirDescripcion: 'sí' as never });
  assert.ok(validarPlantilla(p).some((e) => e.includes('exigirDescripcion')));
  assert.ok(validarPlantilla({ ...plantilla(), exigirDescripcion: 1 }).some((e) => e.includes('exigirDescripcion')));
});

// ───────────────────────── (d) formato español ─────────────────────────

test('(d) formatearFechaEs', () => {
  assert.equal(formatearFechaEs('2026-11-02'), '02/11/2026');
  assert.equal(formatearFechaEs('2027-05'), '05/2027');
  assert.equal(formatearFechaEs('2026-13-45'), '2026-13-45');
  assert.equal(formatearFechaEs('2027-13'), '2027-13');
  assert.equal(formatearFechaEs('Lote 2027-05'), 'Lote 2027-05');
  assert.equal(formatearFechaEs('mañana'), 'mañana');
});
test('(d) formatearNumeroEs y formatearUnidades', () => {
  assert.equal(formatearNumeroEs(0.25), '0,25');
  assert.equal(formatearNumeroEs(0.1 + 0.2), '0,3');
  assert.equal(formatearUnidades(2), '2');
  assert.equal(formatearUnidades(0.25), '0,25 (¼)');
  assert.equal(formatearUnidades(0.5), '0,5 (½)');
  assert.equal(formatearUnidades(0.75), '0,75 (¾)');
  assert.equal(formatearUnidades(1.5), '1,5 (1½)');
  assert.equal(formatearUnidades(0.3), '0,3');
  assert.equal(formatearUnidades(NaN), 'NaN');
});
test('(d) etiqueta con formato_es: ×0,25 y fechas dd/mm/aaaa', () => {
  const r = renderizarEtiqueta(plantilla(), datos(tomas(1, { alendronato: true })));
  assert.ok(r.html.includes('×0,25 (¼)'));
  assert.ok(!r.html.includes('×0.25'));
  assert.match(r.html, /<td>01\/11\/2026<\/td>/);
  assert.match(r.html, /Cad 03\/2027/);
  assert.match(r.html, /Del 01\/11\/2026 al 14\/11\/2026 · Caduca 01\/12\/2026/);
});
test('(d) el código QR conserva el valor original (los datos no se tocan)', () => {
  const p = plantilla();
  p.bloques.find((b) => b.tipo === 'codigo')!.contenido = '{{preparacion.caducidad}}';
  const r = renderizarEtiqueta(p, datos(tomas(1)));
  assert.match(r.html, /data-codigo="2026-12-01"/);
  const entrada = datos(tomas(1));
  renderizarEtiqueta(plantilla(), entrada);
  assert.equal((entrada.periodo as { inicio: string }).inicio, '2026-11-01');
});
test('(d) sin formato_es (histórico) todo se imprime como antes', () => {
  const p = plantilla();
  delete p.formato_es;
  const r = renderizarEtiqueta(p, datos(tomas(1, { alendronato: true })));
  assert.ok(r.html.includes('×0.25'));
  assert.ok(r.html.includes('2026-11-01'));
  assert.match(r.html, /Cad 2027-03/);
});
test('(d) formato_es no español-iza un dato raro (queda visible)', () => {
  const t = tomas(1);
  t[0].fecha = '2026-13-45';
  assert.match(renderizarEtiqueta(plantilla(), datos(t)).html, /2026-13-45/);
});
test('(d) formato_es de tipo incorrecto no valida', () => {
  assert.ok(validarPlantilla({ ...plantilla(), formato_es: 'si' as never }).some((e) => e.includes('formato_es')));
});
test('(d) la plantilla de partida es válida', () => {
  assert.deepEqual(validarPlantilla(PLANTILLA_DOC07_RESUMIBLE), []);
});

// ───────────────────────── documentación ─────────────────────────

test('docs/07 documenta la etiqueta resumida', () => {
  const doc = readFileSync(new URL('../docs/07-etiquetas-e-impresion.md', import.meta.url), 'utf8');
  assert.match(doc, /Etiqueta resumida/);
  assert.match(doc, /elegirModoEtiqueta/);
  assert.match(doc, /unidadesEsperadas/);
  assert.match(doc, /exigirDescripcion/);
});
