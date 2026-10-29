import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consultarCima, normalizarCnCima, urlAemps, textoSeguro, htmlATexto, unidadesDePresentacion, textoSeccion3, TIEMPO_LIMITE_CIMA_MS } from '../src/servicios/cima.ts';
import type { FetchLike, RespuestaHttp } from '../src/servicios/cima.ts';

const resp = (status: number, cuerpo: string): RespuestaHttp => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => cuerpo });
const sinEspera = async () => {};

const FICHA = {
  nregistro: '65432', nombre: 'METFORMINA CINFA 850 mg COMPRIMIDOS RECUBIERTOS CON PELICULA EFG', labtitular: 'LABORATORIOS CINFA',
  formaFarmaceutica: { id: 1, nombre: 'COMPRIMIDO RECUBIERTO CON PELÍCULA' }, receta: true, comerc: true, psum: false, triangulo: false, conduc: false,
  cpresc: 'Con receta médica',
  principiosActivos: [{ nombre: 'METFORMINA HIDROCLORURO', cantidad: '850', unidad: 'mg' }],
  presentaciones: [{ cn: '654321', nombre: 'METFORMINA CINFA 850 mg COMPRIMIDOS RECUBIERTOS CON PELICULA EFG, 50 comprimidos', comerc: true }, { cn: '654322', nombre: 'X, 100 comprimidos' }],
  docs: [{ tipo: 1, url: 'https://cima.aemps.es/cima/pdfs/ft/65432/FT_65432.pdf' }, { tipo: 2, url: 'https://cima.aemps.es/cima/pdfs/p/65432/P_65432.pdf' }],
};
const SECCION3 = '<p>Comprimidos recubiertos con película, blancos, redondos, biconvexos, con ranura en una cara y grabado &quot;M 850&quot;.</p>';

/** Fetch simulado por ruta; cuenta las llamadas. */
function simular(rutas: { medicamento?: () => Promise<RespuestaHttp> | RespuestaHttp; seccion?: () => Promise<RespuestaHttp> | RespuestaHttp }) {
  const llamadas: string[] = [];
  const f: FetchLike = async (url) => {
    llamadas.push(url);
    if (url.includes('/medicamento?')) return rutas.medicamento!();
    if (url.includes('docSegmentado')) return rutas.seccion ? rutas.seccion() : resp(404, '');
    throw new Error('ruta inesperada ' + url);
  };
  return { f, llamadas };
}
const cima = (r: Parameters<typeof simular>[0], extra = {}) => { const s = simular(r); return { s, p: consultarCima('654321', { fetch: s.f, esperar: sinEspera, ...extra }) }; };

test('éxito completo: ficha + sección 3 → propuesta de descripción y aptitud', async () => {
  const { s, p } = cima({ medicamento: () => resp(200, JSON.stringify(FICHA)), seccion: () => resp(200, SECCION3) });
  const r = await p;
  assert.ok(r.ok && r.datos.disponible);
  const d = (r as any).datos;
  assert.equal(d.medicamento.cn, '654321');
  assert.equal(d.medicamento.nregistro, '65432');
  assert.match(d.medicamento.principiosActivos, /METFORMINA HIDROCLORURO 850 mg/);
  assert.equal(d.medicamento.unidadesEnvase, 50);
  assert.equal(d.medicamento.receta, true);
  assert.equal(d.medicamento.descripcionEstado, 'propuesta');
  assert.ok(d.descripcion.colores.includes('blanco'));
  assert.equal(d.medicamento.ranurado, null, 'la divisibilidad la marca el farmacéutico');
  assert.equal(d.medicamento.spdAptitud, null, 'la aptitud propuesta no se aplica sola');
  assert.equal(d.medicamento.urlFichaTecnica, 'https://cima.aemps.es/cima/pdfs/ft/65432/FT_65432.pdf');
  assert.equal(s.llamadas.length, 2);
  assert.ok(s.llamadas[0].endsWith('medicamento?cn=654321'));
  assert.ok(s.llamadas[1].includes('nregistro=65432') && s.llamadas[1].includes('seccion=3'));
});

test('a CIMA sólo viaja el CN: la URL no lleva nada más', async () => {
  const { s, p } = cima({ medicamento: () => resp(200, JSON.stringify(FICHA)), seccion: () => resp(200, SECCION3) });
  await p;
  assert.equal(s.llamadas[0], 'https://cima.aemps.es/cima/rest/medicamento?cn=654321');
});

