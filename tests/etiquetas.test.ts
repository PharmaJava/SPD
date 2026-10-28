import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validarPlantilla, avisosPlantilla, resolverVariables, ajustarTexto, renderizarEtiqueta,
  posicionesPlancha, renderizarPlancha, filasTablaTomas, escaparHtml, VARIABLES_PERMITIDAS,
} from '../src/dominio/etiquetas.ts';
import type { Plantilla, Plancha } from '../src/dominio/etiquetas.ts';

const PLANCHA: Plancha = {
  filas: 7, columnas: 2, ancho_etiqueta_mm: 99.1, alto_etiqueta_mm: 38.1,
  margen_sup_mm: 15.1, margen_izq_mm: 4.65, paso_h_mm: 101.6, paso_v_mm: 38.1, primera_libre: 1,
};

const DATOS = {
  farmacia: { nombre: 'Farmacia Ñandú', telefono: '954 000 000', direccion: 'C/ Sierpes 1' },
  paciente: { nombre_completo: 'María Peña Núñez', id_corto: 'MPN-01' },
  preparacion: { id_publico: 'SPD-8F3K', caducidad: '2026-12-01' },
  periodo: { inicio: '2026-11-02', fin: '2026-11-29' },
  prep: { iniciales: 'AB' }, val: { iniciales: 'CD' },
  tomas: [{ fecha: '2026-11-02', momentoNombre: 'Desayuno', medicamentos: [{ nombre: 'Enalapril 5 mg', unidades: 1, lote: 'L123', caducidad: '2027-05' }] }],
  aparte: ['Insulina'],
};

function plantilla(): Plantilla {
  return {
    pagina: { ancho_mm: 100, alto_mm: 150, orientacion: 'vertical' },
    plancha: null,
    margenes_mm: [3, 3, 3, 3],
    fuente_base_pt: 7,
    bloques: [
      { tipo: 'texto', x: 0, y: 0, w: 94, h: 8, contenido: '{{farmacia.nombre}} · {{farmacia.telefono}}', negrita: true },
      { tipo: 'texto', x: 0, y: 9, w: 94, h: 6, contenido: '{{paciente.nombre_completo}}', tam_pt: 10 },
      { tipo: 'tabla_tomas', x: 0, y: 16, w: 94, h: 80, columnas: ['medicamento', 'descripcion', 'momentos', 'lote_caducidad'] },
      { tipo: 'aparte', x: 0, y: 98, w: 70, h: 20 },
      { tipo: 'codigo', simbologia: 'qrcode', x: 74, y: 98, w: 20, h: 20, contenido: '{{preparacion.id_publico}}' },
      { tipo: 'texto', x: 0, y: 120, w: 94, h: 20, contenido: 'Del {{periodo.inicio}} al {{periodo.fin}} · Caduca {{preparacion.caducidad}} · Prep. {{prep.iniciales}} / Val. {{val.iniciales}}' },
    ],
  };
}

// ── plancha ──────────────────────────────────────────────

test('plancha 2×7: 14 posiciones y coordenadas exactas', () => {
  const p = posicionesPlancha(PLANCHA);
  assert.equal(p.length, 14);
  assert.deepEqual(p[0], { fila: 1, columna: 1, xMm: 4.65, yMm: 15.1 });
  assert.deepEqual(p[1], { fila: 1, columna: 2, xMm: 106.25, yMm: 15.1 });
  assert.deepEqual(p[2], { fila: 2, columna: 1, xMm: 4.65, yMm: 53.2 });
  assert.deepEqual(p[13], { fila: 7, columna: 2, xMm: 106.25, yMm: 243.7 });
});

test('plancha: el orden es por filas', () => {
  const p = posicionesPlancha(PLANCHA);
  assert.deepEqual(p.slice(0, 4).map((x) => [x.fila, x.columna]), [[1, 1], [1, 2], [2, 1], [2, 2]]);
});

