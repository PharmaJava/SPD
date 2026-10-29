import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearVigilanteInactividad, minutosValidos, BLOQUEO_POR_DEFECTO_MIN, BLOQUEO_MAXIMO_MIN } from '../src/principal/inactividad.ts';
import type { Temporizadores } from '../src/principal/inactividad.ts';
import { planificarCopias } from '../src/principal/planificador-copias.ts';
import { ensamblarApi } from '../src/principal/ensamblar.ts';
import { plantillaMenu, textoAcercaDe } from '../src/principal/menu.ts';
import { leerModoPruebas } from '../src/principal/modo-pruebas.ts';
import { METODOS, GRUPO_DE_METODO } from '../src/servicios/metodos.ts';
import { ok } from '../src/servicios/contexto.ts';

/** Reloj falso: avanzar() dispara los temporizadores vencidos en orden. */
function reloj() {
  let ahora = 1_000_000; let sig = 1;
  const pend = new Map<number, { en: number; fn: () => void }>();
  const t: Temporizadores = {
    setTimeout: (fn, ms) => { const id = sig++; pend.set(id, { en: ahora + ms, fn }); return id; },
    clearTimeout: (id) => { pend.delete(id as number); },
    ahora: () => ahora,
  };
  const avanzar = async (ms: number) => {
    const fin = ahora + ms;
    for (;;) {
      const prox = [...pend.entries()].filter(([, v]) => v.en <= fin).sort((a, b) => a[1].en - b[1].en)[0];
      if (!prox) break;
      pend.delete(prox[0]); ahora = prox[1].en; prox[1].fn();
      await new Promise(r => setImmediate(r));
    }
    ahora = fin;
  };
  return { t, avanzar, pendientes: () => pend.size };
}
const MIN = 60_000;

// ── Inactividad ──
test('inactividad: bloquea a los N minutos sin actividad', async () => {
  const r = reloj(); let bloqueos = 0;
  crearVigilanteInactividad({ minutos: 5, alBloquear: () => { bloqueos++; }, t: r.t });
  await r.avanzar(4 * MIN + 59_000); assert.equal(bloqueos, 0);
  await r.avanzar(2_000); assert.equal(bloqueos, 1);
});

test('inactividad: la actividad reinicia el reloj', async () => {
  const r = reloj(); let bloqueos = 0;
  const v = crearVigilanteInactividad({ minutos: 5, alBloquear: () => { bloqueos++; }, t: r.t });
  for (let i = 0; i < 10; i++) { await r.avanzar(3 * MIN); v.actividad(); }
  assert.equal(bloqueos, 0);
  await r.avanzar(6 * MIN); assert.equal(bloqueos, 1);
});

test('inactividad: una ráfaga de eventos (<1 s) no rearma sin parar, pero sí cuenta la primera', async () => {
  const r = reloj(); let bloqueos = 0;
  const v = crearVigilanteInactividad({ minutos: 1, alBloquear: () => { bloqueos++; }, t: r.t });
  await r.avanzar(50_000); v.actividad(); v.actividad(); v.actividad();
  await r.avanzar(59_000); assert.equal(bloqueos, 0);
  await r.avanzar(2_000); assert.equal(bloqueos, 1);
});

test('inactividad: tras bloquear no vuelve a bloquear hasta nueva actividad', async () => {
  const r = reloj(); let bloqueos = 0;
  crearVigilanteInactividad({ minutos: 1, alBloquear: () => { bloqueos++; }, t: r.t });
  await r.avanzar(10 * MIN); assert.equal(bloqueos, 1);
});

test('inactividad: configurar cambia el plazo; no se puede desactivar', async () => {
  const r = reloj(); let bloqueos = 0;
  const v = crearVigilanteInactividad({ minutos: 5, alBloquear: () => { bloqueos++; }, t: r.t });
  v.configurar(1); await r.avanzar(61_000); assert.equal(bloqueos, 1);
  for (const raro of [0, -3, NaN, Infinity, undefined, null, '5', {}]) {
    assert.equal(minutosValidos(raro), raro === Infinity ? BLOQUEO_POR_DEFECTO_MIN : BLOQUEO_POR_DEFECTO_MIN, String(raro));
  }
  assert.equal(minutosValidos(100000), BLOQUEO_MAXIMO_MIN);
  assert.equal(minutosValidos(2.9), 2);
});

