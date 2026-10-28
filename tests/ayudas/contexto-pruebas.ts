/**
 * Contexto de pruebas para los servicios: base en memoria, usuario con sesión y
 * auditoría real encadenada (usa el dominio) pero sin ficheros ni cifrado.
 */
import { abrirDb } from '../../src/servicios/db.ts';
import type { Db } from '../../src/servicios/db.ts';
import type { Contexto, DatosAuditoria } from '../../src/servicios/contexto.ts';
import type { RolUsuario, UsuarioPublico } from '../../src/servicios/api.ts';
import { crearEntrada, HASH_GENESIS } from '../../src/dominio/auditoria.ts';

export interface ContextoPruebas { ctx: Contexto; db: Db; reloj: { fecha: Date }; auditadas: DatosAuditoria[]; cambiarUsuario(rol: RolUsuario | null): UsuarioPublico | null; persistencias: () => number }

const NOMBRES: Record<RolUsuario, string> = { titular: 'Titular Prueba', farmaceutico: 'Farma Prueba', tecnico: 'Técnico Prueba', administrativo: 'Admin Prueba' };

/** Crea la base, un usuario por rol y deja la sesión iniciada con `rol` (por defecto farmacéutico). */
export async function crearContextoPruebas(rol: RolUsuario | null = 'farmaceutico', fecha = '2026-11-02T09:00:00Z'): Promise<ContextoPruebas> {
  const db = await abrirDb();
  const ids = new Map<RolUsuario, number>();
  for (const r of ['titular', 'farmaceutico', 'tecnico', 'administrativo'] as RolUsuario[]) {
    ids.set(r, db.run('INSERT INTO usuario(nombre,iniciales,rol,hash_clave) VALUES (?,?,?,?)', [NOMBRES[r], r.slice(0, 2).toUpperCase(), r, 'x']).ultimoId);
  }
  db.run("INSERT INTO farmacia(id,nombre,titular) VALUES (1,'Farmacia de Prueba','Titular Prueba')");
  for (const [i, n] of ['Desayuno', 'Comida', 'Cena', 'Acostarse'].entries()) db.run('INSERT INTO momento_toma(nombre,orden) VALUES (?,?)', [n, i + 1]);
  const reloj = { fecha: new Date(fecha) };
  let sesion: UsuarioPublico | null = null;
  let persist = 0;
  const auditadas: DatosAuditoria[] = [];
  const cambiarUsuario = (r: RolUsuario | null) => { sesion = r ? { id: ids.get(r)!, nombre: NOMBRES[r], iniciales: r.slice(0, 2).toUpperCase(), rol: r } : null; return sesion; };
  cambiarUsuario(rol);
  const ctx: Contexto = {
    db: () => db,
    ahora: () => new Date(reloj.fecha),
    sesion: () => sesion,
    auditar(d) {
      auditadas.push(d);
      const ult = db.get<{ hash: string }>('SELECT hash FROM auditoria ORDER BY id DESC LIMIT 1');
      const e = crearEntrada({
        momento: reloj.fecha.toISOString().replace(/(\.\d+)?Z$/, '.000Z'), usuarioId: sesion?.id ?? null, accion: d.accion, entidad: d.entidad,
        entidadId: d.entidadId == null ? null : String(d.entidadId), antes: d.antes ?? null, despues: d.despues ?? null, motivo: d.motivo ?? null,
      }, ult?.hash ?? HASH_GENESIS);
      db.run('INSERT INTO auditoria(momento,usuario_id,accion,entidad,entidad_id,antes,despues,motivo,hash_previo,hash) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [e.momento, e.usuarioId, e.accion, e.entidad, e.entidadId, JSON.stringify(e.antes), JSON.stringify(e.despues), e.motivo, e.hashPrevio, e.hash]);
    },
    persistir() { persist++; },
  };
  return { ctx, db, reloj, auditadas, cambiarUsuario, persistencias: () => persist };
}
