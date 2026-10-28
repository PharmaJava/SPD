import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analizarDescripcion as a, resumenDescripcion as res, AVISO_RANURA, AVISO_SIN_DESCRIPCION } from '../src/dominio/descripcion-fisica.ts';

// Todos los textos son SINTÉTICOS, con el estilo de la sección 3 de la ficha técnica.

test('comprimido con ranura en una cara y grabado en la otra', () => {
  const r = a('Comprimidos recubiertos con película, blancos, oblongos, biconvexos, con ranura en una cara y grabados con "M 850" en la otra.');
  assert.deepEqual(r.colores, ['blanco']);
  assert.equal(r.forma, 'oblongo, biconvexo');
  assert.equal(r.ranura, 'una_cara');
  assert.deepEqual(r.marcas, ['M 850']);
  assert.equal(r.tipo, 'comprimido');
  assert.equal(r.recubierto, true);
});

test('ranuraDivisible es siempre desconocido y avisa si hay ranura', () => {
  for (const t of ['Comprimido redondo blanco, con ranura en una cara', 'Comprimido blanco ranurado en ambas caras', 'Comprimido blanco, sin ranura', 'Comprimido blanco']) {
    assert.equal(a(t).ranuraDivisible, 'desconocido');
  }
  assert.ok(a('Comprimido blanco ranurado en ambas caras').avisos.includes(AVISO_RANURA));
  assert.ok(!a('Comprimido blanco, sin ranura').avisos.includes(AVISO_RANURA));
});

test('cápsula bicolor: cuerpo y cabeza', () => {
  const r = a('Cápsulas duras de gelatina, cuerpo blanco y cabeza azul opaca, con la inscripción "20" en tinta negra.');
  assert.equal(r.tipo, 'capsula');
  assert.deepEqual(r.colores, ['blanco', 'azul opaco']);
  assert.deepEqual(r.marcas, ['20']);
  assert.ok(r.avisos.some((x) => x.includes('cuerpo blanco') && x.includes('cabeza azul opaco')));
  assert.ok(!r.colores.includes('negro'), 'el color de la tinta no es el de la cápsula');
});

test('comprimido redondo amarillo claro ranurado en ambas caras', () => {
  const r = a('Comprimido redondo, de color amarillo claro, ranurado en ambas caras');
  assert.deepEqual(r.colores, ['amarillo claro']);
  assert.equal(r.forma, 'redondo');
  assert.equal(r.ranura, 'ambas_caras');
});

test('comprimidos oblongos rosa con ranura marcados en una cara', () => {
  const r = a('Comprimidos oblongos de color rosa, con ranura, marcados con "AB 5" en una cara.');
  assert.deepEqual(r.colores, ['rosa']);
  assert.equal(r.ranura, 'sin_dato');
  assert.ok(r.avisos.includes(AVISO_RANURA));
  assert.ok(r.avisos.some((x) => x.includes('cuántas caras')));
  assert.deepEqual(r.marcas, ['AB 5']);
});

test('género y plural se normalizan', () => {
  for (const [t, c] of [['blancos', 'blanco'], ['Blancas', 'blanco'], ['BLANCA', 'blanco'], ['amarillas', 'amarillo'], ['rojos', 'rojo'], ['verdes', 'verde'], ['azules', 'azul'], ['marrones', 'marrón'], ['grises', 'gris'], ['negras', 'negro'], ['naranjas', 'naranja']] as const) {
    assert.deepEqual(a(`Comprimidos ${t}, redondos`).colores, [c], t);
  }
  assert.equal(a('Comprimidos ovalados').forma, 'ovalado');
  assert.equal(a('Comprimidas redondas').forma, 'redondo');
  assert.equal(a('Comprimido oval').forma, 'ovalado');
});

test('tildes: bicóncavo, cilíndrico, elíptico, marrón', () => {
  assert.equal(a('Comprimido bicóncavo').forma, 'bicóncavo');
  assert.equal(a('Comprimido biconcavo').forma, 'bicóncavo');
  assert.equal(a('Comprimido CILÍNDRICO').forma, 'cilíndrico');
  assert.equal(a('Comprimido elíptico').forma, 'elíptico');
  assert.deepEqual(a('Comprimido marron').colores, ['marrón']);
});

test('mayúsculas y minúsculas', () => {
  const r = a('COMPRIMIDOS BLANCOS, REDONDOS, CON RANURA EN UNA CARA');
  assert.deepEqual(r.colores, ['blanco']);
  assert.equal(r.forma, 'redondo');
  assert.equal(r.ranura, 'una_cara');
});

