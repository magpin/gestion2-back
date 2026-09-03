import { Controller, Get, Query } from '@nestjs/common';

import { GeografiaService } from '../servicios/geografia.service';

/**
 * Catálogo DANE. Es compartido y no lleva datos de nadie, así que cualquier
 * usuario autenticado puede consultarlo sin haber elegido empresa.
 */
@Controller()
export class GeografiaController {
  constructor(private readonly geo: GeografiaService) {}

  @Get('departamentos')
  departamentos() {
    return this.geo.departamentos();
  }

  @Get('municipios')
  municipios(
    @Query('departamento') departamento?: string,
    @Query('q') q?: string,
  ) {
    return this.geo.municipios(departamento, q);
  }
}
