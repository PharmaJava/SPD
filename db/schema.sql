-- =============================================================================
-- SPD — esquema de base de datos (SQLite + SQLCipher)
-- Versión de esquema 1. Las siguientes van como migraciones numeradas.
--
-- Convenciones:
--   * Claves primarias INTEGER autoincrementales; id_publico (UUID) donde un
--     registro sale en papel o en un código (blíster, consentimiento).
--   * Fechas ISO-8601 en TEXT ('2026-10-28' o '2026-10-28T10:15:00Z').
--   * Importes en céntimos (INTEGER). Unidades de medicamento en REAL para
--     admitir fracciones (0.5, 0.25).
--   * Nada se borra si tiene historia: se marca baja_en / anulado_en.
--   * Toda escritura pasa por la capa de servicios, que añade la fila de
--     auditoria en la misma transacción.
-- =============================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ─── Farmacia y usuarios ─────────────────────────────────────────────────────

CREATE TABLE farmacia (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),   -- una sola fila
  nombre                TEXT NOT NULL,
  titular               TEXT NOT NULL,
  nif                   TEXT,
  direccion             TEXT,
  codigo_postal         TEXT,
  municipio             TEXT,
  provincia             TEXT,
  comunidad_autonoma    TEXT,         -- decide qué normativa SPD aplica
  telefono              TEXT,
  email                 TEXT,
  numero_autorizacion   TEXT,         -- nº de la farmacia en la CCAA
  spd_declaracion_fecha TEXT,         -- declaración responsable de SPD presentada
  spd_declaracion_ref   TEXT,
  logo                  BLOB,
  -- Datos del responsable del tratamiento (RGPD) si no coinciden con el titular
  rgpd_responsable      TEXT,
  rgpd_contacto         TEXT,
  rgpd_dpd              TEXT,         -- delegado de protección de datos, si lo hay
  dias_validez_spd      INTEGER NOT NULL DEFAULT 14,   -- validez estándar
  -- Opcional: permitir hasta 30 días (no es lo que recomiendan los documentos de
  -- referencia). Apagado por defecto; lo activa el titular y cada uso se justifica.
  validez_extendida_permitida INTEGER NOT NULL DEFAULT 0,
  creado_en             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE usuario (
  id              INTEGER PRIMARY KEY,
  nombre          TEXT NOT NULL,
  iniciales       TEXT NOT NULL,                -- salen en registros impresos
  rol             TEXT NOT NULL CHECK (rol IN ('titular','farmaceutico','tecnico','administrativo')),
  num_colegiado   TEXT,
  hash_clave      TEXT NOT NULL,                -- argon2id
  activo          INTEGER NOT NULL DEFAULT 1,
  creado_en       TEXT NOT NULL DEFAULT (datetime('now')),
  baja_en         TEXT
);

-- ─── Pacientes ───────────────────────────────────────────────────────────────

CREATE TABLE paciente (
  id                 INTEGER PRIMARY KEY,
  id_publico         TEXT NOT NULL UNIQUE,      -- UUID; nunca el DNI en un código
  nombre             TEXT NOT NULL,
  apellido1          TEXT NOT NULL,
  apellido2          TEXT,
  fecha_nacimiento   TEXT,
  sexo               TEXT CHECK (sexo IN ('M','H','X') OR sexo IS NULL),
  dni_nie            TEXT,
  -- Tarjeta sanitaria: el formato del CIP cambia por comunidad, no se valida
  cip_autonomico     TEXT,
  cip_sns            TEXT,                      -- código CIP-SNS de la TSI
  nass               TEXT,                      -- nº de afiliación a la SS
  tsi_ccaa           TEXT,                      -- comunidad emisora de la tarjeta
  aseguradora        TEXT,                      -- mutualidades (MUFACE…) o privada
  direccion          TEXT,
  codigo_postal      TEXT,
  municipio          TEXT,
  telefono           TEXT,
  telefono2          TEXT,
  email              TEXT,
  centro_id          INTEGER REFERENCES centro(id),   -- residencia, si aplica
  habitacion         TEXT,
  -- Accesibilidad que afecta a la etiqueta
  necesita_braille   INTEGER NOT NULL DEFAULT 0,
  letra_grande       INTEGER NOT NULL DEFAULT 0,
  idioma             TEXT NOT NULL DEFAULT 'es',
  estado             TEXT NOT NULL DEFAULT 'activo'
                     CHECK (estado IN ('activo','pausado','baja','fallecido')),
  motivo_estado      TEXT,
  alta_en            TEXT NOT NULL DEFAULT (date('now')),
  baja_en            TEXT,
  bloqueado_en       TEXT,   -- supresión RGPD solicitada pero con obligación de conservar
  notas              TEXT
);
CREATE INDEX paciente_nombre ON paciente(apellido1, apellido2, nombre);