test('primera_libre salta los huecos ya usados', () => {
  const p = posicionesPlancha({ ...PLANCHA, primera_libre: 4 });
  assert.equal(p.length, 11);
  assert.deepEqual([p[0].fila, p[0].columna], [2, 2]);
});

test('primera_libre en el último hueco deja uno', () => {
  const p = posicionesPlancha({ ...PLANCHA, primera_libre: 14 });
  assert.equal(p.length, 1);
  assert.deepEqual([p[0].fila, p[0].columna], [7, 2]);
});

test('todas:true ignora primera_libre', () => {
  assert.equal(posicionesPlancha({ ...PLANCHA, primera_libre: 10 }, { todas: true }).length, 14);
});

test('sin primera_libre se empieza en el hueco 1', () => {
  const { primera_libre: _omitida, ...sin } = PLANCHA;
  assert.equal(posicionesPlancha(sin as Plancha).length, 14);
});

function plantillaPlancha(): Plantilla {
  return {
    pagina: { ancho_mm: 99.1, alto_mm: 38.1 }, plancha: PLANCHA, margenes_mm: [1, 1, 1, 1], fuente_base_pt: 7,
    bloques: [{ tipo: 'texto', x: 0, y: 0, w: 97, h: 10, contenido: '{{paciente.nombre_completo}}' }],
  };
}

test('renderizarPlancha: una etiqueta en el hueco primera_libre', () => {
  const r = renderizarPlancha(plantillaPlancha(), [DATOS], { ...PLANCHA, primera_libre: 3 });
  assert.equal(r.hojas, 1);
  assert.equal(r.etiquetas, 1);
  assert.match(r.html, /left:4\.65mm;top:53\.2mm;/);
  assert.ok(!/left:4\.65mm;top:15\.1mm/.test(r.html));
  assert.ok(r.imprimible);
});

test('renderizarPlancha: pagina en hojas (14 huecos, 1ª con primera_libre 13)', () => {
  const lista = Array.from({ length: 4 }, () => DATOS);
  const r = renderizarPlancha(plantillaPlancha(), lista, { ...PLANCHA, primera_libre: 13 });
  // la 1ª hoja admite 2; las otras 2 pasan a la hoja siguiente, desde el hueco 1
  assert.equal(r.hojas, 2);
  const hojas = r.html.split('<section class="hoja">').slice(1);
  assert.equal(hojas[0].split('class="etq"').length - 1, 2);
  assert.equal(hojas[1].split('class="etq"').length - 1, 2);
  assert.match(hojas[1], /left:4\.65mm;top:15\.1mm/);
});

test('renderizarPlancha: más de 14 etiquetas -> 2 hojas', () => {
  const r = renderizarPlancha(plantillaPlancha(), Array.from({ length: 15 }, () => DATOS), PLANCHA);
  assert.equal(r.hojas, 2);
  assert.equal(r.etiquetas, 15);
});

test('renderizarPlancha: @page A4', () => {
  const r = renderizarPlancha(plantillaPlancha(), [DATOS], PLANCHA);
  assert.match(r.html, /@page\{size:210mm 297mm;margin:0\}/);
});

test('renderizarPlancha: una etiqueta con dato faltante bloquea toda la plancha', () => {
  const r = renderizarPlancha(plantillaPlancha(), [DATOS, { ...DATOS, paciente: {} }], PLANCHA);
  assert.equal(r.imprimible, false);
  assert.deepEqual(r.faltan, ['paciente.nombre_completo']);
  assert.ok(r.problemas.some((p) => p.startsWith('Etiqueta 2:')));
});

test('renderizarPlancha: lista vacía no es imprimible', () => {
  const r = renderizarPlancha(plantillaPlancha(), [], PLANCHA);
  assert.equal(r.imprimible, false);
  assert.equal(r.hojas, 0);
});

