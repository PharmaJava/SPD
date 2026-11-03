// Genera docs/manual/manual-usuario.pdf desde manual-usuario.md (Chromium vía Playwright, A4).
//   node docs/manual/generar-pdf.mjs
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const AQUI = dirname(fileURLToPath(import.meta.url));
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';
const { chromium } = createRequire(import.meta.url)('/opt/node22/lib/node_modules/playwright');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const en = (s) => esc(s).replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<figure><img src="$2" alt="$1"><figcaption>$1</figcaption></figure>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>').replace(/`([^`]+)`/g, '<code>$1</code>');
const lineas = readFileSync(join(AQUI, 'manual-usuario.md'), 'utf8').split('\n');
let html = '', lista = null;
const cerrar = () => { if (lista) { html += `</${lista}>`; lista = null; } };
for (const l of lineas) {
  let m;
  if ((m = l.match(/^# (.*)/))) { cerrar(); html += `<h1>${en(m[1])}</h1>`; }
  else if ((m = l.match(/^## (.*)/))) { cerrar(); html += `<h2>${en(m[1])}</h2>`; }
  else if ((m = l.match(/^> (.*)/))) { cerrar(); html += `<blockquote>${en(m[1])}</blockquote>`; }
  else if ((m = l.match(/^(\d+)\. (.*)/))) { if (lista !== 'ol') { cerrar(); html += '<ol>'; lista = 'ol'; } html += `<li>${en(m[2])}</li>`; }
  else if ((m = l.match(/^- (.*)/))) { if (lista !== 'ul') { cerrar(); html += '<ul>'; lista = 'ul'; } html += `<li>${en(m[1])}</li>`; }
  else if (l.trim() === '') { cerrar(); }
  else if (/^!\[/.test(l)) { cerrar(); html += en(l); }
  else { cerrar(); html += `<p>${en(l)}</p>`; }
}
cerrar();
const css = `
@page { size: A4; margin: 15mm 16mm 16mm; }
body { font: 10pt/1.38 "Inter","Segoe UI",Arial,sans-serif; color: #1f2a2e; margin: 0; }
h1 { font-size: 22pt; color: #0f766e; margin: 0 0 2mm; }
h2 { font-size: 13pt; color: #0f766e; border-bottom: 1.5px solid #cfe5e1; padding-bottom: 1mm; margin: 5mm 0 2mm; break-after: avoid; }
p, li { margin: 0 0 1.6mm; } ul, ol { margin: 0 0 2mm; padding-left: 6mm; }
blockquote { margin: 2mm 0 3mm; padding: 2.5mm 3.5mm; background: #fdf0dc; border-left: 3px solid #c2610c; border-radius: 2px; }
p:has(+ ol), p:has(+ ul) { break-after: avoid; }
figure { margin: 2mm auto 3mm; text-align: center; break-inside: avoid; }
figure img { width: 130mm; border: 1px solid #cfd6d4; border-radius: 3px; }
figcaption { font-size: 8.5pt; color: #5b676b; margin-top: 1mm; }
code { background: #eef2f1; padding: 0 1mm; border-radius: 2px; font-size: 9pt; }
`;
const doc = `<!doctype html><html lang="es"><meta charset="utf-8"><title>SPD · Manual de usuario</title><style>${css}</style><body>${html}</body></html>`;
const f = join(AQUI, 'manual-usuario.html'); writeFileSync(f, doc);
const nav = await chromium.launch(); const p = await nav.newPage();
await p.goto(pathToFileURL(f).href); await p.waitForLoadState('load');
await p.pdf({ path: join(AQUI, 'manual-usuario.pdf'), format: 'A4', printBackground: true, displayHeaderFooter: true,
  headerTemplate: '<span></span>', footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#777">SPD · Manual de usuario · <span class="pageNumber"></span>/<span class="totalPages"></span></div>',
  margin: { top: '15mm', bottom: '16mm', left: '16mm', right: '16mm' } });
await nav.close();