test('CN de 7 cifras: se descarta el dígito de control sin validarlo', async () => {
  const s = simular({ medicamento: () => resp(200, JSON.stringify(FICHA)), seccion: () => resp(200, SECCION3) });
  const r = await consultarCima('6543219', { fetch: s.f, esperar: sinEspera });
  assert.ok(r.ok && r.datos.disponible);
  assert.ok(s.llamadas[0].endsWith('cn=654321'));
});

test('CN no válido: fallo sin llamar a la red', async () => {
  let n = 0;
  const f: FetchLike = async () => { n++; return resp(200, '{}'); };
  for (const cn of ['', '12345', '12345678', 'abcdef', '65 4321', '654321; DROP', null as any, 654321 as any]) {
    const r = await consultarCima(cn, { fetch: f, esperar: sinEspera });
    assert.equal(r.ok, false, String(cn));
  }
  assert.equal(n, 0);
});

test('404: disponible:false con aviso', async () => {
  const r = await cima({ medicamento: () => resp(404, 'not found') }).p;
  assert.ok(r.ok && !r.datos.disponible); assert.match(r.datos.aviso!, /no tiene/i);
});

test('204 sin cuerpo y 200 vacío: no son éxito', async () => {
  for (const cr of [resp(204, ''), resp(200, ''), resp(200, '   \n')]) {
    const r = await cima({ medicamento: () => cr }).p;
    assert.ok(r.ok && !r.datos.disponible);
  }
});

test('200 con objeto vacío o sin nombre: no es éxito', async () => {
  for (const cuerpo of ['{}', '{"nregistro":"1"}', '{"nombre":""}', '{"nombre":"   "}', '{"nombre":5}']) {
    const r = await cima({ medicamento: () => resp(200, cuerpo) }).p;
    assert.ok(r.ok && !r.datos.disponible, cuerpo);
  }
});

test('JSON inválido: disponible:false', async () => {
  const r = await cima({ medicamento: () => resp(200, '{"nombre": ') }).p;
  assert.ok(r.ok && !r.datos.disponible); assert.match(r.datos.aviso!, /no es JSON/);
});

test('respuesta HTML (página de error): disponible:false', async () => {
  const r = await cima({ medicamento: () => resp(200, '<!doctype html><html><body>Mantenimiento</body></html>') }).p;
  assert.ok(r.ok && !r.datos.disponible);
});

test('JSON que no es objeto (array, número, null, cadena): disponible:false', async () => {
  for (const cuerpo of ['[]', '[{"nombre":"X"}]', '5', 'null', '"hola"', 'true']) {
    const r = await cima({ medicamento: () => resp(200, cuerpo) }).p;
    assert.ok(r.ok && !r.datos.disponible, cuerpo);
  }
});

test('tiempo agotado: disponible:false y SIN reintento', async () => {
  let n = 0;
  const f: FetchLike = () => { n++; return new Promise(() => {}); };   // ignora la señal y no responde nunca
  const r = await consultarCima('654321', { fetch: f, timeoutMs: 30, esperar: sinEspera });
  assert.ok(r.ok && !r.datos.disponible); assert.match(r.datos.aviso!, /a tiempo/);
  assert.equal(n, 1);
});

test('el cuerpo que se cuelga también agota el tiempo', async () => {
  const f: FetchLike = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: () => new Promise(() => {}) });
  const r = await consultarCima('654321', { fetch: f, timeoutMs: 30, esperar: sinEspera });
  assert.ok(r.ok && !r.datos.disponible);
});

test('error de red: un único reintento y luego disponible:false', async () => {
  let n = 0;
  const f: FetchLike = async () => { n++; throw new TypeError('fetch failed'); };
  const r = await consultarCima('654321', { fetch: f, esperar: sinEspera });
  assert.ok(r.ok && !r.datos.disponible); assert.match(r.datos.aviso!, /conexión/);
  assert.equal(n, 2);
});

test('error de red que se recupera en el reintento', async () => {
  let n = 0;
  const f: FetchLike = async (url) => {
    if (url.includes('docSegmentado')) return resp(200, SECCION3);
    n++; if (n === 1) throw new TypeError('fetch failed');
    return resp(200, JSON.stringify(FICHA));
  };
  const r = await consultarCima('654321', { fetch: f, esperar: sinEspera });
  assert.ok(r.ok && r.datos.disponible);
});