test('«sin ranura» y variantes negadas', () => {
  for (const t of [
    'Comprimido blanco, sin ranura', 'Comprimido blanco sin ninguna ranura', 'Comprimido blanco, no ranurado',
    'Comprimido blanco que no presenta ranura', 'Comprimido blanco, no tiene ranuras', 'Comprimido blanco sin marca ni ranura',
    'Comprimido blanco, sin grabado ni ranura', 'Comprimido blanco, carece de ranura',
  ]) assert.equal(a(t).ranura, 'ninguna', t);
});

test('«no ranurado» no cuenta como ranura ni avisa de divisibilidad', () => {
  const r = a('Comprimidos blancos, redondos, no ranurados.');
  assert.equal(r.ranura, 'ninguna');
  assert.ok(!r.avisos.includes(AVISO_RANURA));
  assert.ok(!/ranurado/.test(res(r)));
});

test('la negación no se contagia a otra cláusula ni a otra palabra', () => {
  assert.equal(a('Comprimido sin recubrir, con ranura en una cara').ranura, 'una_cara');
  assert.equal(a('Comprimido no recubierto con ranura en ambas caras').ranura, 'ambas_caras');
  assert.equal(a('Comprimidos no ranurados recubiertos').recubierto, true);
});

test('ranura afirmada y negada a la vez: aviso y no se esconde', () => {
  const r = a('Comprimido sin ranura en una cara y con ranura en la otra');
  assert.equal(r.ranura, 'una_cara');
  assert.ok(r.avisos.some((x) => x.includes('con y sin')));
});

test('ranura mencionada en la otra cara', () => {
  assert.equal(a('Comprimido blanco, grabado con "X" en una cara y ranurado en la otra').ranura, 'una_cara');
  assert.equal(a('Comprimido blanco con una ranura en cada cara').ranura, 'ambas_caras');
  assert.equal(a('Comprimido blanco con ambas caras ranuradas').ranura, 'ambas_caras');
});

test('el grabado en ambas caras no se confunde con la ranura', () => {
  const r = a('Comprimido blanco, con ranura en una cara y grabado "A" en ambas caras');
  assert.equal(r.ranura, 'una_cara');
});

test('línea de rotura, surco y muesca cuentan como ranura (con aviso)', () => {
  for (const t of ['Comprimido blanco con línea de rotura en una cara', 'Comprimido blanco con surco', 'Comprimido blanco con muesca']) {
    assert.ok(a(t).avisos.includes(AVISO_RANURA), t);
  }
});

test('comillas rectas, tipográficas, latinas y simples', () => {
  assert.deepEqual(a('Comprimido blanco grabado con "A1"').marcas, ['A1']);
  assert.deepEqual(a('Comprimido blanco grabado con “B2”').marcas, ['B2']);
  assert.deepEqual(a('Comprimido blanco grabado con «C3»').marcas, ['C3']);
  assert.deepEqual(a("Comprimido blanco grabado con 'D4'").marcas, ['D4']);
  assert.deepEqual(a('Comprimido blanco grabado con ‘E5’').marcas, ['E5']);
  assert.deepEqual(a('Comprimido blanco, “F 6” en una cara y «G 7» en la otra').marcas, ['F 6', 'G 7']);
});

test('apóstrofo dentro de una palabra no abre una marca', () => {
  const r = a("Comprimido blanco, d'un tipo redondo");
  assert.deepEqual(r.marcas, []);
  assert.equal(r.forma, 'redondo');
});

test('comillas sin cerrar: aviso, sin inventar marca', () => {
  const r = a('Comprimido blanco grabado con “ABC en una cara');
  assert.deepEqual(r.marcas, []);
  assert.ok(r.avisos.some((x) => x.includes('comillas sin cerrar')));
});

test('el texto de la marca no contamina color ni forma', () => {
  const r = a('Comprimido blanco, grabado con "ROJO redondo"');
  assert.deepEqual(r.colores, ['blanco']);
  assert.equal(r.forma, null);
  assert.deepEqual(r.marcas, ['ROJO redondo']);
});

test('marcas repetidas se deduplican y las vacías se ignoran', () => {
  assert.deepEqual(a('Comprimido blanco "A" en una cara y "A" en la otra, ""').marcas, ['A']);
});

test('colores compuestos conservan el detalle', () => {
  assert.deepEqual(a('Comprimido de color rosa pálido').colores, ['rosa pálido']);
  assert.deepEqual(a('Comprimidos amarillo anaranjado').colores, ['amarillo anaranjado']);
  assert.deepEqual(a('Comprimidos verde oscuro').colores, ['verde oscuro']);
  assert.deepEqual(a('Comprimidos azul muy claro').colores, ['azul claro']);
  assert.deepEqual(a('Comprimidos rosada').colores, ['rosa']);
});

