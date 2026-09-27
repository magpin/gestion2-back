import { Module } from '@nestjs/common';

import { ContabilidadModule } from '../contabilidad/contabilidad.module';
import { AuthController } from './controladores/auth.controller';
import { CatalogosController } from './controladores/catalogos.controller';
import { EmpresaLegalController } from './controladores/empresa-legal.controller';
import { ImpuestosController } from './controladores/impuestos.controller';
import { EmpresasController } from './controladores/empresas.controller';
import { GeografiaController } from './controladores/geografia.controller';
import { PlanCuentasController } from './controladores/plan-cuentas.controller';
import { ResolucionesController } from './controladores/resoluciones.controller';
import { TenantsController } from './controladores/tenants.controller';
import { TercerosController } from './controladores/terceros.controller';
import { UsuariosController } from './controladores/usuarios.controller';
import { ProvisionGuard } from './controladores/provision.guard';
import { NucleoApi } from './nucleo.api';
import { AutenticacionService } from './servicios/autenticacion.service';
import { CatalogoService } from './servicios/catalogo.service';
import { EmpresaLegalService } from './servicios/empresa-legal.service';
import { ImpuestosEmpresaService } from './servicios/impuestos-empresa.service';
import { EmpresaService } from './servicios/empresa.service';
import { EstadoConfiguracionService } from './servicios/estado-configuracion.service';
import { GeografiaService } from './servicios/geografia.service';
import { PlanCuentasService } from './servicios/plan-cuentas.service';
import { ResolucionService } from './servicios/resolucion.service';
import { TenantService } from './servicios/tenant.service';
import { TerceroService } from './servicios/tercero.service';
import { UsuarioService } from './servicios/usuario.service';

/**
 * `nucleo` — identidad, políticas de la empresa y terceros.
 *
 * Garantiza: el correo es único global · el usuario se desactiva, nunca se borra ·
 * los roles se suman y `DIRECTOR` no es superusuario · un tercero es cliente,
 * proveedor o ambos, nunca ninguno · las condiciones legales llevan vigencia y no
 * se sobrescriben · el consecutivo fiscal se toma con bloqueo de fila, dentro de
 * la transacción del documento.
 *
 * `exports` tiene una sola clase: `NucleoApi`. Los servicios internos no salen.
 */
@Module({
  imports: [ContabilidadModule],
  controllers: [
    AuthController,
    TenantsController,
    EmpresasController,
    EmpresaLegalController,
    ImpuestosController,
    ResolucionesController,
    UsuariosController,
    TercerosController,
    GeografiaController,
    CatalogosController,
    PlanCuentasController,
  ],
  providers: [
    AutenticacionService,
    EmpresaService,
    EmpresaLegalService,
    ImpuestosEmpresaService,
    EstadoConfiguracionService,
    ResolucionService,
    UsuarioService,
    TerceroService,
    GeografiaService,
    CatalogoService,
    PlanCuentasService,
    TenantService,
    ProvisionGuard,
    NucleoApi,
  ],
  exports: [NucleoApi],
})
export class NucleoModule {}
