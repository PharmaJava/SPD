# 10. Seguridad

## 10.1 Cifrado y claves (decidido)

- Base de datos con **SQLCipher** (AES-256) y una **clave de datos aleatoria
  de 256 bits**, que nunca se guarda en claro.
- La clave de datos se guarda **envuelta** con una clave derivada de la
  **contraseña de la farmacia** (scrypt, **N=2^17**, r=8, p=1; los ficheros
  antiguos con N=2^15 se siguen leyendo y se migran al desbloquear o al cambiar
  la contraseña; al LEER se acepta N≤2^18, p≤4 y un tope de memoria: fuera de
  eso, error `FICHERO_CORRUPTO` claro, nunca uno interno). La contraseña se pide
  **al arrancar el programa** y se configura en el primer uso.
- **Cambiar la contraseña ROTA la clave de datos**: clave nueva, base recifrada,
  envoltura nueva (también en la `.bak`, para que no siga abriendo con la
  contraseña antigua) y **clave de recuperación nueva**, que hay que confirmar
  tecleando tres grupos (el diálogo no se puede cerrar antes). La clave de
  recuperación anterior deja de abrir el fichero actual. Recuperar con la clave
  de recuperación (olvido de contraseña) no rota la clave.
- **Copias antiguas**: siguen abriéndose con la contraseña (o la clave de
  recuperación) de cuando se hicieron; quien las conserve y conociera esa
  contraseña puede abrirlas: guardarlas aparte o borrarlas si hay sospecha.
  **Restaurar** una copia con otra clave de datos pide SU contraseña (o su clave
  de recuperación) y la **recifra con la clave actual**, así la clave de
  recuperación vigente sigue valiendo; queda en la auditoría. Ya no se rechazan
  «copias de otra instalación»: basta con conocer sus credenciales (además de
  ser titular y escribir RESTAURAR).
- **Clave de recuperación**: en el primer uso se muestra la clave de datos en
  dos formatos y no se deja continuar hasta confirmar que se ha guardado
  (comprobación tecleando tres grupos):
  1. **Texto en grupos de 4** (Base32 con 2 caracteres de control que detectan
     erratas), para imprimir y guardar en la caja fuerte.
  2. **QR / URI `otpauth://`**, que se puede escanear con **Google
     Authenticator, Aegis, 2FAS u otra app de autenticación** para tenerla
     en el móvil.
  ⚠️ Las apps de autenticación guardan secretos pensados para códigos de 6
  cifras: **el código que enseñan no sirve**; lo que vale es el secreto, que
  se recupera exportando la entrada desde la app (y depende de que la app
  permita exportar: Google Authenticator lo permite con «Exportar cuentas»).
  Antes de fiarse de este formato hay que **probarlo con cada app** y con
  secretos de 52 caracteres; por eso el texto impreso es la copia principal
  y la app, una comodidad.
- Sin contraseña **ni** clave de recuperación, los datos son irrecuperables
  (es la propiedad que se busca). La pantalla de bloqueo lo dice.
- Implementado y probado: `src/dominio/clave-recuperacion.ts`.
- Rate limit a los intentos de contraseña (espera creciente).
- Los adjuntos (escaneos, fotos) van dentro de la base cifrada.

## 10.2 Usuarios

- Cada persona con su usuario y clave (argon2id). Nada de usuario común.
- Roles: titular (todo, incluidos ajustes y exportaciones), farmacéutico
  (preparar, **validar**, pautas), técnico (preparar, envases; **no valida** ni
  cambia pautas), administrativo (datos de contacto, consentimientos).
- **Cambio rápido de usuario** con PIN para el día a día y bloqueo por
  inactividad (5 min por defecto): en el mostrador la pantalla se queda
  abierta.
- Las acciones críticas (validar, cambiar pauta, exportar datos) piden la
  clave aunque la sesión esté abierta.

## 10.3 Auditoría

