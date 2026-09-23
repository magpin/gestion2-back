// Deja en cero el kardex de los documentos que se anularon mal.
//
// Hasta el 23 de septiembre de 2026, anular tenía dos errores:
//
//   - una factura de venta anulada **no devolvía la mercancía** al kardex: se
//     anulaba el asiento y las unidades quedaban descontadas;
//   - una compra anulada sacaba la mercancía **al costo promedio** y no al
//     costo con que había entrado, y el kardex quedaba distinto de la cuenta.
//
// Los dos se ven en Contabilidad → Revisión como «Anular … no devolvió la
// mercancía» o «… dejó el kardex descuadrado». Este script los repara con el
// mismo código que hoy usa la anulación —`InventarioApi.revertirPorAnulacion`—,
// que deja en cero, al mismo valor, lo que movió cada asiento anulado.
//
// **Se puede correr dos veces**: un asiento que ya está en cero no se toca.
// Cada movimiento nuevo queda a nombre de quien anuló el documento, con el
// asiento anulado como referencia y la fecha de hoy.
//
// Uso:
//   npx ts-node scripts/reparar-anulaciones-kardex.ts            muestra qué haría
//   npx ts-node scripts/reparar-anulaciones-kardex.ts --aplicar  lo hace

import 'dotenv/config';

import { NestFactory } from '@nestjs/core';
// `pg` no trae tipos en este proyecto: se describe lo poco que se usa.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Client } = require('pg') as {
  Client: new (config: object) => {
    connect(): Promise<void>;
    query<T>(sql: string): Promise<{ rows: T[] }>;
    end(): Promise<void>;
  };
};

import { AppModule } from '../src/app.module';
import { hoyEnColombia } from '../src/common/fecha';
import { TxService } from '../src/common/db/tx.service';
import { InventarioApi } from '../src/modules/inventario/inventario.api';

interface Pendiente {
  tenant_id: string;
  empresa_id: string;
  asiento_id: string;
  anulado_por: string;
  documento: string;
  diferencia: string;
}

(async () => {
  const aplicar = process.argv.includes('--aplicar');

  // Buscar entre todas las empresas lo hace el dueño de la base: con el rol de
  // la API, el RLS solo deja ver una a la vez.
  const dueno = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  await dueno.connect();
  const { rows: pendientes } = await dueno.query<Pendiente>(`
    SELECT e.tenant_id, a.empresa_id, a.id AS asiento_id, a.anulado_por,
           CASE a.origen_tipo
             WHEN 'VENTA'  THEN 'la factura ' || concat_ws('-', nullif(v.prefijo, ''), v.consecutivo::text)
             WHEN 'COMPRA' THEN 'la compra ' || c.numero_factura_proveedor
             ELSE 'el asiento ' || a.id
           END AS documento,
           sum(CASE WHEN m.tipo LIKE 'ENTRADA%' THEN m.valor_total ELSE -m.valor_total END) AS diferencia
      FROM asiento a
      JOIN empresa e ON e.id = a.empresa_id
      JOIN producto_movimiento m ON m.asiento_id = a.id
      LEFT JOIN venta_documento v  ON a.origen_tipo = 'VENTA'  AND v.id = a.origen_id
      LEFT JOIN compra_documento c ON a.origen_tipo = 'COMPRA' AND c.id = a.origen_id
     WHERE a.estado = 'ANULADO'
     GROUP BY e.tenant_id, a.empresa_id, a.id, a.anulado_por, a.origen_tipo,
              v.prefijo, v.consecutivo, c.numero_factura_proveedor
    HAVING abs(sum(CASE WHEN m.tipo LIKE 'ENTRADA%' THEN m.valor_total ELSE -m.valor_total END)) > 0.01
        OR sum(CASE WHEN m.tipo LIKE 'ENTRADA%' THEN m.cantidad ELSE -m.cantidad END) <> 0`);
  await dueno.end();

  if (pendientes.length === 0) {
    console.log('No hay anulaciones con el kardex descuadrado.');
    return;
  }
  for (const p of pendientes) {
    console.log(
      `${p.documento}: el kardex quedó ${Number(p.diferencia).toLocaleString('es-CO')} de diferencia.`,
    );
  }
  if (!aplicar) {
    console.log('\nNo se cambió nada. Para repararlas: --aplicar');
    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const tx = app.get(TxService);
  const inventario = app.get(InventarioApi);
  const hoy = hoyEnColombia();

  for (const p of pendientes) {
    const ctx = {
      tenantId: p.tenant_id,
      empresaId: p.empresa_id,
      usuarioId: p.anulado_por,
      roles: ['CONTADOR' as const],
    };
    // Cada asiento en su propia transacción: si uno no se puede —las
    // unidades de una compra ya se vendieron—, los demás se reparan igual.
    try {
      const r = await tx.enContexto(ctx, (t) =>
        inventario.revertirPorAnulacion(
          ctx,
          p.asiento_id,
          hoy,
          `Corrección de la anulación de ${p.documento}: el kardex no había quedado en cero.`,
          t,
        ),
      );
      console.log(`Reparada ${p.documento}: ${r.movimientos} movimientos.`);
    } catch (error) {
      console.log(
        `No pude reparar ${p.documento}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  await app.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
