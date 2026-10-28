# 7. Etiquetas e impresión

## 7.1 Qué se imprime

| Documento | Formato | Contenido |
|---|---|---|
| **Etiqueta del SPD** | Etiqueta adhesiva: rollo térmico o plancha A4 | Datos mínimos del etiquetado (abajo) |
| **Hoja de plan de administración** | Folio A4 | Mapa día × toma, descripción física (y foto opcional) de cada medicamento, medicación aparte, instrucciones, lotes |
| Orden de preparación | A4 | Mapa para trabajar en la mesa, con casillas |
| Consentimientos | A4 | Doc 09 |
| Hoja de comunicación con el médico | A4 | Texto genérico con la incidencia |
| Etiqueta de custodia | Pequeña | Para la caja guardada: paciente (iniciales + id corto), CN, lote, caducidad |

## 7.2 Datos mínimos de la etiqueta del SPD

(Los del servicio descritos en conveniodefarmacia.com/spd-farmacia, según los
documentos de referencia SEFAC/CTI-SPD; **contrastar con la norma de la
comunidad autónoma**, que puede pedir más.)

- Farmacia: nombre, dirección, teléfono.
- Paciente: nombre y apellidos.
- Día y hora de cada toma.
- Nombre, dosis y **descripción física** de cada medicamento.
- Trazabilidad: **CN, lote y caducidad** de cada envase usado (y serie si se
  pide).
- Identificador del SPD (y su código).
- **Medicamentos no reacondicionados** («administrar aparte»).
- Periodo de uso (fecha inicial y final) y **caducidad del SPD**.
- Instrucciones de uso y advertencias de conservación.
- Prescriptor.
- Preparado por / validado por (iniciales) y fecha.

Si no cabe todo, la etiqueta lleva lo esencial y un **QR a la hoja A4**, que
se entrega junto al blíster con los prospectos. Opción braille (vía
impresora/servicio externo; la etiqueta indica que se ha solicitado).

## 7.2 bis Etiqueta resumida

Si las tomas del periodo (hasta 14 días) no caben en la etiqueta, **no se
recorta nada**: el bloque `tabla_tomas` con `"modo": "auto"` pasa solo al
**resumen por medicamento** y la etiqueta lleva el QR/código a la hoja A4 (el
bloque `codigo` ya existente) con el detalle de cada toma.

Una línea por medicamento, siempre con **todos** los lotes y caducidades:

```
RESUMEN DEL PERIODO · detalle de cada toma en la hoja A4 (código)
Metformina 850 mg — 2 al día — lotes: L1 (cad 05/2028), L2 (cad 11/2027) — Comprimido blanco, redondo
```

- `elegirModoEtiqueta(plantilla, tomas)` decide: tabla completa si cabe (letra
  ≥ 6 pt); si no, resumen. Devuelve `cabe:false` si ni el resumen cabe: la
  etiqueta **no es imprimible** (nunca se recorta en silencio).
- Modos de `tabla_tomas`: `"completa"` (por defecto, comportamiento histórico),
  `"resumen"` y `"auto"`. El tipo `resumen_periodo` es siempre resumen.
- Un lote con otra caducidad es otro par: no se fusionan. Si la pauta no es
  igual todos los días no se inventa un «al día»: «29 en 14 días (pauta variable)».
- El resumen sin bloque `codigo` en la plantilla **bloquea** la impresión: la
  hoja A4 no sería alcanzable.
- `PLANTILLA_DOC07_RESUMIBLE` es la plantilla de §7.3 (100×150 mm) con todo esto activado.

### Tomas ausentes, descripción física y formato

- **`unidadesEsperadas`** (opcional, en los datos de `renderizarEtiqueta`): la
  suma de unidades que dice la pauta. Si las filas de la etiqueta no suman lo
  mismo (faltan o sobran tomas), `imprimible:false`. Un valor no numérico, o
  una plantilla sin bloque de tomas, también bloquea (no se puede comprobar).
- **Descripción física**: cada medicamento de `TomaEntrada` admite
  `descripcion` (de `resumenDescripcion`). La columna `descripcion` la imprime
  si alguna toma la trae. Si falta, la etiqueta avisa (`avisos`) sin bloquear;
  con **`exigirDescripcion: true`** (en el bloque o en la plantilla) y la
  columna incluida, su ausencia es un dato faltante y bloquea.
