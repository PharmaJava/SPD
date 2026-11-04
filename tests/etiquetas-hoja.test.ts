import { test } from 'node:test';
import assert from 'node:assert/strict';
import { A4_ALTO_MM, A4_ANCHO_MM, renderizarEtiqueta, validarPlantilla } from '../src/dominio/etiquetas.ts';
import {
  CONFIG_IMPRESION_POR_DEFECTO, PLANTILLAS_HOJA, componerImpresion, hojaDePrueba, huecosPorHoja, libresDesde, normalizarConfigImpresion, partesDocumento,
  plantillaParaTamano, posicionesHoja, repartirEnHojas, siguientePosicionLibre, tamanoDeEtiqueta, validarAjustable, validarConfigImpresion, validarRejilla, validarRollo,
} from '../src/dominio/etiquetas-hoja.ts';
import type { ConfigImpresion } from '../src/dominio/etiquetas-hoja.ts';
import { argumentosPdf } from '../src/principal/impresion.ts';

// Datos ficticios
const DATOS = {
  farmacia: { nombre: 'Farmacia de Prueba', telefono: '000000000' }, paciente: { nombre_completo: 'Paciente Ficticio' },
  preparacion: { id_publico: 'ABC123', caducidad: '2026-12-01' }, periodo: { inicio: '2026-11-01', fin: '2026-11-14' }, prep: { iniciales: 'AA' }, val: { iniciales: 'BB' }, aparte: [],
  tomas: [{ fecha: '2026-11-01', momentoNombre: 'Desayuno', medicamentos: [{ nombre: 'Medicamento Uno', unidades: 1, lote: 'L1', caducidad: '2028-05' }] }], unidadesEsperadas: 1,
};
const cfg = (m: Partial<ConfigImpresion> = {}): ConfigImpresion => ({ ...structuredClone(CONFIG_IMPRESION_POR_DEFECTO), ...m });
const etiquetaPara = (ancho: number, alto: number) => renderizarEtiqueta(plantillaParaTamano(ancho, alto), DATOS);
const num = (html: string, re: RegExp) => Number(re.exec(html)?.[1]);

test('las plantillas de hoja son válidas, caben en el folio y no llevan marcas comerciales', () => {
  assert.deepEqual(PLANTILLAS_HOJA.map((p) => p.nombre), ['3×7 · 63,5×38,1 mm', '2×7 · 99,1×38,1 mm', '2×4 · 99,1×67,7 mm', '3×8 · 70×36 mm']);
  for (const p of PLANTILLAS_HOJA) {
    assert.deepEqual(validarRejilla(p.rejilla), [], p.nombre);
    assert.doesNotMatch(p.nombre, /avery|apli|herma|zweckform|dymo|brother/i);
  }
});

test('validarRejilla: rechaza lo que no cabe en el A4 y lo absurdo', () => {
  const r = PLANTILLAS_HOJA[0].rejilla;
  assert.ok(validarRejilla({ ...r, columnas: 4 }).some((m) => /no cabe en el folio.*ancho/.test(m)));
  assert.ok(validarRejilla({ ...r, filas: 8 }).some((m) => /no cabe en el folio.*alto/.test(m)));
  assert.ok(validarRejilla({ ...r, margenIzqMm: 20 }).length > 0);
  assert.ok(validarRejilla({ ...r, anchoMm: 0 }).length > 0);
  assert.ok(validarRejilla({ ...r, columnas: 2.5 }).length > 0);
  assert.ok(validarRejilla({ ...r, separacionVMm: -1 }).length > 0);
  assert.ok(validarRejilla({ ...r, filas: NaN }).length > 0);
  assert.ok(validarRejilla(null).length > 0);
  // justo al límite sí cabe (3×70 = 210)
  assert.deepEqual(validarRejilla(PLANTILLAS_HOJA[3].rejilla), []);
  assert.ok(validarRejilla({ ...PLANTILLAS_HOJA[3].rejilla, margenIzqMm: 0.5 }).length > 0);
});

