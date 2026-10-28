# 12. Decisiones

## Tomadas (28-oct-2026)

| # | Decisión | Consecuencia |
|---|---|---|
| 1 | **Se regala; licencia freeware** (gratis, redistribuible sin modificar, no vendible). Ver `LICENSE.txt` | Sin soporte ni garantía obligatorios; el texto legal hay que revisarlo con un abogado. Una farmacia es responsable de sus propios datos, no el autor |
| 2 | Interfaz: la elige Claude, **bonita y sencilla** → Svelte 5 (doc 13) | |
| 3 | **Contraseña al arrancar**, configurable en el primer uso, con **clave de recuperación exportable** (texto para imprimir y URI de app de autenticación) | Doc 10 §10.1 |
| 4 | Lector e impresora: **adaptables** | Lector serie o teclado con separador configurable; impresoras por driver con perfil y calibración |
| 5 | **Ámbito nacional** (sin requisitos de una comunidad concreta) | Doc 08 |
| 12 | **DataMatrix opcional; lote y caducidad OBLIGATORIOS** en cada caja | Esquema con CHECK; `validarEntradaEnvase()` |

| 6 | **Sólo un farmacéutico (o el titular) valida** un SPD; el técnico puede preparar. El farmacéutico puede validar lo que él mismo ha preparado, con registro | Doc 03; `puedeValidar()` |
| 7 | **Validez estándar 14 días; opción de hasta 30** (no recomendada por los documentos de referencia), apagada por defecto, con justificación por preparación y marcada como desviación | `src/dominio/caducidad-spd.ts`; doc 03 y 08 |
| 8 | **Momentos de toma:** los define el farmacéutico en el primer uso (plantilla de partida editable) | Sin valores sembrados en la base |
| 9 | **Conservación tras la baja: 2 años** | A confirmar con abogado (doc 08) |
| 10 | **No se admiten cajas que traiga el paciente** | Eliminado `procedencia` del modelo |
| 11 | **El instalador se distribuye desde las *releases* de GitHub** de tu repositorio | Ver doc 14 |

## Pendientes

| # | Pregunta |
|---|---|
| B | Confirmar con abogado/Colegio: la validez de 30 días, los 2 años de conservación y la licencia |
| C | Instalador sin firma de código: avisos de SmartScreen (doc 14) |
| D | ¿El repo debe ser público para publicar releases? (doc 14) |
