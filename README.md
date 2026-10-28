# SPD — Gestión de Sistemas Personalizados de Dosificación

Programa de escritorio para **Windows** con el que una oficina de farmacia
gestiona su servicio de SPD de principio a fin:

- **Pacientes**: datos personales, tarjeta sanitaria, contactos (cuidador,
  residencia, médico), datos de salud relevantes (alergias, diagnósticos,
  observaciones) y consentimientos firmados.
- **Tratamientos**: pauta totalmente editable (dosis, tomas, días, ciclos,
  «si precisa», no emblistable) con historial de versiones.
- **Envases custodiados**: cada caja que entra se registra con su **código
  nacional, lote, caducidad y número de serie**, leídos del **DataMatrix**.
  Cuando se acaban sus unidades se añade la siguiente (mismo CN u otro).
- **Preparación**: orden de llenado por alvéolo, comprobación con lector,
  doble validación y registro de qué lote fue a qué blíster (trazabilidad).
- **Etiquetas** personalizables para cualquier impresora y tamaño de etiqueta
  en blanco, y **hoja A4** de plan de administración.
- **Consulta a la AEMPS (CIMA)**: buscar el medicamento, ver su ficha, su
  foto y la descripción física del comprimido (color, forma, marcas).
- **Legal**: consentimientos del servicio y de protección de datos
  imprimibles, registro de auditoría, copias cifradas, derechos RGPD.

> **Programa gratuito (freeware)**: ver [LICENSE.txt](LICENSE.txt). Ámbito: España (nacional).

> Estado: **fase de diseño**. Lo escrito hasta ahora es la especificación
> (`docs/`), el esquema de base de datos (`db/schema.sql`), las plantillas de
> consentimiento y el primer módulo de dominio con pruebas (lectura de
> DataMatrix GS1).

## Documentación

| Fichero | Qué contiene |
|---|---|
| [docs/01-vision-y-alcance.md](docs/01-vision-y-alcance.md) | Qué es, para quién, qué entra y qué no |
| [docs/02-arquitectura.md](docs/02-arquitectura.md) | Decisión de stack y por qué (ADR) |
| [docs/03-modelo-de-datos.md](docs/03-modelo-de-datos.md) | Entidades y reglas; el DDL está en `db/schema.sql` |
| [docs/04-flujos.md](docs/04-flujos.md) | Alta, envases, preparación, validación, entrega, cambios |
| [docs/05-aemps-cima.md](docs/05-aemps-cima.md) | Integración con CIMA y uso sin conexión |
| [docs/06-datamatrix.md](docs/06-datamatrix.md) | Lectura GS1, lectores, trampas |
| [docs/07-etiquetas-e-impresion.md](docs/07-etiquetas-e-impresion.md) | Diseñador de etiquetas, impresoras, hoja A4 |
| [docs/08-legal-y-rgpd.md](docs/08-legal-y-rgpd.md) | Marco legal del SPD y protección de datos |
| [docs/09-consentimientos.md](docs/09-consentimientos.md) | Documentos que se imprimen y firman |
| [docs/10-seguridad.md](docs/10-seguridad.md) | Cifrado, usuarios, auditoría, copias |
| [docs/11-roadmap.md](docs/11-roadmap.md) | Fases de desarrollo |
| [docs/12-decisiones-pendientes.md](docs/12-decisiones-pendientes.md) | Decisiones tomadas y pendientes |
| [docs/13-interfaz.md](docs/13-interfaz.md) | Diseño de la interfaz |
| [docs/14-distribucion.md](docs/14-distribucion.md) | Releases en GitHub, actualizaciones, firma |
| [docs/15-analisis-programa-comercial.md](docs/15-analisis-programa-comercial.md) | Qué aprender de un programa comercial de SPD |

## Pruebas

```bash
npm test
```