test('posiciones de la rejilla 3×7 en mm', () => {
  const p = posicionesHoja(PLANTILLAS_HOJA[0].rejilla);
  assert.equal(p.length, 21);
  assert.deepEqual(p[0], { fila: 1, columna: 1, xMm: 7.2, yMm: 15.15 });
  assert.deepEqual(p[1], { fila: 1, columna: 2, xMm: 73.2, yMm: 15.15 });     // 7,2 + 63,5 + 2,5
  assert.deepEqual(p[3], { fila: 2, columna: 1, xMm: 7.2, yMm: 53.25 });      // 15,15 + 38,1
  assert.deepEqual(p[20], { fila: 7, columna: 3, xMm: 139.2, yMm: 243.75 });
});

test('reparto en hojas: respeta la primera libre y pasa a una hoja nueva desde el hueco 1', () => {
  const r = PLANTILLAS_HOJA[0].rejilla; // 21 huecos
  const a = repartirEnHojas(r, { fila: 7, columna: 2 }, 4);    // quedan 2 en la primera (7,2 y 7,3)
  assert.equal(a.hojas.length, 2);
  assert.deepEqual(a.hojas[0].map((x) => [x.fila, x.columna]), [[7, 2], [7, 3]]);
  assert.deepEqual(a.hojas[1].map((x) => [x.fila, x.columna]), [[1, 1], [1, 2]]);
  assert.deepEqual(a.siguiente, { fila: 1, columna: 3 });
  const b = repartirEnHojas(r, { fila: 1, columna: 1 }, 21);   // hoja justa: la siguiente empieza en una hoja nueva
  assert.equal(b.hojas.length, 1);
  assert.deepEqual(b.siguiente, { fila: 1, columna: 1 });
  assert.deepEqual(siguientePosicionLibre(r, { fila: 2, columna: 3 }, 1), { fila: 3, columna: 1 });
  assert.deepEqual(siguientePosicionLibre(r, { fila: 1, columna: 1 }, 0), { fila: 1, columna: 1 });
  assert.equal(libresDesde(r, { fila: 7, columna: 3 }), 1);
  assert.equal(libresDesde(r, { fila: 1, columna: 1 }), huecosPorHoja(r));
  assert.equal(repartirEnHojas(r, { fila: 1, columna: 1 }, 0).hojas.length, 0);
});

test('configuración: validar y normalizar (lo corrupto vuelve a valores seguros)', () => {
  assert.deepEqual(validarConfigImpresion(CONFIG_IMPRESION_POR_DEFECTO), []);
  assert.ok(validarConfigImpresion({ ...CONFIG_IMPRESION_POR_DEFECTO, modo: 'otro' }).length > 0);
  assert.ok(validarConfigImpresion({ ...CONFIG_IMPRESION_POR_DEFECTO, ajustable: { escalaPct: 24, dxMm: 0, dyMm: 0 } }).length > 0);
  assert.ok(validarConfigImpresion({ ...CONFIG_IMPRESION_POR_DEFECTO, hoja: { ...CONFIG_IMPRESION_POR_DEFECTO.hoja, primeraLibre: { fila: 8, columna: 1 } } }).length > 0);
  assert.ok(validarConfigImpresion({ ...CONFIG_IMPRESION_POR_DEFECTO, rollo: { anchoMm: 5, altoMm: 40 } }).length > 0);
  assert.deepEqual(normalizarConfigImpresion(undefined), CONFIG_IMPRESION_POR_DEFECTO);
  assert.deepEqual(normalizarConfigImpresion('basura'), CONFIG_IMPRESION_POR_DEFECTO);
  const n = normalizarConfigImpresion({ modo: 'hoja', rollo: { anchoMm: 60, altoMm: 40 }, hoja: { ...PLANTILLAS_HOJA[2].rejilla, primeraLibre: { fila: 9, columna: 1 } }, ajustable: { escalaPct: 500, dxMm: 0, dyMm: 0 } });
  assert.equal(n.modo, 'hoja');
  assert.deepEqual(n.rollo, { anchoMm: 60, altoMm: 40 });
  assert.equal(n.hoja.columnas, 2);
  assert.deepEqual(n.hoja.primeraLibre, { fila: 1, columna: 1 });    // la fila 9 no existe en 2×4
  assert.deepEqual(n.ajustable, CONFIG_IMPRESION_POR_DEFECTO.ajustable);
});

