// Prueba de extremo a extremo de las pantallas U2 (cajas, preparar, documentos, medicamentos, auditoría)
// con Chromium real contra el servidor de desarrollo REAL (datos temporales). Genera capturas en capturas/u2/.
//   npm run build:interfaz && node tests/interfaz-u2.mjs
import http from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { digitoControlGS1, GS } = await import(pathToFileURL(join(RAIZ, 'src/dominio/gs1.ts')).href);

const PUERTO_API = 5181, PUERTO_WEB = 5182;
process.env.SPD_DEV_PUERTO = String(PUERTO_API);
process.env.SPD_DATOS = mkdtempSync(join(tmpdir(), 'spd-u2-'));
const CAP = join(RAIZ, 'capturas/u2'); mkdirSync(CAP, { recursive: true });

// ── servidor real + servidor estático con proxy /api ──
const { crearServidorDev } = await import(pathToFileURL(join(RAIZ, 'scripts/dev-servidor.mjs')).href);
const srv = await crearServidorDev({ rutaDatos: process.env.SPD_DATOS, carpetaImpresos: join(process.env.SPD_DATOS, 'impresos') });
await new Promise(r => srv.servidor.listen(PUERTO_API, '127.0.0.1', r));
const DIST = join(RAIZ, 'dist/interfaz');
const TIPOS = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.map': 'application/json' };
const web = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    const h = { ...req.headers }; delete h.origin; delete h.referer; h.host = `127.0.0.1:${PUERTO_API}`;
    const p = http.request({ host: '127.0.0.1', port: PUERTO_API, path: req.url, method: req.method, headers: h }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    p.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(p); return;
  }
  let f = join(DIST, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!existsSync(f)) f = join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': TIPOS[extname(f)] ?? 'application/octet-stream' }); res.end(readFileSync(f));
}).listen(PUERTO_WEB, '127.0.0.1');