- Tabla `auditoria` encadenada por hash; sin `UPDATE` ni `DELETE`.
- Se registra: inicio y fin de sesión, apertura de la ficha de un paciente,
  cada cambio (antes/después), impresiones, exportaciones, cambios de
  ajustes.
- Al arrancar se comprueba la cadena; si está rota, aviso al titular.
- **Marcha atrás (rollback)**: junto a los datos hay un fichero `spd.estado` con
  un contador monótono (id de la última entrada de auditoría) y su hash, firmado
  con HMAC-SHA256 con una clave derivada (HKDF) de la clave de datos. Al
  desbloquear se compara; si la base es más antigua (o la historia se bifurca)
  se avisa en pantalla y se audita (`alerta_seguridad`). Restaurar una copia
  desde Ajustes lo actualiza a propósito (queda auditado). Límite: quien pueda
  borrar `spd.estado` y sustituir los datos a la vez no deja rastro.
- Los **listados de pacientes** (lectura masiva) se auditan como «consulta de
  listado» (sin el texto buscado), una vez por sesión y minuto (y tipo).
- Informe «quién ha accedido a este paciente», que es lo primero que se
  pregunta ante una queja.

## 10.4 Copias de seguridad

- Copia automática diaria **cifrada** (el fichero de SQLCipher ya lo está)
  a una carpeta elegida: disco USB, NAS. Rotación: 7 diarias, 4 semanales,
  12 mensuales. Sólo cuentan las copias con nombre propio, fecha no futura y
  cabecera `SPDDATOS`: un fichero plantado ni da por buena la copia «al día» ni
  desplaza a las verdaderas.
- Copia obligatoria **antes de cada migración** de versión.
- **Prueba de restauración** guiada desde Ajustes (una copia que nunca se ha
  restaurado no se sabe si sirve).
- Aviso en el panel si la última copia tiene más de 2 días.
- Copia en la nube: **no** por defecto. Si la farmacia la quiere, cifrada en
  el puesto antes de subirla, y con contrato con el proveedor.

## 10.5 Aplicación Electron

- `contextIsolation`, `sandbox`, sin `nodeIntegration`, CSP estricta, sin
  contenido remoto en las ventanas (lo de CIMA se pide desde el proceso
  principal y se pinta como datos, nunca como HTML ajeno).
- **Nada de datos de pacientes en el almacenamiento del renderer**: el estado de
  trabajo (cajas del día, curso de la preparación, avance del llenado, ids de
  documentos firmados) vive sólo en memoria y se vacía al bloquear y al perder la
  sesión; al arrancar se borran los restos que dejaban versiones anteriores en
  `localStorage` (sólo se conserva el aspecto/tema).
- **Impresión**: el HTML temporal va a `userData/impresion-tmp` (0700), no a
  `%TEMP%`; la sesión de impresión sólo permite leer ficheros de esa carpeta y
  `data:`; imprimir y exportar PDF se rechazan con el programa bloqueado.
- **Fuses de Electron** (`scripts/after-pack.cjs`, hook `afterPack` de
  electron-builder, sólo en `npm run dist:win`): RunAsNode=false,
  EnableNodeOptionsEnvironmentVariable=false, EnableNodeCliInspectArguments=false,
  OnlyLoadAppFromAsar=true, EnableEmbeddedAsarIntegrityValidation=true,
  EnableCookieEncryption=true. No se ha podido probar el instalador en Windows
  desde este entorno: probar el .exe resultante antes de publicar.
- IPC con lista blanca y validación de esquema en cada canal.
- Actualizaciones firmadas; el instalador firmado con certificado de código.
- Registro de errores local sin datos de pacientes.

## 10.6 Brecha de seguridad

Procedimiento en la ayuda: qué se perdió (la auditoría lo dice), a quién
afecta, notificación a la AEPD en 72 h si procede (art. 33 RGPD) y a los
afectados si hay riesgo alto (art. 34).
