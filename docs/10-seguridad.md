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

### 10.1.bis Contraseña de arranque OPCIONAL («sin contraseña»)

La contraseña de arranque es **recomendada pero opcional** (primer uso: casilla
«Proteger con contraseña (recomendado)», marcada; Ajustes → Seguridad para
quitarla o ponerla después). Lo que cambia es **cómo se guarda la clave de
datos**; el cifrado de la base es el mismo en los dos modos.

| | Con contraseña (por defecto) | Sin contraseña de arranque |
|---|---|---|
| Fichero `spd.datos` | versión 1, `tipo: contrasena` | versión 2, `tipo: sistema` |
| La clave de datos se envuelve con | scrypt(contraseña) + AES-256-GCM | Windows (**DPAPI** vía Electron `safeStorage`), ligada al **usuario de Windows** |
| Al arrancar | pide la contraseña | abre solo (si Windows puede descifrar la clave) |
| Intentos de contraseña | espera creciente | no existen (nada que adivinar) |
| «Bloquear» / inactividad | cierra los datos | **cierra la sesión del usuario** y vuelve a «¿Quién eres?» (Windows reabriría los datos al instante); cerrar el programa sí lo cierra todo |
| Clave de recuperación | = clave de datos | = clave de datos (**igual de válida**) |

- **Qué NO protege el modo sin contraseña.** «Cualquier persona que abra
  Windows con tu usuario podrá abrir SPD y ver los datos de los pacientes. La
  base sigue cifrada en el disco, pero no protege frente a quien use tu sesión
  de Windows.» Cualquier proceso que corra como ese usuario puede pedirle a
  Windows que descifre la clave. Sí protege frente a quien se lleve el disco, el
  fichero o una copia a otro equipo u otro usuario de Windows.
- **`ProtectorClave`** (`seguridad.ts`) es la interfaz inyectada
  (`disponible`/`cifrar`/`descifrar`); la implementa
  `src/principal/protector-clave.ts` sobre `safeStorage` **sólo en el proceso
  principal** (en Linux se rechaza el respaldo `basic_text`). Los servicios no
  dependen de Electron y se prueban con un doble. Si `safeStorage` no está
  disponible el modo **no se permite** y se explica por qué (primer uso y Ajustes).
  Antes de dar nada por bueno se comprueba que lo cifrado se descifra a la misma
  clave; si no, no se escribe nada.
- **Migración, siempre con copia previa, motivo y auditoría**
  (`antes_cambio_acceso`; sin carpeta de copias no se cambia nada):
  - *Contraseña → sin contraseña*: pide la contraseña actual, motivo (≥ 5
    letras) y confirmar el aviso. **No rota** la clave de datos: la clave de
    recuperación sigue valiendo. Reescribe el fichero y su `.bak`.
  - *Sin contraseña → contraseña*: pide contraseña nueva (política de siempre) y
    motivo. **Rota** la clave de datos (mientras estuvo sin contraseña cualquier
    proceso del usuario pudo leerla) y muestra una clave de recuperación nueva.
  - El fichero `spd.estado` (HMAC con la clave de datos) conserva el contador al
    rotar; el rollback se detecta igual en ambos modos.
- **Cambiar de equipo o de usuario de Windows.** Los datos (y las **copias**
  hechas en este modo) están ligados al usuario de Windows que los creó: otro
  usuario/equipo los rechaza con «CLAVE_SISTEMA_ILEGIBLE». La salida es la
  **clave de recuperación**: `recuperar(clave)` vuelve a ligar los datos al
  usuario actual (o, si se da una contraseña nueva, pasan a modo contraseña).
  **Restaurar** una copia de este modo en otro equipo exige su clave de
  recuperación (`COPIA_SISTEMA_AJENA`, el mensaje lo dice). Con el mismo usuario
  de Windows basta con el sistema.
- Restaurar en modo sin contraseña: no hay contraseña que confirmar; basta ser
  titular y escribir RESTAURAR.
- Implementado y probado: `src/dominio/clave-recuperacion.ts`.
- Rate limit a los intentos de contraseña (espera creciente).
- Los adjuntos (escaneos, fotos) van dentro de la base cifrada.

## 10.2 Usuarios

- Cada persona con su usuario y clave (argon2id). Nada de usuario común.
- Roles: titular (todo, incluidos ajustes y exportaciones), farmacéutico
  (preparar, **validar**, pautas), técnico (preparar, envases; **no valida** ni
  cambia pautas), administrativo (datos de contacto, consentimientos).
- **Cambio rápido de usuario** con PIN para el día a día y bloqueo por
  inactividad (5 min por defecto; 0 = no bloquear): en el mostrador la pantalla
  se queda abierta.
- **PIN y elegir usuario, opcionales** (Ajustes → Seguridad → «PIN y usuarios»,
  sólo el titular, con motivo, auditado). Dos ajustes **independientes**:
  - `pedirPin` (por defecto sí). Desactivado: se elige usuario con un clic; el
    `login` queda auditado como «Entrada sin PIN».
  - `pedirUsuarioAlArrancar` (por defecto sí). Desactivado: al **abrir** los
    datos entra solo el `usuarioPredeterminadoId` (tras bloquear o por
    inactividad se vuelve a elegir). **Exige `pedirPin = false`**: si no, el
    usuario predeterminado esquivaría el PIN (el servidor rechaza la combinación).
  - **Validar sigue exigiendo un usuario con rol farmacéutico/titular
    identificado.** Sin PIN, la entrada no identifica a nadie, así que validar
    pide **elegir** al farmacéutico/titular y confirmar con un clic; la
    validación, el consumo de cajas y la auditoría quedan a **su** nombre (y el
    motivo anota quién tenía la sesión). Con PIN, valida la sesión abierta.
  - Límite honesto: sin PIN los roles dependen de la honestidad de quien elige.
    Es el coste de la comodidad; el aviso lo dice.
- Las acciones críticas (validar, cambiar pauta, exportar datos) piden la
  clave aunque la sesión esté abierta.

## 10.3 Auditoría

- Tabla `auditoria` encadenada por hash; sin `UPDATE` ni `DELETE`.
- Se registra: inicio y fin de sesión, cambios de cómo se abren los datos
  (`modificar acceso`, con motivo y nombre de la copia previa), apertura de la ficha de un paciente,
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