test('renderizarPlancha: plancha que no cabe en A4 se rechaza', () => {
  const r = renderizarPlancha(plantillaPlancha(), [DATOS], { ...PLANCHA, filas: 8 });
  assert.equal(r.imprimible, false);
  assert.ok(r.problemas.some((p) => /no caben en A4/.test(p)));
});

// ── validación ───────────────────────────────────────────

test('plantilla de ejemplo del doc 07 es válida y sin solapes', () => {
  assert.deepEqual(validarPlantilla(plantilla()), []);
  assert.deepEqual(avisosPlantilla(plantilla()), []);
});

test('validar: no es objeto', () => {
  assert.ok(validarPlantilla(null).length > 0);
  assert.ok(validarPlantilla('x').length > 0);
  assert.ok(validarPlantilla([]).length > 0);
});

test('validar: dimensiones <= 0', () => {
  const p = plantilla(); p.pagina.ancho_mm = 0;
  assert.ok(validarPlantilla(p).some((e) => /ancho_mm/.test(e)));
  const q = plantilla(); q.pagina.alto_mm = -5;
  assert.ok(validarPlantilla(q).some((e) => /alto_mm/.test(e)));
});

test('validar: fuente base inválida', () => {
  const p = plantilla(); p.fuente_base_pt = 0;
  assert.ok(validarPlantilla(p).some((e) => /fuente_base_pt/.test(e)));
});

test('validar: márgenes que no dejan área útil', () => {
  const p = plantilla(); p.margenes_mm = [3, 50, 3, 50];
  assert.ok(validarPlantilla(p).some((e) => /área útil/.test(e)));
});

test('validar: márgenes mal formados', () => {
  const p = plantilla(); (p as unknown as { margenes_mm: number[] }).margenes_mm = [3, 3];
  assert.ok(validarPlantilla(p).some((e) => /margenes_mm/.test(e)));
});

test('validar: bloque fuera de la página por la derecha', () => {
  const p = plantilla(); p.bloques[0].w = 95;
  assert.ok(validarPlantilla(p).some((e) => /derecha/.test(e)));
});

test('validar: bloque fuera de la página por abajo', () => {
  const p = plantilla(); p.bloques[5].h = 25;
  assert.ok(validarPlantilla(p).some((e) => /abajo/.test(e)));
});

test('validar: bloque que justo llega al borde es válido', () => {
  const p = plantilla(); p.bloques[5].h = 24;
  assert.deepEqual(validarPlantilla(p), []);
});

test('validar: tipo de bloque desconocido', () => {
  const p = plantilla(); (p.bloques[0] as unknown as { tipo: string }).tipo = 'imagen';
  assert.ok(validarPlantilla(p).some((e) => /tipo desconocido/.test(e)));
});

test('validar: variable desconocida', () => {
  const p = plantilla(); p.bloques[0].contenido = '{{paciente.dni}}';
  assert.ok(validarPlantilla(p).some((e) => /variable desconocida «paciente\.dni»/.test(e)));
});

test('validar: bloque de texto sin contenido', () => {
  const p = plantilla(); delete p.bloques[0].contenido;
  assert.ok(validarPlantilla(p).some((e) => /falta contenido/.test(e)));
});

test('validar: simbología desconocida', () => {
  const p = plantilla(); (p.bloques[4] as unknown as { simbologia: string }).simbologia = 'pdf417';
  assert.ok(validarPlantilla(p).some((e) => /simbología/.test(e)));
});

test('validar: columna de tabla desconocida', () => {
  const p = plantilla(); p.bloques[2].columnas = ['medicamento', 'precio'];
  assert.ok(validarPlantilla(p).some((e) => /columna desconocida «precio»/.test(e)));
});

test('validar: w/h <= 0 y x/y negativos', () => {
  const p = plantilla(); p.bloques[0].w = 0; p.bloques[1].x = -1;
  const e = validarPlantilla(p);
  assert.ok(e.some((x) => /w debe/.test(x)));
  assert.ok(e.some((x) => /x debe/.test(x)));
});