const api = async (m, ...args) => {
  const r = await fetch(`http://127.0.0.1:${PUERTO_API}/api/${m}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args }) });
  const j = await r.json(); if (!j.ok) throw new Error(`${m}: ${j.error}`); return j.datos;
};

// ── datos de ejemplo creados por la API ──
const PIN = '1234', PASS = 'contraseña-de-prueba-1';
await api('primerUso', { farmacia: { nombre: 'Farmacia Luz del Sur', titular: 'Marta Etxeberria', municipio: 'Sevilla', provincia: 'Sevilla', direccion: 'Calle Sol 1', telefono: '955 000 000' },
  titular: { nombre: 'Marta Etxeberria', iniciales: 'ME', pin: PIN }, contrasena: PASS, momentos: [{ nombre: 'Desayuno', hora: '08:00' }, { nombre: 'Comida', hora: '14:00' }, { nombre: 'Cena', hora: '21:00' }, { nombre: 'Acostarse', hora: '23:00' }] });
await api('desbloquear', PASS).catch(() => {});
await api('guardarFarmacia', { nombre: 'Farmacia Luz del Sur', titular: 'Marta Etxeberria', nif: 'B12345678', direccion: 'Calle Sol 1', municipio: 'Sevilla', provincia: 'Sevilla', telefono: '955 000 000', email: 'f@farmacia.test', rgpdContacto: 'f@farmacia.test', rgpdDpd: 'No designado' }).catch(e => console.error('farmacia:', e.message));
const usuarios = await api('listarUsuarios');
await api('iniciarSesion', usuarios[0].id, PIN);
const momentos = await api('listarMomentos');
const pac = await api('guardarPaciente', { nombre: 'Ana', apellido1: 'López', apellido2: 'Pérez', fechaNacimiento: '1940-03-04', dniNie: '12345678Z', necesitaBraille: false, letraGrande: false, direccion: 'Calle Luna 5', codigoPostal: '41001', municipio: 'Sevilla' });
const cnMet = '654321', cnEna = '123456';
await api('guardarMedicamento', { cn: cnMet, nombre: 'Metformina 850 mg 28 comprimidos', formaFarmaceutica: 'Comprimido recubierto con película', unidadesEnvase: 28 });
await api('guardarMedicamento', { cn: cnEna, nombre: 'Enalapril 10 mg 30 comprimidos', formaFarmaceutica: 'Comprimido', unidadesEnvase: 30, color: 'blanco', forma: 'redondo', descripcionFisica: 'Comprimido blanco, redondo, ranurado', marcasGrabado: 'E10' }, true);
const tMet = await api('guardarTratamiento', { pacienteId: pac.id, principioActivo: 'Metformina', dosisTexto: '850 mg', cnPreferente: cnMet, emblistable: true });
const tEna = await api('guardarTratamiento', { pacienteId: pac.id, principioActivo: 'Enalapril', dosisTexto: '10 mg', cnPreferente: cnEna, emblistable: true });
const hoy = new Date().toISOString().slice(0, 10);
const pautaBase = { vigenteDesde: '2026-01-01', patron: 'diario', origen: 'receta' };
await api('guardarPauta', tMet.id, { ...pautaBase, dosis: [{ momentoId: momentos[0].id, unidades: 1 }, { momentoId: momentos[2].id, unidades: 0.5 }] });
await api('guardarPauta', tEna.id, { ...pautaBase, dosis: [{ momentoId: momentos[0].id, unidades: 1 }] });

// ── navegador ──
const navegador = await chromium.launch();
const ctx = await navegador.newContext({ viewport: { width: 1280, height: 800 }, locale: 'es-ES' });
const pag = await ctx.newPage();
const errores = [];
pag.on('pageerror', e => errores.push('pageerror: ' + e.message));
pag.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errores.push('console: ' + m.text()); });
const base = `http://127.0.0.1:${PUERTO_WEB}/`;
let fallos = 0, n = 0;
const comprobar = (cond, msg) => { n++; if (!cond) { fallos++; console.error('  ✗', msg); } else console.log('  ✓', msg); };
const foto = async nombre => { await pag.evaluate(() => document.querySelector('.contenido')?.scrollTo(0, 0)); await pag.waitForTimeout(300); await pag.screenshot({ path: join(CAP, nombre + '.png') }); };
const ir = async h => { await pag.goto(base + '#' + h); await pag.waitForTimeout(300); };
const P = s => pag.locator(`[data-prueba="${s}"]`);
const sinFoco = async () => pag.evaluate(() => document.activeElement?.id);

try {
  await pag.goto(base);
  await pag.waitForTimeout(800);
  // Si pide desbloquear/iniciar sesión, se hace por la interfaz
  if (await pag.getByText('Contraseña').first().isVisible().catch(() => false) && await pag.locator('input[type=password]').first().isVisible().catch(() => false)) {
    console.log('(la pantalla pide credenciales)');
  }

  // ───────── Documentos (consentimientos) ─────────
  console.log('Documentos');
  await ir(`/pacientes/${pac.id}/documentos`);
  await pag.waitForSelector('[data-prueba="tabla-docs"]');
  comprobar(await pag.locator('#docs-faltan').isVisible(), 'avisa de que faltan consentimientos');
  await foto('09-documentos-faltan');
  for (const cod of ['consentimiento_spd', 'info_rgpd']) {
    await P('doc-' + cod).click();
    await pag.waitForSelector('[data-prueba="texto-documento"]');
    if (cod === 'consentimiento_spd') { comprobar(await pag.getByText('BORRADOR', { exact: false }).first().isVisible(), 'el borrador se ve marcado'); await foto('10-documento-vista'); }
    await P('marcar-firmado').click();
    await pag.waitForTimeout(500);
  }
  comprobar(await pag.locator('#docs-completos').isVisible(), 'consentimientos completos tras firmar');
  await foto('11-documentos-completos');

  // ───────── Entrada de cajas ─────────
  console.log('Cajas');
  await ir('/cajas');
  await pag.waitForSelector('#busca-paciente');
  await foto('01a-cajas-sin-paciente');
  await pag.fill('#busca-paciente', 'López'); await pag.waitForSelector('[role=option]'); await pag.keyboard.press('Enter');
  await pag.waitForSelector('[data-prueba="paciente-elegido"]');
  comprobar(await sinFoco() === 'escaneo', 'tras elegir paciente el foco está en el campo de escaneo');
  await foto('01-cajas-escaneo');
  // manual: CN + lote + caducidad
  await P('escaneo').fill(cnMet); await pag.keyboard.press('Enter');
  comprobar(await sinFoco() === 'lote', 'tras el CN el foco pasa al lote');
  await pag.keyboard.type('MET2026A'); await pag.keyboard.press('Enter');
  comprobar(await sinFoco() === 'caducidad', 'y luego a la caducidad');
  await pag.keyboard.type('122028');
  comprobar(await P('caducidad').inputValue() === '12/2028', 'la máscara da MM/AAAA');
  await pag.keyboard.press('Enter');
  await pag.waitForSelector('[data-prueba="resumen-envase"]');
  await pag.waitForTimeout(500);
  await foto('02-cajas-manual');
  comprobar(await P('guardar').isEnabled(), 'se puede guardar con lote y caducidad');
  await P('guardar').click();
  await pag.waitForSelector('#exito');
  comprobar((await P('entradas-hoy').innerText()).includes('MET2026A'), 'aparece en «Entradas de hoy»');
  // sin lote: bloquea
  await P('escaneo').fill(cnEna); await pag.keyboard.press('Enter'); await pag.waitForTimeout(600);
  comprobar(await P('guardar').isDisabled(), 'sin lote ni caducidad «Guardar» está desactivado');
  // DataMatrix completo
  const gtin = '0' + '847000' + cnEna + String(digitoControlGS1('0847000' + cnEna)); 
  const gtin14 = '0' + '8470001' + '23456'.slice(0, 0); void gtin14;
  const ean12 = '847000' + cnEna; const dc = digitoControlGS1(ean12); const ean13 = ean12 + dc;
  const g14 = '0' + ean13; const g14ok = g14.slice(0, 13) + digitoControlGS1(g14.slice(0, 13));
  const dm = `01${g14ok}17281231`;
  const dmCompleto = `${dm}10ENA77${GS}21SERIE12345`;
  await P('escaneo').fill(dmCompleto); await pag.keyboard.press('Enter');
  await pag.waitForSelector('[data-prueba="resumen-envase"]'); await pag.waitForTimeout(600);
  comprobar(await P('lote').inputValue() === 'ENA77', 'el DataMatrix rellena el lote');
  comprobar((await P('caducidad').inputValue()).startsWith('2028-12-31'), 'y la caducidad');
  await foto('03-cajas-datamatrix');
  await pag.keyboard.press('Enter'); // Intro sobre el campo de escaneo vacío = guardar
  await pag.waitForTimeout(800);
  comprobar((await P('entradas-hoy').innerText()).includes('ENA77'), 'Intro guarda la caja leída');
  // lectura ambigua (sin GS)
  await P('escaneo').fill(`${dm}10ENA8821SERIE999`); await pag.keyboard.press('Enter'); await pag.waitForTimeout(500);
  comprobar(await P('candidata-0').count() > 0, 'lectura ambigua: pide confirmar el lote');
  await foto('04-cajas-ambigua');
  await P('candidata-0').click();
  comprobar((await P('lote').inputValue()).length > 0, 'al confirmar se rellena el lote');
  // CN desconocido
  await P('escaneo').fill('999999'); await pag.keyboard.press('Enter'); await pag.waitForTimeout(600);
  comprobar(await pag.getByText('Dar de alta el medicamento').isVisible(), 'CN desconocido: ofrece darlo de alta');
  await foto('05-cajas-cn-desconocido');

  // ficha del paciente → cajas
  await ir(`/pacientes/${pac.id}/cajas`);
  await pag.waitForSelector('[data-prueba="cajas-en-uso"]');
  await foto('06-ficha-cajas');
  comprobar((await P('cajas-en-uso').locator('tbody tr').count()) === 2, 'la ficha lista las dos cajas');

  // ───────── Preparar ─────────
  console.log('Preparar');
  await ir(`/preparar/${pac.id}`);
  await pag.waitForSelector('[data-prueba="empezar-llenar"]');
  await pag.selectOption('[data-prueba="dias"]', '14');
  await pag.waitForTimeout(1500);
  await foto('12-preparar-revisar-bloqueo');
  comprobar(await pag.getByText('Empezar hoy').isVisible(), 'si el periodo no cabe en la validez, ofrece empezar hoy');
  await pag.getByRole('button', { name: /^Hoy ·/ }).click(); await pag.waitForTimeout(1500);
  const textoRev = await pag.locator('main, .contenido').first().innerText();
  console.log('   (unidades suficientes?)', !(textoRev.includes('Faltan')));
  // dos cajas más para cubrir 14 días (metformina 14×1.5=21 de 28 → cubre; enalapril 14 de 30 → cubre)
  comprobar(await P('empezar-llenar').isEnabled(), 'con 14 días y dos medicamentos se puede empezar a llenar');
  await foto('13-preparar-revisar');
  await P('empezar-llenar').click();
  await pag.waitForSelector('[data-prueba="siguiente"]');
  await foto('14-preparar-llenar');
  // escanear una caja que no es de este blíster
  await P('escaneo-llenar').fill(`01${g14ok}1728123110OTRO99`); await pag.keyboard.press('Enter'); await pag.waitForTimeout(300);
  comprobar(await pag.getByText('NO es una de las que se usan').isVisible(), 'caja que no corresponde: bloquea con aviso');
  await foto('15-preparar-caja-ajena');
  // llenar todo
  let vueltas = 0;
  while (await P('siguiente').count() && vueltas++ < 200) { await P('marcar-siguiente').click(); }
  const avance = await P('total-avance').innerText(); console.log('   avance:', avance);
  comprobar(/^(\d+) de \1 /.test(avance), 'todos los puestos marcados');
  await foto('16-preparar-llenar-completo');
  await P('marcar-preparado').click(); await pag.waitForTimeout(300);
  comprobar(await pag.getByText('Anota la temperatura').isVisible(), 'exige temperatura y humedad');
  await P('temperatura').fill('21,5'); await P('humedad').fill('48');
  await P('marcar-preparado').click();
  await pag.waitForSelector('[data-prueba="validar"]');
  await foto('17-preparar-validar');
  comprobar(await P('validar').isDisabled(), '«Validar» exige marcar la comparación');
  await P('he-comparado').check(); await P('validar').click();
  await pag.waitForSelector('#validada'); await pag.waitForSelector('iframe');
  await pag.waitForTimeout(800);
  await foto('18-preparar-etiqueta');
  await P('pestana-hoja').click(); await pag.waitForTimeout(1200);
  await foto('19-preparar-hoja-paciente');
  await P('registrar-entrega').click(); await pag.waitForSelector('[data-prueba="confirmar-entrega"]');
  await foto('20-preparar-entrega');
  await P('confirmar-entrega').click();
  await pag.waitForSelector('#entregada');
  comprobar(true, 'entrega registrada');
  await foto('21-preparar-entregado');

  await ir(`/pacientes/${pac.id}/blisteres`);
  await pag.waitForSelector('[data-prueba="lista-blisteres"]');
  await foto('22-ficha-blisteres');
  await ir(`/pacientes/${pac.id}/historial`);
  await pag.waitForSelector('[data-prueba="historial"]');
  await foto('23-ficha-historial');

  // ───────── Medicamentos ─────────
  console.log('Medicamentos');
  await ir('/medicamentos');
  await pag.waitForSelector('[data-prueba="lista-med"]');
  await foto('24-medicamentos');
  await pag.locator('[data-prueba="lista-med"] tbody tr').first().click();
  await pag.waitForSelector('[data-prueba="ficha-med"]');
  await P('cima').click(); await pag.waitForTimeout(2500);
  await foto('25-medicamentos-cima');
  await pag.getByText('Pegar la ficha técnica').click();
  await P('texto-ficha').fill('Comprimidos recubiertos con película, blancos, redondos, biconvexos, ranurados por una cara y con la inscripción "MF" en la otra.');
  await P('analizar').click(); await pag.waitForTimeout(800);
  await foto('26-medicamentos-propuesta');
  await P('confirmar-aspecto').click(); await pag.waitForSelector('#ok-form');
  comprobar(true, 'aspecto confirmado por el farmacéutico');
  await P('incompletas').click(); await pag.waitForTimeout(500);
  await foto('27-medicamentos-incompletas');
  await P('nuevo-med').click(); await P('alta-cn').fill('777777'); await P('alta-nombre').fill('Paracetamol 1 g 40 comprimidos'); await P('alta-unidades').fill('40');
  await foto('28-medicamentos-alta');
  await P('alta-guardar').click(); await pag.waitForTimeout(800);
  comprobar((await pag.locator('[data-prueba="ficha-med"] h2').innerText()).includes('Paracetamol'), 'alta manual abre su ficha');

  // ───────── Auditoría ─────────
  console.log('Auditoría');
  await ir('/auditoria');
  await pag.waitForSelector('[data-prueba="tabla-auditoria"]');
  await P('verificar').click(); await pag.waitForSelector('#veredicto');
  comprobar((await pag.locator('#veredicto').innerText()).includes('Todo en orden'), 'la cadena de auditoría está íntegra');
  await foto('29-auditoria');

  // 1024×700 sin desbordes
  console.log('Tamaños');
  for (const [w, h] of [[1024, 700], [1920, 1080]]) {
    await pag.setViewportSize({ width: w, height: h });
    for (const r of ['/cajas', `/preparar/${pac.id}`, '/medicamentos', '/auditoria', `/pacientes/${pac.id}/documentos`]) {
      await ir(r); await pag.waitForTimeout(700);
      const desborde = await pag.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2 || [...document.querySelectorAll('.contenido')].some(c => c.scrollWidth > c.clientWidth + 2));
      comprobar(!desborde, `${w}×${h} ${r} sin desborde horizontal`);
    }
  }
  await pag.setViewportSize({ width: 1280, height: 800 });
} catch (e) {
  fallos++; console.error('FALLO:', e.message); await pag.screenshot({ path: join(CAP, 'zz-fallo.png') }).catch(() => {});
}
if (errores.length) { console.error('Errores de consola:\n' + [...new Set(errores)].join('\n')); }
await navegador.close(); web.close(); await srv.cerrar();
console.log(`\n${n - fallos}/${n} comprobaciones correctas`);
process.exit(fallos || errores.length ? 1 : 0);
