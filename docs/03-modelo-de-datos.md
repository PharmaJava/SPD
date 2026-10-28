# 3. Modelo de datos

El DDL completo está en [`db/schema.sql`](../db/schema.sql) (comprobado:
compila en SQLite y los disparadores de la auditoría impiden modificarla).

## La idea central: tres cosas distintas que se suelen mezclar

| Concepto | Tabla | Responde a | Cambia cuando… |
|---|---|---|---|
| **Tratamiento / pauta** | `tratamiento` + `pauta_version` + `pauta_dosis` | ¿Qué toma y cómo? | Lo cambia el médico o se corrige |
| **Envase** | `envase` | ¿De qué caja sale? (CN, lote, caducidad, serie, unidades) | Se acaba una caja y entra otra |
| **Preparación** | `preparacion` + `preparacion_linea` | ¿Qué se metió en este blíster, de qué caja, quién lo hizo? | Nunca: es un registro histórico |

Separarlas es lo que permite lo que pediste: la pauta es **totalmente
editable** sin tocar los lotes, y los lotes se registran **por caja** sin
tocar la pauta. Si un paciente toma metformina 850 mg en desayuno y cena, la
línea de tratamiento es una; las cajas de 30 que van entrando son muchas.

## Tratamiento identificado por principio activo, no por marca

La línea de tratamiento se identifica por **principio activo + dosis**
(«metformina 850 mg»), con un `cn_preferente` orientativo. Así, si la
farmacia dispensa otro genérico (otro CN), el envase nuevo se asocia a la
misma línea sin rehacer la pauta.

⚠️ **Al entrar un CN distinto del anterior, el programa avisa de que el
aspecto puede cambiar** y obliga a confirmar la descripción física de ese
CN antes de preparar con él. Un paciente mayor que ve una pastilla roja donde
había una blanca deja de tomarla o la toma dos veces.

## La pauta, con versiones

- Cada cambio crea una `pauta_version` nueva con `vigente_desde`, el
  **origen** (receta, informe médico, comunicación con el médico, paciente,
  revisión farmacéutica, corrección) y quién la introdujo.
- La preparación guarda la versión usada (`preparacion_linea.pauta_version_id`):
  se puede reconstruir exactamente qué se preparó y con qué instrucciones.
- Patrones de días: diario, días de la semana, cada N días, ciclo
  (p.ej. 21 días con toma y 7 sin) y «si precisa». Los «si precisa» y los no
  emblistables **no van al blíster pero salen en la etiqueta** («administrar
  aparte»).
- `pauta_dosis` admite fracciones (0,5; 0,25). El programa sólo deja partir
  si el medicamento está marcado como **ranurado** para ello.

⚠️ **Pautas semanales de alto riesgo** (metotrexato, alendronato…): el
patrón «días de la semana» con un solo día dispara un aviso visible en la
orden de preparación. Un metotrexato puesto a diario por error es un error
grave conocido.

## Envases: el lote por caja y el consumo FEFO

- Cada caja tiene `unidades_inicio` y `unidades_restantes`.
- Al preparar, las unidades se descuentan **de la caja que caduca antes**
  (FEFO) entre las de esa línea que sigan en uso.
- Si una semana necesita 14 unidades y quedan 3 en la caja A, se toman 3 de
  A y 11 de B: el blíster lleva **los dos lotes** y la etiqueta los lista.
- Al llegar a 0 la caja pasa a `agotado`. El programa avisa **antes**:
  «a este paciente le quedan unidades para 5 días de metformina».
- `UNIQUE (cn, numero_serie)`: la misma caja no puede entrar dos veces.
- Si no se lee el DataMatrix (cajas antiguas o aportadas por el paciente),
  se teclean CN, lote y caducidad y queda `origen_lectura = 'manual'`.
- **No se admiten cajas que traiga el paciente**: toda la medicación que entra en un SPD la ha dispensado la farmacia (decisión de Antonio, 28-oct-2026). Si el paciente aparece con una caja, se dispensa de nuevo o queda fuera del blíster.

## Caducidad del SPD

```
caducidad_spd = mínimo( caducidad de cada lote incluido,
                        fecha de preparación + días de validez )
```

- **Estándar: 14 días** (documentos de referencia). Es lo que viene activado.
- **Opcional, hasta 30 días**: en la práctica algunas farmacias preparan para
  un mes aunque los documentos de referencia no lo recomiendan. El programa
  **lo permite si el titular lo activa** (`farmacia.validez_extendida_permitida`)
  y, aun así, cada preparación de más de 14 días:
  - exige una **justificación escrita** (mínimo 10 caracteres);
  - queda marcada `fuera_de_estandar` y se ve en la ficha, la etiqueta
    interna y la auditoría;
  - nunca supera los 30 días ni la caducidad del lote que antes caduque.
  El aviso del ajuste dice claramente que es una desviación asumida por la
  farmacia. El programa informa; no oculta ni bloquea.
- Implementado y probado: `src/dominio/caducidad-spd.ts`. Una preparación no
  se puede validar si su último día de administración excede la caducidad.

## Validación

**Sólo un farmacéutico (o el titular) puede validar** una preparación
(`puedeValidar(rol)`); un técnico puede preparar pero no validar. Si quien
prepara es un farmacéutico, puede validar lo que ha preparado él mismo (hay
farmacias con un solo farmacéutico); queda en la auditoría como
«validación por el mismo usuario». La regla se aplica en servicios; la base
sólo garantiza validez entre 1 y 30 días y la justificación de las
desviaciones.

## Trazabilidad inversa

Con `envase(cn, lote)` + `preparacion_linea.envase_id`, una alerta de
calidad de la AEMPS («retirada del lote X de CN Y») responde en una consulta:
qué pacientes, qué blísteres, si ya se entregaron y a quién.

## Auditoría encadenada

Cada escritura añade una fila con el estado antes/después y un `hash` que
incluye el de la fila anterior: borrar o editar una fila rompe la cadena y el
programa lo detecta al arrancar. Los disparadores impiden `UPDATE` y
`DELETE` desde SQL.

Se audita también la **lectura** de la ficha de un paciente (quién la abrió),
porque en datos de salud el acceso indebido es la brecha más común.

## Lo que deliberadamente NO se guarda

- La historia clínica completa: sólo los datos de salud **necesarios** para
  preparar con seguridad (alergias, disfagia, función renal…). Minimización.
- El DNI dentro de ningún código impreso: los QR llevan el UUID.
