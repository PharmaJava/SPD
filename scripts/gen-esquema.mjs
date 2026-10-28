// Genera src/servicios/esquema-sql.ts a partir de db/schema.sql (para poder empaquetarlo sin leer ficheros).
import { readFileSync, writeFileSync } from 'node:fs';
const sql = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const ts = `// GENERADO por scripts/gen-esquema.mjs desde db/schema.sql. No editar a mano.\nexport const ESQUEMA_V1 = ${JSON.stringify(sql)};\n`;
writeFileSync(new URL('../src/servicios/esquema-sql.ts', import.meta.url), ts);
console.log('esquema-sql.ts generado');