CREATE TABLE centro (               -- residencias / centros sociosanitarios
  id         INTEGER PRIMARY KEY,
  nombre     TEXT NOT NULL,
  direccion  TEXT,
  telefono   TEXT,
  contacto   TEXT,
  notas      TEXT
);

CREATE TABLE contacto (             -- cuidador, representante legal, médico…
  id            INTEGER PRIMARY KEY,
  paciente_id   INTEGER NOT NULL REFERENCES paciente(id),
  tipo          TEXT NOT NULL CHECK (tipo IN
                ('cuidador','representante_legal','familiar','medico_cabecera',
                 'especialista','enfermeria','centro','otro')),
  nombre        TEXT NOT NULL,
  dni_nie       TEXT,
  parentesco    TEXT,
  telefono      TEXT,
  email         TEXT,
  num_colegiado TEXT,               -- para médicos: identificación del prescriptor
  centro_salud  TEXT,
  autorizado_recoger INTEGER NOT NULL DEFAULT 0,
  notas         TEXT,
  baja_en       TEXT
);

-- Datos de salud: sólo los necesarios para preparar con seguridad (minimización)
CREATE TABLE salud_dato (
  id            INTEGER PRIMARY KEY,
  paciente_id   INTEGER NOT NULL REFERENCES paciente(id),
  tipo          TEXT NOT NULL CHECK (tipo IN
                ('alergia','intolerancia','diagnostico','disfagia','insuficiencia_renal',
                 'insuficiencia_hepatica','embarazo_lactancia','peso','otro')),
  descripcion   TEXT NOT NULL,
  valor         TEXT,               -- p.ej. peso en kg, FG en mL/min
  fecha         TEXT,
  fuente        TEXT,               -- informe médico, paciente, historia…
  vigente       INTEGER NOT NULL DEFAULT 1,
  registrado_por INTEGER NOT NULL REFERENCES usuario(id),
  registrado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Catálogo de medicamentos (caché local de CIMA + datos propios) ──────────

CREATE TABLE medicamento (
  cn                 TEXT PRIMARY KEY CHECK (length(cn) = 6),  -- sin dígito de control
  nregistro          TEXT,
  nombre             TEXT NOT NULL,
  principios_activos TEXT,          -- JSON [{nombre, cantidad, unidad}]
  laboratorio        TEXT,
  forma_farmaceutica TEXT,
  forma_simplificada TEXT,
  via                TEXT,
  unidades_envase    REAL,          -- 28, 30, 56…
  receta             INTEGER,
  estupefaciente     INTEGER NOT NULL DEFAULT 0,
  psicotropo         INTEGER NOT NULL DEFAULT 0,
  comercializado     INTEGER,
  url_ficha_tecnica  TEXT,
  url_prospecto      TEXT,
  url_foto_forma     TEXT,          -- foto del comprimido en CIMA
  foto_forma         BLOB,          -- copia local para trabajar sin conexión
  -- Descripción física: la propone CIMA (FT 3) y la CONFIRMA un farmacéutico
  descripcion_fisica     TEXT,      -- «comprimido blanco, redondo, ranurado, “M 500”»
  color                  TEXT,
  forma                  TEXT,
  marcas_grabado         TEXT,
  ranurado               INTEGER,   -- 1 = ranura para partir dosis
  descripcion_confirmada_por INTEGER REFERENCES usuario(id),
  descripcion_confirmada_en  TEXT,
  -- Aptitud para SPD (motor de reglas + criterio del farmacéutico)
  spd_aptitud        TEXT CHECK (spd_aptitud IN ('apto','precaucion','no_apto') OR spd_aptitud IS NULL),
  spd_motivo         TEXT,
  spd_decidido_por   INTEGER REFERENCES usuario(id),
  cima_json          TEXT,          -- respuesta cruda, para auditar de dónde salió
  cima_actualizado_en TEXT,
  creado_manual      INTEGER NOT NULL DEFAULT 0   -- dado de alta sin CIMA
);
CREATE INDEX medicamento_nombre ON medicamento(nombre);

-- ─── Tratamiento: QUÉ toma y CÓMO (independiente de las cajas) ───────────────

-- Momentos de toma configurables (desayuno, comida, cena, acostarse…)
CREATE TABLE momento_toma (
  id        INTEGER PRIMARY KEY,
  nombre    TEXT NOT NULL,          -- «Desayuno»
  hora      TEXT,                   -- «08:00» orientativa para la etiqueta
  orden     INTEGER NOT NULL,
  activo    INTEGER NOT NULL DEFAULT 1
);

-- Una línea de tratamiento; la pauta vive en sus versiones
CREATE TABLE tratamiento (
  id               INTEGER PRIMARY KEY,
  paciente_id      INTEGER NOT NULL REFERENCES paciente(id),
  principio_activo TEXT NOT NULL,   -- se identifica por PA + dosis, no por marca
  dosis_texto      TEXT,            -- «850 mg»
  cn_preferente    TEXT REFERENCES medicamento(cn),   -- lo que se suele dispensar
  prescriptor_id   INTEGER REFERENCES contacto(id),
  indicacion       TEXT,
  emblistable      INTEGER NOT NULL DEFAULT 1,  -- 0 = va aparte pero sale en la etiqueta
  motivo_no_emblistable TEXT,
  creado_en        TEXT NOT NULL DEFAULT (datetime('now')),
  finalizado_en    TEXT,
  motivo_fin       TEXT
);

CREATE TABLE pauta_version (
  id             INTEGER PRIMARY KEY,
  tratamiento_id INTEGER NOT NULL REFERENCES tratamiento(id),
  version        INTEGER NOT NULL,
  vigente_desde  TEXT NOT NULL,     -- fecha en que empieza a aplicarse
  vigente_hasta  TEXT,              -- NULL = indefinida
  -- Patrón de días
  patron         TEXT NOT NULL CHECK (patron IN
                 ('diario','dias_semana','cada_n_dias','ciclo','si_precisa')),
  dias_semana    TEXT,              -- '1,3,5' (1 = lunes) si patron = dias_semana
  cada_n_dias    INTEGER,           -- si patron = cada_n_dias
  ciclo_on       INTEGER,           -- días con toma si patron = ciclo (p.ej. 21)
  ciclo_off      INTEGER,           -- días de descanso (p.ej. 7)
  fecha_ancla    TEXT,              -- desde dónde se cuentan cada_n_dias y ciclos
  instrucciones  TEXT,              -- «en ayunas, con un vaso de agua»
  -- Por qué cambió: trazabilidad de la decisión
  origen         TEXT NOT NULL CHECK (origen IN
                 ('receta','informe_medico','comunicacion_medico','paciente','revision_farmaceutica','correccion')),
  origen_detalle TEXT,
  creado_por     INTEGER NOT NULL REFERENCES usuario(id),
  creado_en      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tratamiento_id, version)
);