test('«blanco o casi blanco» se conserva y avisa', () => {
  const r = a('Comprimidos de color blanco o casi blanco, redondos');
  assert.deepEqual(r.colores, ['blanco o casi blanco']);
  assert.ok(r.avisos.some((x) => x.includes('color ambiguo')));
});

test('blanco o amarillento / blanco o rosa', () => {
  assert.deepEqual(a('Comprimido blanco o ligeramente amarillento').colores, ['blanco o ligeramente amarillento']);
  assert.deepEqual(a('Comprimidos blancos o rosas').colores, ['blanco o rosa']);
});

test('dos colores sin partes: aviso de varios colores', () => {
  const r = a('Comprimidos bicapa, una capa blanca y otra azul');
  assert.deepEqual(r.colores, ['blanco', 'azul']);
  assert.ok(r.avisos.some((x) => x.includes('varios colores')));
  assert.ok(r.avisos.some((x) => x.includes('motas, capas')));
});

test('«cuerpo y cabeza blancos»: un solo color en las dos partes', () => {
  const r = a('Cápsulas duras, cuerpo y cabeza blancos');
  assert.deepEqual(r.colores, ['blanco']);
  assert.ok(!r.avisos.some((x) => x.includes('por partes')));
});

test('solo se indica el color de una parte de la cápsula', () => {
  const r = a('Cápsulas duras con cabeza azul');
  assert.deepEqual(r.colores, ['azul']);
  assert.ok(r.avisos.some((x) => x.includes('solo para la cabeza')));
});

test('tapa se trata como cabeza', () => {
  const r = a('Cápsulas con cuerpo rojo y tapa verde');
  assert.ok(r.avisos.some((x) => x.includes('cabeza verde')));
});

test('sabor o aroma no es un color', () => {
  assert.deepEqual(a('Comprimidos masticables blancos, con sabor naranja').colores, ['blanco']);
});

test('texto sin color: lista vacía y aviso', () => {
  const r = a('Comprimidos redondos y biconvexos, ranurados en una cara.');
  assert.deepEqual(r.colores, []);
  assert.ok(r.avisos.includes('color no indicado en el texto'));
  assert.equal(res(r), 'Comprimido, redondo, biconvexo, ranurado');
});

test('dos formas de contorno: se listan y se avisa', () => {
  const r = a('Comprimidos redondos u oblongos según la dosis');
  assert.equal(r.forma, 'redondo, oblongo');
  assert.ok(r.avisos.some((x) => x.includes('varias formas')));
});

test('forma negada no cuenta', () => {
  assert.equal(a('Comprimido blanco no biconvexo').forma, null);
});

test('«forma de cápsula» es forma, no tipo', () => {
  const r = a('Comprimidos blancos con forma de cápsula');
  assert.equal(r.tipo, 'comprimido');
  assert.equal(r.forma, 'capsulado');
});

test('tipo: gragea, otro y desconocido', () => {
  assert.equal(a('Grageas rojas').tipo, 'gragea');
  assert.equal(a('Polvo blanco para solución oral').tipo, 'otro');
  assert.equal(a('Blanco y redondo').tipo, null);
  assert.ok(a('Comprimidos que se presentan en cápsulas blancas').avisos.some((x) => x.includes('varios tipos')));
});

test('recubierto: sí, no y sin dato', () => {
  assert.equal(a('Comprimidos recubiertos con película, blancos').recubierto, true);
  assert.equal(a('Comprimidos blancos, sin recubrir').recubierto, false);
  assert.equal(a('Comprimidos blancos no recubiertos').recubierto, false);
  assert.equal(a('Comprimidos blancos').recubierto, null);
  assert.equal(a('Comprimidos blancos, pelicular y no recubiertos').recubierto, null);
});

test('HTML, entidades y markdown residuales', () => {
  const r = a('<p><strong>Comprimidos&nbsp;blancos</strong>,&nbsp;redondos, con ranura en una cara&#44; grabados con &quot;K 9&quot;.</p>');
  assert.deepEqual(r.colores, ['blanco']);
  assert.equal(r.forma, 'redondo');
  assert.deepEqual(r.marcas, ['K 9']);
  const m = a('**Comprimidos** __blancos__, `redondos`\n# oblongos');
  assert.deepEqual(m.colores, ['blanco']);
});