test('inactividad: parar() deja de bloquear; un fallo de alBloquear no rompe el reloj', async () => {
  const r = reloj(); let n = 0;
  const v = crearVigilanteInactividad({ minutos: 1, alBloquear: () => { n++; }, t: r.t });
  v.parar(); await r.avanzar(5 * MIN); assert.equal(n, 0); assert.equal(r.pendientes(), 0);
  const r2 = reloj();
  crearVigilanteInactividad({ minutos: 1, alBloquear: () => { throw new Error('x'); }, t: r2.t });
  await r2.avanzar(2 * MIN);
});

// ── Copias automáticas ──
test('copias automáticas: una por día, reintenta si falla, ignora «sin carpeta»', async () => {
  const r = reloj(); let llamadas = 0; const fallos: string[] = [];
  let resultado: any = { ok: false, error: 'x', codigo: 'SIN_CARPETA_COPIAS' };
  const p = planificarCopias({ ejecutar: async () => { llamadas++; return resultado; }, alFallar: m => fallos.push(m), t: r.t, primeraMs: 1000, cadaMs: 3600_000 });
  await r.avanzar(2000); assert.equal(llamadas, 1); assert.deepEqual(fallos, []);
  resultado = { ok: false, error: 'disco lleno', codigo: 'COPIA_FALLIDA' };
  await r.avanzar(3600_000); assert.equal(llamadas, 2); assert.deepEqual(fallos, ['COPIA_FALLIDA']);
  resultado = { ok: true };
  await r.avanzar(3600_000); assert.equal(llamadas, 3); assert.ok(p.ultimoDia);
  await r.avanzar(5 * 3600_000); assert.equal(llamadas, 3, 'ya hay copia de hoy');
  p.parar(); await r.avanzar(48 * 3600_000); assert.equal(llamadas, 3);
});

test('copias automáticas: una excepción no mata el planificador', async () => {
  const r = reloj(); let n = 0;
  planificarCopias({ ejecutar: async () => { n++; throw new Error('boom'); }, t: r.t, primeraMs: 10, cadaMs: 1000 });
  await r.avanzar(5000); assert.ok(n >= 3);
});

// ── Ensamblado ──
const fnOk = () => async () => ok(null);
const pieza = (grupo: string, quitar: string[] = []) => Object.fromEntries(METODOS.filter(m => GRUPO_DE_METODO[m] === grupo && !quitar.includes(m)).map(m => [m, fnOk()]));

test('ensamblar: cada método viene de su grupo; no falta ninguno', async () => {
  const clin = METODOS.filter(m => GRUPO_DE_METODO[m] === 'clinica');
  const mitad = clin.length >> 1;
  const base = Object.fromEntries(clin.slice(0, mitad).map(m => [m, fnOk()]));
  const prep = Object.fromEntries(clin.slice(mitad).map(m => [m, fnOk()]));
  const { api, faltan } = ensamblarApi({ sistema: pieza('sistema') as any, clinicaBase: base as any, clinicaPreparacion: prep as any, externo: pieza('externa') as any });
  assert.deepEqual(faltan, []);
  for (const m of METODOS) assert.equal(typeof (api as any)[m], 'function', m);
  assert.deepEqual(await (api as any).estado(), { ok: true, datos: null });
});

test('ensamblar: un método sin implementar devuelve NO_IMPLEMENTADO y se lista', async () => {
  const { api, faltan } = ensamblarApi({ sistema: pieza('sistema', ['estado']) as any });
  assert.ok(faltan.includes('estado') && faltan.includes('panelHoy'));
  const r = await api.estado();
  assert.equal(r.ok, false); assert.equal((r as any).codigo, 'NO_IMPLEMENTADO');
});

