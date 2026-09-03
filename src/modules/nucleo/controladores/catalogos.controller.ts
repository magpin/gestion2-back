import { Controller, Get, Param, Query } from '@nestjs/common';

import {
  BuscarCiiuDto,
  BuscarPucDto,
  BuscarResponsabilidadRutDto,
} from '../dto/catalogo.dto';
import { CatalogoService } from '../servicios/catalogo.service';

/**
 * Catálogos normativos: CIIU, PUC y las casillas del RUT.
 *
 * Sin `@ExigeEmpresa()` a propósito. No llevan datos de nadie y hacen falta antes
 * de que la empresa exista: el formulario de alta ya necesita el selector de CIIU
 * y el de forma asociativa. Basta con estar autenticado.
 *
 * Todo es de lectura. Estos catálogos se cargan y se corrigen por migración —
 * si un usuario pudiera editarlos, dos empresas verían PUC distintos.
 *
 * Geografía (`/departamentos`, `/municipios`) sigue donde estaba para no romper
 * lo que ya consume el frontend.
 */
@Controller('catalogos')
export class CatalogosController {
  constructor(private readonly catalogo: CatalogoService) {}

  // ---------------------------------------------------------------------------
  // CIIU
  // ---------------------------------------------------------------------------

  @Get('ciiu/secciones')
  secciones() {
    return this.catalogo.secciones();
  }

  @Get('ciiu/divisiones')
  divisiones(@Query('seccion') seccion?: string) {
    return this.catalogo.divisiones(seccion);
  }

  @Get('ciiu/grupos')
  grupos(@Query('division') division?: string) {
    return this.catalogo.grupos(division);
  }

  /** Búsqueda por nombre o por código: "4741" y "computadores" llevan al mismo lado. */
  @Get('ciiu')
  ciiu(@Query() q: BuscarCiiuDto) {
    return this.catalogo.clases(q);
  }

  // Va después de las rutas fijas de arriba: si estuviera antes, 'secciones'
  // entraría por acá como si fuera un código.
  @Get('ciiu/:codigo')
  clase(@Param('codigo') codigo: string) {
    return this.catalogo.clase(codigo);
  }

  // ---------------------------------------------------------------------------
  // PUC
  // ---------------------------------------------------------------------------

  @Get('puc')
  puc(@Query() q: BuscarPucDto) {
    return this.catalogo.cuentas(q);
  }

  @Get('puc/:codigo')
  cuenta(@Param('codigo') codigo: string) {
    return this.catalogo.cuenta(codigo);
  }

  /** Devuelve `rangoLibre: true` con lista vacía cuando el decreto no numera ese nivel. */
  @Get('puc/:codigo/hijas')
  hijas(@Param('codigo') codigo: string) {
    return this.catalogo.hijas(codigo);
  }

  // ---------------------------------------------------------------------------
  // RUT
  // ---------------------------------------------------------------------------

  @Get('responsabilidades-rut')
  responsabilidadesRut(@Query() q: BuscarResponsabilidadRutDto) {
    return this.catalogo.responsabilidadesRut(q.q, q.incluirNoVigentes === 'true');
  }

  @Get('responsabilidades-fe')
  responsabilidadesFe() {
    return this.catalogo.responsabilidadesFe();
  }

  @Get('tipos-documento')
  tiposDocumento(@Query('aplicaPersona') aplica?: 'NATURAL' | 'JURIDICA') {
    return this.catalogo.tiposDocumento(aplica);
  }

  @Get('formas-asociativas')
  formasAsociativas() {
    return this.catalogo.formasAsociativas();
  }

  @Get('tipos-contribuyente')
  tiposContribuyente() {
    return this.catalogo.tiposContribuyente();
  }
}
