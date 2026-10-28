# 5. Integración con la AEMPS (CIMA)

CIMA (Centro de Información online de Medicamentos de la AEMPS) tiene una
**API REST pública y gratuita**, sin clave, que devuelve JSON. La
documentación oficial es un PDF enlazado desde la propia web de CIMA
(«CIMA REST API»).

> ⚠️ **Contrastar antes de programar.** Desde el entorno donde se escribió
> este documento CIMA no era accesible (proxy). Las rutas y campos de abajo
> son los conocidos de la API v1 y **hay que comprobarlos contra el PDF
> oficial y contra respuestas reales** antes de escribir el cliente. La
> lección de conveniodefarmacia: el campo `cn` de un listado de la AEMPS
> resultó ser el número de registro.

## 5.1 Qué se usa y para qué

| Necesidad | Ruta (base `https://cima.aemps.es/cima/rest/`) | Qué se extrae |
|---|---|---|
| Buscar por nombre / principio activo | `medicamentos?nombre=…` · `medicamentos?practiv1=…` (paginado) | Lista para elegir |
| Ficha de una presentación por CN | `medicamento?cn=XXXXXX` | Nombre, laboratorio, PA y cantidades, forma farmacéutica, vía, receta, comercializado, documentos, fotos |
| Presentaciones | `presentaciones?cn=…` / `presentacion/{cn}` | Nombre de la presentación (de ahí las unidades: «30 comprimidos») |
| Problemas de suministro | `psuministro?cn=…` | Aviso de desabastecimiento |
| Descripción del comprimido | `docSegmentado/contenido/1?nregistro=…&seccion=3` | Texto de la sección 3 de la ficha técnica («Forma farmacéutica») |
| Fotos | campo `fotos[]` de `medicamento` (tipos `formafarmac` = el comprimido, `materialas` = el envase) | Imagen para la validación y, opcionalmente, para la hoja A4 |

## 5.2 Color, forma y marcas del comprimido

CIMA **no tiene campos estructurados** de color o forma. Hay dos fuentes:

1. **La sección 3 de la ficha técnica**, que suele decir algo como
   «comprimidos recubiertos con película, blancos, oblongos, biconvexos, con
   ranura en una cara y grabado “M 850”».
2. **La foto** `formafarmac`, cuando el laboratorio la ha subido (no siempre).

El programa:
- Descarga la sección 3 y **propone** color, forma, ranura y grabado con un
  analizador sencillo de palabras (lista cerrada de colores y formas).
- Enseña el texto original al lado.
- **Un farmacéutico confirma o corrige**; se guarda quién y cuándo
  (`descripcion_confirmada_por/en`). Hasta entonces, la etiqueta no puede
  incluir esa descripción y la preparación avisa.

⚠️ La ranura de la ficha técnica a veces es **sólo para facilitar la
deglución, no para dividir la dosis**; la ficha lo dice. El campo `ranurado`
significa «divisible en dosis iguales» y lo marca el farmacéutico.

## 5.3 Aptitud para SPD

Se porta a TypeScript el motor `calculos/spd.js` de conveniodefarmacia.com
(reglas por forma farmacéutica: efervescentes, sublinguales,
bucodispersables, liberación modificada, líquidos, termolábiles…) y se le da
como entrada la **forma farmacéutica de CIMA** además del nombre. Resultado:
`apto · precaucion · no_apto` con motivo. El farmacéutico puede corregirlo
(`spd_decidido_por`), y su decisión manda sobre la del motor.

Fuentes de criterio para los casos dudosos: ficha técnica (conservación en
el envase original, sensibilidad a la luz/humedad), BOT PLUS y la guía del
NHS SPS. El programa enlaza, no copia.

## 5.4 Avisos que se pueden derivar de CIMA (informativos, con fuente)

- No comercializado / anulado.
- Problemas de suministro.
- Estupefaciente o psicótropo (condiciones de custodia y registro).
- Medicamento con triángulo negro (seguimiento adicional).
- Afecta a la conducción.

No se calculan interacciones propias en la v1 (doc 08, producto sanitario).

## 5.5 Sin conexión y caché

- Cada CN consultado se guarda en `medicamento` con la respuesta cruda
  (`cima_json`) y la fecha. Se refresca si tiene más de 30 días y hay red.
- **Nomenclátor de prescripción**: la AEMPS publica un fichero descargable
  con todo el catálogo prescribible. Importarlo periódicamente permite
  buscar sin conexión. (Comprobar formato y licencia de reutilización antes.)
- Si CIMA no responde, el programa lo dice y permite alta manual del
  medicamento (`creado_manual = 1`), que queda marcada para revisar.

## 5.6 Cortesía con el servicio

- Tiempo de espera de 8 s, reintento único, y nunca más de unas pocas
  peticiones por segundo.
- Las búsquedas se lanzan tras dejar de teclear (300 ms), no en cada tecla.
- **A CIMA sólo viajan códigos nacionales y nombres de medicamento.** Nunca
  un dato del paciente.

## 5.7 Alertas de calidad

Las retiradas de lotes no están en la API de CIMA; se publican en la web de
la AEMPS. conveniodefarmacia.com ya las lee y las guarda (tablas
`aemps_alertas` y `aemps_alertas_lotes`, con CN y lotes por presentación).
Opción para fase posterior: que el programa descargue ese índice público
(sólo CN y lotes, nada del paciente sale de la farmacia) y cruce **en local**
con los envases en custodia. Mientras tanto, importación manual.