test('5xx: se reintenta una vez', async () => {
  let n = 0;
  const f: FetchLike = async () => { n++; return resp(503, 'x'); };
  const r = await consultarCima('654321', { fetch: f, esperar: sinEspera });
  assert.ok(r.ok && !r.datos.disponible);
  assert.equal(n, 2);
});

test('otros códigos (403, 429, 301): disponible:false sin reintento', async () => {
  for (const st of [403, 429, 301, 400]) {
    let n = 0;
    const f: FetchLike = async () => { n++; return resp(st, ''); };
    const r = await consultarCima('654321', { fetch: f, esperar: sinEspera });
    assert.ok(r.ok && !r.datos.disponible, String(st));
    assert.equal(n, 1);
  }
});

test('respuesta enorme: se rechaza', async () => {
  const r = await cima({ medicamento: () => resp(200, '{"nombre":"' + 'a'.repeat(2_100_000) + '"}') }).p;
  assert.ok(r.ok && !r.datos.disponible);
});

test('la ficha no incluye el CN pedido (podría ser otro medicamento): se descarta', async () => {
  const otra = { ...FICHA, presentaciones: [{ cn: '111111', nombre: 'Otro, 30 comprimidos' }] };
  const r = await cima({ medicamento: () => resp(200, JSON.stringify(otra)) }).p;
  assert.ok(r.ok && !r.datos.disponible); assert.match(r.datos.aviso!, /no incluye/);
});

test('el campo cn de las presentaciones se compara por los 6 primeros dígitos (con control)', async () => {
  const f = { ...FICHA, presentaciones: [{ cn: '6543219', nombre: 'X, 28 comprimidos' }] };
  const r = await cima({ medicamento: () => resp(200, JSON.stringify(f)), seccion: () => resp(200, SECCION3) }).p;
  assert.ok(r.ok && r.datos.disponible);
});

test('sin presentaciones: se acepta pero se avisa de que no se pudo comprobar', async () => {
  const { presentaciones, ...sin } = FICHA;
  const r = await cima({ medicamento: () => resp(200, JSON.stringify(sin)), seccion: () => resp(200, SECCION3) }).p;
  assert.ok(r.ok && r.datos.disponible); assert.match(r.datos.aviso!, /no se pudo comprobar/i);
});

test('campos con tipos raros: se ignoran, no rompen', async () => {
  const rara = { nombre: 'FARMACO RARO 5 mg', nregistro: { x: 1 }, labtitular: 42, pactivos: ['a'], formaFarmaceutica: 7, receta: 'si', comerc: 'no',
    docs: 'nada', presentaciones: [null, 5, 'x', { cn: 654321 }], psum: 'true' };
  const r = await cima({ medicamento: () => resp(200, JSON.stringify(rara)) }).p;
  assert.ok(r.ok);
  if (!r.ok) return;
  // «presentaciones» con elementos que no son objetos con cn válido: ninguno es el CN → se descarta
  assert.equal(r.datos.disponible, false);
});

test('campos con tipos raros (sin presentaciones): valores nulos, sin excepciones', async () => {
  const rara = { nombre: 'FARMACO RARO 5 mg', nregistro: { x: 1 }, labtitular: 42, pactivos: ['a'], formaFarmaceutica: 7, receta: 'si', docs: 'nada', psum: 'true' };
  const r = await cima({ medicamento: () => resp(200, JSON.stringify(rara)) }).p;
  assert.ok(r.ok && r.datos.disponible);
  const m = (r as any).datos.medicamento;
  assert.equal(m.nregistro, null); assert.equal(m.laboratorio, null); assert.equal(m.receta, null);
  assert.equal(m.formaFarmaceutica, null); assert.equal(m.urlFichaTecnica, null);
});

