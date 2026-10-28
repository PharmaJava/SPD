# 8. Marco legal y protección de datos

> ⚠️ **Esto es un análisis para orientar el diseño, no asesoramiento
> jurídico.** Antes de usar el programa con pacientes reales, y sobre todo
> antes de distribuirlo a otras farmacias, hay que revisarlo con un abogado
> especializado en protección de datos y sanidad, y con el Colegio de
> Farmacéuticos de la provincia. Donde abajo no se cita un artículo es
> porque no se ha podido contrastar con el texto oficial.

## 8.1 El servicio de SPD

- **No hay una ley estatal específica del SPD.** Lo regulan normas de
  algunas comunidades autónomas y documentos técnicos de referencia (el
  documento del Comité Técnico de Inspección, CTI-SPD; los procedimientos de
  SEFAC y del Consejo General de COF).
- Requisitos que se repiten y que el programa tiene que facilitar:
  - **Declaración responsable** de la farmacia ante su comunidad autónoma
    antes de empezar → se guarda fecha y referencia (`farmacia`), y el
    programa lo recuerda si falta.
  - **Sólo la farmacia que dispensa** prepara y entrega el SPD; no se encarga
    a terceros → el programa no tiene ninguna función de «enviar a preparar».
  - **Consentimiento del paciente** o su representante, incluida la
    autorización para custodiar sus medicamentos (doc 09).
  - **Procedimientos normalizados de trabajo** escritos, condiciones de la
    sala (15-25 ºC, 40-60 % HR), registro de cada preparación, trazabilidad
    de lotes, etiquetado mínimo, entrega con prospectos, validez limitada.
- Como cada comunidad pide cosas algo distintas, el programa no las
  incrusta: tiene una **lista de comprobación por comunidad autónoma**,
  editable, que se rellena cuando se contraste cada norma.

## 8.2 ¿Es el programa un producto sanitario?

El Reglamento (UE) 2017/745 (MDR) y la guía MDCG 2019-11 distinguen:
- Software que **registra, almacena, imprime o busca** datos sin
  interpretarlos → en principio **no** es producto sanitario.
- Software que **calcula dosis, detecta interacciones o recomienda
  tratamientos** para un paciente concreto → puede serlo (clase IIa o
  superior), con marcado CE, organismo notificado y vigilancia.

**Decisión de diseño para la v1:** el programa no decide nada clínico.
- La pauta la introduce un farmacéutico; el programa la reparte en el
  calendario (cálculo aritmético de lo que se le ha dicho).
- La aptitud para SPD se basa en la forma farmacéutica y la ficha técnica,
  se presenta con su fuente y **la decide el farmacéutico**.
- No hay detector de interacciones propio. Si en el futuro se quiere,
  primero se pide opinión regulatoria. Esta frontera se escribe en el propio
  programa (Acerca de) y en el contrato de uso.

## 8.3 Protección de datos (RGPD y LOPDGDD)

### Quién es quién
| Papel | Quién |
|---|---|
| **Responsable del tratamiento** | La farmacia (su titular) |
| Encargado del tratamiento | Nadie mientras los datos estén sólo en el ordenador de la farmacia. **Si el desarrollador accede a los datos** (soporte remoto, copias en su servidor) pasa a ser encargado y hace falta un contrato del art. 28 RGPD |
| Interesados | Pacientes, sus cuidadores/representantes, médicos (datos de contacto profesional), usuarios del programa |

### Datos y bases de legitimación
- Los datos de salud y la medicación son **categoría especial** (art. 9
  RGPD).
- Base plausible: la prestación de un servicio sanitario por un profesional
  sujeto a secreto (art. 9.2.h y 9.3) y la relación con el paciente que lo
  pide. Hay quien prefiere además el **consentimiento explícito** (art.
  9.2.a). **Qué base se elige lo decide la farmacia con su asesor**, y
  importa: si la base es el consentimiento y se retira, hay que dejar de
  tratar; si es la asistencia sanitaria, no. El consentimiento **del
  servicio** (doc 09) existe en cualquier caso: es otra cosa.

### Lo que el programa aporta a cada obligación
| Obligación | Qué hace el programa |
|---|---|
| Informar al interesado (art. 13) | Plantilla de información de protección de datos, imprimible y versionada |
| Minimización (art. 5.1.c) | Sólo campos de salud útiles para preparar; los opcionales se pueden ocultar |
| Exactitud | Historial de cambios; rectificación con rastro |
| Limitación del plazo | Plazo de conservación configurable y avisos de datos a eliminar |
| Seguridad (art. 32) | Cifrado de la base, usuarios, bloqueo por inactividad, auditoría, copias cifradas (doc 10) |
| Registro de actividades (art. 30) | Modelo de ficha del tratamiento «SPD» rellenado con los datos de la farmacia, para que la incluya en su registro |
| Evaluación de impacto (art. 35) | Probablemente exigible o muy recomendable (datos de salud de personas vulnerables). Se aporta un borrador con la descripción técnica del sistema |
| Derechos (arts. 15-22) | Exportación completa de un paciente (PDF legible + JSON), rectificación, bloqueo, y registro de solicitudes con su plazo de un mes |
| Brechas (art. 33) | El registro de auditoría permite saber qué se vio y quién; guía de qué hacer en 72 h |

### Conservación
No hay un plazo claro para los registros de SPD. Referencias posibles: la
normativa de la comunidad autónoma sobre SPD y la Ley 41/2002 (historia
clínica), si la farmacia considera que estos registros forman parte de ella.
**Por defecto, 5 años desde la baja** y configurable; tras el plazo, el
programa propone la eliminación y la registra. Durante el plazo, una
solicitud de supresión **bloquea** los datos (no se usan, pero se conservan
para responder ante una reclamación o una inspección).

### Personas que no pueden decidir por sí mismas
Mayores con deterioro cognitivo son el paciente típico de SPD. Desde la
reforma de la Ley 8/2021 (apoyo a personas con discapacidad) la figura
habitual es el **guardador de hecho** o la curatela, no la tutela. El
programa registra **en calidad de qué firma** cada persona
(`documento_firmado.firmante_calidad`) y qué contacto está autorizado a
recoger el blíster.

### Lo que nunca sale de la farmacia
- A CIMA: sólo CN y nombres de medicamento.
- Ninguna analítica, telemetría con datos ni IA externa sobre pacientes.
- Informes de error: sin datos de pacientes (se filtran antes de guardarse).

## 8.4 Otros frentes

| Frente | Situación |
|---|---|
| **Estupefacientes y psicótropos** | Normativa propia de custodia y registro. El programa los marca (CIMA) y avisa; si la farmacia decide no emblistarlos, se marcan «aparte» |
| **SEVeM** | La desactivación se hace en la dispensación, no aquí (doc 06) |
| **Facturación del servicio** | Si el programa emitiera facturas entraría en el reglamento de sistemas de facturación (VERI*FACTU). **Fuera del alcance**: se factura con el programa de gestión |
| **Distribución a otras farmacias** | Licencia de uso, limitación de responsabilidad, contrato de encargo si hay soporte con acceso, política de actualizaciones. Pendiente de abogado |
| **Accesibilidad** | Letra grande y braille como opciones del paciente en la etiqueta |

## 8.5 Textos de la interfaz

Mismo criterio que conveniodefarmacia.com: el programa **no afirma** lo que
corresponde decidir a un profesional. «Revisar con el prescriptor», no
«suspender». «Según la ficha técnica…», con enlace, no «este medicamento no
se puede emblistar» a secas cuando el motivo es de estabilidad discutible.
