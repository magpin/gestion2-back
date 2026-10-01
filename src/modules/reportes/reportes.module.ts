import { Module } from '@nestjs/common';

import { EstadosFinancierosModule } from '../estados-financieros/estados-financieros.module';
import { EstadosReporteController } from './controladores/estados-reporte.controller';
import { EstadosReporteService } from './servicios/estados-reporte.service';

import { ContabilidadModule } from '../contabilidad/contabilidad.module';
import { ArmadorController } from './controladores/armador.controller';
import { DocumentosController } from './controladores/documentos.controller';
import { DocumentosPdfService } from './servicios/documentos-pdf.service';
import { ReportesController } from './controladores/reportes.controller';
import { CarteraReporteService } from './servicios/cartera-reporte.service';
import { RetencionesReporteService } from './servicios/retenciones-reporte.service';
import { CorridaService } from './servicios/corrida.service';
import { ExcelService } from './servicios/excel.service';
import { FechasReporteService } from './servicios/fechas.service';
import { ArmadorService } from './servicios/armador.service';
import { GotenbergService } from './servicios/gotenberg.service';
import { GraficoService } from './servicios/grafico.service';
import { MembreteService } from './servicios/membrete.service';
import { PlantillaService } from './servicios/plantilla.service';
import { VentasReporteService } from './servicios/ventas-reporte.service';

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
  imports: [ContabilidadModule, EstadosFinancierosModule],
  controllers: [
    ReportesController,
    ArmadorController,
    EstadosReporteController,
    DocumentosController,
  ],
  providers: [
    GotenbergService,
    GraficoService,
    MembreteService,
    PlantillaService,
    VentasReporteService,
    CarteraReporteService,
    RetencionesReporteService,
    CorridaService,
    ExcelService,
    FechasReporteService,
    ArmadorService,
    EstadosReporteService,
    DocumentosPdfService,
  ],
  // `ArmadorService` lo usa el asistente para consultar datos (paso 6 de
  // `asistente-conversacion.md`): con los mismos permisos que la pantalla, y
  // re-mirados adentro de `correr`.
  exports: [
    VentasReporteService,
    CarteraReporteService,
    ArmadorService,
    RetencionesReporteService,
  ],
})
export class ReportesModule {}
