# CLAUDE.md — SPD

Programa de escritorio para Windows que gestiona el servicio de **Sistema
Personalizado de Dosificación** de una oficina de farmacia. Autor: Antonio
(farmacéutico y programador). Proyecto hermano de conveniodefarmacia.com;
**no comparten código ni base de datos**.

## Reglas que no se negocian

1. **Seguridad del paciente antes que comodidad.** Ante la duda, el programa
   **bloquea y pregunta**; nunca adivina un lote, una dosis ni un medicamento.
2. **Nada clínico se inventa.** Las dosis, la pauta y la descripción física
   las introduce o confirma un farmacéutico. Lo que venga de CIMA se enseña
   con su fuente y se puede corregir; no se aplica solo.
3. **Datos de salud = categoría especial (art. 9 RGPD).** Base de datos
   cifrada, acceso con usuario, todo cambio auditado. Nunca se manda un dato
   de paciente a un servicio externo (ni a una IA, ni a analítica, ni a
   CIMA: a CIMA sólo van códigos nacionales y nombres de medicamento).
4. **El historial no se borra, se versiona.** Pautas, envases, preparaciones
   y entregas guardan quién, cuándo y por qué. Un dato corregido deja rastro.
5. **Lógica de dominio pura** en `src/dominio/`: sin acceso a disco, red ni
   interfaz. Es lo que se prueba y lo que no puede tener dos copias.
6. **Textos legales genéricos**: sin la marca del programa en los
   documentos que firma el paciente, sin citar artículos que no se hayan
   contrastado con el BOE/boletín autonómico. Los consentimientos son
   **borradores para revisar con un abogado**.
7. **Español** en código, comentarios, interfaz y documentación.

## Pruebas

`npm test` (Node ≥ 22.18: los `.ts` se ejecutan sin compilar).
Cada módulo de `src/dominio/` lleva su prueba. Una mutación que rompa la
regla tiene que hacer fallar la prueba.

## Lecciones heredadas de conveniodefarmacia.com que aplican aquí

- **El dígito de control del CN no se valida** (sólo se lee): una fórmula sin
  contrastar rechaza CN buenos y un rechazo es un medicamento que no entra.
- **El `cn` de los datos de la AEMPS puede ser el nº de registro**: en el
  listado de alertas de calidad, `cn` era el NR y el CN venía por lote.
  Comprobar cada campo de CIMA contra un caso real antes de fiarse.
- **Un 200 sin datos no es un éxito**: si CIMA responde vacío, se dice.
- **Comprobar el código, no el comentario que lo describe.**
