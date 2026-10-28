// Copia a dist/recursos lo que el programa necesita en tiempo de ejecución (el motor SQLite WebAssembly).
import { mkdirSync, copyFileSync } from 'node:fs';
mkdirSync(new URL('../dist/recursos', import.meta.url), { recursive: true });
copyFileSync(new URL('../node_modules/sql.js/dist/sql-wasm.wasm', import.meta.url), new URL('../dist/recursos/sql-wasm.wasm', import.meta.url));
console.log('recursos copiados');
