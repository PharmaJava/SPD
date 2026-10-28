# 6. DataMatrix y lectores

> **El DataMatrix es opcional; el lote y la fecha de caducidad son obligatorios.** Sin lector (o si la caja no lo trae) se teclean. Nunca se guarda una caja sin lote o sin caducidad.

Implementado y probado en [`src/dominio/gs1.ts`](../src/dominio/gs1.ts)
(`npm test`).

## 6.1 Qué lleva el código de una caja

Desde 2019 (Reglamento Delegado (UE) 2016/161, dispositivos de seguridad)
los medicamentos con receta llevan un DataMatrix GS1 con el identificador
único:

| AI | Contenido | Longitud |
|---|---|---|
| (01) | GTIN: en España `0` + `847000` + **CN (6)** + control | 14 fija |
| (17) | Caducidad AAMMDD (día `00` = último del mes) | 6 fija |
| (10) | Lote | hasta 20, variable |
| (21) | Número de serie | hasta 20, variable |
| (712) | Código nacional (NHRN de España), sólo si el fabricante lo incluye | variable |

Los campos variables terminan con el carácter **GS** (ASCII 29) salvo el
último. El orden de los campos no es fijo.

Los medicamentos sin receta suelen llevar sólo el código de barras lineal
(EAN-13 `847000` + CN + control): de ahí sale el CN, pero **el lote y la
caducidad se teclean**.

## 6.2 Lo que hace el lector del programa

1. Quita el identificador de simbología (`]d2`) y el FNC1 inicial.
2. Sustituye los separadores alternativos configurados (ver 6.3) por GS.
3. Prueba **todas** las formas de partir la cadena en campos conocidos y se
   queda con las que tienen un GTIN con dígito de control correcto y una
   caducidad válida.
4. Si queda **más de una** (falta el GS entre lote y serie), marca la
   lectura como **ambigua** y no elige: la pantalla enseña las candidatas y
   pide confirmar el lote mirando la caja.
5. Saca el CN del GTIN. El dígito de control **del CN** no se valida.

## 6.3 Lectores: la trampa del separador y del teclado

| Modo del lector | Ventaja | Problema | Qué hacer |
|---|---|---|---|
| **Puerto serie virtual (USB-COM)** | Llega la cadena exacta, con GS | Hay que activarlo en el lector (código de configuración del manual) | **Recomendado.** El programa lo lee con `serialport` |
| Teclado (HID) | Funciona sin configurar | El GS no es una tecla: se pierde o sale otro carácter. Con el teclado en español, algunos símbolos del lote cambian | Programar el lector para que envíe el GS como un carácter que no aparezca en lotes (p.ej. `~`) y configurarlo en Ajustes |

Pantalla de **prueba del lector** en Ajustes: se escanea una caja y el
programa enseña los bytes recibidos, si llegó el GS y qué ha entendido.

Lectores probables: Zebra DS2208, Honeywell Voyager 1470g/1472g, Datalogic
QuickScan. Todos tienen modo USB-COM; hay que comprobarlo con el modelo que
compre la farmacia (fase 1, lista de hardware probado).

## 6.4 SEVeM: lo que este programa NO hace

En España la verificación y desactivación del identificador único se hace al
**dispensar**, desde el programa de gestión de la farmacia conectado al
nodo SEVeM. El programa de SPD **no desactiva** nada: lee el código para
registrar CN, lote, caducidad y serie, y comprobar que la misma caja no entra
dos veces. El programa **no admite cajas que traiga el paciente**: sólo medicación
dispensada por la farmacia.

## 6.5 Generar códigos en las etiquetas

La etiqueta lleva un **QR o DataMatrix propio** con el identificador del SPD
(`preparacion.id_publico`, un UUID), **nunca datos personales**. Al
escanearlo en la farmacia se abre la preparación: contenido, lotes, quién la
preparó. Librería prevista: `bwip-js` (genera DataMatrix/QR en SVG, sin red).

## 6.6 Lector adaptable (decidido: no se fija un modelo)

Ajustes → Lector, con asistente y prueba:
- **Modo:** teclado (por defecto, funciona con cualquier lector) o puerto
  serie (elegir COM, velocidad, terminador).
- **Separador** que el lector manda en lugar de GS (o ninguno), prefijo y
  sufijo a quitar, y distribución de teclado (los lectores en modo teclado
  mandan teclas, no caracteres: con el teclado en español, símbolos como `-`
  o `/` pueden cambiar).
- La prueba enseña los bytes recibidos y lo que se ha entendido, para poder
  ajustar sin conocer el lector. Si una lectura sale ambigua, el programa lo
  dice (6.2) en vez de adivinar.