test('validar: bloques no es lista', () => {
  const p = plantilla(); (p as unknown as { bloques: unknown }).bloques = 'no';
  assert.ok(validarPlantilla(p).some((e) => /bloques/.test(e)));
});

test('validar: plancha que no cabe en A4 (alto)', () => {
  const p = plantillaPlancha(); p.plancha = { ...PLANCHA, filas: 8 };
  assert.ok(validarPlantilla(p).some((e) => /alto 319\.9? mm|alto 3\d\d(\.\d+)? mm/.test(e)));
});

test('validar: plancha que no cabe en A4 (ancho)', () => {
  const p = plantillaPlancha(); p.plancha = { ...PLANCHA, columnas: 3 };
  assert.ok(validarPlantilla(p).some((e) => /ancho/.test(e) && /no caben en A4/.test(e)));
});

test('validar: plancha de ejemplo del doc 07 cabe (205.35 × 281.8)', () => {
  assert.deepEqual(validarPlantilla(plantillaPlancha()), []);
});

test('validar: primera_libre fuera de rango', () => {
  const p = plantillaPlancha(); p.plancha = { ...PLANCHA, primera_libre: 15 };
  assert.ok(validarPlantilla(p).some((e) => /primera_libre/.test(e)));
  p.plancha = { ...PLANCHA, primera_libre: 0 };
  assert.ok(validarPlantilla(p).some((e) => /primera_libre/.test(e)));
});

test('validar: paso menor que la etiqueta (solape)', () => {
  const p = plantillaPlancha(); p.plancha = { ...PLANCHA, paso_v_mm: 30 };
  assert.ok(validarPlantilla(p).some((e) => /paso_v_mm/.test(e)));
});

test('validar: tamaño de página distinto del de la etiqueta de plancha', () => {
  const p = plantillaPlancha(); p.pagina = { ancho_mm: 80, alto_mm: 38.1 };
  assert.ok(validarPlantilla(p).some((e) => /no coincide/.test(e)));
});

test('avisos: bloques solapados', () => {
  const p = plantilla(); p.bloques[1].y = 5;
  assert.ok(avisosPlantilla(p).some((a) => /1 y 2/.test(a)));
});

test('renderizar: plantilla inválida no genera HTML ni es imprimible', () => {
  const p = plantilla(); p.pagina.ancho_mm = 0;
  const r = renderizarEtiqueta(p, DATOS);
  assert.equal(r.html, '');
  assert.equal(r.imprimible, false);
  assert.ok(r.problemas.length > 0);
});

// ── variables ────────────────────────────────────────────

test('resolver: sustituye variables con ruta de puntos', () => {
  const r = resolverVariables('Hola {{paciente.nombre_completo}} ({{ paciente.id_corto }})', DATOS);
  assert.equal(r.texto, 'Hola María Peña Núñez (MPN-01)');
  assert.deepEqual(r.faltan, []);
});

test('resolver: variable sin valor deja marcador y se lista en faltan', () => {
  const r = resolverVariables('Dr. {{prescriptor.nombre}}', DATOS);
  assert.equal(r.texto, 'Dr. ⟦prescriptor.nombre⟧');
  assert.deepEqual(r.faltan, ['prescriptor.nombre']);
});

test('resolver: valor vacío o en blanco cuenta como faltante', () => {
  const r = resolverVariables('{{paciente.id_corto}}', { paciente: { id_corto: '   ' } });
  assert.deepEqual(r.faltan, ['paciente.id_corto']);
  const r2 = resolverVariables('{{paciente.id_corto}}', { paciente: { id_corto: null } });
  assert.deepEqual(r2.faltan, ['paciente.id_corto']);
});

test('resolver: variable fuera de la lista blanca no se resuelve aunque haya dato', () => {
  const r = resolverVariables('{{paciente.dni}}', { paciente: { dni: '12345678Z' } });
  assert.deepEqual(r.faltan, ['paciente.dni']);
  assert.ok(!r.texto.includes('12345678Z'));
});

