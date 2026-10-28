import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizar, clasificarPorForma, clasificarMedicamento, evaluarIdoneidad,
  DATOS_SPD, ALIAS_SPD, FORMAS_NO_APTAS,
} from '../src/dominio/aptitud-spd.ts';

const estadoForma = (t: string) => clasificarPorForma(t)?.estado ?? null;
const estadoMed = (nombre: string, forma?: string, pa?: string) =>
  clasificarMedicamento({ nombre, formaFarmaceutica: forma, principioActivo: pa })?.estado ?? null;

test('normalizar: tildes, mayúsculas, espacios y entradas no válidas', () => {
  assert.equal(normalizar('  Ácido   ACETILSALICÍLICO '), 'acido acetilsalicilico');
  assert.equal(normalizar(''), '');
  assert.equal(normalizar(undefined), '');
  assert.equal(normalizar(42), '');
});

test('texto vacío o sin información → null (nunca adivina)', () => {
  assert.equal(clasificarPorForma(''), null);
  assert.equal(clasificarPorForma('   '), null);
  assert.equal(clasificarMedicamento({}), null);
  assert.equal(clasificarMedicamento({ nombre: '' }), null);
  assert.equal(clasificarMedicamento({ nombre: 'Fármaco desconocido XYZ 10 mg' }), null);
  assert.equal(clasificarMedicamento(undefined as never), null);
});

test('forma sin regla («comprimido recubierto») no decide', () => {
  assert.equal(clasificarPorForma('COMPRIMIDO RECUBIERTO CON PELICULA'), null);
  assert.equal(clasificarPorForma('Cápsula dura'), null);
});

test('efervescente', () => {
  const c = clasificarPorForma('Comprimido efervescente');
  assert.equal(c?.estado, 'no_apto');
  assert.match(c!.motivo, /efervescente/);
  assert.equal(estadoForma('COMPRIMIDOS EFERVESCENTES'), 'no_apto');
  assert.equal(estadoForma('Granulado efervescente'), 'no_apto');
});

test('sublingual y marcas sublinguales', () => {
  assert.equal(estadoForma('Comprimido sublingual'), 'no_apto');
  assert.equal(estadoForma('Cafinitrina 1 mg'), 'no_apto');
  assert.equal(estadoForma('Vernies'), 'no_apto');
});

test('bucodispersable / Flas / liofilizado / ODT / melt / dispersable', () => {
  for (const t of ['Comprimido bucodispersable', 'Mirtazapina Flas', 'Liotab', 'liofilizado oral',
    'Comprimido orodispersable', 'Risperidona ODT', 'Zolmitriptan Melt', 'Comprimido dispersable',
    'Aspirina soluble']) {
    assert.equal(estadoForma(t), 'no_apto', t);
  }
  assert.match(clasificarPorForma('Mirtazapina Flas')!.motivo, /bucodispersable/);
});

test('liberación modificada/prolongada → precaución', () => {
  for (const t of ['Comprimido de liberación prolongada', 'comprimidos liberacion modificada',
    'Tramadol retard', 'Quetiapina SR', 'Seroquel XR', 'Metoprolol MR', 'Nifedipino XL',
    'Concerta OROS', 'Diltiazem liberación retardada', 'liberación sostenida', 'liberación controlada']) {
    assert.equal(estadoForma(t), 'precaucion', t);
  }
  assert.equal(clasificarPorForma('Quetiapina SR')?.categoria, 'forma');
});

test('falsos positivos: «la» y «cr» no son liberación modificada', () => {
  assert.equal(estadoForma('Levotiroxina LA'), null);
  assert.equal(estadoForma('Metformina CR'), null);
  assert.equal(estadoForma('Dame la pastilla de la mañana'), null);
  assert.equal(estadoMed('Levotiroxina LA', undefined, 'levotiroxina'), 'precaucion'); // por dataset, no por forma
});

