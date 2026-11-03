/**
 * Acceso a la base de datos: SQLite compilado a WebAssembly (sql.js), en memoria.
 *
 * ¿Por qué en memoria? Para poder CIFRAR el fichero entero al guardarlo (AES-256-GCM,
 * ver almacen.ts) sin depender de módulos nativos que habría que recompilar para
 * Electron. Para una farmacia (cientos de pacientes) el tamaño es de unos pocos MB.
 *
 * Todo es síncrono salvo la carga inicial del motor.
 */
import initSqlJs from 'sql.js';
import type { Database, SqlValue } from 'sql.js';
import { ESQUEMA_V1 } from './esquema-sql.ts';
import { TIPOS_CENTRO, normalizarNombreCentro } from '../dominio/origen-paciente.ts';

export type Param = string | number | null | Uint8Array;
export type Fila = Record<string, string | number | null | Uint8Array>;

export interface Db {
  exec(sql: string): void;
  run(sql: string, params?: Param[]): { cambios: number; ultimoId: number };
  all<T = Fila>(sql: string, params?: Param[]): T[];
  get<T = Fila>(sql: string, params?: Param[]): T | undefined;
  /** BEGIN/COMMIT; si `fn` lanza, ROLLBACK y se relanza. Admite anidación (savepoints). */
  transaccion<T>(fn: () => T): T;
  exportar(): Uint8Array;
  version(): number;
  cerrar(): void;
}

export interface OpcionesDb { wasmPath?: string }

export const VERSION_ESQUEMA = 3;

let motor: Awaited<ReturnType<typeof initSqlJs>> | null = null;
let motorWasm: string | undefined;

async function cargarMotor(wasmPath?: string) {
  if (motor && motorWasm === wasmPath) return motor;
  motor = await initSqlJs(wasmPath ? { locateFile: () => wasmPath } : undefined);
  motorWasm = wasmPath;
  return motor;
}

/** Abre una base (de bytes ya descifrados) o crea una nueva con el esquema vigente. */
export async function abrirDb(bytes?: Uint8Array, opciones: OpcionesDb = {}): Promise<Db> {
  const SQL = await cargarMotor(opciones.wasmPath);
  const raw: Database = bytes ? new SQL.Database(bytes) : new SQL.Database();
  const db = envolver(raw);
  db.exec('PRAGMA foreign_keys = ON;');
  migrar(db);
  return db;
}

/**
 * Aplica el esquema si la base es nueva (user_version = 0) y las migraciones numeradas si es
 * de una versión anterior. Cada migración va en su transacción y SÓLO añade (nunca borra datos).
 */
function migrar(db: Db): void {
  const v = db.version();
  if (v > VERSION_ESQUEMA) throw new Error(`La base de datos es de una versión más nueva (${v}) que este programa (${VERSION_ESQUEMA}). Actualiza el programa.`);
  if (v === 0) {
    db.transaccion(() => {
      db.exec(ESQUEMA_V1.replace(/PRAGMA journal_mode = WAL;/i, ''));
      db.exec(`PRAGMA user_version = ${VERSION_ESQUEMA};`);
    });
    return;
  }
  if (v < 2) db.transaccion(() => { migrarV2(db); db.exec('PRAGMA user_version = 2;'); });
  if (v < 3) db.transaccion(() => { migrarV3(db); db.exec('PRAGMA user_version = 3;'); });
}

/**
 * v2 → v3: documentos «gestionados sin firma individual» (`origen`, `motivo_gestion` y la calidad `sin_firma`).
 * SQLite no cambia un CHECK existente, así que se reconstruye la tabla copiando TODAS las filas tal cual
 * (todas quedan con origen 'firma'): ni se pierde ni se reescribe ningún documento firmado. Idempotente.
 */