test('nombres con HTML/inyección: se conservan como TEXTO acotado (la interfaz escapa) y sin control', async () => {
  const largo = 'X'.repeat(5000);
  const f = { ...FICHA, nombre: '<img src=x onerror=alert(1)>\u0000\u0007 ' + largo, labtitular: '<script>alert(1)</script>' + largo };
  const r = await cima({ medicamento: () => resp(200, JSON.stringify(f)), seccion: () => resp(200, SECCION3) }).p;
  assert.ok(r.ok && r.datos.disponible);
  const m = (r as any).datos.medicamento;
  assert.ok(m.nombre.length <= 300); assert.ok(m.laboratorio.length <= 200);
  assert.ok(!/[\u0000-\u0008]/.test(m.nombre));
});

test('enlaces: sólo https de aemps.es; el resto se descarta', async () => {
  const mala = { ...FICHA, docs: [{ tipo: 1, url: 'javascript:alert(1)' }, { tipo: 2, url: 'https://evil.com/p.pdf' }] };
  const r = await cima({ medicamento: () => resp(200, JSON.stringify(mala)), seccion: () => resp(200, SECCION3) }).p;
  const m = (r as any).datos.medicamento;
  assert.equal(m.urlFichaTecnica, null); assert.equal(m.urlProspecto, null);
});

test('urlAemps: casos', () => {
  assert.equal(urlAemps('https://cima.aemps.es/x'), 'https://cima.aemps.es/x');
  assert.equal(urlAemps('https://www.aemps.gob.es/y'), 'https://www.aemps.gob.es/y');
  for (const u of ['http://cima.aemps.es/x', 'https://aemps.es.evil.com/x', 'https://evilaemps.es/x', 'https://user:pw@cima.aemps.es/x', 'ftp://aemps.es', '', 'no-url', null, 5, 'https://cima.aemps.es/' + 'a'.repeat(700)]) {
    assert.equal(urlAemps(u), null, String(u));
  }
});

test('sin sección 3: la ficha vale pero se avisa y la descripción queda «sin datos»', async () => {
  const r = await cima({ medicamento: () => resp(200, JSON.stringify(FICHA)), seccion: () => resp(404, '') }).p;
  assert.ok(r.ok && r.datos.disponible);
  assert.equal((r as any).datos.medicamento.descripcionEstado, 'sin_datos');
  assert.match(r.datos.aviso!, /sección 3/);
});

test('sección 3 que falla por red: la ficha vale', async () => {
  const r = await cima({ medicamento: () => resp(200, JSON.stringify(FICHA)), seccion: () => { throw new TypeError('x'); } }).p;
  assert.ok(r.ok && r.datos.disponible);
  assert.match(r.datos.aviso!, /sección 3/);
});

test('sección 3 en JSON ({contenido} y [{contenido}])', async () => {
  for (const cuerpo of [JSON.stringify({ contenido: SECCION3 }), JSON.stringify([{ contenido: SECCION3 }])]) {
    const r = await cima({ medicamento: () => resp(200, JSON.stringify(FICHA)), seccion: () => resp(200, cuerpo) }).p;
    assert.equal((r as any).datos.medicamento.descripcionEstado, 'propuesta');
  }
});

test('sección 3 sin información de aspecto: no se inventa nada', async () => {
  const r = await cima({ medicamento: () => resp(200, JSON.stringify(FICHA)), seccion: () => resp(200, '<p>Comprimidos para administración oral.</p>') }).p;
  const m = (r as any).datos.medicamento;
  assert.equal(m.descripcionEstado, 'sin_datos'); assert.equal(m.color, null);
});

test('sección 3 con HTML hostil: sólo texto', async () => {
  const r = await cima({ medicamento: () => resp(200, JSON.stringify(FICHA)), seccion: () => resp(200, '<script>alert(1)</script><p>Comprimidos blancos, redondos.</p><img src=x onerror=1>') }).p;
  const d = (r as any).datos.descripcion;
  assert.ok(!d.textoOriginal.includes('<') && !d.textoOriginal.includes('alert'));
  assert.ok(d.colores.includes('blanco'));
});

test('aptitud: forma efervescente → se propone no apto, sin aplicarlo', async () => {
  const f = { ...FICHA, nombre: 'ALGO EFERVESCENTE 500 mg', formaFarmaceutica: { nombre: 'COMPRIMIDO EFERVESCENTE' } };
  const r = await cima({ medicamento: () => resp(200, JSON.stringify(f)) }).p;
  const d = (r as any).datos;
  assert.ok(d.aptitud && d.aptitud.estado !== 'apto');
  assert.equal(d.medicamento.spdAptitud, null);
});

