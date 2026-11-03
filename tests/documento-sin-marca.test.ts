/**
 * El documento que firma el paciente NO lleva marca de borrador ni banner (CLAUDE.md, regla 6: sin avisos del programa en el
 * papel). La cautela jurídica («son borradores para revisar con un abogado») vive SÓLO en Ajustes → Acerca de, el README y el manual.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PLANTILLAS_DOCUMENTOS } from '../src/servicios/plantillas-documentos.ts';
import { renderizarDocumento, VARIABLES_DOCUMENTO } from '../src/dominio/documentos.ts';
import { htmlDocumentoImprimible } from '../src/interfaz/pantallas/preparacion/util.ts';

const sinComentarios = (t: string) => t.replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|^\s*\/\/.*$/gm, '');
const completos = () => Object.fromEntries(VARIABLES_DOCUMENTO.map((v) => [v, `${v} ok`]));

test('ninguna plantilla (fuente .md ni embebida) contiene la palabra BORRADOR', () => {
  const dir = new URL('../plantillas/consentimientos/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) assert.doesNotMatch(readFileSync(new URL(f, dir), 'utf8'), /borrador/i, f);
  for (const p of PLANTILLAS_DOCUMENTOS) assert.doesNotMatch(p.cuerpo, /borrador/i, p.codigo);
});

test('el texto impreso de cada plantilla no lleva marca, ni siquiera si una plantilla ANTIGUA de la base aún trae el comentario BORRADOR', () => {
  for (const p of PLANTILLAS_DOCUMENTOS) {
    const nueva = renderizarDocumento(p.cuerpo, completos());
    const antigua = renderizarDocumento(`<!-- BORRADOR v1 — revisar con un abogado -->\n${p.cuerpo}`, completos());
    assert.doesNotMatch(nueva.texto, /borrador/i, p.codigo);
    assert.equal(antigua.texto, nueva.texto, `${p.codigo}: el comentario antiguo no cambia lo impreso`);
    assert.equal(antigua.hash, nueva.hash);
  }
});

test('el HTML que se imprime es el texto del documento y nada más: sin marca, sin banner, sin recuadro rojo', () => {
  const html = htmlDocumentoImprimible('# Consentimiento\n\nYo, Ana, acepto.', 'Consentimiento informado');
  assert.match(html, /<h3>Consentimiento<\/h3>/);
  assert.match(html, /Yo, Ana, acepto\./);
  assert.doesNotMatch(html, /borrador|pendiente de revisi|abogado|class="marca"|\.marca\{/i);
  assert.doesNotMatch(html, /b42318/, 'ni el rojo de la marca');
  // lo que sí protege: el título y el texto se escapan
  const malo = htmlDocumentoImprimible('<script>x</script>', '<img onerror=x>');
  assert.doesNotMatch(malo, /<script>|<img/);
});

test('la pantalla de documentos no enseña el aviso de borrador ni marca el impreso', () => {
  const f = sinComentarios(readFileSync('src/interfaz/pantallas/FichaDocumentos.svelte', 'utf8'));
  assert.doesNotMatch(f, /BORRADOR|esBorrador|pendiente de revisi[óo]n|marca de borrador/i);
  assert.match(f, /htmlDocumentoImprimible\(/, 'imprime con la función sin marca');
});

test('el contrato y los servicios ya no tienen esBorrador; el aviso legal conserva la cautela donde debe', () => {
  for (const f of ['src/dominio/documentos.ts', 'src/servicios/api.ts', 'src/servicios/preparacion/documentos.ts']) {
    assert.doesNotMatch(sinComentarios(readFileSync(f, 'utf8')), /esBorrador/, f);
  }
  const ajustes = readFileSync('src/interfaz/pantallas/Ajustes.svelte', 'utf8');
  assert.match(ajustes, /Los textos de consentimiento que incluye son <strong>borradores<\/strong> para revisar con un profesional del derecho/);
  assert.match(readFileSync('README.md', 'utf8'), /son borradores/);
  assert.match(readFileSync('docs/manual/manual-usuario.md', 'utf8'), /son borradores/);
});

test('«borrador» sólo aparece en el texto de la interfaz como estado de la preparación y en el aviso legal', () => {
  const dir = 'src/interfaz';
  const leer = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? leer(`${d}/${x.name}`) : /\.(svelte|ts)$/.test(x.name) ? [`${d}/${x.name}`] : []));
  const intrusos = leer(dir).filter((f) => /BORRADOR/.test(sinComentarios(readFileSync(f, 'utf8')))).filter((f) => !/Ajustes\.svelte$/.test(f));
  assert.deepEqual(intrusos, []);
});