test('falsos positivos: siglas e «melt» dentro de otra palabra', () => {
  assert.equal(estadoForma('Dolmelton'), null);
  assert.equal(estadoForma('Rexulti'), null);   // «xl» dentro de «rexulti»
  assert.equal(estadoForma('Ansrmax'), null);   // «sr» pegado a otras letras
  assert.equal(estadoForma('Sobredosis'), null); // «sobre» sin frontera
  assert.equal(estadoForma('Retardo'), null);    // «retard» sin \b final
});

test('sobres, granulado y polvo', () => {
  for (const t of ['Sobres', 'sobre 5 g', 'Granulado', 'Polvo para suspensión oral', 'polvo']) {
    assert.equal(estadoForma(t), 'no_apto', t);
  }
});

test('líquidos orales: jarabe, solución, suspensión, gotas', () => {
  for (const t of ['Jarabe', 'Solución oral', 'Suspensión', 'Gotas orales', 'Elixir', 'Emulsión']) {
    assert.equal(estadoForma(t), 'no_apto', t);
    assert.match(clasificarPorForma(t)!.motivo, /líquida oral/);
  }
});

test('orden de reglas: oftálmica/ótica antes que líquidos', () => {
  const c = clasificarPorForma('Gotas oftálmicas');
  assert.match(c!.motivo, /oftálmica/);
  assert.match(clasificarPorForma('Colirio en solución')!.motivo, /oftálmica/);
  assert.match(clasificarPorForma('Gotas óticas')!.motivo, /oftálmica\/ótica/);
  assert.match(clasificarPorForma('Spray nasal')!.motivo, /nasal/);
});

test('parche, inhalador, tópicos, rectal/vaginal', () => {
  assert.match(clasificarPorForma('Parche transdérmico')!.motivo, /Parche/);
  assert.match(clasificarPorForma('Fentanilo parche')!.motivo, /Parche/);
  assert.match(clasificarPorForma('Inhalador Turbuhaler')!.motivo, /inhalada/);
  assert.match(clasificarPorForma('Aerosol presurizado')!.motivo, /inhalada/);
  assert.match(clasificarPorForma('Crema')!.motivo, /tópica/);
  assert.match(clasificarPorForma('Pomada')!.motivo, /tópica/);
  assert.match(clasificarPorForma('Gel')!.motivo, /tópica/);
  assert.match(clasificarPorForma('Supositorio')!.motivo, /rectal/);
  assert.match(clasificarPorForma('Óvulo vaginal')!.motivo, /rectal/);
});

test('insulina, inyectables y nevera', () => {
  assert.match(clasificarPorForma('Insulina glargina')!.motivo, /inyectable/);
  assert.match(clasificarPorForma('Lantus pluma precargada')!.motivo, /inyectable/);
  assert.equal(estadoForma('Solución inyectable en jeringa'), 'no_apto'); // gana «líquida oral» (misma consecuencia)
  assert.match(clasificarPorForma('Jeringa precargada')!.motivo, /inyectable/);
  assert.match(clasificarPorForma('Ampolla')!.motivo, /inyectable/);
  const n = clasificarPorForma('Conservar en nevera');
  assert.equal(n?.estado, 'no_apto');
  assert.match(n!.motivo, /nevera/);
  assert.match(clasificarPorForma('Medicamento termolábil')!.motivo, /nevera/);
  assert.match(clasificarPorForma('Refrigerar')!.motivo, /nevera/);
});

test('masticable → precaución', () => {
  assert.equal(estadoForma('Comprimido masticable'), 'precaucion');
});

test('mayúsculas y tildes no cambian el resultado', () => {
  assert.equal(estadoForma('COMPRIMIDO EFERVESCENTE'), estadoForma('comprimido efervescente'));
  assert.equal(estadoForma('LIBERACIÓN PROLONGADA'), 'precaucion');
  assert.equal(estadoMed('SINTROM 4 MG'), 'no_apto');
});