test('ensamblar: un método clínico en las dos piezas es un error al arrancar', () => {
  const dup = { panelHoy: fnOk() };
  assert.throws(() => ensamblarApi({ clinicaBase: dup as any, clinicaPreparacion: dup as any }), /clinica-base Y en clinica-preparacion/);
});

test('ensamblar: una pieza no puede colar métodos de otro grupo', async () => {
  // «estado» es de sistema: si lo trae la clínica, se ignora.
  const { api } = ensamblarApi({ clinicaBase: { estado: async () => ok('colado') } as any, sistema: pieza('sistema') as any });
  assert.deepEqual(await api.estado(), { ok: true, datos: null });
});

test('ensamblar: conserva el `this` de la pieza', async () => {
  const pieza = { x: 5, async estado() { return ok(this.x); } };
  const { api } = ensamblarApi({ sistema: pieza as any });
  assert.deepEqual(await api.estado(), { ok: true, datos: 5 });
});

// ── Menú ──
test('menú: Archivo (Bloquear, Copia de seguridad), Ver (zoom), Ayuda (Acerca de); sin herramientas de desarrollo en producción', () => {
  const llamado: string[] = [];
  const m = plantillaMenu({ bloquear: () => llamado.push('b'), copiaSeguridad: () => llamado.push('c'), acercaDe: () => llamado.push('a'), salir: () => llamado.push('s') }, { desarrollo: false });
  const etiquetas = (nombre: string) => ((m.find(x => x.label === nombre)!.submenu as any[]).map(i => i.label).filter(Boolean));
  assert.deepEqual(m.map(x => x.label), ['Archivo', 'Edición', 'Ver', 'Ayuda']);
  assert.ok(etiquetas('Archivo').includes('Bloquear') && etiquetas('Archivo').includes('Copia de seguridad…'));
  assert.ok(['Acercar', 'Alejar', 'Tamaño normal'].every(e => etiquetas('Ver').includes(e)));
  assert.ok(etiquetas('Ayuda').includes('Acerca de SPD'));
  assert.ok(!JSON.stringify(m).includes('toggleDevTools'));
  for (const sub of m.flatMap(x => x.submenu as any[])) sub.click?.();
  assert.deepEqual(llamado.sort(), ['a', 'b', 'c', 's']);
  assert.ok(JSON.stringify(plantillaMenu({ bloquear() {}, copiaSeguridad() {}, acercaDe() {}, salir() {} }, { desarrollo: true })).includes('toggleDevTools'));
});

test('«Acerca de» dice que NO es un producto sanitario y menciona la licencia', () => {
  const t = textoAcercaDe('1.2.3');
  assert.match(t.mensaje, /1\.2\.3/); assert.match(t.detalle, /NO es un producto sanitario/); assert.match(t.detalle, /licencia/i);
});

// ── Modo de pruebas ──
test('modo de pruebas: sólo con SPD_CAPTURAS=1, sin empaquetar y con carpeta', () => {
  assert.equal(leerModoPruebas({}, false), null);
  assert.equal(leerModoPruebas({ SPD_CAPTURAS: '0', SPD_DATOS_PRUEBAS: '/x' }, false), null);
  assert.equal(leerModoPruebas({ SPD_CAPTURAS: 'true', SPD_DATOS_PRUEBAS: '/x' }, false), null);
  assert.equal(leerModoPruebas({ SPD_CAPTURAS: '1' }, false), null);
  assert.equal(leerModoPruebas({ SPD_CAPTURAS: '1', SPD_DATOS_PRUEBAS: '  ' }, false), null);
  assert.deepEqual(leerModoPruebas({ SPD_CAPTURAS: '1', SPD_DATOS_PRUEBAS: '/x' }, false), { rutaDatos: '/x' });
});

test('modo de pruebas: JAMÁS en la versión empaquetada, ni con las variables puestas', () => {
  assert.equal(leerModoPruebas({ SPD_CAPTURAS: '1', SPD_DATOS_PRUEBAS: '/x' }, true), null);
});
