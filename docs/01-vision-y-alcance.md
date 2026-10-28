# 1. Visión y alcance

## El problema

El SPD es un servicio profesional post-dispensación: la farmacia reacondiciona
la medicación sólida oral de un paciente polimedicado en blísteres sellados
por día y toma. Hoy la mayoría de farmacias lo llevan con hojas de cálculo,
el módulo básico de su programa de gestión o programas de los fabricantes de
blíster. Los puntos débiles se repiten:

| Punto débil | Consecuencia |
|---|---|
| El lote no se registra por blíster | Ante una retirada de la AEMPS no se sabe a qué pacientes afecta |
| La pauta se sobrescribe | No se sabe qué tomaba el paciente la semana pasada ni quién lo cambió |
| Cambio de laboratorio (otro genérico) | El comprimido cambia de color y forma, pero la etiqueta dice lo de antes |
| Etiquetas rígidas | Sólo funcionan con una impresora o un formato de blíster |
| Consentimientos en papel suelto | No consta qué firmó cada paciente ni cuándo |
| Datos de salud en un Excel | Sin cifrado, sin control de acceso y sin registro de quién lo mira |

## Lo que tiene que hacer el programa

1. Registrar pacientes con sus datos personales, sanitarios y de contacto.
2. Llevar la pauta de cada medicamento, editable y versionada.
3. Registrar cada envase custodiado (CN, lote, caducidad, serie), leído del
   DataMatrix o tecleado, y descontar sus unidades al preparar.
4. Generar la orden de preparación de un periodo y guiar el llenado.
5. Comprobar con el lector cada envase antes de cargarlo: que es el
   medicamento de la pauta, que no está caducado ni caduca antes del final
   del SPD y que no tiene una alerta de calidad.
6. Registrar la preparación (qué lotes, quién preparó, quién validó).
7. Imprimir etiqueta y hoja A4 con los datos mínimos del etiquetado de SPD.
8. Registrar la entrega y el seguimiento (incidencias, comunicaciones con el
   médico, cambios de tratamiento).
9. Consultar CIMA para elegir el medicamento y ver su ficha y su aspecto.
10. Imprimir y archivar los consentimientos; atender derechos RGPD.

## Para quién

- **Usuario principal:** farmacéutico/a y técnico/a de la farmacia que
  prepara SPD. Personas con poco tiempo y muchas interrupciones: el programa
  tiene que poder dejarse a medias y retomarse.
- **Escenarios:** farmacia comunitaria con 5-80 pacientes de SPD, y farmacia
  que atiende a un centro sociosanitario (residencia) con preparación por
  lotes de muchos pacientes.

## Fuera del alcance (al menos en la primera versión)

| Fuera | Por qué |
|---|---|
| Dispensación y facturación al SNS | Es del programa de gestión de la farmacia. No se duplica |
| Verificación/desactivación SEVeM del identificador único | Se hace al dispensar, en el programa de gestión (ver doc 06) |
| Conexión con la receta electrónica | Requiere los nodos autonómicos vía el Colegio; no hay acceso abierto |
| Control de robots de emblistado | Cada fabricante tiene su protocolo; posible exportación en fase posterior |
| Decidir dosis o detectar interacciones por sí solo | Convertiría el programa en producto sanitario (doc 08). Se muestran avisos con fuente, no decisiones |
| Nube | Los datos se quedan en la farmacia. Se estudia un modo LAN multipuesto (doc 02) |

## Principios de diseño

- **Lector primero:** todo lo que se pueda leer del DataMatrix no se teclea.
- **Sin conexión:** la farmacia tiene que poder preparar aunque se caiga
  internet; CIMA es una ayuda, no una dependencia.
- **Cada pantalla responde a una pregunta del mostrador:** ¿qué hay que
  preparar hoy?, ¿a quién le falta medicación?, ¿qué lleva este blíster?
- **Imprimir bien a la primera:** calibración por impresora y vista previa
  a tamaño real.
