# 13. Interfaz: bonita y sencilla

**Decisión: Svelte 5 + CSS propio, sin librería de componentes pesada.**
Motivo: muchas pantallas de formulario con estado, un compilador que genera
JS pequeño, y control total del aspecto.

## Principios

1. **Una tarea por pantalla, con el siguiente paso evidente.** Un único botón
   principal por pantalla; el resto, secundarios.
2. **Teclado y lector primero.** El foco vive en el campo de escaneo; no hay
   que tocar el ratón para ir de caja en caja. Atajos visibles.
3. **Pensada para el mostrador:** interrupciones constantes. Todo se guarda
   solo como borrador y se retoma donde se dejó.
4. **Nada de jerga informática.** «Entrada de cajas», no «alta de lote».
5. **Los avisos clasifican por gravedad con color Y icono Y texto** (no sólo
   color): bloqueo (rojo), atención (ámbar), informativo (gris-azul).
6. **Letra grande por defecto** (16-17 px base), alto contraste, modo claro y
   oscuro, objetivos táctiles ≥ 44 px por si hay pantalla táctil.
7. **Español, sin tecnicismos del esquema:** «paciente», «caja», «blíster».

## Estructura

- **Barra lateral fija** con cinco destinos: **Hoy · Pacientes · Cajas ·
  Preparar · Ajustes** (+ buscador global arriba: nombre, CN o lote).
- **Hoy** (inicio): tarjetas de lo que requiere acción — preparar esta
  semana, faltan unidades, caducan pronto, alertas de calidad, copia de
  seguridad atrasada.
- **Ficha del paciente** con pestañas: Resumen · Tratamiento · Cajas ·
  Blísteres · Documentos · Historial. La cabecera lleva siempre alergias y
  consentimientos vigentes.
- **Preparar:** asistente de tres pasos (Revisar → Llenar → Validar) con el
  mapa del blíster como protagonista y el siguiente alvéolo resaltado.
- **Entrada de cajas:** una sola pantalla grande con el campo de escaneo y la
  lista de lo leído; confirmar con Intro.

## Estilo visual

- Paleta sobria: fondo claro cálido, azul-verdoso sanitario como acento,
  estados semánticos reservados para avisos. Tipografía del sistema
  (Segoe UI Variable en Windows) para que cargue al instante y sin red.
- Tarjetas con esquinas suaves, mucho aire, iconos lineales (Lucide, empaquetados
  localmente).
- Mapa del blíster: rejilla día × toma con un color por medicamento **más una
  letra/forma** (accesible a daltónicos).
- Animaciones mínimas (sólo para dar continuidad), respetando «reducir
  movimiento».

## Accesibilidad

Navegación completa con teclado, etiquetas para lectores de pantalla, foco
visible, contraste AA, tamaño de letra ajustable en Ajustes.

## Primera ejecución (asistente)

Bienvenida → datos de la farmacia → **contraseña** → **clave de recuperación**
(impresa/guardada; no se continúa hasta confirmar que se ha guardado, con una
comprobación tecleando 3 grupos) → impresora y lector (con prueba) → **momentos
de toma (los define el farmacéutico; hay una plantilla de partida editable, p. ej. desayuno, comida, cena, acostarse)**
→ listo.