export function migrarV3(db: Db): void {
  if (db.all<{ name: string }>('PRAGMA table_info(documento_firmado)').some((c) => c.name === 'origen')) return;
  db.exec(`CREATE TABLE documento_firmado_v3 (
    id INTEGER PRIMARY KEY,
    id_publico TEXT NOT NULL UNIQUE,
    paciente_id INTEGER NOT NULL REFERENCES paciente(id),
    plantilla_id INTEGER NOT NULL REFERENCES plantilla_documento(id),
    firmante TEXT NOT NULL,
    firmante_calidad TEXT NOT NULL,
    contacto_id INTEGER REFERENCES contacto(id),
    firmado_en TEXT NOT NULL,
    texto_impreso TEXT NOT NULL,
    hash_texto TEXT NOT NULL,
    escaneo BLOB,
    revocado_en TEXT,
    motivo_revocacion TEXT,
    registrado_por INTEGER NOT NULL REFERENCES usuario(id),
    origen TEXT NOT NULL DEFAULT 'firma' CHECK (origen IN ('firma','gestionado_sin_firma')),
    motivo_gestion TEXT,
    CHECK (
      (origen = 'firma' AND firmante_calidad IN ('paciente','representante_legal','guardador_de_hecho'))
      OR (origen = 'gestionado_sin_firma' AND firmante_calidad = 'sin_firma' AND motivo_gestion IS NOT NULL AND length(trim(motivo_gestion)) >= 5)
    )
  )`);
  db.exec(`INSERT INTO documento_firmado_v3 (id, id_publico, paciente_id, plantilla_id, firmante, firmante_calidad, contacto_id, firmado_en,
             texto_impreso, hash_texto, escaneo, revocado_en, motivo_revocacion, registrado_por)
           SELECT id, id_publico, paciente_id, plantilla_id, firmante, firmante_calidad, contacto_id, firmado_en,
             texto_impreso, hash_texto, escaneo, revocado_en, motivo_revocacion, registrado_por FROM documento_firmado`);
  db.exec('DROP TABLE documento_firmado');
  db.exec('ALTER TABLE documento_firmado_v3 RENAME TO documento_firmado');
}

/** v1 → v2: origen del paciente. Los pacientes existentes no cambian (sin centro = individual). */
export function migrarV2(db: Db): void {
  const lista = TIPOS_CENTRO.map((t) => `'${t}'`).join(',');
  db.exec(`ALTER TABLE centro ADD COLUMN tipo TEXT NOT NULL DEFAULT 'otro' CHECK (tipo IN (${lista}))`);
  db.exec('ALTER TABLE centro ADD COLUMN activo INTEGER NOT NULL DEFAULT 1');
  db.exec("ALTER TABLE centro ADD COLUMN nombre_norm TEXT NOT NULL DEFAULT ''");
  // Los centros ya existentes conservan su nombre; sólo se calcula la clave de comparación.
  for (const c of db.all<{ id: number; nombre: string }>('SELECT id, nombre FROM centro')) {
    db.run('UPDATE centro SET nombre_norm = ? WHERE id = ?', [normalizarNombreCentro(c.nombre), c.id]);
  }
  db.exec('CREATE INDEX IF NOT EXISTS centro_nombre_norm ON centro(nombre_norm)');
  db.exec('CREATE INDEX IF NOT EXISTS paciente_centro ON paciente(centro_id)');
}

function envolver(raw: Database): Db {
  let profundidad = 0;
  const enlazar = (params?: Param[]) => (params ?? []) as SqlValue[];
  return {
    exec: (sql) => { raw.exec(sql); },
    run(sql, params) {
      raw.run(sql, enlazar(params));
      const cambios = raw.getRowsModified();
      const r = raw.exec('SELECT last_insert_rowid() AS id');
      return { cambios, ultimoId: Number(r[0]?.values[0]?.[0] ?? 0) };
    },
    all<T>(sql: string, params?: Param[]): T[] {
      const st = raw.prepare(sql);
      try {
        st.bind(enlazar(params));
        const out: T[] = [];
        while (st.step()) out.push(st.getAsObject() as unknown as T);
        return out;
      } finally { st.free(); }
    },
    get<T>(sql: string, params?: Param[]): T | undefined {
      const st = raw.prepare(sql);
      try {
        st.bind(enlazar(params));
        return st.step() ? (st.getAsObject() as unknown as T) : undefined;
      } finally { st.free(); }
    },
    transaccion<T>(fn: () => T): T {
      const nombre = `sp${profundidad}`;
      raw.exec(profundidad === 0 ? 'BEGIN' : `SAVEPOINT ${nombre}`);
      profundidad++;
      try {
        const r = fn();
        profundidad--;
        raw.exec(profundidad === 0 ? 'COMMIT' : `RELEASE ${nombre}`);
        return r;
      } catch (e) {
        profundidad--;
        raw.exec(profundidad === 0 ? 'ROLLBACK' : `ROLLBACK TO ${nombre}; RELEASE ${nombre}`);
        throw e;
      }
    },
    exportar: () => raw.export(),
    version: () => Number(raw.exec('PRAGMA user_version')[0]?.values[0]?.[0] ?? 0),
    cerrar: () => raw.close(),
  };
}
