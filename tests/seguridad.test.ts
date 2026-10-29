import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  abrirConClaveDeDatos, abrirConContrasena, crearAlmacenNuevo, esperaContrasena, guardarCarga, hashPin, KDF_POR_DEFECTO,
  LimitadorFallos, limitadorContrasena, limitadorPin, pareceFicheroSpd, reenvolver, verificarPin,
} from '../src/servicios/seguridad.ts';
import { ErrorSpd } from '../src/servicios/contexto.ts';

// Parámetros baratos para recorrer muchos casos; un test usa los de verdad.
const KDF = { n: 1 << 10, r: 8, p: 1 };
const CONTENIDO = new Uint8Array(randomBytes(64));
const codigo = (f: () => unknown) => { try { f(); } catch (e) { return e instanceof ErrorSpd ? e.codigo : 'OTRO:' + (e as Error).message; } return 'SIN_ERROR'; };

test('ida y vuelta con contraseña', () => {
  const { fichero } = crearAlmacenNuevo('contraseña correcta', CONTENIDO, KDF);
  const a = abrirConContrasena(fichero, 'contraseña correcta');
  assert.deepEqual(Buffer.from(a.bytesDb), Buffer.from(CONTENIDO));
  assert.equal(a.claveDatos.length, 32);
});

test('la clave de datos es aleatoria: dos almacenes no comparten clave', () => {
  const a = crearAlmacenNuevo('x1234567', CONTENIDO, KDF), b = crearAlmacenNuevo('x1234567', CONTENIDO, KDF);
  assert.notDeepEqual(Buffer.from(a.claveDatos), Buffer.from(b.claveDatos));
  assert.notDeepEqual(Buffer.from(a.fichero), Buffer.from(b.fichero));
});

test('contraseña incorrecta → CONTRASENA_INCORRECTA', () => {
  const { fichero } = crearAlmacenNuevo('buena-buena', CONTENIDO, KDF);
  assert.equal(codigo(() => abrirConContrasena(fichero, 'mala-mala')), 'CONTRASENA_INCORRECTA');
  assert.equal(codigo(() => abrirConContrasena(fichero, '')), 'CONTRASENA_INCORRECTA');
  assert.equal(codigo(() => abrirConContrasena(fichero, 'BUENA-BUENA')), 'CONTRASENA_INCORRECTA');
});

test('no se crea un almacén con contraseña vacía', () => {
  assert.equal(codigo(() => crearAlmacenNuevo('', CONTENIDO, KDF)), 'CONTRASENA_VACIA');
});

test('la contraseña se normaliza (NFKC): la «é» compuesta y la descompuesta abren lo mismo', () => {
  const { fichero } = crearAlmacenNuevo('café-cafe', CONTENIDO, KDF);
  assert.doesNotThrow(() => abrirConContrasena(fichero, 'café-cafe'));
});

test('con la clave de datos (recuperación) se abre sin contraseña', () => {
  const { fichero, claveDatos } = crearAlmacenNuevo('lo-que-sea-1', CONTENIDO, KDF);
  const a = abrirConClaveDeDatos(fichero, claveDatos);
  assert.deepEqual(Buffer.from(a.bytesDb), Buffer.from(CONTENIDO));
});

test('una clave de datos equivocada no abre el fichero', () => {
  const { fichero } = crearAlmacenNuevo('lo-que-sea-1', CONTENIDO, KDF);
  assert.equal(codigo(() => abrirConClaveDeDatos(fichero, new Uint8Array(randomBytes(32)))), 'FICHERO_CORRUPTO');
  assert.equal(codigo(() => abrirConClaveDeDatos(fichero, new Uint8Array(16))), 'CLAVE_INVALIDA');
});

