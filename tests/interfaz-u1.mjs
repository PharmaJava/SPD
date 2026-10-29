// Recorrido real de la interfaz U1 con Chromium contra vite (5173) + dev-servidor (5174).
// Uso: node tests/interfaz-u1.mjs   (con ambos servidores arrancados y datos vacíos)
import { createRequire } from 'node:module';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const URL = process.env.SPD_URL ?? 'http://localhost:5173/';
const CAP = 'capturas/u1/';
const errores = [];
const b = await chromium.launch(); const _cl = b.close.bind(b); const pg = await (await b.newContext({ viewport: { width: 1280, height: 800 }, locale: 'es-ES' })).newPage();
pg.on('console', m => { if (m.type() === 'error') errores.push(m.text()); });
pg.on('pageerror', e => errores.push('pageerror ' + e.message));
const foto = (n) => pg.screenshot({ path: `${CAP}${n}.png` });
const sigue = async () => { await pg.getByRole('button', { name: /Continuar|Crear mi farmacia|Comprobar y continuar/ }).click(); await pg.waitForTimeout(300); };
process.on('uncaughtException', async (e) => { await pg.screenshot({ path: CAP + 'fallo.png' }); console.log(String(e).slice(0, 300)); process.exit(1); });
await pg.goto(URL); await pg.waitForSelector('text=Vamos a preparar');
await foto('01-primer-uso-bienvenida');
await pg.getByLabel(/He leído y acepto/).check(); await sigue();
await pg.getByLabel('Nombre de la farmacia').fill('Farmacia Prueba'); await pg.getByLabel(/Titular \(nombre/).fill('Ana Pérez López');
await pg.getByLabel('Municipio').fill('Sevilla'); await foto('02-primer-uso-farmacia'); await sigue();
await pg.getByLabel('PIN (4 a 8 cifras)').fill('1234'); await pg.getByLabel('Repite el PIN').fill('1234'); await foto('03-primer-uso-titular'); await sigue();
await pg.getByLabel(/^Contraseña\s*\*?$/).fill('abc'); await sigue(); await foto('04a-primer-uso-contrasena-corta');
await pg.getByLabel(/^Contraseña\s*\*?$/).fill('Una-frase-larga-2026'); await pg.getByLabel('Repite la contraseña').fill('Una-frase-larga-2026'); await foto('04-primer-uso-contrasena'); await sigue();
await pg.waitForSelector('text=Momentos de toma'); await foto('05-primer-uso-momentos'); await sigue();
await pg.waitForSelector('.clave'); await foto('06-primer-uso-clave');
const grupos = (await pg.locator('.clave span').allInnerTexts()).map(t => t.replace(/^\d+\s*/, '').trim());
await pg.getByLabel(/Ya he guardado/).check();
await sigue(); await pg.waitForSelector('text=no coincide'); await foto('06b-clave-error');
const campos = pg.locator('input[maxlength="5"]');
for (let i = 0; i < 3; i++) { const et = await campos.nth(i).evaluate(e => document.querySelector(`label[for="${e.id}"]`).textContent); const n = +/\d+/.exec(et)[0]; await campos.nth(i).fill(grupos[n - 1]); }
await sigue(); await pg.waitForSelector('text=Todo listo'); await foto('07-primer-uso-listo');
await pg.getByRole('button', { name: /Empezar a usar/ }).click();
await pg.waitForSelector('text=Todo al día'); await foto('08-hoy-vacio');
// Bloqueo y desbloqueo
await pg.getByRole('button', { name: 'Bloquear' }).click(); await pg.waitForSelector('text=Programa bloqueado'); await foto('09-bloqueado');
await pg.getByLabel(/Contraseña de la farmacia/).fill('mala-contrasena-1'); await pg.keyboard.press('Enter'); await pg.waitForSelector('[role=alert]'); await foto('10-bloqueo-error');
await pg.waitForTimeout(2500);
await pg.getByLabel(/Contraseña de la farmacia/).fill('Una-frase-larga-2026'); await pg.keyboard.press('Enter');
await pg.waitForSelector('text=¿Quién eres?'); await foto('11-quien-eres');
await pg.getByLabel('PIN').fill('1234'); await pg.keyboard.press('Enter');
await pg.waitForSelector('text=Todo al día');
// Paciente
await pg.getByRole('link', { name: 'Pacientes' }).click(); await pg.waitForSelector('text=Aún no hay pacientes'); await foto('12-pacientes-vacio');
await pg.getByRole('button', { name: 'Nuevo paciente' }).first().click();
await pg.getByLabel(/^Nombre\s*\*?$/).fill('María'); await pg.getByLabel('Primer apellido').fill('García'); await pg.getByLabel('Segundo apellido').fill('Ruiz');
await pg.getByLabel('Fecha de nacimiento').fill('1941-05-12'); await pg.getByLabel('Teléfono', { exact: true }).fill('600111222'); await foto('13-nuevo-paciente');
await pg.getByRole('button', { name: 'Crear paciente' }).click(); await pg.waitForSelector('h1:has-text("María García")'); await foto('14-ficha-resumen');
await pg.getByRole('tab', { name: 'Datos' }).click(); await pg.getByRole('button', { name: 'Añadir dato' }).click();
await pg.getByLabel(/^Descripción/).fill('Penicilina'); await foto('15-salud-dialogo'); await pg.getByRole('button', { name: 'Guardar', exact: true }).click();
await pg.waitForSelector('.etiqueta.alergia'); await foto('16-ficha-datos');
await pg.getByRole('tab', { name: /Tratamiento/ }).click(); await pg.getByRole('button', { name: 'Nuevo tratamiento' }).first().click();
await pg.getByLabel('Medicamento o principio activo').fill('Metformina'); await pg.getByLabel('Dosis del envase (texto)').fill('850 mg'); await foto('17-nuevo-tratamiento');
await pg.getByRole('button', { name: 'Guardar y definir la pauta' }).click(); await pg.waitForSelector('text=Pauta de Metformina');
await pg.getByLabel('Dosis en Desayuno').selectOption('1'); await pg.getByLabel('Dosis en Cena').selectOption('0.5'); await pg.getByLabel(/Detalle del origen/).fill('Receta 123'); await foto('18-editor-pauta');
await pg.getByRole('button', { name: 'Guardar pauta' }).click(); await pg.waitForSelector('.pauta-texto:has-text("desayuno")'); await foto('19-tratamiento');
await pg.getByRole('tab', { name: 'Resumen' }).click(); await foto('20-resumen-con-avisos');
for (const [n, h] of [['21-hoy', 'hoy'], ['22-pacientes', 'pacientes'], ['23-ajustes-farmacia', 'ajustes/farmacia'], ['24-ajustes-momentos', 'ajustes/momentos'], ['25-ajustes-validez', 'ajustes/validez'], ['26-ajustes-lector', 'ajustes/lector'], ['27-ajustes-copias', 'ajustes/copias'], ['28-ajustes-usuarios', 'ajustes/usuarios'], ['29-ajustes-seguridad', 'ajustes/seguridad'], ['30-ajustes-acerca', 'ajustes/acerca'], ['31-ajustes-impresoras', 'ajustes/impresoras']]) {
  await pg.evaluate(h => (location.hash = '#/' + h), h); await pg.waitForTimeout(700); await foto(n);
}
await pg.setViewportSize({ width: 1024, height: 700 }); await pg.evaluate(() => (location.hash = '#/pacientes/1/tratamiento')); await pg.waitForTimeout(600); await foto('32-ficha-1024');
const desborde = await pg.evaluate(() => document.documentElement.scrollWidth > innerWidth);
console.log('desborde horizontal a 1024:', desborde);
console.log('errores de consola:', errores.length ? errores : 'ninguno');
await b.close();