test('una etiqueta no cerrada no se traga el texto', () => {
  const r = a('Comprimidos blancos < 5 mg, redondos');
  assert.deepEqual(r.colores, ['blanco']);
  assert.equal(r.forma, 'redondo');
});

test('texto vacío, espacios o sin información: todo vacío y aviso', () => {
  for (const t of ['', '   \n ', 'Ver composición cualitativa y cuantitativa.', '12345', 'zzzz']) {
    const r = a(t);
    assert.deepEqual(r.colores, []);
    assert.equal(r.forma, null);
    assert.equal(r.ranura, 'sin_dato');
    assert.deepEqual(r.marcas, []);
    assert.equal(r.tipo, null);
    assert.equal(r.recubierto, null);
    assert.ok(r.avisos.includes(AVISO_SIN_DESCRIPCION), JSON.stringify(t));
    assert.equal(res(r), '');
    assert.equal(r.textoOriginal, t);
  }
});

test('entradas que no son texto no rompen', () => {
  assert.equal(a(undefined as unknown as string).textoOriginal, '');
  assert.equal(a(null as unknown as string).avisos[0], AVISO_SIN_DESCRIPCION);
  assert.equal(a(42 as unknown as string).forma, null);
});

test('textoOriginal se conserva tal cual', () => {
  const t = '  <b>Comprimido</b> blanco  ';
  assert.equal(a(t).textoOriginal, t);
});

test('resumen: comprimido blanco, oblongo, ranurado', () => {
  assert.equal(res(a('Comprimidos blancos, oblongos, con ranura en una cara')), 'Comprimido blanco, oblongo, ranurado');
});

test('resumen: cápsula bicolor en femenino', () => {
  assert.equal(res(a('Cápsulas duras, cuerpo blanco y cabeza azul opaca')), 'Cápsula bicolor blanca y azul opaca');
});

test('resumen: cápsula nunca "ranurada" y gragea en femenino', () => {
  assert.equal(res(a('Cápsulas rojas, redondas')), 'Cápsula roja, redonda');
  assert.equal(res(a('Grageas blancas, ovaladas')), 'Gragea blanca, ovalada');
});

test('resumen: sin tipo conocido solo con color o forma; vacío si no hay ninguno', () => {
  assert.equal(res(a('Blanco y redondo')), 'Blanco, redondo');
  assert.equal(res(a('Comprimidos recubiertos')), '');
  assert.equal(res(a('Comprimidos grabados con "X"')), '');
});

test('resumen: color ambiguo se conserva', () => {
  assert.equal(res(a('Comprimidos blancos o casi blancos, redondos')), 'Comprimido blanco o casi blanco, redondo');
});

test('resumen: robusto con objetos incompletos', () => {
  assert.equal(res(undefined as never), '');
  assert.equal(res({} as never), '');
});

test('rendimiento: 100.000 caracteres de texto normal', () => {
  const t = 'Comprimidos blancos, redondos, con ranura en una cara y grabados con "M 850" en la otra. '.repeat(1200).slice(0, 100000);
  const t0 = performance.now();
  const r = a(t);
  assert.ok(performance.now() - t0 < 200, 'demasiado lento');
  assert.deepEqual(r.colores, ['blanco']);
});

test('rendimiento: entradas adversarias de 100.000 caracteres', () => {
  const casos = ['<'.repeat(100000), '<a '.repeat(33000), '"'.repeat(100000), "'".repeat(100000), '“'.repeat(100000),
    'a'.repeat(100000), 'sin '.repeat(25000), 'de '.repeat(33000) + 'ranura', '&'.repeat(100000), '&#'.repeat(50000), ' \n'.repeat(50000), '. '.repeat(50000), 'blanco '.repeat(14000)];
  for (const c of casos) {
    const t0 = performance.now();
    a(c);
    const ms = performance.now() - t0;
    assert.ok(ms < 200, `${c.slice(0, 6)}… tardó ${ms.toFixed(0)} ms`);
  }
});

test('limitación conocida: la cara tras una coma no se lee y se avisa (sin_dato)', () => {
  const r = a('Comprimido blanco con dos ranuras, una en cada cara');
  assert.equal(r.ranura, 'sin_dato');
  assert.ok(r.avisos.includes(AVISO_RANURA));
});

test('los atributos HTML no aportan colores', () => {
  const r = a('<td class="rojo" style="background:azul">Comprimido blanco</td>');
  assert.deepEqual(r.colores, ['blanco']);
});

test('rendimiento: comillas de apertura sin cierre (coste lineal)', () => {
  const t0 = performance.now();
  a('“'.repeat(100000));
  assert.ok(performance.now() - t0 < 100, 'coste no lineal con comillas sin cerrar');
});