test('acenocumarol y warfarina: dosis variable, no apto', () => {
  for (const m of [
    clasificarMedicamento({ principioActivo: 'acenocumarol' }),
    clasificarMedicamento({ nombre: 'Sintrom 4 mg comprimidos' }),
    clasificarMedicamento({ nombre: 'Aldocumar' }),
    clasificarMedicamento({ principioActivo: 'warfarina' }),
  ]) {
    assert.equal(m?.estado, 'no_apto');
    assert.equal(m?.categoria, 'dosis_variable');
  }
});

test('citotóxicos: no apto', () => {
  for (const pa of ['metotrexato', 'capecitabina', 'hidroxiurea']) {
    const c = clasificarMedicamento({ principioActivo: pa });
    assert.equal(c?.estado, 'no_apto', pa);
    assert.equal(c?.categoria, 'citotoxico', pa);
  }
  assert.match(clasificarMedicamento({ nombre: 'Metotrexato oral 2,5 mg' })!.motivo, /semanal/);
});

test('aptos: metformina 850 comprimidos y compañía', () => {
  assert.equal(estadoMed('Metformina 850 mg comprimidos'), 'apto');
  assert.equal(estadoMed('Dianben 850'), 'apto');
  for (const pa of ['enalapril', 'ramipril', 'amlodipino', 'bisoprolol', 'atorvastatina',
    'simvastatina', 'rosuvastatina', 'paracetamol', 'metamizol', 'losartan', 'furosemida',
    'gliclazida', 'sertralina', 'lorazepam']) {
    assert.equal(estadoMed(pa, 'COMPRIMIDO RECUBIERTO'), 'apto', pa);
  }
});

test('precaución por dataset: omeprazol cápsula, levotiroxina, litio, bifosfonatos…', () => {
  assert.equal(estadoMed('Omeprazol 20 mg cápsulas gastrorresistentes', 'CAPSULA DURA GASTRORRESISTENTE'), 'precaucion');
  assert.equal(estadoMed('Losec'), 'precaucion');
  assert.equal(estadoMed('Eutirox 100'), 'precaucion');
  assert.equal(estadoMed('Carbonato de litio'), 'precaucion');
  assert.equal(estadoMed('Plenur'), 'precaucion');
  assert.equal(estadoMed('Digoxina 0,25'), 'precaucion');
  assert.equal(estadoMed('Fosamax semanal'), 'precaucion');
  assert.equal(estadoMed('Adiro 100'), 'precaucion');
  assert.equal(estadoMed('Anticonceptivo oral'), 'precaucion');
});

test('la forma de CIMA manda sobre el principio activo', () => {
  // metformina es apta, pero en solución oral no se emblista
  assert.equal(estadoMed('Metformina', 'SOLUCION ORAL', 'metformina'), 'no_apto');
  // acenocumarol en comprimido: la forma no decide, decide el dataset
  assert.equal(estadoMed('Sintrom', 'COMPRIMIDO', 'acenocumarol'), 'no_apto');
  // liberación prolongada gana a «apto» del dataset
  assert.equal(estadoMed('Metformina', 'COMPRIMIDO DE LIBERACION PROLONGADA', 'metformina'), 'precaucion');
  // «Adiro efervescente» en el nombre: la forma gana a la precaución del dataset
  assert.equal(estadoMed('Adiro efervescente', undefined, 'acido acetilsalicilico'), 'no_apto');
  assert.equal(estadoMed('Insulina glargina', 'SOLUCION INYECTABLE EN PLUMA PRECARGADA'), 'no_apto');
});

test('el nombre se usa si no hay principio activo y viceversa', () => {
  assert.equal(estadoMed('', undefined, 'Ácido acetilsalicílico'), 'precaucion');
  assert.equal(estadoMed('Zarator 20 mg'), 'apto');
  assert.equal(estadoMed('Cardyl'), 'apto');
});

test('alias cortos («aas») sólo casan exactos, no por subcadena', () => {
  assert.equal(estadoMed('AAS'), 'precaucion');
  assert.equal(estadoMed('Zaasol 5 mg'), null);
  assert.equal(estadoMed('Maasai forte'), null);
});