test('escala: 25–200 %; desplazamiento acotado', () => {
  for (const e of [25, 100, 200]) assert.deepEqual(validarAjustable({ escalaPct: e, dxMm: 0, dyMm: 0 }), []);
  for (const e of [24.9, 201, NaN, '100']) assert.ok(validarAjustable({ escalaPct: e, dxMm: 0, dyMm: 0 }).length > 0, String(e));
  assert.ok(validarAjustable({ escalaPct: 100, dxMm: 101, dyMm: 0 }).length > 0);
  assert.deepEqual(validarRollo({ anchoMm: 100, altoMm: 150 }), []);
  assert.ok(validarRollo({ anchoMm: 301, altoMm: 150 }).length > 0);
});

test('modo A (rollo): una etiqueta por copia, página del tamaño del rollo y mismo tamaño que el PDF', () => {
  const e = etiquetaPara(100, 150);
  assert.equal(e.imprimible, true);
  const c = componerImpresion(e.html, cfg({ modo: 'rollo' }), 'rollo', 3);
  assert.deepEqual(c.problemas, []);
  assert.equal(c.paginas, 3);
  assert.equal(c.etiquetas, 3);
  assert.deepEqual([c.anchoMm, c.altoMm], [100, 150]);
  assert.match(c.html, /@page\{size:100mm 150mm;margin:0\}/);
  assert.equal((c.html.match(/<section class="pg">/g) ?? []).length, 3);
  const pdf = argumentosPdf({ anchoMm: c.anchoMm, altoMm: c.altoMm });
  assert.ok(Math.abs((pdf.pageSize as { width: number }).width - 100 / 25.4) < 1e-9);
  // rollo de otro tamaño: la etiqueta se compone para ese espacio y se acepta
  const e2 = etiquetaPara(60, 40);
  const c2 = componerImpresion(e2.html, cfg({ modo: 'rollo', rollo: { anchoMm: 60, altoMm: 40 } }), 'rollo', 1);
  assert.deepEqual(c2.problemas, []);
  assert.deepEqual([c2.anchoMm, c2.altoMm], [60, 40]);
});

test('una etiqueta que no tiene el tamaño de su rollo o de su celda NO se coloca', () => {
  const e = etiquetaPara(100, 150);
  const r = componerImpresion(e.html, cfg({ rollo: { anchoMm: 60, altoMm: 40 } }), 'rollo');
  assert.equal(r.html, '');
  assert.ok(r.problemas.some((p) => /no tiene el tamaño del rollo/.test(p)));
  const h = componerImpresion(e.html, cfg(), 'hoja');
  assert.equal(h.html, '');
  assert.ok(h.problemas.some((p) => /no tiene el tamaño de la etiqueta de la hoja/.test(p)));
});

test('modo B (hoja): las etiquetas van en las posiciones calculadas en mm, saltando las usadas', () => {
  const r = PLANTILLAS_HOJA[0].rejilla;
  const e = etiquetaPara(r.anchoMm, r.altoMm);
  const config = cfg({ modo: 'hoja', hoja: { ...r, primeraLibre: { fila: 2, columna: 3 } } });
  const c = componerImpresion(e.html, config, 'hoja', 3);
  assert.deepEqual(c.problemas, []);
  assert.deepEqual([c.anchoMm, c.altoMm], [A4_ANCHO_MM, A4_ALTO_MM]);
  assert.match(c.html, /@page\{size:210mm 297mm;margin:0\}/);
  const celdas = [...c.html.matchAll(/<div class="cel" data-fila="(\d+)" data-columna="(\d+)" style="left:([\d.]+)mm;top:([\d.]+)mm;width:([\d.]+)mm;height:([\d.]+)mm">/g)].map((m) => m.slice(1).map(Number));
  assert.deepEqual(celdas, [[2, 3, 139.2, 53.25, 63.5, 38.1], [3, 1, 7.2, 91.35, 63.5, 38.1], [3, 2, 73.2, 91.35, 63.5, 38.1]]);
  assert.deepEqual(c.siguiente, { fila: 3, columna: 3 });
  // las posiciones usadas (fila 1 y fila 2, columnas 1-2) no llevan etiqueta
  assert.ok(!celdas.some(([f, col]) => f === 1 || (f === 2 && col < 3)));
  // más copias que huecos: segunda hoja
  const d = componerImpresion(e.html, config, 'hoja', 21);
  assert.equal(d.paginas, 2);
  assert.equal((d.html.match(/<div class="cel"/g) ?? []).length, 21);
  assert.equal(d.etiquetas, 21);
});