-- Cantidad por momento de toma (0.5 = medio comprimido)
CREATE TABLE pauta_dosis (
  pauta_version_id INTEGER NOT NULL REFERENCES pauta_version(id),
  momento_id       INTEGER NOT NULL REFERENCES momento_toma(id),
  unidades         REAL NOT NULL CHECK (unidades > 0),
  PRIMARY KEY (pauta_version_id, momento_id)
);

-- ─── Envases custodiados: las CAJAS reales, con su lote ──────────────────────

CREATE TABLE envase (
  id               INTEGER PRIMARY KEY,
  paciente_id      INTEGER NOT NULL REFERENCES paciente(id),
  tratamiento_id   INTEGER REFERENCES tratamiento(id),  -- a qué línea abastece
  cn               TEXT NOT NULL REFERENCES medicamento(cn),
  gtin             TEXT,                 -- AI (01) tal como se leyó
  lote             TEXT NOT NULL,
  caducidad        TEXT NOT NULL,        -- AAAA-MM-DD (día 00 del GS1 → último del mes)
  numero_serie     TEXT,                 -- AI (21)
  datamatrix_crudo TEXT,                 -- lectura original, por si hay que revisarla
  origen_lectura   TEXT NOT NULL CHECK (origen_lectura IN ('datamatrix','manual')),
  unidades_inicio  REAL NOT NULL CHECK (unidades_inicio > 0),
  unidades_restantes REAL NOT NULL CHECK (unidades_restantes >= 0),
  recibido_en      TEXT NOT NULL DEFAULT (datetime('now')),
  recibido_por     INTEGER NOT NULL REFERENCES usuario(id),
  estado           TEXT NOT NULL DEFAULT 'en_uso'
                   CHECK (estado IN ('en_uso','agotado','devuelto','retirado','desechado')),
  cerrado_en       TEXT,
  motivo_cierre    TEXT,
  UNIQUE (cn, numero_serie)              -- un nº de serie no puede entrar dos veces
);
CREATE INDEX envase_lote ON envase(cn, lote);           -- búsqueda por alerta de calidad
CREATE INDEX envase_paciente ON envase(paciente_id, estado);