test('NADA en claro: ni el contenido ni la clave de datos aparecen en el fichero', () => {
  const marca = Buffer.from('FARMACIA-LUZ-DEL-SUR-paciente-Ana-García');
  const contenido = Buffer.concat([marca, Buffer.from(randomBytes(200))]);
  const { fichero, claveDatos } = crearAlmacenNuevo('secreto-1234', contenido, KDF);
  const f = Buffer.from(fichero);
  assert.equal(f.indexOf(marca), -1);
  assert.equal(f.indexOf(marca.subarray(0, 12)), -1);
  assert.equal(f.indexOf(Buffer.from(claveDatos)), -1);
  assert.equal(f.indexOf(Buffer.from('secreto-1234')), -1);
});

test('un solo bit cambiado en CUALQUIER byte hace fallar la apertura (contraseña y clave de datos)', () => {
  const { fichero, claveDatos } = crearAlmacenNuevo('contraseña-1', CONTENIDO, KDF);
  let probados = 0;
  for (let i = 0; i < fichero.length; i++) {
    const mal = new Uint8Array(fichero); mal[i] ^= 0x01;
    assert.notEqual(codigo(() => abrirConContrasena(mal, 'contraseña-1')), 'SIN_ERROR', `byte ${i} con contraseña`);
    assert.notEqual(codigo(() => abrirConClaveDeDatos(mal, claveDatos)), 'SIN_ERROR', `byte ${i} con clave de datos`);
    probados++;
  }
  assert.equal(probados, fichero.length);
});

test('un fichero truncado en cualquier longitud no abre', () => {
  const { fichero, claveDatos } = crearAlmacenNuevo('contraseña-1', CONTENIDO, KDF);
  for (let n = 0; n < fichero.length; n += 1) {
    const corto = fichero.slice(0, n);
    assert.notEqual(codigo(() => abrirConClaveDeDatos(corto, claveDatos)), 'SIN_ERROR', `longitud ${n}`);
  }
});

test('bytes añadidos al final tampoco pasan', () => {
  const { fichero, claveDatos } = crearAlmacenNuevo('contraseña-1', CONTENIDO, KDF);
  const largo = Buffer.concat([fichero, Buffer.from([0])]);
  assert.equal(codigo(() => abrirConClaveDeDatos(largo, claveDatos)), 'FICHERO_CORRUPTO');
  assert.equal(codigo(() => abrirConContrasena(largo, 'contraseña-1')), 'FICHERO_CORRUPTO');
});

test('cabecera reescrita (otra sal, mismo resto) → error: la cabecera va autenticada', () => {
  const { fichero, claveDatos } = crearAlmacenNuevo('contraseña-1', CONTENIDO, KDF);
  const b = Buffer.from(fichero);
  const lon = b.readUInt32BE(9);
  const cab = JSON.parse(b.subarray(13, 13 + lon).toString('utf8'));
  cab.kdf.n = 2048;                                  // parámetro cambiado, tamaño de JSON igual
  const json = Buffer.from(JSON.stringify(cab));
  const nuevo = Buffer.concat([b.subarray(0, 13), json, b.subarray(13 + lon)]);
  nuevo.writeUInt32BE(json.length, 9);
  assert.notEqual(codigo(() => abrirConContrasena(nuevo, 'contraseña-1')), 'SIN_ERROR');
  assert.notEqual(codigo(() => abrirConClaveDeDatos(nuevo, claveDatos)), 'SIN_ERROR');
});

test('parámetros de scrypt hostiles en la cabecera se rechazan sin calcularlos', () => {
  const { fichero } = crearAlmacenNuevo('contraseña-1', CONTENIDO, KDF);
  const b = Buffer.from(fichero);
  const lon = b.readUInt32BE(9);
  const cab = JSON.parse(b.subarray(13, 13 + lon).toString('utf8'));
  cab.kdf.n = 1 << 30;
  const json = Buffer.from(JSON.stringify(cab));
  const nuevo = Buffer.concat([b.subarray(0, 13), json, b.subarray(13 + lon)]);
  nuevo.writeUInt32BE(json.length, 9);
  const t0 = Date.now();
  assert.equal(codigo(() => abrirConContrasena(nuevo, 'contraseña-1')), 'FICHERO_CORRUPTO');
  assert.ok(Date.now() - t0 < 500);
});

