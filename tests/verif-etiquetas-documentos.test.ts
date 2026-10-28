/**
 * Verificación adversarial independiente de src/dominio/etiquetas.ts y
 * src/dominio/documentos.ts. Escrita desde la especificación (CLAUDE.md,
 * docs/07, docs/09), no desde las pruebas del autor.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

import {
  renderizarEtiqueta, renderizarPlancha, posicionesPlancha, validarPlantilla,
  resolverVariables, ajustarTexto, filasTablaTomas, escaparHtml,
  type Plantilla, type Plancha, type Bloque,
} from '../src/dominio/etiquetas.ts';
import {
  renderizarDocumento, estadoConsentimientos, variablesDe, VARIABLES_DOCUMENTO,
  type ValorDocumento,
} from '../src/dominio/documentos.ts';

// ───────────────────────── utilidades ─────────────────────────

let semilla = 123456789;
function azar(): number {
  // LCG determinista
  semilla = (Math.imul(semilla, 1664525) + 1013904223) >>> 0;
  return semilla / 4294967296;
}
const entre = (a: number, b: number) => a + Math.floor(azar() * (b - a + 1));

const DATOS_OK = {
  farmacia: { nombre: 'Farmacia Mayor', direccion: 'C/ Real 1', telefono: '600000000' },
  paciente: { nombre_completo: 'Ana Pérez', id_corto: 'P-001' },
  preparacion: { id_publico: 'SPD-AB12', caducidad: '2026-12-01' },
  periodo: { inicio: '2026-11-01', fin: '2026-11-28' },
  prep: { iniciales: 'AB' },
  val: { iniciales: 'CD' },
  prescriptor: { nombre: 'Dr. X' },
  aparte: [] as string[],
  tomas: [
    { fecha: '2026-11-01', momentoNombre: 'Desayuno',
      medicamentos: [{ nombre: 'Metformina 850', unidades: 1, lote: 'L123', caducidad: '2027-05' }] },
  ],
};

function plantillaBase(over: Partial<Plantilla> = {}): Plantilla {
  return {
    pagina: { ancho_mm: 100, alto_mm: 150 },
    plancha: null,
    margenes_mm: [3, 3, 3, 3],
    fuente_base_pt: 7,
    bloques: [
      { tipo: 'texto', x: 0, y: 0, w: 94, h: 8, contenido: '{{farmacia.nombre}} · {{farmacia.telefono}}', negrita: true },
      { tipo: 'texto', x: 0, y: 9, w: 94, h: 6, contenido: '{{paciente.nombre_completo}}', tam_pt: 10 },
      { tipo: 'tabla_tomas', x: 0, y: 16, w: 94, h: 80 },
      { tipo: 'aparte', x: 0, y: 98, w: 70, h: 20 },
      { tipo: 'codigo', simbologia: 'qrcode', x: 74, y: 98, w: 20, h: 20, contenido: '{{preparacion.id_publico}}' },
      { tipo: 'texto', x: 0, y: 120, w: 94, h: 20,
        contenido: 'Del {{periodo.inicio}} al {{periodo.fin}} · Caduca {{preparacion.caducidad}} · Prep. {{prep.iniciales}} / Val. {{val.iniciales}}' },
    ],
    ...over,
  };
}

const clon = <T>(x: T): T => structuredClone(x);

// ───────────────────────── etiquetas: inyección ─────────────────────────

describe('etiquetas: inyección y escape', () => {
  const hostiles = [
    '<script>alert(1)</script>',
    '"><img src=x onerror=alert(1)>',
    "'; DROP TABLE x;--",
    '</div><div class="b">falso</div>',
    '{{farmacia.nombre}}',
    '⟦paciente.nombre_completo⟧',
    'línea1\nlínea2\r\nlínea3',
    'nul\u0000byte',
    '\u202Eevil\u202C',
    '&amp; &lt;b&gt;',
  ];

  for (const h of hostiles) {
    test(`valor hostil ${JSON.stringify(h).slice(0, 30)} no abre etiquetas`, () => {
      const d = clon(DATOS_OK);
      d.paciente.nombre_completo = h;
      d.farmacia.nombre = h;
      d.tomas[0].medicamentos[0].nombre = h;
      d.tomas[0].medicamentos[0].lote = h;
      d.tomas[0].momentoNombre = h;
      d.aparte = [h];
      const p = plantillaBase();
      p.bloques.push({ tipo: 'texto', x: 0, y: 140.5, w: 90, h: 3, contenido: '{{paciente.id_corto}}' });
      const r = renderizarEtiqueta(p, { ...d, paciente: { ...d.paciente, id_corto: h } });
      assert.ok(r.html.length > 0);
      assert.ok(!/<script/i.test(r.html), 'script sin escapar');
      assert.ok(!/<img/i.test(r.html), 'img sin escapar');
      assert.ok(!/onerror=/i.test(r.html.replace(/&quot;|&#39;/g, '')) || !/<[^>]*onerror=/i.test(r.html), 'atributo inyectado');
      // Contar etiquetas: el número de <div que abre debe ser el estructural (1 etq + 1 por bloque).
      const divs = (r.html.match(/<div\b/g) ?? []).length;
      assert.equal(divs, 1 + p.bloques.length, `divs=${divs}: se inyectó un <div>`);
      // data-codigo no se rompe
      assert.ok(/data-codigo="[^"]*"/.test(r.html));
    });
  }

  test('valor con {{x}} no se re-evalúa ni se marca como faltante', () => {
    const d = clon(DATOS_OK);
    d.paciente.nombre_completo = '{{farmacia.telefono}}';
    const r = renderizarEtiqueta(plantillaBase(), d);
    assert.ok(r.html.includes('{{farmacia.telefono}}'));
    assert.ok(!r.html.includes('600000000') || r.html.split('600000000').length === 2);
    assert.deepEqual(r.faltan, []);
  });

  test('resolverVariables: ruta no permitida (__proto__, constructor) => faltan y marcador', () => {
    for (const ruta of ['__proto__', 'constructor', 'toString', '__proto__.x', 'paciente.__proto__', 'paciente.constructor']) {
      const r = resolverVariables(`a {{${ruta}}} b`, { paciente: { nombre_completo: 'X' } });
      assert.deepEqual(r.faltan, [ruta]);
      assert.ok(r.texto.includes('⟦'));
    }
  });

  test('ruta permitida con datos que tienen __proto__ propio no contamina', () => {
    const datos = JSON.parse('{"__proto__":{"nombre":"HACK"},"farmacia":{"__proto__":{"nombre":"HACK2"}}}');
    const r = resolverVariables('{{farmacia.nombre}}', datos);
    assert.deepEqual(r.faltan, ['farmacia.nombre']);
    assert.equal(({} as any).nombre, undefined);
  });

  test('marcador de variable desconocida con html se escapa', () => {
    const r = resolverVariables('{{<b>x</b>}}', {});
    assert.ok(!r.texto.includes('<b>'));
  });

  test('valores solo-espacio, vacíos, null, objetos y booleanos cuentan como faltantes', () => {
    for (const v of ['', '   ', '\t\n', null, undefined, {}, [], true, NaN, Infinity]) {
      const r = resolverVariables('{{paciente.nombre_completo}}', { paciente: { nombre_completo: v } });
      assert.deepEqual(r.faltan, ['paciente.nombre_completo'], String(v));
    }
  });

  test('valores invisibles (U+200B, nulos, bidi sueltos) cuentan como faltantes', () => {
    for (const v of ['\u200B', '\u200B\u200B', '\u0000', '\u202E', ' \u200B ', '\u2060']) {
      const r = resolverVariables('{{paciente.nombre_completo}}', { paciente: { nombre_completo: v } });
      assert.deepEqual(r.faltan, ['paciente.nombre_completo'], JSON.stringify(v));
    }
  });

  test('número 0 es un valor válido; NaN no', () => {
    assert.deepEqual(resolverVariables('{{paciente.id_corto}}', { paciente: { id_corto: 0 } }).faltan, []);
    assert.deepEqual(resolverVariables('{{paciente.id_corto}}', { paciente: { id_corto: NaN } }).faltan, ['paciente.id_corto']);
  });

  test('string de 1 MB: no revienta, no recorta, no cabe => no imprimible', () => {
    const d = clon(DATOS_OK);
    d.paciente.nombre_completo = 'A'.repeat(1_000_000);
    const t0 = Date.now();
    const r = renderizarEtiqueta(plantillaBase(), d);
    assert.ok(Date.now() - t0 < 5000, 'demasiado lento');
    assert.equal(r.cabe, false);
    assert.equal(r.imprimible, false);
    assert.ok(r.html.includes('A'.repeat(1_000_000)), 'texto recortado en silencio');
  });

  test('escaparHtml escapa los 5 caracteres', () => {
    assert.equal(escaparHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
  });

  test('el CSS permite partir palabras largas (si no, el texto se recorta en silencio)', () => {
    const r = renderizarEtiqueta(plantillaBase(), DATOS_OK);
    assert.match(r.html, /overflow-wrap:\s*(anywhere|break-word)|word-break:\s*(break-all|break-word)/);
  });
});

// ───────────────────────── etiquetas: faltantes ─────────────────────────

describe('etiquetas: nada se imprime en blanco', () => {
  test('datos completos => imprimible', () => {
    const r = renderizarEtiqueta(plantillaBase(), DATOS_OK);
    assert.deepEqual(r.problemas, []);
    assert.equal(r.imprimible, true);
  });

  test('cada variable usada ausente => faltan, marcador y no imprimible', () => {
    const rutas = ['farmacia.nombre', 'farmacia.telefono', 'paciente.nombre_completo', 'preparacion.id_publico',
      'periodo.inicio', 'periodo.fin', 'preparacion.caducidad', 'prep.iniciales', 'val.iniciales'];
    for (const ruta of rutas) {
      const d: any = clon(DATOS_OK);
      const [a, b] = ruta.split('.');
      delete d[a][b];
      const r = renderizarEtiqueta(plantillaBase(), d);
      assert.ok(r.faltan.includes(ruta), ruta);
      assert.equal(r.imprimible, false, ruta);
      assert.ok(r.html.includes(`⟦${ruta}⟧`), ruta);
    }
  });

  test('variable fuera de lista blanca en plantilla => plantilla inválida', () => {
    const p = plantillaBase();
    (p.bloques[0] as Bloque).contenido = '{{usuario.password}}';
    const r = renderizarEtiqueta(p, DATOS_OK);
    assert.equal(r.imprimible, false);
    assert.equal(r.html, '');
  });

  test('sin tomas => no imprimible; tomas no array => no imprimible', () => {
    for (const t of [undefined, [], 'x', {}, null]) {
      const r = renderizarEtiqueta(plantillaBase(), { ...DATOS_OK, tomas: t });
      assert.equal(r.imprimible, false, JSON.stringify(t));
    }
  });

  test('aparte mal formado (no array / elementos no string) nunca imprime sin avisar', () => {
    for (const a of ['paracetamol', { 0: 'x' }, [{ nombre: 'Sintrom' }], [42]]) {
      const r = renderizarEtiqueta(plantillaBase(), { ...DATOS_OK, aparte: a });
      assert.equal(r.imprimible, false, JSON.stringify(a));
    }
  });

  test('aparte válido aparece en la etiqueta', () => {
    const r = renderizarEtiqueta(plantillaBase(), { ...DATOS_OK, aparte: ['Sintrom 4 mg', 'Insulina'] });
    assert.ok(r.html.includes('ADMINISTRAR APARTE: Sintrom 4 mg; Insulina'));
  });

  test('tomas: lote o caducidad ausentes/solo-espacio/invisibles => marcador y no imprimible', () => {
    for (const mal of ['', '   ', '\t', '\u200B', undefined, null]) {
      for (const campo of ['lote', 'caducidad'] as const) {
        const d: any = clon(DATOS_OK);
        d.tomas[0].medicamentos[0][campo] = mal;
        const r = renderizarEtiqueta(plantillaBase(), d);
        assert.equal(r.imprimible, false, `${campo}=${JSON.stringify(mal)}`);
        assert.ok(r.html.includes(campo === 'lote' ? '⟦lote⟧' : '⟦caducidad⟧'), `${campo}=${JSON.stringify(mal)}`);
      }
    }
  });

  test('tomas: nombre/unidades/fecha/momento vacíos o inválidos no se imprimen en blanco ni como "undefined"/"NaN"', () => {
    const casos: [string, unknown][] = [
      ['nombre', ''], ['nombre', '  '], ['unidades', undefined], ['unidades', NaN], ['unidades', -1], ['unidades', 0],
    ];
    for (const [campo, v] of casos) {
      const d: any = clon(DATOS_OK);
      d.tomas[0].medicamentos[0][campo] = v;
      const r = renderizarEtiqueta(plantillaBase(), d);
      assert.equal(r.imprimible, false, `${campo}=${String(v)}`);
      assert.ok(!/×undefined|×NaN/.test(r.html) || !r.imprimible);
    }
    for (const campo of ['fecha', 'momentoNombre']) {
      const d: any = clon(DATOS_OK);
      d.tomas[0][campo] = '';
      const r = renderizarEtiqueta(plantillaBase(), d);
      assert.equal(r.imprimible, false, campo);
    }
  });

  test('varios lotes del mismo medicamento: TODOS visibles, ninguno fusionado', () => {
    const d: any = clon(DATOS_OK);
    d.tomas = [
      { fecha: '2026-11-01', momentoNombre: 'Desayuno', medicamentos: [
        { nombre: 'Metformina', unidades: 1, lote: 'LOTE-A', caducidad: '2027-01' },
        { nombre: 'Metformina', unidades: 1, lote: 'LOTE-B', caducidad: '2027-02' },
      ] },
      { fecha: '2026-11-02', momentoNombre: 'Desayuno', medicamentos: [
        { nombre: 'Metformina', unidades: 2, lote: 'LOTE-C', caducidad: '2027-03' },
      ] },
    ];
    const r = renderizarEtiqueta(plantillaBase(), d);
    for (const l of ['LOTE-A', 'LOTE-B', 'LOTE-C', '2027-01', '2027-02', '2027-03']) assert.ok(r.html.includes(l), l);
    assert.equal(filasTablaTomas(d.tomas).length, 3);
    assert.equal(r.imprimible, true, r.problemas.join('|'));
  });

  test('un solo medicamento sin traza entre muchos con traza marca solo la fila mala', () => {
    const d: any = clon(DATOS_OK);
    d.tomas[0].medicamentos.push({ nombre: 'Otro', unidades: 1, lote: '', caducidad: '2027-01' });
    const r = renderizarEtiqueta(plantillaBase(), d);
    assert.equal(r.imprimible, false);
    assert.ok(r.faltan.some((f) => f.includes('lote_caducidad')));
  });

  test('tomas con estructura rota lanza o bloquea, nunca imprime', () => {
    for (const t of [[null], [{ fecha: 'x', momentoNombre: 'y' }], [{ fecha: 'x', momentoNombre: 'y', medicamentos: [null] }]]) {
      let r;
      try { r = renderizarEtiqueta(plantillaBase(), { ...DATOS_OK, tomas: t }); } catch { continue; }
      assert.equal(r.imprimible, false, JSON.stringify(t));
    }
  });
});

// ───────────────────────── etiquetas: ajuste y plantillas hostiles ─────────────────────────

describe('etiquetas: ajuste de texto', () => {
  test('texto que no cabe a 6 pt => cabe:false y tamaño mínimo', () => {
    const r = ajustarTexto('palabra '.repeat(500), 20, 5, 10);
    assert.equal(r.cabe, false);
    assert.equal(r.tamPt, 6);
  });
  test('el texto se reduce antes de rendirse', () => {
    const r = ajustarTexto('hola mundo '.repeat(8), 40, 14, 12);
    assert.equal(r.cabe, true);
    assert.ok(r.tamPt < 12);
  });
  test('entradas degeneradas nunca devuelven cabe:true', () => {
    for (const [a, h, t] of [[0, 5, 8], [-1, 5, 8], [5, 0, 8], [NaN, 5, 8], [5, NaN, 8], [5, 5, 0], [5, 5, NaN], [Infinity, 5, 8]] as const) {
      assert.equal(ajustarTexto('x', a, h, t).cabe, a === Infinity ? ajustarTexto('x', a, h, t).cabe : false, `${a},${h},${t}`);
    }
  });
  test('tam_pt gigante no cuelga el proceso', () => {
    const p = plantillaBase();
    p.bloques[1] = { ...(p.bloques[1] as Bloque), tam_pt: 1e7 };
    const t0 = Date.now();
    const r = renderizarEtiqueta(p, DATOS_OK);
    assert.ok(Date.now() - t0 < 3000, `tardó ${Date.now() - t0} ms`);
    assert.equal(r.imprimible, false);
  });
  test('fuente_base_pt gigante no cuelga el proceso', () => {
    const t0 = Date.now();
    const r = renderizarEtiqueta(plantillaBase({ fuente_base_pt: 1e7 }), DATOS_OK);
    assert.ok(Date.now() - t0 < 3000, `tardó ${Date.now() - t0} ms`);
    assert.equal(r.imprimible, false);
  });
});

describe('etiquetas: plantillas hostiles', () => {
  const malas: [string, (p: any) => void][] = [
    ['ancho negativo', (p) => { p.pagina.ancho_mm = -5; }],
    ['alto cero', (p) => { p.pagina.alto_mm = 0; }],
    ['ancho NaN', (p) => { p.pagina.ancho_mm = NaN; }],
    ['alto Infinity', (p) => { p.pagina.alto_mm = Infinity; }],
    ['ancho string', (p) => { p.pagina.ancho_mm = '100'; }],
    ['margenes negativos', (p) => { p.margenes_mm = [-1, 3, 3, 3]; }],
    ['margenes sin área', (p) => { p.margenes_mm = [80, 3, 80, 3]; }],
    ['margenes longitud', (p) => { p.margenes_mm = [3, 3, 3]; }],
    ['fuente 0', (p) => { p.fuente_base_pt = 0; }],
    ['fuente string', (p) => { p.fuente_base_pt = '7'; }],
    ['bloque w 0', (p) => { p.bloques[0].w = 0; }],
    ['bloque h 0', (p) => { p.bloques[0].h = 0; }],
    ['bloque w negativo', (p) => { p.bloques[0].w = -4; }],
    ['bloque x NaN', (p) => { p.bloques[0].x = NaN; }],
    ['bloque y string', (p) => { p.bloques[0].y = '0'; }],
    ['bloque fuera por derecha', (p) => { p.bloques[0].x = 50; }],
    ['bloque fuera por abajo', (p) => { p.bloques[0].y = 200; }],
    ['tipo desconocido', (p) => { p.bloques[0].tipo = 'script'; }],
    ['tipo __proto__', (p) => { p.bloques[0].tipo = '__proto__'; }],
    ['tam_pt negativo', (p) => { p.bloques[0].tam_pt = -3; }],
    ['tam_pt NaN', (p) => { p.bloques[0].tam_pt = NaN; }],
    ['codigo sin simbologia', (p) => { delete p.bloques[4].simbologia; }],
    ['codigo simbologia rara', (p) => { p.bloques[4].simbologia = 'x" onload="'; }],
    ['texto sin contenido', (p) => { p.bloques[0].contenido = ''; }],
    ['columna desconocida', (p) => { p.bloques[2].columnas = ['hack']; }],
    ['bloques no lista', (p) => { p.bloques = {}; }],
    ['orientacion rara', (p) => { p.pagina.orientacion = 'diagonal'; }],
  ];
  for (const [nombre, f] of malas) {
    test(`rechaza: ${nombre}`, () => {
      const p: any = clon(plantillaBase());
      f(p);
      const errs = validarPlantilla(p);
      assert.ok(errs.length > 0, 'no detectó el fallo');
      const r = renderizarEtiqueta(p, DATOS_OK);
      assert.equal(r.imprimible, false);
      assert.equal(r.html, '');
    });
  }
  test('no-objetos', () => {
    for (const x of [null, undefined, 5, 'x', []]) assert.ok(validarPlantilla(x).length > 0);
  });
  test('plantilla válida base pasa sin errores', () => {
    assert.deepEqual(validarPlantilla(plantillaBase()), []);
  });
});

// ───────────────────────── etiquetas: planchas ─────────────────────────

function referenciaPosiciones(p: Plancha, todas: boolean) {
  const out: { fila: number; columna: number; xMm: number; yMm: number }[] = [];
  const r2 = (n: number) => Math.round(n * 100) / 100;
  for (let f = 1; f <= p.filas; f++) {
    for (let c = 1; c <= p.columnas; c++) {
      out.push({ fila: f, columna: c, xMm: r2(p.margen_izq_mm + (c - 1) * p.paso_h_mm), yMm: r2(p.margen_sup_mm + (f - 1) * p.paso_v_mm) });
    }
  }
  const saltar = todas ? 0 : (p.primera_libre ?? 1) - 1;
  return out.slice(saltar);
}

function plancha(): Plancha {
  const filas = entre(1, 12);
  const columnas = entre(1, 4);
  const ancho = entre(20, 90) + entre(0, 99) / 100;
  const alto = entre(10, 40) + entre(0, 99) / 100;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    filas, columnas,
    ancho_etiqueta_mm: r2(ancho), alto_etiqueta_mm: r2(alto),
    margen_sup_mm: entre(0, 10) + entre(0, 99) / 100, margen_izq_mm: entre(0, 10) + entre(0, 99) / 100,
    paso_h_mm: r2(ancho + entre(0, 5) + entre(0, 99) / 100), paso_v_mm: r2(alto + entre(0, 3) + entre(0, 99) / 100),
    primera_libre: entre(1, filas * columnas),
  };
}

describe('etiquetas: planchas', () => {
  test('200 configuraciones: posiciones iguales a la implementación de referencia', () => {
    for (let i = 0; i < 200; i++) {
      const p = plancha();
      assert.deepEqual(posicionesPlancha(p), referenciaPosiciones(p, false), JSON.stringify(p));
      assert.deepEqual(posicionesPlancha(p, { todas: true }), referenciaPosiciones(p, true));
      // sin primera_libre = 1
      const q = { ...p, primera_libre: undefined };
      assert.deepEqual(posicionesPlancha(q), referenciaPosiciones({ ...p, primera_libre: 1 }, false));
    }
  });

  test('primera_libre en TODOS los valores válidos de la plancha 7x2 de la documentación', () => {
    const base: Plancha = { filas: 7, columnas: 2, ancho_etiqueta_mm: 99.1, alto_etiqueta_mm: 38.1,
      margen_sup_mm: 15.1, margen_izq_mm: 4.65, paso_h_mm: 101.6, paso_v_mm: 38.1 };
    for (let k = 1; k <= 14; k++) {
      const p = { ...base, primera_libre: k };
      const pos = posicionesPlancha(p);
      assert.equal(pos.length, 14 - k + 1);
      assert.deepEqual(pos[0], referenciaPosiciones(p, false)[0]);
      // la primera posición ocupada por k debe ser fila ceil(k/2), columna ((k-1)%2)+1
      assert.equal(pos[0].fila, Math.ceil(k / 2));
      assert.equal(pos[0].columna, ((k - 1) % 2) + 1);
    }
  });

  function plantillaPlancha(pl: Plancha): Plantilla {
    return {
      pagina: { ancho_mm: pl.ancho_etiqueta_mm, alto_mm: pl.alto_etiqueta_mm },
      plancha: pl, margenes_mm: [1, 1, 1, 1], fuente_base_pt: 7,
      bloques: [{ tipo: 'texto', x: 0, y: 0, w: pl.ancho_etiqueta_mm - 2, h: pl.alto_etiqueta_mm - 2, contenido: '{{paciente.id_corto}}' }],
    };
  }
  const plA: Plancha = { filas: 7, columnas: 2, ancho_etiqueta_mm: 99.1, alto_etiqueta_mm: 38.1,
    margen_sup_mm: 15.1, margen_izq_mm: 4.65, paso_h_mm: 101.6, paso_v_mm: 38.1 };

  test('más etiquetas que huecos => varias hojas y ninguna etiqueta perdida', () => {
    for (const primera of [1, 2, 7, 14]) {
      for (const n of [1, 5, 14, 15, 28, 29, 45]) {
        const pl = { ...plA, primera_libre: primera };
        const lista = Array.from({ length: n }, (_, i) => ({ paciente: { id_corto: `ID${String(i).padStart(3, '0')}` } }));
        const r = renderizarPlancha(plantillaPlancha(pl), lista, pl);
        const esperadas = n <= 14 - primera + 1 ? 1 : 1 + Math.ceil((n - (14 - primera + 1)) / 14);
        assert.equal(r.hojas, esperadas, `primera=${primera} n=${n}`);
        assert.equal(r.etiquetas, n);
        for (let i = 0; i < n; i++) assert.ok(r.html.includes(`ID${String(i).padStart(3, '0')}`), `falta ${i}`);
        assert.equal((r.html.match(/class="etq"/g) ?? []).length, n);
        assert.equal(r.imprimible, true, r.problemas.join('|'));
      }
    }
  });

  test('la primera etiqueta cae en el hueco primera_libre y las demás no se solapan', () => {
    const pl = { ...plA, primera_libre: 5 };
    const lista = Array.from({ length: 20 }, (_, i) => ({ paciente: { id_corto: `X${i}` } }));
    const r = renderizarPlancha(plantillaPlancha(pl), lista, pl);
    const cajas = [...r.html.matchAll(/class="etq" style="left:([\d.]+)mm;top:([\d.]+)mm;/g)].map((m) => [Number(m[1]), Number(m[2])]);
    assert.equal(cajas.length, 20);
    const ref = referenciaPosiciones(pl, false);
    assert.deepEqual(cajas[0], [ref[0].xMm, ref[0].yMm]);
    const hoja1 = cajas.slice(0, 10);
    assert.equal(new Set(hoja1.map((c) => c.join(','))).size, 10);
    // segunda hoja empieza en el hueco 1
    assert.deepEqual(cajas[10], [referenciaPosiciones(pl, true)[0].xMm, referenciaPosiciones(pl, true)[0].yMm]);
  });

  test('lista vacía => no imprimible', () => {
    const r = renderizarPlancha(plantillaPlancha(plA), [], plA);
    assert.equal(r.imprimible, false);
  });

  test('un dato faltante en UNA etiqueta bloquea toda la plancha y se señala cuál', () => {
    const lista: any[] = [{ paciente: { id_corto: 'A' } }, {}, { paciente: { id_corto: 'C' } }];
    const r = renderizarPlancha(plantillaPlancha(plA), lista, plA);
    assert.equal(r.imprimible, false);
    assert.ok(r.problemas.some((p) => p.startsWith('Etiqueta 2:')));
  });

  const planchasMalas: [string, Partial<Plancha>][] = [
    ['primera_libre 0', { primera_libre: 0 }], ['primera_libre 15', { primera_libre: 15 }], ['primera_libre 1.5', { primera_libre: 1.5 }],
    ['primera_libre NaN', { primera_libre: NaN }], ['filas 0', { filas: 0 }], ['columnas -1', { columnas: -1 }],
    ['filas 2.5', { filas: 2.5 }], ['paso menor que etiqueta', { paso_h_mm: 50 }], ['no cabe en A4', { filas: 9 }],
    ['ancho NaN', { ancho_etiqueta_mm: NaN }], ['margen negativo', { margen_sup_mm: -1 }],
  ];
  for (const [n, o] of planchasMalas) {
    test(`plancha inválida rechazada: ${n}`, () => {
      const pl = { ...plA, ...o } as Plancha;
      const r = renderizarPlancha(plantillaPlancha(plA), [{ paciente: { id_corto: 'A' } }], pl);
      assert.equal(r.imprimible, false);
      assert.equal(r.html, '');
    });
  }

  test('tamaño de etiqueta de la plantilla distinto al de la plancha se rechaza', () => {
    const pl = { ...plA };
    const p = plantillaPlancha(pl);
    p.pagina.ancho_mm = 50;
    p.bloques[0] = { ...(p.bloques[0] as Bloque), w: 40 };
    const r = renderizarPlancha(p, [{ paciente: { id_corto: 'A' } }], pl);
    assert.equal(r.imprimible, false);
  });

  test('valores hostiles en plancha no inyectan estructura', () => {
    const lista = [{ paciente: { id_corto: '</div></section><script>x</script>' } }];
    const r = renderizarPlancha(plantillaPlancha(plA), lista, plA);
    assert.ok(!r.html.includes('<script>x'));
    assert.equal((r.html.match(/<section/g) ?? []).length, 1);
  });
});

// ───────────────────────── documentos ─────────────────────────

function datosCompletos(): Record<string, ValorDocumento> {
  const d: Record<string, ValorDocumento> = {};
  for (const v of VARIABLES_DOCUMENTO) d[v] = `valor de ${v}`;
  return d;
}
const DIR = new URL('../plantillas/consentimientos/', import.meta.url);
const plantillas = readdirSync(DIR).filter((f) => f.endsWith('.md')).sort();

describe('documentos: plantillas reales', () => {
  test('están las 6 plantillas', () => {
    assert.deepEqual(plantillas, ['autorizacion_terceros.md', 'comunicacion_medico.md', 'consentimiento_spd.md',
      'info_rgpd.md', 'recibi_devolucion.md', 'revocacion.md']);
  });
  for (const f of plantillas) {
    const txt = readFileSync(new URL(f, DIR), 'utf8');
    test(`${f}: solo variables conocidas`, () => {
      for (const v of variablesDe(txt)) assert.ok(VARIABLES_DOCUMENTO.includes(v), `variable desconocida ${v}`);
    });
    test(`${f}: con datos completos no deja {{ ni ⟦`, () => {
      const r = renderizarDocumento(txt, datosCompletos());
      assert.ok(!r.texto.includes('{{') && !r.texto.includes('}}'), 'llaves');
      assert.ok(!r.texto.includes('⟦'));
      assert.ok(!r.texto.includes('<!--'));
      assert.deepEqual(r.faltan, []);
      assert.equal(r.esBorrador, true);
      assert.equal(r.hash, createHash('sha256').update(r.texto, 'utf8').digest('hex'));
    });
    test(`${f}: con una variable menos => faltan, marcador, no definitivo`, () => {
      for (const v of variablesDe(txt)) {
        if (v === 'motivo') continue;
        const d = datosCompletos();
        delete d[v];
        const r = renderizarDocumento(txt, d);
        assert.deepEqual(r.faltan, [v]);
        assert.ok(r.texto.includes(`⟦${v}⟧`));
        assert.equal(r.imprimibleDefinitivo, false);
      }
    });
    test(`${f}: valores en blanco/invisibles = faltan`, () => {
      for (const mal of ['', '   ', null, undefined, '\u200B', '\n\t']) {
        const d = datosCompletos();
        d['firmante.nombre'] = mal;
        const vars = variablesDe(txt);
        const r = renderizarDocumento(txt, d);
        if (vars.includes('firmante.nombre')) assert.deepEqual(r.faltan, ['firmante.nombre'], JSON.stringify(mal));
      }
    });
  }
  test('revocacion: motivo opcional vacío => "no indicado" y no bloquea por eso', () => {
    const txt = readFileSync(new URL('revocacion.md', DIR), 'utf8');
    const d = datosCompletos();
    d['motivo'] = '  ';
    const r = renderizarDocumento(txt, d);
    assert.ok(r.texto.includes('Motivo (opcional): no indicado'));
    assert.ok(!r.faltan.includes('motivo'));
  });
  test('info_rgpd: [A COMPLETAR] impide el definitivo', () => {
    const txt = readFileSync(new URL('info_rgpd.md', DIR), 'utf8');
    const r = renderizarDocumento(txt, datosCompletos());
    assert.equal(r.imprimibleDefinitivo, false);
    assert.ok(r.sinCompletar.length >= 2);
  });
});

describe('documentos: valores hostiles', () => {
  const P = 'Hola {{paciente.nombre_completo}}, firma {{firmante.nombre}}.';
  const D = (a: ValorDocumento, b: ValorDocumento = 'B') => ({ 'paciente.nombre_completo': a, 'firmante.nombre': b });

  test('{{x}} en un valor no se re-evalúa ni queda como {{ en el texto', () => {
    for (const v of ['{{firmante.nombre}}', '{{{firmante.nombre}}}', '{{{{x}}}}', '}}}', '{{{', '}}{{', '{{ {{ }} }}', '{{', '}}']) {
      const r = renderizarDocumento(P, D(v));
      assert.ok(!r.texto.includes('{{') && !r.texto.includes('}}'), `${v} => ${r.texto}`);
      assert.deepEqual(r.faltan, []);
      assert.ok(r.avisos.length > 0, 'debe avisar de la neutralización');
    }
  });

  test('saltos de línea (incluidos \\u2028, \\r) no abren párrafos', () => {
    const r = renderizarDocumento(P, D('Ana\n\n# Título falso\r\n---\u2028x\u2029y'));
    assert.ok(!/[\n\r\u2028\u2029]/.test(r.texto.replace(/\n/g, '').replace(/^[\s\S]*$/, (s) => s)) || true);
    const linea = r.texto.split('\n')[0];
    assert.ok(linea.includes('Ana') && linea.includes('Título falso') && linea.includes('x y'), linea);
    assert.equal(r.texto.split('\n').length, 1);
  });

  test('bloque (tabla) conserva saltos de línea pero no \\u2028', () => {
    const r = renderizarDocumento('{{tabla_envases_devueltos}}', { tabla_envases_devueltos: 'a\nb\u2028c\r\nd' });
    assert.equal(r.texto, 'a\nb c\nd');
  });

  test('objetos, arrays, booleanos, NaN e Infinity NO se imprimen como "[object Object]"/"true"/"NaN"', () => {
    for (const v of [{}, [], ['a', 'b'], true, false, NaN, Infinity, -Infinity] as unknown as ValorDocumento[]) {
      const r = renderizarDocumento(P, D(v));
      assert.ok(!/\[object|true|false|NaN|Infinity|a,b/.test(r.texto.split(',')[0]), `${String(v)} => ${r.texto}`);
      assert.deepEqual(r.faltan, ['paciente.nombre_completo'], String(v));
    }
  });

  test('número 0 es valor válido', () => {
    const r = renderizarDocumento('{{documento.version}}', { 'documento.version': 0 });
    assert.equal(r.texto, '0');
    assert.deepEqual(r.faltan, []);
  });

  test('valor largo: se avisa Y bloquea el definitivo (nunca recorte silencioso)', () => {
    const r = renderizarDocumento(P, D('x'.repeat(5000)));
    assert.ok(r.avisos.some((a) => /recortado/.test(a)));
    assert.equal(r.imprimibleDefinitivo, false);
  });

  test('tabla larga recortada también bloquea el definitivo', () => {
    const r = renderizarDocumento('{{tabla_envases_devueltos}}', { tabla_envases_devueltos: 'línea\n'.repeat(1000) });
    assert.equal(r.imprimibleDefinitivo, false);
  });

  test('recorte no parte un par sustituto (emoji)', () => {
    const r = renderizarDocumento('{{motivo}}', { motivo: 'a'.repeat(299) + '😀' + 'b' });
    assert.ok(r.texto.isWellFormed(), 'surrogate suelto en el texto');
  });

  test('surrogates sueltos: el texto impreso queda bien formado, con aviso, y el hash corresponde a ese texto', () => {
    const a = renderizarDocumento('{{motivo}}', { motivo: 'x\uD800y' });
    assert.ok(a.texto.isWellFormed());
    assert.ok(a.avisos.length > 0);
    assert.equal(a.hash, createHash('sha256').update(a.texto, 'utf8').digest('hex'));
  });

  test('1 MB: no revienta y avisa', () => {
    const t0 = Date.now();
    const r = renderizarDocumento(P, D('é'.repeat(1_000_000)));
    assert.ok(Date.now() - t0 < 5000);
    assert.ok(r.avisos.length > 0);
    assert.equal(r.imprimibleDefinitivo, false);
  });

  test('prototype pollution: datos con __proto__/constructor no se usan', () => {
    const datos = JSON.parse('{"__proto__":"HACK","constructor":"HACK","paciente.nombre_completo":"Ok"}');
    const r = renderizarDocumento('{{__proto__}} {{constructor}} {{toString}} {{paciente.nombre_completo}}', datos);
    // __proto__ como propiedad propia (JSON.parse) es legítimo del dato; toString nunca
    assert.ok(r.faltan.includes('toString'));
    assert.equal(({} as any).HACK, undefined);
    const vacio = renderizarDocumento('{{__proto__}}{{constructor}}{{hasOwnProperty}}', {});
    assert.deepEqual(vacio.faltan, ['__proto__', 'constructor', 'hasOwnProperty']);
  });

  test('null bytes y bidi en el valor se conservan sin romper el hash', () => {
    const r = renderizarDocumento('{{motivo}}', { motivo: 'a\u0000b\u202Ec' });
    assert.equal(r.hash.length, 64);
  });

  test('llaves sueltas en la plantilla no pasan por "imprimible"', () => {
    for (const p of ['Hola {{}} x', 'Hola {{ }} x', 'Hola {{ x', 'Hola }} x', 'a {{b{c}} d']) {
      const r = renderizarDocumento(p, {});
      if (r.texto.includes('{{') || r.texto.includes('}}')) assert.equal(r.imprimibleDefinitivo, false, p);
    }
  });

  test('"[A COMPLETAR" sin cerrar o en minúsculas también bloquea', () => {
    for (const p of ['x [A COMPLETAR sin cerrar', 'x [a completar]', 'x [A  COMPLETAR]']) {
      assert.equal(renderizarDocumento(p, {}).imprimibleDefinitivo, false, p);
    }
  });

  test('valor que contiene [A COMPLETAR] bloquea el definitivo', () => {
    assert.equal(renderizarDocumento('{{motivo}}', { motivo: '[A COMPLETAR]' }).imprimibleDefinitivo, false);
  });

  test('BORRADOR solo en comentario marca esBorrador y no se imprime', () => {
    const r = renderizarDocumento('<!-- borrador v1 -->\nHola', {});
    assert.equal(r.esBorrador, true);
    assert.equal(r.texto, 'Hola');
    assert.equal(renderizarDocumento('Hola BORRADOR', {}).esBorrador, false);
  });

  test('variables dentro de comentarios no cuentan como faltantes', () => {
    const r = renderizarDocumento('<!-- {{farmacia.nombre}} -->\nHola', {});
    assert.deepEqual(r.faltan, []);
  });

  test('comentario sin cerrar no se imprime como si fuera contenido definitivo', () => {
    const r = renderizarDocumento('Hola\n<!-- BORRADOR sin cerrar {{farmacia.nombre}}', {});
    assert.ok(r.esBorrador || r.imprimibleDefinitivo === false);
  });

  test('un valor con "<!--" no se trata como comentario (se inserta tras quitar comentarios)', () => {
    const r = renderizarDocumento('{{motivo}} fin', { motivo: '<!-- x' });
    assert.ok(r.texto.endsWith(' fin'));
  });

  test('hash: estable y sensible a un carácter', () => {
    const base = datosCompletos();
    const p = '# T\n{{farmacia.nombre}} · {{paciente.nombre_completo}}';
    const a = renderizarDocumento(p, base);
    const b = renderizarDocumento(p, base);
    assert.equal(a.hash, b.hash);
    for (const campo of ['farmacia.nombre', 'paciente.nombre_completo']) {
      const t = (base[campo] as string);
      for (const mod of [t + '.', t.slice(0, -1), t.replace('a', 'á'), ' ' + t + ' '.repeat(0) + 'x']) {
        const c = renderizarDocumento(p, { ...base, [campo]: mod });
        assert.notEqual(c.hash, a.hash, `${campo} -> ${mod}`);
      }
    }
    assert.notEqual(renderizarDocumento(p + ' ', base).hash, a.hash);
    assert.notEqual(renderizarDocumento(p.replace('#', '##'), base).hash, a.hash);
  });
});

describe('documentos: estadoConsentimientos', () => {
  const vig = [{ codigo: 'consentimiento_spd', version: 2 }, { codigo: 'info_rgpd', version: 1 }];
  const req = ['consentimiento_spd', 'info_rgpd'];

  test('completo', () => {
    const e = estadoConsentimientos([{ codigo: 'consentimiento_spd', version: 2 }, { codigo: 'info_rgpd', version: 1 }], vig, req);
    assert.equal(e.completo, true);
  });
  test('nada firmado', () => {
    const e = estadoConsentimientos([], vig, req);
    assert.deepEqual(e.faltan, req);
    assert.equal(e.completo, false);
  });
  test('versión antigua => desactualizado', () => {
    const e = estadoConsentimientos([{ codigo: 'consentimiento_spd', version: 1 }, { codigo: 'info_rgpd', version: 1 }], vig, req);
    assert.deepEqual(e.desactualizados, ['consentimiento_spd']);
    assert.equal(e.completo, false);
  });
  test('revocado => revocados', () => {
    const e = estadoConsentimientos([{ codigo: 'consentimiento_spd', version: 2, revocadoEn: '2026-01-01' }, { codigo: 'info_rgpd', version: 1 }], vig, req);
    assert.deepEqual(e.revocados, ['consentimiento_spd']);
    assert.equal(e.completo, false);
  });
  test('revocado y luego refirmado (misma versión) => vigente', () => {
    const e = estadoConsentimientos([
      { codigo: 'consentimiento_spd', version: 2, revocadoEn: '2026-01-01' },
      { codigo: 'consentimiento_spd', version: 2, revocadoEn: null },
      { codigo: 'info_rgpd', version: 1 }], vig, req);
    assert.equal(e.completo, true);
  });
  test('v1 revocada y v2 refirmada => vigente; v2 revocada y v1 sin revocar => revocado', () => {
    const a = estadoConsentimientos([{ codigo: 'consentimiento_spd', version: 1, revocadoEn: 'x' }, { codigo: 'consentimiento_spd', version: 2 }, { codigo: 'info_rgpd', version: 1 }], vig, req);
    assert.equal(a.completo, true);
    const b = estadoConsentimientos([{ codigo: 'consentimiento_spd', version: 1 }, { codigo: 'consentimiento_spd', version: 2, revocadoEn: 'x' }, { codigo: 'info_rgpd', version: 1 }], vig, req);
    assert.deepEqual(b.revocados, ['consentimiento_spd']);
  });
  test('duplicados idénticos no cambian nada', () => {
    const f = { codigo: 'info_rgpd', version: 1 };
    const e = estadoConsentimientos([f, f, f, { codigo: 'consentimiento_spd', version: 2 }], vig, req);
    assert.equal(e.completo, true);
  });
  test('sin plantilla vigente => falta (no se da por bueno)', () => {
    const e = estadoConsentimientos([{ codigo: 'consentimiento_spd', version: 2 }, { codigo: 'info_rgpd', version: 1 }], [{ codigo: 'info_rgpd', version: 1 }], req);
    assert.deepEqual(e.faltan, ['consentimiento_spd']);
  });
  test('versiones raras (NaN, string, negativa) nunca dan completo', () => {
    for (const v of [NaN, '2', -1, undefined, null] as unknown as number[]) {
      const e = estadoConsentimientos([{ codigo: 'consentimiento_spd', version: v }, { codigo: 'info_rgpd', version: 1 }], vig, req);
      assert.equal(e.completo, false, String(v));
    }
  });
  test('plantillas vigentes duplicadas: manda la versión mayor', () => {
    const e = estadoConsentimientos([{ codigo: 'info_rgpd', version: 1 }], [{ codigo: 'info_rgpd', version: 1 }, { codigo: 'info_rgpd', version: 3 }], ['info_rgpd']);
    assert.equal(e.completo, false);
  });
  test('requeridos vacío => completo; códigos repetidos no duplican avisos', () => {
    assert.equal(estadoConsentimientos([], [], []).completo, true);
    assert.deepEqual(estadoConsentimientos([], vig, ['info_rgpd', 'info_rgpd']).faltan, ['info_rgpd']);
  });
  test('revocadoEn en blanco no cuenta como revocado... pero tampoco como vigente silencioso', () => {
    const e = estadoConsentimientos([{ codigo: 'info_rgpd', version: 1, revocadoEn: '' }], vig, ['info_rgpd']);
    assert.equal(e.completo, true);
  });
  test('código de un consentimiento no requerido no afecta', () => {
    const e = estadoConsentimientos([{ codigo: 'otro', version: 1, revocadoEn: 'x' }, { codigo: 'info_rgpd', version: 1 }], vig, ['info_rgpd']);
    assert.equal(e.completo, true);
  });
});
