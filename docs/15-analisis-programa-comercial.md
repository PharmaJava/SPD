# 15. Qué aprender de un programa comercial de SPD

Antonio compartió capturas del programa que usa una farmacia (un sistema
comercial de SPD con verificación por cámara). **No se copia nada**: ni la
disposición de pantallas, ni los iconos, ni los nombres. Se recogen las
funciones generales y se decide, una a una, qué hacer mejor. Las capturas
tienen nombres de pacientes y datos de una farmacia real: **no se guardan en
el repositorio**.

## Qué hace (resumen funcional)

| Área | Lo que se ve |
|---|---|
| Inicio | Cinco módulos en círculo: Preparación, Revisión, Corrección, Farmacia, Consultas. Indicador de sincronización con la nube, cambio de idioma, usuario |
| Preparación | Contador de blísteres pendientes (27); lista de pacientes con nº de blísteres; **dos blísteres a la vez** en pantalla (paciente, centro, fechas, id); rejilla días × tomas; menú: importar preparación a mano, preparaciones pendientes, filtrar, añadir lote de blísteres |
| Revisión / Corrección | Pasos aparte tras preparar; estados «revisión pendiente / finalizada» |
| Consultas | Cuatro pestañas: blísteres, albarán de entrega, **buscar por lote**, uso de medicamentos. Tabla paginada (12 por página, 338 registros) con paciente, centro, id, estado, fechas de inicio, fin y preparación; filtros; «buscar en histórico» |
| Farmacia | Datos de la farmacia y logo; usuarios; pacientes; **base de datos de medicamentos** (CN, nombre, forma, color, detalles: «ranura simple», grabado) con «crear medicamento» |
| Personalización | Planificador, tipo de blíster, **rotar 180°**, **posición inicial de preparación** (izq./dcha.), **día de inicio** (convencional / cronológico), tipo de etiqueta (impresora de rollo / A4), **campos de la etiqueta** (aspecto, lote, caducidad, nº de serie), idioma de etiquetas, mostrar el centro |
| Hardware | Recorte y propiedades de **cámara**, prueba de hardware |

## Lo que me parece acertado y adopto (a mi manera)

| Idea | Cómo queda en SPD |
|---|---|
| Flujo en etapas separadas (preparar → revisar → corregir) | Ya está: `borrador → preparado → validado → entregado → anulado`, con **validación obligatoria por un farmacéutico** y registro de quién hizo cada paso |
| Disposición configurable del blíster (rotación, sentido, día de inicio, lado de arranque) | **Implementado**: `src/dominio/disposicion-blister.ts` (15 pruebas, 4 mutaciones). Y columnas nuevas en `plantilla_blister` |
| Buscar por lote | Más: **trazabilidad inversa completa** (alerta de calidad → envases en custodia → blísteres preparados → blísteres entregados) |
| Uso de medicamentos | Informe de consumo por medicamento y periodo, con cobertura (días que le quedan a cada paciente) |
| Albarán de entrega a centros | Tablas `albaran_entrega` y `albaran_linea`: un albarán por centro con varios blísteres, quien recibe y firma |
| Etiqueta con campos elegibles | Ya está con las plantillas (doc 07). **Diferencia deliberada:** en SPD **el lote y la caducidad no se pueden quitar de la etiqueta** (son obligatorios, igual que al registrar la caja); sí son opcionales el nº de serie, el centro y la foto |
| Prueba de hardware | Pantalla de prueba del lector y de la impresora, con página de calibración |
| Datos de medicamento con forma, color y detalle | Ya está (`descripcion-fisica`), con ficha de aspecto **por estados** (ver abajo) |

## Puntos débiles que se ven en las capturas (y cómo los evito)