-- ─── Preparaciones: cada blíster/bolsa fabricado ─────────────────────────────

CREATE TABLE plantilla_blister (     -- formatos físicos: 7 × 4, 28 alvéolos…
  id            INTEGER PRIMARY KEY,
  nombre        TEXT NOT NULL,
  dias          INTEGER NOT NULL,      -- columnas
  tomas         INTEGER NOT NULL,      -- filas
  capacidad_alveolo REAL,              -- nº máx. de unidades por alvéolo
  notas         TEXT
);

CREATE TABLE preparacion (
  id                 INTEGER PRIMARY KEY,
  id_publico         TEXT NOT NULL UNIQUE,   -- va en el QR de la etiqueta
  paciente_id        INTEGER NOT NULL REFERENCES paciente(id),
  plantilla_id       INTEGER REFERENCES plantilla_blister(id),
  fecha_inicio       TEXT NOT NULL,          -- primer día de administración
  fecha_fin          TEXT NOT NULL,
  caducidad_spd      TEXT NOT NULL,          -- min(caducidades, preparado + validez)
  validez_dias       INTEGER NOT NULL DEFAULT 14,
  fuera_de_estandar  INTEGER NOT NULL DEFAULT 0,  -- validez > 14 días: desviación registrada
  justificacion_validez TEXT,                     -- obligatoria si fuera_de_estandar
  estado             TEXT NOT NULL DEFAULT 'borrador'
                     CHECK (estado IN ('borrador','preparado','validado','entregado','anulado')),
  preparado_por      INTEGER REFERENCES usuario(id),
  preparado_en       TEXT,
  validado_por       INTEGER REFERENCES usuario(id),   -- doble verificación
  validado_en        TEXT,
  temperatura        REAL,                   -- condiciones de la sala (15-25 ºC)
  humedad            REAL,                   -- (40-60 %)
  observaciones      TEXT,
  anulado_en         TEXT,
  motivo_anulacion   TEXT,
  CHECK (fuera_de_estandar = 0 OR length(trim(coalesce(justificacion_validez,''))) >= 10),
  CHECK (validez_dias BETWEEN 1 AND 30)
  -- Quién puede validar (sólo farmacéutico/titular) y si puede validar lo que
  -- él mismo preparó se aplica en la capa de servicios (puedeValidar) y se audita.
);

