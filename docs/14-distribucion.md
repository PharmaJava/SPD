# 14. Distribución del instalador (decidido: desde GitHub)

## Cómo

Cada versión es una **release de GitHub** con el instalador de Windows
(`SPD-Setup-x.y.z.exe`), su suma de comprobación SHA-256 y las notas de la
versión. Un flujo de GitHub Actions en `windows-latest` compila con
`electron-builder`, calcula el SHA-256 y sube los ficheros al etiquetar
(`git tag v0.1.0`). Se escribirá cuando exista la aplicación; ahora no hay
nada que compilar.

## ⚠️ Un repositorio privado no sirve para regalarlo

Los ficheros de una release de un repositorio **privado** sólo los descarga
quien tenga acceso al repositorio. Para que cualquier farmacia lo baje hay
que elegir una de estas opciones:

| Opción | Código | Descargas | Comentario |
|---|---|---|---|
| **A. Repo `SPD` público** | Visible | Públicas | Lo más simple. Con la licencia actual (no modificar ni vender) sería «código visible, uso gratuito», no código abierto |
| **B. Repo `SPD` privado + repo público aparte** (p. ej. `SPD-descargas`) con sólo las releases | Privado | Públicas | El Actions del repo privado publica los binarios en el público (con un token propio). Mantiene el código cerrado |

Recomendación: **B** si quieres mantener el código cerrado; **A** si no te
importa que se lea. Lo decides tú; no cambia nada del resto del diseño.

## Actualizaciones automáticas

`electron-updater` lee las releases del repositorio público. Antes de
instalar una actualización el programa **hace copia de la base** y
sólo migra el esquema si la copia ha ido bien. Las actualizaciones son
opcionales (aviso, no forzadas): en una farmacia nunca debe reiniciarse el
programa solo en mitad de una preparación.

## Confianza del usuario

- **Windows SmartScreen** avisa de «aplicación no reconocida» con
  instaladores sin firmar, y las farmacias no técnicas se asustan. Opciones:
  certificado de firma de código de pago, o servicios de firma que se ofrezcan
  a proyectos gratuitos (hay que comprobar condiciones vigentes: no he podido
  verificarlas). Mientras no haya firma, la página de descargas explica el
  aviso y muestra el SHA-256 para comprobar el fichero.
- Notas de cada versión con los cambios de esquema y qué comprobar tras
  actualizar.
- **No hay telemetría**: ni siquiera para contar descargas más allá de las que
  muestra GitHub.

## Aviso legal en el instalador

El instalador muestra `LICENSE.txt` y exige aceptarla. La primera ejecución
repite el aviso de que el programa no es un producto sanitario y de que la
farmacia es responsable de sus datos y de verificar cada preparación.