test('resolver: no sigue prototipos (constructor, __proto__)', () => {
  const r = resolverVariables('{{farmacia.constructor}}', DATOS);
  assert.deepEqual(r.faltan, ['farmacia.constructor']);
});

test('resolver: faltante repetido se lista una vez', () => {
  const r = resolverVariables('{{val.iniciales}} {{val.iniciales}}', {});
  assert.deepEqual(r.faltan, ['val.iniciales']);
});

test('resolver: escapa HTML del valor (O\'Brien <b> & "x")', () => {
  const r = resolverVariables('{{paciente.nombre_completo}}', { paciente: { nombre_completo: `O'Brien <b>&"x"` } });
  assert.equal(r.texto, 'O&#39;Brien &lt;b&gt;&amp;&quot;x&quot;');
  assert.ok(!r.texto.includes('<b>'));
});

test('resolver: valor numérico se imprime', () => {
  const r = resolverVariables('{{paciente.id_corto}}', { paciente: { id_corto: 42 } });
  assert.equal(r.texto, '42');
});

test('resolver: conserva ñ y tildes', () => {
  const r = resolverVariables('{{farmacia.nombre}}', DATOS);
  assert.equal(r.texto, 'Farmacia Ñandú');
});

test('VARIABLES_PERMITIDAS incluye las del doc 07', () => {
  for (const v of ['farmacia.nombre', 'paciente.nombre_completo', 'preparacion.id_publico', 'periodo.inicio', 'prep.iniciales']) {
    assert.ok(VARIABLES_PERMITIDAS.includes(v), v);
  }
});