test('modo B: copias fuera de rango o rejilla que no cabe → no se genera nada', () => {
  const r = PLANTILLAS_HOJA[0].rejilla;
  const e = etiquetaPara(r.anchoMm, r.altoMm);
  assert.equal(componerImpresion(e.html, cfg({ modo: 'hoja' }), 'hoja', 0).html, '');
  assert.equal(componerImpresion(e.html, cfg({ modo: 'hoja' }), 'hoja', 101).html, '');
  assert.equal(componerImpresion(e.html, cfg({ modo: 'hoja' }), 'hoja', 1.5).html, '');
  const mala = cfg({ modo: 'hoja', hoja: { ...r, columnas: 4, primeraLibre: { fila: 1, columna: 1 } } });
  assert.equal(componerImpresion(e.html, mala, 'hoja').html, '');
});

test('modo C (ajustable): escala y desplazamiento en la página A4', () => {
  const e = etiquetaPara(100, 150);
  const c = componerImpresion(e.html, cfg({ modo: 'ajustable', ajustable: { escalaPct: 50, dxMm: 12.5, dyMm: 8 } }), 'ajustable');
  assert.deepEqual(c.problemas, []);
  assert.match(c.html, /left:12.5mm;top:8mm;width:100mm;height:150mm;transform:scale\(0.5\)/);
  assert.deepEqual([c.anchoMm, c.altoMm], [210, 297]);
  assert.equal(c.paginas, 1);
  assert.ok(c.avisos.some((a) => /Escala del 50 %/.test(a)));
  const grande = componerImpresion(e.html, cfg({ modo: 'ajustable', ajustable: { escalaPct: 100, dxMm: 0, dyMm: 0 } }), 'ajustable');
  assert.deepEqual(grande.avisos, []);
});

test('modo C: si la etiqueta se saldría de la hoja, NO se imprime', () => {
  const e = etiquetaPara(100, 150);
  const a = (escalaPct: number, dxMm: number, dyMm: number) => componerImpresion(e.html, cfg({ modo: 'ajustable', ajustable: { escalaPct, dxMm, dyMm } }), 'ajustable');
  assert.deepEqual(a(200, 0, 0).problemas.filter((p) => /derecha/.test(p)), []);   // 200 mm de ancho cabe; 300 mm de alto no
  assert.ok(a(200, 11, 0).problemas.some((p) => /derecha/.test(p)));
  assert.ok(a(200, 0, 0).problemas.some((p) => /abajo/.test(p)));
  assert.ok(a(150, 61, 0).problemas.some((p) => /derecha/.test(p)));
  assert.ok(a(100, -1, 0).problemas.some((p) => /izquierda/.test(p)));
  assert.ok(a(100, 0, -1).problemas.some((p) => /arriba/.test(p)));
  assert.equal(a(150, 61, 0).html, '');
  assert.deepEqual(a(140, 70, 87).problemas, []);                          // 70+140 = 210 y 87+210 = 297: justo
  assert.ok(a(100, 101, 0).problemas.some((p) => /desplazamiento/.test(p)));
  assert.equal(a(24, 0, 0).html, '');
});

test('la marca de agua de un borrador pasa a todos los modos (una vez, sobre toda la página)', () => {
  const e = etiquetaPara(100, 150);
  const conMarca = e.html.replace('</head>', '<style>.marca-agua{position:fixed}</style></head>').replace('</body>', '<div class="marca-agua">SIN VALIDAR</div></body>');
  const p = partesDocumento(conMarca)!;
  assert.equal(p.marca, '<div class="marca-agua">SIN VALIDAR</div>');
  assert.ok(!p.etiqueta.includes('marca-agua'));
  for (const m of ['rollo', 'ajustable'] as const) {
    const c = componerImpresion(conMarca, cfg(), m);
    assert.equal((c.html.match(/class="marca-agua"/g) ?? []).length, 1, m);
  }
});