-- Qué se puso, de qué envase, en qué alvéolo
CREATE TABLE preparacion_linea (
  id               INTEGER PRIMARY KEY,
  preparacion_id   INTEGER NOT NULL REFERENCES preparacion(id),
  tratamiento_id   INTEGER NOT NULL REFERENCES tratamiento(id),
  pauta_version_id INTEGER NOT NULL REFERENCES pauta_version(id),  -- foto de la pauta usada
  envase_id        INTEGER NOT NULL REFERENCES envase(id),
  fecha            TEXT NOT NULL,              -- día del alvéolo
  momento_id       INTEGER NOT NULL REFERENCES momento_toma(id),
  unidades         REAL NOT NULL CHECK (unidades > 0),
  verificado_lector INTEGER NOT NULL DEFAULT 0  -- se escaneó el envase antes de cargar
);
CREATE INDEX prep_linea_envase ON preparacion_linea(envase_id);

-- Medicación que NO va en el blíster pero debe figurar en la etiqueta
CREATE TABLE preparacion_aparte (
  preparacion_id INTEGER NOT NULL REFERENCES preparacion(id),
  tratamiento_id INTEGER NOT NULL REFERENCES tratamiento(id),
  texto          TEXT NOT NULL,
  PRIMARY KEY (preparacion_id, tratamiento_id)
);

CREATE TABLE entrega (
  id              INTEGER PRIMARY KEY,
  preparacion_id  INTEGER NOT NULL REFERENCES preparacion(id),
  entregado_a     TEXT NOT NULL,               -- paciente o contacto autorizado
  contacto_id     INTEGER REFERENCES contacto(id),
  entregado_por   INTEGER NOT NULL REFERENCES usuario(id),
  entregado_en    TEXT NOT NULL DEFAULT (datetime('now')),
  firma           BLOB,                        -- tableta de firma, opcional
  prospectos_entregados INTEGER NOT NULL DEFAULT 1,
  observaciones   TEXT
);

-- ─── Seguimiento ─────────────────────────────────────────────────────────────

CREATE TABLE incidencia (            -- PRM, olvidos, devoluciones de blíster, errores
  id            INTEGER PRIMARY KEY,
  paciente_id   INTEGER NOT NULL REFERENCES paciente(id),
  preparacion_id INTEGER REFERENCES preparacion(id),
  tipo          TEXT NOT NULL CHECK (tipo IN
                ('prm','interaccion','duplicidad','adherencia','error_preparacion',
                 'blister_devuelto','comunicacion_medico','otro')),
  descripcion   TEXT NOT NULL,
  actuacion     TEXT,
  resultado     TEXT,
  registrado_por INTEGER NOT NULL REFERENCES usuario(id),
  registrado_en TEXT NOT NULL DEFAULT (datetime('now')),
  cerrado_en    TEXT
);

-- ─── Consentimientos y documentos firmados ───────────────────────────────────

CREATE TABLE plantilla_documento (
  id          INTEGER PRIMARY KEY,
  codigo      TEXT NOT NULL,          -- 'consentimiento_spd', 'info_rgpd', …
  version     INTEGER NOT NULL,
  titulo      TEXT NOT NULL,
  cuerpo      TEXT NOT NULL,          -- Markdown con {{variables}}
  vigente     INTEGER NOT NULL DEFAULT 1,
  creado_en   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (codigo, version)
);

CREATE TABLE documento_firmado (
  id              INTEGER PRIMARY KEY,
  id_publico      TEXT NOT NULL UNIQUE,
  paciente_id     INTEGER NOT NULL REFERENCES paciente(id),
  plantilla_id    INTEGER NOT NULL REFERENCES plantilla_documento(id),
  firmante        TEXT NOT NULL,          -- paciente o representante
  firmante_calidad TEXT NOT NULL CHECK (firmante_calidad IN ('paciente','representante_legal','guardador_de_hecho')),
  contacto_id     INTEGER REFERENCES contacto(id),
  firmado_en      TEXT NOT NULL,
  texto_impreso   TEXT NOT NULL,          -- el texto EXACTO que se imprimió
  hash_texto      TEXT NOT NULL,          -- SHA-256 del texto impreso
  escaneo         BLOB,                   -- PDF/imagen del papel firmado
  revocado_en     TEXT,
  motivo_revocacion TEXT,
  registrado_por  INTEGER NOT NULL REFERENCES usuario(id)
);

