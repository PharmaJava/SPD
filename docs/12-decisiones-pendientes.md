# 12. Decisiones

## Tomadas (28-oct-2026)

| # | Decisión | Consecuencia |
|---|---|---|
| 1 | **Se regala; licencia freeware** (gratis, redistribuible sin modificar, no vendible). Ver `LICENSE.txt` | Sin soporte ni garantía obligatorios; el texto legal hay que revisarlo con un abogado. Una farmacia es responsable de sus propios datos, no el autor |
| 2 | Interfaz: la elige el desarrollador, **bonita y sencilla** → Svelte 5 (doc 13) | |
| 3 | **Contraseña al arrancar**, configurable en el primer uso, con **clave de recuperación exportable** (texto para imprimir y URI de app de autenticación) | Doc 10 §10.1 |
| 4 | Lector e impresora: **adaptables** | Lector serie o teclado con separador configurable; impresoras por driver con perfil y calibración |
| 5 | **Ámbito nacional** (sin requisitos de una comunidad concreta) | Doc 08 |
| 12 | **DataMatrix opcional; lote y caducidad OBLIGATORIOS** en cada caja | Esquema con CHECK; `validarEntradaEnvase()` |

| 6 | **Sólo un farmacéutico (o el titular) valida** un SPD; el técnico puede preparar. El farmacéutico puede validar lo que él mismo ha preparado, con registro | Doc 03; `puedeValidar()` |
| 7 | **Validez estándar 14 días; opción de hasta 30** (no recomendada por los documentos de referencia), apagada por defecto, con justificación por preparación y marcada como desviación | `src/dominio/caducidad-spd.ts`; doc 03 y 08 |
| 8 | **Momentos de toma:** los define el farmacéutico en el primer uso (plantilla de partida editable) | Sin valores sembrados en la base |
| 9 | **Conservación tras la baja: 2 años** | A confirmar con abogado (doc 08) |
| 10 | **No se admiten cajas que traiga el paciente** | Eliminado `procedencia` del modelo |
| 13 | **Criterio estricto de «14 días»** (29-oct-2026, a raíz de un fallo reportado por un tester clínico): el SPD cubre como máximo 14 días **naturales contando el día de la preparación como el primero**. Preparado el día D con validez 14, el último día válido es **D+13**; un periodo de 15 días con validez 14 **bloquea** (`PERIODO_NO_CABE`), también si empieza el mismo día. Preparar un día antes de empezar y cubrir 14 días ya no cabe: o se prepara el mismo día, o el periodo es de 13. La misma cuenta vale para la validez ampliada (30 días → D+29) | `calcularCaducidadSpd()`; el mensaje de bloqueo lo explica; `tests/correcciones-tester.test.ts` |
| 11 | **El instalador se distribuye desde las *releases* de GitHub** de tu repositorio | Ver doc 14 |
| 14 | **Sin marca de «borrador» en los documentos** (3-nov-2026): se quita el banner de la pantalla de documentos y la marca del documento impreso/PDF (`esBorrador` desaparece del contrato). La cautela «son borradores para revisar con un abogado» queda **sólo** en Ajustes → Acerca de (aviso legal), el README y el manual | El papel que firma el paciente es solo el texto del documento. Sigue pendiente la revisión jurídica (B) |
| 15 | **Consentimientos opcionales** (3-nov-2026): ajuste «Exigir consentimientos firmados para validar», **activado por defecto**; solo el titular lo cambia, con motivo, auditado | Desactivado, lo pendiente es información y no bloquea. **La farmacia asume la responsabilidad** de gestionarlos fuera del programa. Rol, alergia, caducidad y alertas de calidad siguen bloqueando. Doc 09 §9.4 |
| 16 | **«Gestionado sin firma individual»** (3-nov-2026), por paciente y masivo por centro («Aceptar todo»): registro con origen propio, motivo obligatorio, usuario y fecha; solo titular/farmacéutico; revocable y auditado; **no se falsifica ni se imprime una firma** | Esquema v3 (`origen`, `motivo_gestion`, calidad `sin_firma`). **La farmacia asume la responsabilidad** de ese consentimiento (p. ej. recogido por la residencia). Doc 09 §9.5 |
| 17 | **Notificaciones** (3-nov-2026): tostadas que se cierran con un clic (error/atención a los 10 s si no hay ratón encima, idénticas agrupadas, «Cerrar todas»); avisos de «Hoy» con «Marcar como visto»/«Quitar»; los de **seguridad nunca se ocultan**; solo se recuerdan tipos de avisos generales, jamás nombres | `src/dominio/avisos.ts`. El asistente de preparar muestra una vez el problema que antes salía en varias cajas rojas |
| 18 | **Contraseña de arranque y PIN opcionales** (4-nov-2026): la contraseña sigue siendo la opción recomendada y por defecto, pero se puede trabajar «sin contraseña de arranque» (clave de datos envuelta con Windows/DPAPI, ligada al usuario de Windows) y se puede desactivar el PIN y/o pedir usuario al arrancar. Sólo el titular, con motivo, aviso y casilla de confirmación; todo auditado | **No protege frente a quien use la sesión de Windows.** Las copias hechas sin contraseña sólo se abren en el mismo usuario/equipo; en otro, con la clave de recuperación. Sin contraseña → con contraseña **rota** la clave de datos (clave de recuperación nueva). Con PIN activado siempre se elige usuario al arrancar. Validar exige elegir farmacéutico/titular también sin PIN. No probado con `safeStorage` real (sólo doble y Electron bajo xvfb sin almacén): **probar en Windows antes de publicar**. Doc 10 §10.1.bis, §10.2 | `tests/acceso-sin-contrasena.test.ts` |

## Pendientes

| # | Pregunta |
|---|---|
| B | Confirmar con abogado/Colegio: la validez de 30 días, los 2 años de conservación y la licencia, y **la revisión de los textos de consentimiento** (ya sin marca de borrador en pantalla; la cautela está en el aviso legal) |
| E | Confirmar con abogado: el valor de **«gestionado sin firma individual»** (consentimiento recogido por un centro) y la **responsabilidad de la farmacia** al no exigir consentimientos |
| C | Instalador sin firma de código: avisos de SmartScreen (doc 14) |
| D | ¿El repo debe ser público para publicar releases? (doc 14) |
