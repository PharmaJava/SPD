# 11. Hoja de ruta

Sin fechas: cada fase termina cuando sus pruebas pasan y se ha usado con
pacientes ficticios en la farmacia.

## Fase 0 — Diseño (esta)
- [x] Visión, arquitectura, modelo de datos, flujos, legal, consentimientos
- [x] Esquema SQLite compilado
- [x] Lector GS1 del DataMatrix con pruebas
- [ ] Decisiones de doc 12 respondidas por Antonio
- [ ] Revisión de los borradores legales con abogado y Colegio

## Fase 1 — Núcleo de dominio (sin interfaz)
Todo en `src/dominio/`, puro y probado:
- Calendario de pauta: de una `pauta_version` a «qué unidades, qué día, qué
  toma» (diario, días de semana, cada N días, ciclos, fracciones).
- Consumo FEFO de envases y aviso de unidades que faltan / días de cobertura.
- Caducidad del SPD.
- Motor de aptitud (port de `calculos/spd.js` de conveniodefarmacia).
- Analizador de la sección 3 de la ficha técnica (color, forma, grabado).
- Motor de plantillas de etiqueta: JSON → HTML en mm, con detección de
  desbordamiento.
- Cadena de hash de la auditoría.

## Fase 2 — Aplicación mínima usable (un puesto)
- Esqueleto Electron, base cifrada, migraciones, usuarios y sesión.
- Ajustes de la farmacia, momentos de toma, plantillas de blíster.
- Pacientes, contactos, datos de salud.
- Catálogo con CIMA y caché.
- Tratamientos y pautas versionadas.
- Entrada de envases con lector (serie y teclado) y pantalla de prueba.
- Preparación guiada, validación, etiqueta y hoja A4, entrega.
- Consentimientos imprimibles.
- Copias de seguridad.
- Instalador firmado y actualizaciones.

## Fase 3 — Lo que hace que se prefiera a la competencia
- Panel «Hoy» (qué preparar, qué falta, qué caduca).
- Cambio de tratamiento a mitad de periodo con detección de blísteres
  afectados.
- Alertas de calidad: importación y consulta inversa por lote.
- Diseñador visual de etiquetas y calibración por impresora.
- Modo residencia: preparación y entrega por lotes de pacientes, hoja de
  entrega para el centro.
- Exportación RGPD de un paciente, solicitudes de derechos, purga por plazo.
- Informes: pacientes activos, preparaciones por semana, incidencias.

## Fase 4 — Ideas para más adelante
- **Multipuesto** en la LAN (un puesto servidor).
- **Tableta de firma** y firma en pantalla.
- **Recordatorio al paciente** (SMS/WhatsApp) del día de recogida — implica
  enviar el teléfono a un proveedor: contrato de encargado y consentimiento.
- **Importar la hoja de tratamiento** (PDF del plan de medicación del SNS)
  con lectura asistida, siempre confirmada por el farmacéutico.
- **Foto del blíster preparado** con una cámara cenital, archivada con la
  preparación (prueba de lo entregado).
- **Exportación a robots de emblistado** (formato del fabricante).
- Integración con el programa de gestión de la farmacia (exportar/importar
  pacientes y dispensaciones por fichero) si algún fabricante lo permite.
- Revisión del tratamiento asistida (criterios STOPP/START, carga
  anticolinérgica) — **sólo tras opinión regulatoria** (doc 08.2).
- Versión para centros sociosanitarios con registro de administración
  (quién dio cada toma).
- Indicadores del servicio para presentar al Colegio o a la consejería.