test('escaparHtml: los cinco caracteres', () => {
  assert.equal(escaparHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});

// ── ajustar texto ────────────────────────────────────────

test('ajustar: texto corto cabe sin reducir', () => {
  assert.deepEqual(ajustarTexto('Hola', 50, 10, 8), { tamPt: 8, cabe: true, lineas: 1 });
});

test('ajustar: reduce la letra cuando hace falta', () => {
  const t = 'x'.repeat(60);
  const r = ajustarTexto(t, 50, 6, 12);
  assert.ok(r.cabe);
  assert.ok(r.tamPt < 12 && r.tamPt >= 6);
});

test('ajustar: no cabe ni al mínimo -> cabe:false y NO se recorta', () => {
  const t = 'palabra '.repeat(200);
  const r = ajustarTexto(t, 30, 5, 10);
  assert.equal(r.cabe, false);
  assert.equal(r.tamPt, 6);
  assert.ok(r.lineas > 5);
});

test('ajustar: respeta el mínimo configurable', () => {
  const r = ajustarTexto('palabra '.repeat(200), 30, 5, 10, 8);
  assert.equal(r.tamPt, 8);
  assert.equal(r.cabe, false);
});

test('ajustar: saltos de línea cuentan', () => {
  assert.equal(ajustarTexto('a\nb\nc', 50, 50, 8).lineas, 3);
});

test('ajustar: palabra más larga que la línea se parte en varias líneas', () => {
  const r = ajustarTexto('x'.repeat(100), 20, 100, 10);
  assert.ok(r.lineas > 1);
});

test('ajustar: dimensiones inválidas -> no cabe', () => {
  assert.equal(ajustarTexto('a', 0, 10, 8).cabe, false);
  assert.equal(ajustarTexto('a', 10, -1, 8).cabe, false);
});

test('ajustar: unicode cuenta caracteres, no bytes', () => {
  const a = ajustarTexto('ñññññññññññ', 100, 50, 8);
  const b = ajustarTexto('nnnnnnnnnnn', 100, 50, 8);
  assert.deepEqual(a, b);
});

// ── render de etiqueta ───────────────────────────────────

test('renderizar: datos completos -> imprimible y @page con el tamaño correcto', () => {
  const r = renderizarEtiqueta(plantilla(), DATOS);
  assert.equal(r.imprimible, true);
  assert.equal(r.cabe, true);
  assert.deepEqual(r.faltan, []);
  assert.match(r.html, /@page\{size:100mm 150mm;margin:0\}/);
  assert.match(r.html, /Farmacia Ñandú · 954 000 000/);
});

test('renderizar: posiciones absolutas desplazadas por el margen', () => {
  const r = renderizarEtiqueta(plantilla(), DATOS);
  assert.match(r.html, /left:3mm;top:3mm;width:94mm;height:8mm/);
  assert.match(r.html, /left:77mm;top:101mm;width:20mm;height:20mm/);
});

test('renderizar: el bloque código emite div data-codigo con la simbología', () => {
  const r = renderizarEtiqueta(plantilla(), DATOS);
  assert.match(r.html, /data-codigo="SPD-8F3K" data-simbologia="qrcode"/);
});

test('renderizar: dato faltante -> no imprimible y marcador visible', () => {
  const r = renderizarEtiqueta(plantilla(), { ...DATOS, prep: {} });
  assert.equal(r.imprimible, false);
  assert.deepEqual(r.faltan, ['prep.iniciales']);
  assert.match(r.html, /⟦prep\.iniciales⟧/);
});

test('renderizar: nombre malicioso no inyecta HTML en ningún sitio', () => {
  const malo = `O'Brien <img src=x onerror=alert(1)> & "co"`;
  const datos = {
    ...DATOS,
    paciente: { nombre_completo: malo, id_corto: '<b>' },
    preparacion: { id_publico: '"><script>x</script>', caducidad: '2026-12-01' },
    aparte: ['<i>aparte</i>'],
    tomas: [{ fecha: '<u>', momentoNombre: '<s>', medicamentos: [{ nombre: '<script>', unidades: 1, lote: '<L>', caducidad: '&' }] }],
  };
  const r = renderizarEtiqueta(plantilla(), datos);
  assert.ok(!r.html.includes('<img'));
  assert.ok(!r.html.includes('<script>x'));
  assert.ok(!r.html.includes('<script>'));
  assert.ok(!r.html.includes('<i>aparte'));
  assert.ok(!r.html.includes('<u>'));
  assert.ok(!r.html.includes('<L>'));
  assert.match(r.html, /O&#39;Brien &lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;co&quot;/);
  assert.match(r.html, /data-codigo="&quot;&gt;&lt;script&gt;x&lt;\/script&gt;"/);
});

test('renderizar: literales de la plantilla también se escapan', () => {
  const p = plantilla(); p.bloques[0].contenido = '<b>Hola</b> {{farmacia.nombre}}';
  const r = renderizarEtiqueta(p, DATOS);
  assert.ok(!r.html.includes('<b>Hola'));
  assert.match(r.html, /&lt;b&gt;Hola&lt;\/b&gt;/);
});

test('renderizar: texto que no cabe nunca se recorta: se marca y bloquea', () => {
  const largo = 'Aviso importante de conservación '.repeat(40);
  const p = plantilla(); p.bloques[5].contenido = `${largo}FINAL-NO-PERDER`;
  const r = renderizarEtiqueta(p, DATOS);
  assert.equal(r.cabe, false);
  assert.equal(r.imprimible, false);
  assert.ok(r.problemas.some((x) => /bloque 6/.test(x)));
  assert.ok(r.html.includes('FINAL-NO-PERDER'));
  assert.match(r.html, /class="b nocabe"/);
});

test('renderizar: la letra baja de tam_pt pero nunca de 6 pt', () => {
  const p = plantilla(); p.bloques[1].contenido = 'Nombre larguísimo '.repeat(8);
  const r = renderizarEtiqueta(p, DATOS);
  const tam = [...r.html.matchAll(/font-size:([\d.]+)pt/g)].map((m) => Number(m[1]));
  assert.ok(tam.every((t) => t >= 6));
});

test('renderizar: unicode ñ/tildes en el HTML y charset utf-8', () => {
  const r = renderizarEtiqueta(plantilla(), DATOS);
  assert.match(r.html, /<meta charset="utf-8">/);
  assert.match(r.html, /María Peña Núñez/);
});

test('renderizar: medicamento aparte aparece; sin aparte el bloque queda vacío sin error', () => {
  assert.match(renderizarEtiqueta(plantilla(), DATOS).html, /ADMINISTRAR APARTE: Insulina/);
  const r = renderizarEtiqueta(plantilla(), { ...DATOS, aparte: [] });
  assert.ok(!r.html.includes('ADMINISTRAR APARTE'));
  assert.equal(r.imprimible, true);
});

test('renderizar: sin tomas no es imprimible', () => {
  const r = renderizarEtiqueta(plantilla(), { ...DATOS, tomas: [] });
  assert.equal(r.imprimible, false);
  assert.ok(r.faltan.includes('tomas'));
});

test('renderizar: toma sin lote o caducidad bloquea (trazabilidad)', () => {
  const datos = { ...DATOS, tomas: [{ fecha: '2026-11-02', momentoNombre: 'Cena', medicamentos: [{ nombre: 'A', unidades: 1, lote: '', caducidad: '2027-01' }] }] };
  const r = renderizarEtiqueta(plantilla(), datos);
  assert.equal(r.imprimible, false);
  assert.ok(r.faltan.some((f) => /lote_caducidad/.test(f)));
  assert.match(r.html, /⟦lote⟧/);
});

test('renderizar: lote y caducidad de cada medicamento visibles', () => {
  const r = renderizarEtiqueta(plantilla(), DATOS);
  assert.match(r.html, /Lote L123 · Cad 2027-05/);
});

// ── tabla de tomas ───────────────────────────────────────

test('filasTablaTomas: lotes múltiples del mismo medicamento se listan todos', () => {
  const filas = filasTablaTomas([{
    fecha: '2026-11-02', momentoNombre: 'Desayuno',
    medicamentos: [
      { nombre: 'Enalapril 5 mg', unidades: 1, lote: 'L1', caducidad: '2027-01' },
      { nombre: 'Enalapril 5 mg', unidades: 1, lote: 'L2', caducidad: '2027-03' },
    ],
  }, {
    fecha: '2026-11-03', momentoNombre: 'Desayuno',
    medicamentos: [{ nombre: 'Enalapril 5 mg', unidades: 1, lote: 'L2', caducidad: '2027-03' }],
  }]);
  assert.equal(filas.length, 3);
  assert.deepEqual(filas.map((f) => f.lote), ['L1', 'L2', 'L2']);
  assert.deepEqual(filas.map((f) => f.caducidad), ['2027-01', '2027-03', '2027-03']);
  assert.ok(filas.every((f) => !f.faltaTraza));
});

test('filasTablaTomas: marca la falta de lote o caducidad', () => {
  const filas = filasTablaTomas([{ fecha: 'f', momentoNombre: 'm', medicamentos: [
    { nombre: 'A', unidades: 1, lote: ' ', caducidad: '2027-01' },
    { nombre: 'B', unidades: 2, lote: 'L', caducidad: '' },
    { nombre: 'C', unidades: 1, lote: 'L', caducidad: '2027-01' },
  ] }]);
  assert.deepEqual(filas.map((f) => f.faltaTraza), [true, true, false]);
});

test('filasTablaTomas: lista vacía', () => {
  assert.deepEqual(filasTablaTomas([]), []);
});

test('filasTablaTomas: conserva fecha, momento y unidades', () => {
  const [f] = filasTablaTomas([{ fecha: '2026-11-02', momentoNombre: 'Almuerzo', medicamentos: [{ nombre: 'X', unidades: 0.5, lote: 'L', caducidad: '2027-01' }] }]);
  assert.deepEqual(f, { fecha: '2026-11-02', momento: 'Almuerzo', medicamento: 'X', unidades: 0.5, lote: 'L', caducidad: '2027-01', faltaTraza: false });
});