1. **Fichas de medicamento incompletas y con datos sueltos.** En la lista hay
   medicamentos sin color o sin forma, y algunos escritos a mano en minúscula
   («redonda», «blanco») junto a otros con la primera en mayúscula. En SPD:
   - vocabulario **cerrado** de colores, formas y detalles (no se teclea libre);
   - campo `descripcion_estado`: **sin datos → propuesta (de CIMA) →
     confirmada (por un farmacéutico)**;
   - antes de preparar con un medicamento de ficha incompleta, el programa
     lo avisa; el panel «Hoy» lista las fichas por completar.
2. **Lista de pacientes pobre** (sólo nombre y nº de blísteres). SPD enseña
   también alergias, consentimientos vigentes, cobertura de cada tratamiento,
   próxima revisión y un semáforo de «qué le falta».
3. **Los datos viajan a la nube del fabricante** (indicador de sincronización).
   Es una decisión de ellos, pero para datos de salud implica un encargado
   del tratamiento y un tercero con acceso. SPD es **local y cifrado**; no hay
   telemetría y nada sale de la farmacia (doc 08 y 10).
4. **La tabla de consultas pagina de 12 en 12** sobre 338 filas. SPD: búsqueda
   instantánea (nombre, CN, lote, id), filtros guardables, ordenación y
   exportación, sin paginar a mano.
5. **Etiqueta con lote y caducidad desactivables**: se puede imprimir un
   blíster sin trazabilidad. En SPD no.
6. **Mucho vacío y letra pequeña** en pantallas con cuadros sin contenido.
   SPD: celdas con el nombre abreviado del medicamento, **color y letra/forma**
   (accesible a daltónicos) y el siguiente alvéolo resaltado (doc 13).

## Ideas nuevas para ir más allá

- **Medicamentos parecidos en la misma toma** (mismo color y forma, o nombres
  casi iguales): aviso de «aspecto muy parecido» en la hoja de validación. Es
  una comprobación visual sobre datos ya confirmados, no una decisión clínica.
- **Nota del farmacéutico por tratamiento** (`nota_farmaceutico`): «en
  ayunas», «separar de las demás». **La escribe el farmacéutico**; el programa
  la enseña al preparar y la imprime. No deduce agrupaciones ni
  interacciones (se mantiene la frontera de producto sanitario, doc 08.2).
- **Lista de reposición**: con la cobertura de cada paciente, «a estos
  pacientes se les acaba en 10 días; pedir nueva receta». Imprimible para
  enviar al centro de salud.
- **Sustitución de genérico con aviso y reimpresión**: al entrar un CN
  distinto, el programa propone actualizar la descripción y reimprimir la hoja
  del paciente («ahora la pastilla es azul»).
- **Deshacer en la preparación** (anular la última carga de un alvéolo) y
  guardado automático del borrador.
- **Importar desde otros programas**: asistente de importación por CSV
  (pacientes, tratamientos, medicamentos con aspecto) con previsualización y
  validación, para que una farmacia que ya usa otro sistema pueda pasar sin
  teclear de nuevo; y **exportación completa** (también sirve al derecho de
  portabilidad, RGPD).
- **Modo residencia**: preparar por lotes de pacientes de un centro, albarán
  único, hoja de administración por planta/habitación.
- **Segundo blíster en paralelo** (preparar dos a la vez, como hace el
  programa de referencia): se contempla en la pantalla de preparación sin
  mezclar cajas: cada alvéolo exige escanear la caja correcta.
- **Foto de control del blíster** al validar, guardada con la preparación.

## Lo que NO adopto, y por qué

- **Verificación automática por cámara con visión artificial** (lo más
  llamativo del sistema comercial): exige cámara homologada, calibración y un
  modelo de reconocimiento por cada comprimido, con coste y mantenimiento
  altos y un riesgo clínico si se confía en él. Fase 4, como **foto archivada
  y comparación asistida opcional**, siempre con validación humana. Si se
  hace, hay que valorar si pasa a ser producto sanitario (doc 08.2).
- **Sincronización en la nube** por defecto (punto 3 arriba).
- Nombres, disposición de pantallas e iconografía: SPD tiene la suya (doc 13).
