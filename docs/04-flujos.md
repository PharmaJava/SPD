# 4. Flujos de trabajo

## 4.1 Alta de un paciente

1. **Evaluación de idoneidad** (port del evaluador de conveniodefarmacia:
   nº de medicamentos, tomas, olvidos, autonomía, deterioro cognitivo…). Se
   guarda el resultado y quién la hizo.
2. Datos personales, tarjeta sanitaria y contactos (cuidador, representante,
   médico de cabecera = prescriptor por defecto).
3. Datos de salud relevantes (alergias, disfagia, función renal).
4. **Consentimientos**: se imprimen, se firman y se registra la firma
   (doc 09). Sin el consentimiento del servicio registrado **no se puede
   validar ninguna preparación** de ese paciente.
5. Revisión del tratamiento: se dan de alta las líneas y sus pautas. Para cada
   medicamento se consulta CIMA y el motor de aptitud (doc 05).
6. Comprobación de uso con un blíster de prueba (se registra el resultado).

## 4.2 Entrada de un envase (el flujo más repetido)

```
Escanear DataMatrix ─► leer GS1 (CN, lote, caducidad, serie)
      │
      ├─ ¿CN conocido en el catálogo local?  no ─► consultar CIMA y guardar
      ├─ ¿Caducado o caduca antes de N días? ─► AVISO, no se admite sin confirmar
      ├─ ¿Lote con alerta de calidad?        ─► BLOQUEO
      ├─ ¿Nº de serie ya registrado?         ─► BLOQUEO (caja duplicada)
      ├─ ¿A qué línea de tratamiento va?      ─► se propone por principio activo y dosis
      ├─ ¿CN distinto del último de esa línea? ─► confirmar descripción física
      └─ Unidades del envase (de CIMA, editable) ─► guardar
```

Si no hay lector o no se lee: entrada manual con los mismos controles.

## 4.3 Preparar un periodo

1. **Panel «Hoy»**: pacientes con blíster que empieza en los próximos días,
   pacientes a los que les faltan unidades, envases que caducan.
2. Elegir paciente(s) y periodo (normalmente 7 días). En residencias,
   preparación por lotes de pacientes.
3. El programa calcula, con la pauta vigente de cada día:
   - el **mapa del blíster** (día × toma → medicamentos y unidades);
   - de qué envase sale cada unidad (FEFO);
   - si falta medicación → no deja continuar hasta que se añada un envase o
     se marque la toma como pendiente con motivo;
   - la caducidad del SPD (14 días; hasta 30 con el ajuste activo y justificación);
   - los avisos: fracciones, pautas semanales, medicamentos con precaución,
     cambio de aspecto.
4. **Orden de preparación** en pantalla y opcionalmente impresa (hoja de
   trabajo con el mapa, para trabajar en la mesa).
5. **Llenado guiado por medicamento**: se escanea la caja → el programa
   resalta en el mapa los alvéolos donde va y cuántas unidades → se confirma.
   Escanear una caja que no corresponde **pita y bloquea**.
6. Registro de temperatura y humedad de la sala.
7. Estado `preparado`.

## 4.4 Validar (segunda persona)

Un farmacéutico (o el titular) revisa el blíster contra el mapa (con la descripción física y
la foto de cada comprimido en pantalla) y valida con su usuario. Un técnico no puede validar. Hasta
entonces **no se puede imprimir la etiqueta definitiva** (sí un borrador con
marca de agua «SIN VALIDAR»).

## 4.5 Etiquetar y entregar

- Etiqueta en el blíster (y/o hoja A4 de plan de administración).
- Registro de la entrega: a quién (paciente o contacto autorizado), quién
  entrega, prospectos entregados, firma opcional en tableta.

## 4.6 Cambio de tratamiento a mitad de periodo

1. Se crea una versión nueva de la pauta con su origen.
2. El programa detecta los blísteres **ya preparados o entregados** que
   cubren fechas afectadas y lo dice: «el blíster SPD-xxxx, entregado el
   lunes, contiene la pauta anterior del jueves al domingo».
3. Opciones: rehacer el blíster (se anula el anterior con motivo y las
   unidades sin usar vuelven, si procede, a su envase), o registrar
   instrucciones al paciente. Nada se cambia en silencio.

## 4.7 Alerta de calidad de la AEMPS

1. Se importa la alerta (manual o, en fase posterior, desde la fuente de
   alertas que ya lee conveniodefarmacia.com).
2. Consulta inversa: envases afectados en custodia, blísteres preparados,
   blísteres entregados con ese lote.
3. Lista de actuación: retirar envases (`estado = 'retirado'`), rehacer
   blísteres, avisar a pacientes. Cada acción queda registrada.

## 4.8 Baja del paciente

- Motivo (fin del servicio, ingreso, fallecimiento, cambio de farmacia).
- Envases en custodia: devolver al paciente (con recibí) o a SIGRE.
- Los datos **no se borran**: se bloquean durante **2 años** desde la baja
  (doc 08) y después se eliminan con registro.

## 4.9 Revisión periódica

Cada paciente tiene una fecha de próxima revisión del tratamiento (por
defecto, semestral) que sale en el panel. Las incidencias (PRM, comunicaciones
con el médico) se registran en `incidencia` y se pueden imprimir como hoja de
comunicación con el prescriptor (texto genérico, sin diagnósticos inventados).