-- Derechos RGPD ejercidos (acceso, rectificación, supresión, oposición…)
CREATE TABLE solicitud_derecho (
  id            INTEGER PRIMARY KEY,
  paciente_id   INTEGER REFERENCES paciente(id),
  derecho       TEXT NOT NULL CHECK (derecho IN
                ('acceso','rectificacion','supresion','limitacion','oposicion','portabilidad')),
  recibida_en   TEXT NOT NULL,
  plazo_hasta   TEXT NOT NULL,          -- un mes, ampliable (art. 12.3 RGPD)
  respuesta     TEXT,
  respondida_en TEXT,
  registrado_por INTEGER NOT NULL REFERENCES usuario(id)
);

-- ─── Etiquetas ───────────────────────────────────────────────────────────────

CREATE TABLE plantilla_etiqueta (
  id           INTEGER PRIMARY KEY,
  nombre       TEXT NOT NULL,
  tipo         TEXT NOT NULL CHECK (tipo IN ('etiqueta','hoja_a4')),
  definicion   TEXT NOT NULL,           -- JSON (ver docs/07)
  por_defecto  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE impresora_perfil (
  id            INTEGER PRIMARY KEY,
  nombre_windows TEXT NOT NULL,          -- deviceName exacto
  plantilla_id  INTEGER REFERENCES plantilla_etiqueta(id),
  desplaz_x_mm  REAL NOT NULL DEFAULT 0, -- calibración
  desplaz_y_mm  REAL NOT NULL DEFAULT 0,
  escala        REAL NOT NULL DEFAULT 1
);

-- ─── Alertas de calidad (AEMPS) y auditoría ──────────────────────────────────

CREATE TABLE alerta_calidad (
  id          INTEGER PRIMARY KEY,
  referencia  TEXT NOT NULL,            -- p.ej. R_21/2026
  cn          TEXT,
  lote        TEXT,
  fecha       TEXT,
  descripcion TEXT,
  url         TEXT,
  importado_en TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (referencia, cn, lote)
);

-- Registro inmutable: cada fila encadena el hash de la anterior
CREATE TABLE auditoria (
  id          INTEGER PRIMARY KEY,
  momento     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  usuario_id  INTEGER REFERENCES usuario(id),
  accion      TEXT NOT NULL,            -- 'crear','modificar','ver','imprimir','exportar','login'…
  entidad     TEXT NOT NULL,
  entidad_id  TEXT,
  antes       TEXT,                     -- JSON
  despues     TEXT,                     -- JSON
  motivo      TEXT,
  hash_previo TEXT NOT NULL,
  hash        TEXT NOT NULL
);
CREATE TRIGGER auditoria_sin_update BEFORE UPDATE ON auditoria
  BEGIN SELECT RAISE(ABORT, 'La auditoría no se modifica'); END;
CREATE TRIGGER auditoria_sin_delete BEFORE DELETE ON auditoria
  BEGIN SELECT RAISE(ABORT, 'La auditoría no se borra'); END;

CREATE TABLE ajuste (                 -- clave-valor de configuración
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);

-- ─── Datos iniciales ─────────────────────────────────────────────────────────

-- Los momentos de toma NO se siembran: los define el farmacéutico en el primer
-- uso (el asistente ofrece una plantilla de partida editable).

INSERT INTO ajuste (clave, valor) VALUES ('conservacion_anios_tras_baja', '2');

INSERT INTO plantilla_blister (nombre, dias, tomas) VALUES
  ('Semanal 7 días × 4 tomas', 7, 4);