test('hoja de prueba: sin datos, del tamaño de la impresión real y con la rejilla marcada', () => {
  const r = PLANTILLAS_HOJA[0].rejilla;
  const h = hojaDePrueba(cfg({ modo: 'hoja', hoja: { ...r, primeraLibre: { fila: 1, columna: 3 } } }), 'hoja');
  assert.deepEqual(h.problemas, []);
  assert.deepEqual([h.anchoMm, h.altoMm], [210, 297]);
  assert.equal((h.html.match(/class="r( u)?" style="left/g) ?? []).length, 21);
  assert.equal((h.html.match(/ · usada/g) ?? []).length, 2);
  assert.match(h.html, /1,3 · primera libre/);
  assert.match(h.html, /left:7.2mm;top:15.15mm;width:63.5mm;height:38.1mm/);
  const rollo = hojaDePrueba(cfg({ rollo: { anchoMm: 60, altoMm: 40 } }), 'rollo');
  assert.deepEqual([rollo.anchoMm, rollo.altoMm], [60, 40]);
  assert.match(rollo.html, /Prueba · 60×40 mm/);
  const aj = hojaDePrueba(cfg({ ajustable: { escalaPct: 80, dxMm: 5, dyMm: 6 } }), 'ajustable');
  assert.match(aj.html, /left:5mm;top:6mm;width:80mm;height:120mm/);
  assert.match(aj.html, /Escala 80 % · X 5 mm · Y 6 mm/);
  assert.equal(hojaDePrueba(cfg({ ajustable: { escalaPct: 200, dxMm: 0, dyMm: 0 } }), 'ajustable').html, '');
  assert.equal(hojaDePrueba(cfg({ hoja: { ...r, columnas: 4, primeraLibre: { fila: 1, columna: 1 } } }), 'hoja').html, '');
  for (const x of [h, rollo, aj]) assert.ok(!/Paciente|Farmacia/.test(x.html));
});

test('tamaño de etiqueta que se pide al servicio según el modo', () => {
  assert.deepEqual(tamanoDeEtiqueta(cfg({ rollo: { anchoMm: 62, altoMm: 29 } }), 'rollo'), { anchoMm: 62, altoMm: 29 });
  assert.deepEqual(tamanoDeEtiqueta(cfg(), 'hoja'), { anchoMm: 63.5, altoMm: 38.1 });
  assert.deepEqual(tamanoDeEtiqueta(cfg(), 'ajustable'), { anchoMm: 100, altoMm: 150 });
});

test('plantilla para otro tamaño: válida, código cuadrado, y el estándar no cambia', () => {
  assert.equal(JSON.stringify(plantillaParaTamano(100, 150)).includes('"w":94'), true);
  for (const [w, h] of [[63.5, 38.1], [99.1, 67.7], [70, 36], [60, 40], [150, 100]]) {
    const p = plantillaParaTamano(w, h);
    assert.deepEqual(validarPlantilla(p), [], `${w}×${h}`);
    const cod = p.bloques.find((b) => b.tipo === 'codigo')!;
    assert.equal(cod.w, cod.h);
    assert.ok(p.bloques.some((b) => b.tipo === 'tabla_tomas' && b.modo === 'auto'));
  }
});

test('una etiqueta que no cabe en una celda pequeña NO es imprimible (no se recorta en silencio)', () => {
  const muchas = { ...DATOS, tomas: Array.from({ length: 14 }, (_, i) => ({ fecha: `2026-11-${String(i + 1).padStart(2, '0')}`, momentoNombre: 'Desayuno',
    medicamentos: [{ nombre: 'Medicamento Con Nombre Largo 850 mg', unidades: 1, lote: 'LOTE-123', caducidad: '2028-05' }] })), unidadesEsperadas: 14 };
  const r = renderizarEtiqueta(plantillaParaTamano(63.5, 38.1), muchas);
  assert.equal(r.imprimible, false);
  assert.ok(r.problemas.some((p) => /no cabe/.test(p)));
});