- **`formato_es: true`** (plantilla; por defecto `false` por compatibilidad):
  en lo impreso, fechas `dd/mm/aaaa`, caducidades `mm/aaaa` y decimales con
  coma (`×0,25 (¼)`, `×1,5 (1½)`). Los datos y el contenido de los códigos no
  se tocan. Una fecha imposible se deja tal cual para que se vea.

## 7.3 Diseñador de plantillas

La plantilla es un JSON (`plantilla_etiqueta.definicion`):

```json
{
  "pagina": { "ancho_mm": 100, "alto_mm": 150, "orientacion": "vertical" },
  "plancha": null,
  "margenes_mm": [3, 3, 3, 3],
  "fuente_base_pt": 7,
  "bloques": [
    { "tipo": "texto", "x": 0, "y": 0, "w": 94, "h": 8,
      "contenido": "{{farmacia.nombre}} · {{farmacia.telefono}}", "negrita": true },
    { "tipo": "texto", "x": 0, "y": 9, "w": 94, "h": 6,
      "contenido": "{{paciente.nombre_completo}}", "tam_pt": 10 },
    { "tipo": "tabla_tomas", "x": 0, "y": 16, "w": 94, "h": 80,
      "columnas": ["medicamento","descripcion","momentos","lote_caducidad"] },
    { "tipo": "aparte", "x": 0, "y": 98, "w": 70, "h": 20 },
    { "tipo": "codigo", "simbologia": "qrcode", "x": 74, "y": 98, "w": 20, "h": 20,
      "contenido": "{{preparacion.id_publico}}" },
    { "tipo": "texto", "x": 0, "y": 120, "w": 94, "h": 20,
      "contenido": "Del {{periodo.inicio}} al {{periodo.fin}} · Caduca {{preparacion.caducidad}} · Prep. {{prep.iniciales}} / Val. {{val.iniciales}}" }
  ]
}
```

Para **planchas A4** de etiquetas en blanco (tipo Apli/Avery):

```json
"plancha": { "filas": 7, "columnas": 2, "ancho_etiqueta_mm": 99.1, "alto_etiqueta_mm": 38.1,
             "margen_sup_mm": 15.1, "margen_izq_mm": 4.65, "paso_h_mm": 101.6, "paso_v_mm": 38.1,
             "primera_libre": 1 }
```
`primera_libre` permite **aprovechar una plancha empezada**.

El editor: arrastrar bloques sobre un lienzo a escala, variables de una
lista (nunca texto libre que no se sepa resolver), vista previa con datos de
un paciente de ejemplo ficticio, y **plantillas de partida** para los
formatos más comunes.

⚠️ **Si un texto no cabe, no se corta en silencio**: el bloque reduce la letra
hasta un mínimo legible (6 pt) y, si aun así no cabe, la vista previa lo
marca en rojo y no deja imprimir la definitiva. Una etiqueta que pierde la
última línea pierde justo los avisos (lección #31 de conveniodefarmacia).

## 7.4 Cómo se imprime

- La plantilla se convierte en HTML con CSS en **milímetros** (`@page { size:
  100mm 150mm; margin: 0 }`, posiciones absolutas en `mm`).
- Electron imprime con `webContents.print({ deviceName, silent: true,
  pageSize: { width: micras, height: micras }, margins: { marginType: 'none' } })`.
- Siempre se puede **exportar a PDF** (`printToPDF`) y archivar el PDF de lo
  entregado junto a la preparación (prueba de qué etiqueta llevó).
- **Calibración por impresora** (`impresora_perfil`): desplazamiento X/Y y
  escala, con una página de prueba con reglas en mm.
- Impresoras térmicas Zebra: por driver de Windows igual que las demás
  (sencillo y suficiente); el envío directo de ZPL queda para más adelante si
  hace falta velocidad.
- Brother QL y Dymo: por driver, con el tamaño de rollo configurado.

## 7.5 Hoja A4 (sin etiquetas)

Opción por paciente: «imprimir en folio». Misma información, más espacio:
foto del comprimido de CIMA (si existe y se ha descargado), letra grande si
el paciente lo necesita, y la tabla semanal para colgar en la nevera.
