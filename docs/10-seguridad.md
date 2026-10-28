# 10. Seguridad

## 10.1 Cifrado

- Base de datos con **SQLCipher** (AES-256). La clave se deriva con
  **Argon2id** de una **contraseña de la farmacia** que se pide al arrancar,
  o se guarda protegida con **DPAPI de Windows** (`safeStorage` de Electron)
  ligada a la cuenta de Windows del puesto. Lo segundo es más cómodo; lo
  primero aguanta el robo del ordenador con la sesión de Windows abierta.
  Decisión en doc 12.
- **Clave de recuperación** impresa al instalar (24 palabras), para guardar
  en la caja fuerte. Sin ella, una contraseña olvidada es la pérdida de
  todos los datos.
- Los adjuntos (escaneos, fotos) van dentro de la base cifrada, no sueltos
  en disco.

## 10.2 Usuarios

- Cada persona con su usuario y clave (argon2id). Nada de usuario común.
- Roles: titular (todo, incluidos ajustes y exportaciones), farmacéutico
  (preparar, validar, pautas), técnico (preparar, envases; no valida ni
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
- Informe «quién ha accedido a este paciente», que es lo primero que se
  pregunta ante una queja.

## 10.4 Copias de seguridad

- Copia automática diaria **cifrada** (el fichero de SQLCipher ya lo está)
  a una carpeta elegida: disco USB, NAS. Rotación: 7 diarias, 4 semanales,
  12 mensuales.
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
- IPC con lista blanca y validación de esquema en cada canal.
- Actualizaciones firmadas; el instalador firmado con certificado de código.
- Registro de errores local sin datos de pacientes.

## 10.6 Brecha de seguridad

Procedimiento en la ayuda: qué se perdió (la auditoría lo dice), a quién
afecta, notificación a la AEPD en 72 h si procede (art. 33 RGPD) y a los
afectados si hay riesgo alto (art. 34).