test('toda clasificación es propuesta del motor y trae fuente y motivo', () => {
  const todas = [
    clasificarPorForma('efervescente'),
    clasificarMedicamento({ principioActivo: 'metformina' }),
    clasificarMedicamento({ nombre: 'Sintrom' }),
  ];
  for (const c of todas) {
    assert.ok(c);
    assert.equal(c.decidePor, 'motor');
    assert.ok(c.motivo.length > 10);
    assert.ok(c.fuente.length > 10);
  }
  assert.match(todas[0]!.fuente, /forma/i);
  assert.match(todas[1]!.fuente, /Dataset/);
});

test('coherencia del dataset: estados válidos y alias que apuntan a una ficha', () => {
  for (const [k, d] of Object.entries(DATOS_SPD)) {
    assert.ok(['apto', 'precaucion', 'no_apto'].includes(d.estado), k);
    assert.ok(d.motivo && d.categoria, k);
  }
  for (const [a, k] of Object.entries(ALIAS_SPD)) assert.ok(DATOS_SPD[k], `${a} → ${k}`);
  for (const r of FORMAS_NO_APTAS) assert.ok(r.estado === undefined || r.estado === 'precaucion');
});

test('idoneidad: perfil alto', () => {
  const r = evaluarIdoneidad({ numFarmacos: 12, tomasDia: 4, olvidos: 'frecuente', autonomia: 'dependiente',
    deterioroCognitivo: true, viveSolo: true });
  assert.equal(r.nivel, 'alta');
  assert.equal(r.puntuacion, 3 + 2 + 3 + 2 + 2 + 1);
  assert.equal(r.factores.length, 6);
  assert.equal(r.decidePor, 'motor');
  assert.match(r.recomendacion, /claro/);
});

test('idoneidad: umbrales 3 y 6', () => {
  assert.equal(evaluarIdoneidad({ numFarmacos: 5, tomasDia: 3 }).puntuacion, 3);
  assert.equal(evaluarIdoneidad({ numFarmacos: 5, tomasDia: 3 }).nivel, 'media');
  assert.equal(evaluarIdoneidad({ numFarmacos: 5, tomasDia: 2 }).nivel, 'baja');
  assert.equal(evaluarIdoneidad({ numFarmacos: 10, olvidos: 'frecuente' }).nivel, 'alta');
  assert.equal(evaluarIdoneidad({ numFarmacos: 10, olvidos: 'aveces' }).nivel, 'media');
});

test('idoneidad: cada factor suma lo suyo', () => {
  assert.equal(evaluarIdoneidad({ numFarmacos: 3 }).puntuacion, 1);
  assert.equal(evaluarIdoneidad({ tomasDia: 4 }).puntuacion, 2);
  assert.equal(evaluarIdoneidad({ olvidos: 'aveces' }).puntuacion, 1);
  assert.equal(evaluarIdoneidad({ olvidos: 'nunca' }).puntuacion, 0);
  assert.equal(evaluarIdoneidad({ autonomia: 'ayuda' }).puntuacion, 1);
  assert.equal(evaluarIdoneidad({ autonomia: 'autonomo' }).puntuacion, 0);
  assert.equal(evaluarIdoneidad({ dificultadManipulacion: true }).puntuacion, 1);
  assert.equal(evaluarIdoneidad({ pautaCompleja: true }).puntuacion, 1);
  assert.equal(evaluarIdoneidad({ variosPrescriptores: true }).puntuacion, 1);
});

test('idoneidad: entradas raras no rompen (cadenas, vacío, undefined)', () => {
  assert.equal(evaluarIdoneidad({ numFarmacos: '12' }).puntuacion, 3);
  assert.equal(evaluarIdoneidad({ numFarmacos: 'abc' }).puntuacion, 0);
  const vacio = evaluarIdoneidad({});
  assert.equal(vacio.nivel, 'baja');
  assert.deepEqual(vacio.factores, []);
  assert.equal(evaluarIdoneidad(undefined as never).puntuacion, 0);
});