test('magic y versión: lo que no es un fichero SPD se rechaza con un error claro', () => {
  assert.equal(codigo(() => abrirConContrasena(new Uint8Array(100), 'x')), 'FICHERO_CORRUPTO');
  assert.equal(codigo(() => abrirConContrasena(new Uint8Array(0), 'x')), 'FICHERO_CORRUPTO');
  const { fichero } = crearAlmacenNuevo('contraseña-1', CONTENIDO, KDF);
  const v = new Uint8Array(fichero); v[8] = 9;
  assert.equal(codigo(() => abrirConContrasena(v, 'contraseña-1')), 'VERSION_FICHERO');
  assert.equal(pareceFicheroSpd(fichero), true);
  assert.equal(pareceFicheroSpd(new Uint8Array(100)), false);
  assert.equal(pareceFicheroSpd(v), false);
});

test('cada guardado usa un iv NUEVO: mismo contenido, distinto cifrado', () => {
  const { fichero, claveDatos } = crearAlmacenNuevo('contraseña-1', CONTENIDO, KDF);
  const ivs = new Set<string>(), cifrados = new Set<string>();
  for (let i = 0; i < 6; i++) {
    const f = Buffer.from(guardarCarga(fichero, claveDatos, CONTENIDO));
    const lon = f.readUInt32BE(9);
    ivs.add(JSON.parse(f.subarray(13, 13 + lon).toString()).ivCarga);
    cifrados.add(f.subarray(13 + lon).toString('hex'));
  }
  assert.equal(ivs.size, 6);
  assert.equal(cifrados.size, 6);
});

test('guardarCarga: ida y vuelta, mantiene la envoltura y exige la clave correcta', () => {
  const { fichero, claveDatos } = crearAlmacenNuevo('contraseña-1', CONTENIDO, KDF);
  const otro = new Uint8Array(randomBytes(100));
  const nuevo = guardarCarga(fichero, claveDatos, otro);
  assert.deepEqual(Buffer.from(abrirConContrasena(nuevo, 'contraseña-1').bytesDb), Buffer.from(otro));
  assert.equal(codigo(() => guardarCarga(fichero, new Uint8Array(randomBytes(32)), otro)), 'FICHERO_CORRUPTO');
  const roto = new Uint8Array(fichero); roto[roto.length - 1] ^= 1;
  assert.equal(codigo(() => guardarCarga(roto, claveDatos, otro)), 'FICHERO_CORRUPTO');   // no sobrescribe sobre algo dañado sin enterarse
});

test('reenvolver: la contraseña nueva abre, la vieja no, y la clave de datos es la misma', () => {
  const { fichero, claveDatos } = crearAlmacenNuevo('vieja-vieja', CONTENIDO, KDF);
  const nuevo = reenvolver(fichero, claveDatos, 'nueva-nueva', KDF);
  const a = abrirConContrasena(nuevo, 'nueva-nueva');
  assert.deepEqual(Buffer.from(a.bytesDb), Buffer.from(CONTENIDO));
  assert.deepEqual(Buffer.from(a.claveDatos), Buffer.from(claveDatos));
  assert.equal(codigo(() => abrirConContrasena(nuevo, 'vieja-vieja')), 'CONTRASENA_INCORRECTA');
  // La clave de recuperación sigue sirviendo
  assert.doesNotThrow(() => abrirConClaveDeDatos(nuevo, claveDatos));
  // Sal nueva
  const sal = (f: Uint8Array) => JSON.parse(Buffer.from(f).subarray(13, 13 + Buffer.from(f).readUInt32BE(9)).toString()).kdf.sal;
  assert.notEqual(sal(fichero), sal(nuevo));
});

