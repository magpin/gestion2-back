import { Module } from '@nestjs/common';

import { GotenbergService } from './servicios/gotenberg.service';
import { GraficoService } from './servicios/grafico.service';
import { PlantillaService } from './servicios/plantilla.service';

/**
 * `reportes` — convierte datos en una hoja que alguien firma.
 *
 * Es módulo aparte por las tres señales de `decisiones/arquitectura-modulos.md`,
 * y cumple las tres:
 *
 * 1. **Falla por otras razones.** Un reporte se cae porque Gotenberg no
 *    contesta, porque QuickChart rechazó una configuración o porque la consulta
 *    tardó demasiado. Nada de eso tiene que ver con vender, comprar o asentar,
 *    y ninguna de esas fallas puede tumbar la facturación.
 * 2. **Otro contexto.** Habla con dos servicios externos y no escribe una sola
 *    fila: **lee y nada más**. Es el único módulo del que se puede decir eso.
 * 3. **Se construye sin tocar lo demás.** Lee por el catálogo de orígenes, que
 *    declara las columnas y quién puede verlas.
 *
 * Y se llama `reportes` y no `pdf` por el mismo criterio que hizo que el módulo
 * de archivos se llame `almacenamiento` y no `minio`: el nombre es el contexto,
 * no la tecnología. El día que además salga en Excel, sigue llamándose igual.
 */
@Module({
  providers: [GotenbergService, GraficoService, PlantillaService],
  exports: [GotenbergService, GraficoService, PlantillaService],
})
export class ReportesModule {}
