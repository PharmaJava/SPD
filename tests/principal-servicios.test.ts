import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crearServiciosApp } from '../src/principal/servicios.ts';
import { crearManejadores, canalDe } from '../src/principal/ipc-nucleo.ts';
import { crearExterno } from '../src/principal/externo.ts';
import type { DepsExterno } from '../src/principal/externo.ts';

const depsVacias = {} as DepsExterno;

test('integración real: sistema + clínica base + preparación + externo cubren TODO el contrato', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spd-serv-'));
  const sv = crearServiciosApp({ rutaDatos: dir, wasmPath: join(import.meta.dirname, '../node_modules/sql.js/dist/sql-wasm.wasm'), version: '0.0.0', externo: crearExterno(depsVacias) });
  try {
    assert.deepEqual(sv.faltan, [], 'métodos del contrato sin implementar');
    const e = await sv.api.estado();
    assert.ok(e.ok && e.datos.inicializado === false && e.datos.desbloqueado === false);
    // Una llamada clínica sin desbloquear no filtra datos ni lanza.
    const p = await sv.api.listarPacientes();
    assert.equal(p.ok, false);
    // Por IPC (núcleo): remitente ajeno rechazado, propio pasa.
    const mapa = crearManejadores({ api: sv.api, reglas: () => ({ idWebContentsPropio: 1, urlPropia: () => true }) });
    const ajeno = await mapa.get(canalDe('estado'))!({ idWebContents: 2, esMarcoPrincipal: true, urlMarco: 'x' });
    assert.equal((ajeno as any).codigo, 'NO_AUTORIZADO');
    const propio = await mapa.get(canalDe('estado'))!({ idWebContents: 1, esMarcoPrincipal: true, urlMarco: 'x' });
    assert.equal(propio.ok, true);
  } finally { await sv.cerrar(); rmSync(dir, { recursive: true, force: true }); }
});
