// Genera src/servicios/plantillas-documentos.ts a partir de plantillas/consentimientos/*.md
// (para poder empaquetar las plantillas sin leer ficheros en tiempo de ejecución).
//   node scripts/gen-plantillas.mjs            → escribe el fichero
//   node scripts/gen-plantillas.mjs --comprobar → sale con código 1 si está desactualizado
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

const dir = new URL('../plantillas/consentimientos/', import.meta.url);
const destino = new URL('../src/servicios/plantillas-documentos.ts', import.meta.url);

const plantillas = readdirSync(dir)
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((f) => {
    const cuerpo = readFileSync(new URL(f, dir), 'utf8').replace(/\r\n?/g, '\n');
    const t = /^#\s+(.+?)\s*$/m.exec(cuerpo);
    if (!t) throw new Error(`La plantilla ${f} no tiene título (primer encabezado «# …»).`);
    return { codigo: f.replace(/\.md$/, ''), titulo: t[1], cuerpo };
  });

const ts =
  '// GENERADO por scripts/gen-plantillas.mjs desde plantillas/consentimientos/*.md. No editar a mano.\n' +
  'export interface PlantillaEmbebida { codigo: string; titulo: string; cuerpo: string }\n' +
  'export const PLANTILLAS_DOCUMENTOS: readonly PlantillaEmbebida[] = ' + JSON.stringify(plantillas, null, 2) + ';\n';

if (process.argv.includes('--comprobar')) {
  const actual = existsSync(destino) ? readFileSync(destino, 'utf8') : '';
  if (actual !== ts) { console.error('plantillas-documentos.ts está desactualizado: ejecuta node scripts/gen-plantillas.mjs'); process.exit(1); }
  console.log('plantillas-documentos.ts al día');
} else {
  writeFileSync(destino, ts);
  console.log(`plantillas-documentos.ts generado (${plantillas.length} plantillas)`);
}