test('reenvolver exige la clave de datos buena y una contraseña no vacía', () => {
  const { fichero, claveDatos } = crearAlmacenNuevo('vieja-vieja', CONTENIDO, KDF);
  assert.equal(codigo(() => reenvolver(fichero, new Uint8Array(randomBytes(32)), 'nueva-nueva', KDF)), 'FICHERO_CORRUPTO');
  assert.equal(codigo(() => reenvolver(fichero, claveDatos, '', KDF)), 'CONTRASENA_VACIA');
});

test('los parámetros por defecto son scrypt N=2^15, r=8, p=1 y quedan escritos en la cabecera', () => {
  assert.deepEqual({ ...KDF_POR_DEFECTO }, { n: 32768, r: 8, p: 1 });
  const { fichero } = crearAlmacenNuevo('contraseña-1', CONTENIDO);
  const f = Buffer.from(fichero);
  const cab = JSON.parse(f.subarray(13, 13 + f.readUInt32BE(9)).toString());
  assert.equal(cab.kdf.alg, 'scrypt');
  assert.equal(cab.kdf.n, 32768); assert.equal(cab.kdf.r, 8); assert.equal(cab.kdf.p, 1);
  assert.equal(abrirConContrasena(fichero, 'contraseña-1').bytesDb.length, CONTENIDO.length);
});

test('hash de PIN: formato scrypt, sal propia y verificación', () => {
  const a = hashPin('1234'), b = hashPin('1234');
  assert.match(a, /^scrypt\$\d+\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.notEqual(a, b);                       // sal distinta
  assert.equal(a.includes('1234'), false);
  assert.equal(verificarPin('1234', a), true);
  assert.equal(verificarPin('1234', b), true);
  assert.equal(verificarPin('1235', a), false);
  assert.equal(verificarPin('', a), false);
});

test('un hash de PIN mal formado o con parámetros absurdos nunca verifica (y no lanza)', () => {
  for (const h of ['', 'x', 'scrypt$1$2', 'x$16384$8$1$AAAA$AAAA', 'scrypt$1073741824$8$1$AAAA$AAAA', `scrypt$16384$8$1$AAAA$AAAA`]) {
    assert.equal(verificarPin('1234', h), false, h);
  }
});

test('espera creciente: 1, 2, 4, 8, 16, 32 y tope de 60 s', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 20, 100].map(esperaContrasena), [0, 1, 2, 4, 8, 16, 32, 60, 60, 60, 60]);
});

test('limitador de contraseña con reloj inyectado: espera, cuenta atrás y reinicio', () => {
  let t = 1_000_000;
  const l = limitadorContrasena(() => t);
  assert.equal(l.espera(), 0);
  assert.equal(l.registrarFallo(), 1);
  assert.equal(l.espera(), 1);
  t += 400; assert.equal(l.espera(), 1);       // redondea hacia arriba
  t += 700; assert.equal(l.espera(), 0);
  assert.equal(l.registrarFallo(), 2);
  assert.equal(l.registrarFallo(), 4);
  assert.equal(l.espera(), 4);
  l.reiniciar();
  assert.equal(l.espera(), 0);
  assert.equal(l.registrarFallo(), 1);
});

test('limitador de PIN: 4 fallos libres, el 5.º bloquea 30 s y luego empieza de cero', () => {
  let t = 5_000;
  const l = limitadorPin(() => t);
  for (let i = 0; i < 4; i++) { assert.equal(l.registrarFallo(), 0); assert.equal(l.espera(), 0); }
  assert.equal(l.registrarFallo(), 30);
  assert.equal(l.espera(), 30);
  t += 29_000; assert.equal(l.espera(), 1);
  t += 1_000; assert.equal(l.espera(), 0);
  for (let i = 0; i < 4; i++) assert.equal(l.registrarFallo(), 0);   // otra vez 4 libres
  assert.equal(l.registrarFallo(), 30);
});

test('LimitadorFallos con política propia', () => {
  let t = 0;
  const l = new LimitadorFallos(f => f * 10, () => t);
  assert.equal(l.registrarFallo(), 10);
  assert.equal(l.registrarFallo(), 20);
  assert.equal(l.seguidos, 2);
});