test('aptitud desconocida: null, nunca «apto» por defecto', async () => {
  const f = { ...FICHA, nombre: 'MEDICAMENTOXYZ 3 mg', formaFarmaceutica: { nombre: 'COMPRIMIDO' }, principiosActivos: [{ nombre: 'XYZINA' }] };
  const r = await cima({ medicamento: () => resp(200, JSON.stringify(f)) }).p;
  assert.equal((r as any).datos.aptitud, null);
});

test('avisos: no comercializado, suministro, triángulo, conducción, sin cpresc', async () => {
  const f = { ...FICHA, comerc: false, psum: true, triangulo: true, conduc: true, cpresc: undefined, presentaciones: [{ cn: '654321', nombre: 'X, 30 comprimidos', comerc: false }] };
  const r = await cima({ medicamento: () => resp(200, JSON.stringify(f)) }).p;
  const av = r.ok ? r.datos.aviso! : '';
  for (const t of [/NO comercializada/, /suministro/, /triángulo negro/, /conducir/, /estupefaciente o psicótropo/]) assert.match(av, t);
});

test('estupefaciente / psicótropo se leen de las condiciones de prescripción', async () => {
  const e = await cima({ medicamento: () => resp(200, JSON.stringify({ ...FICHA, cpresc: 'Medicamento sujeto a prescripción especial. Estupefaciente' })) }).p;
  assert.equal((e as any).datos.medicamento.estupefaciente, true);
  const p = await cima({ medicamento: () => resp(200, JSON.stringify({ ...FICHA, cpresc: 'Receta. Psicótropo (Lista IV)' })) }).p;
  assert.equal((p as any).datos.medicamento.psicotropo, true);
  const n = await cima({ medicamento: () => resp(200, JSON.stringify(FICHA)) }).p;
  assert.equal((n as any).datos.medicamento.estupefaciente, false);
});

test('nregistro con caracteres raros no se usa en la URL de la ficha técnica', async () => {
  const f = { ...FICHA, nregistro: '1&seccion=9/../../x' };
  const s = simular({ medicamento: () => resp(200, JSON.stringify(f)) });
  const r = await consultarCima('654321', { fetch: s.f, esperar: sinEspera });
  assert.ok(r.ok && r.datos.disponible);
  assert.equal(s.llamadas.length, 1);
  assert.match(r.datos.aviso!, /registro/);
});

test('el fetch no sigue redirecciones', async () => {
  let opts: any;
  const f: FetchLike = async (_u, init) => { opts = init; return resp(404, ''); };
  await consultarCima('654321', { fetch: f, esperar: sinEspera });
  assert.equal(opts.redirect, 'error'); assert.ok(opts.signal);
});

test('nunca lanza aunque el fetch devuelva basura', async () => {
  for (const basura of [undefined, null, 5, {}, { status: 'x' }]) {
    const f = (async () => basura) as unknown as FetchLike;
    const r = await consultarCima('654321', { fetch: f, esperar: sinEspera });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.datos.disponible, false);
  }
});

test('unidadesDePresentacion: sólo si es inequívoco', () => {
  assert.equal(unidadesDePresentacion('Algo 5 mg, 30 comprimidos'), 30);
  assert.equal(unidadesDePresentacion('Algo 5 mg, 2 blísteres de 14 comprimidos'), null);
  assert.equal(unidadesDePresentacion('Algo 5 mg comprimidos'), null);
  assert.equal(unidadesDePresentacion(null), null);
});

test('utilidades: textoSeguro, htmlATexto, normalizarCnCima, textoSeccion3, tiempo por defecto', () => {
  assert.equal(textoSeguro('  a\u0000  b \n c ', 50), 'a b c');
  assert.equal(textoSeguro(5, 10), null);
  assert.equal(textoSeguro('   ', 10), null);
  assert.equal(textoSeguro('abcdefghij', 5), 'abcd…');
  assert.equal(htmlATexto('<p>A&nbsp;&amp;&#233;</p><script>x()</script>B'), 'A &é\nB');
  assert.equal(normalizarCnCima(' 654321 '), '654321');
  assert.equal(textoSeccion3('<p></p>'), null);
  assert.equal(textoSeccion3('{roto'), null);
  assert.equal(TIEMPO_LIMITE_CIMA_MS, 8000);
});
