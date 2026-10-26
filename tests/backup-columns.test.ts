import assert from 'node:assert/strict';
import test from 'node:test';
import {getTableColumns,getTableName} from 'drizzle-orm';
import {getTableConfig} from 'drizzle-orm/sqlite-core';
import * as schema from '../db/schema.ts';
import {tableColumns} from '../server/repository.ts';

// A backup intentionally contains persisted election/configuration data, not
// ephemeral locks, revision bookkeeping, push queues or private what-if drafts.
// Every schema table must appear either in tableColumns or in this explicit list.
const excludedTables:Record<string,string>={
 transaction_assertions:'Guarda aserciones transitorias de escritura; nunca se restaura.',
 app_state:'Su revisión se guarda en el encabezado de la copia y se gestiona por CAS.',
 push_subscriptions:'Suscripciones de dispositivo: no deben reactivarse al restaurar una copia.',
 turn_notifications:'Historial/cola de notificaciones operativas, no datos de elecciones.',
 push_deliveries:'Intentos y leases de envíos push; restaurarlos reenviaría avisos antiguos.',
 personal_simulations:'Borradores privados de simulación ajenos a la elección oficial.',
 local_admin_sessions:'Sesiones del admin local: restaurar una copia las invalida todas.',
 local_admin_attempts:'Intentos de acceso del admin local: caducan en quince minutos.'
};

const tables=Object.fromEntries(Object.values(schema).map(table=>[getTableName(table),table]));

test('toda tabla de Drizzle queda incluida en la copia o excluida expresamente',()=>{
 const included=Object.keys(tableColumns);
 assert.equal(new Set(included).size,included.length,'Tabla duplicada en el manifiesto');
 assert.ok(included.every(name=>!Object.hasOwn(excludedTables,name)),'Tabla simultáneamente incluida y excluida');
 assert.deepEqual([...included,...Object.keys(excludedTables)].sort(),Object.keys(tables).sort(),
  'Hay tablas de db/schema.ts sin tratamiento explícito en las copias');
});

test('las columnas respaldadas coinciden exactamente con db/schema.ts',()=>{
 for(const [name,columns] of Object.entries(tableColumns)){
  const table=tables[name];
  assert.ok(table,`No existe la tabla ${name} en db/schema.ts`);
  assert.equal(new Set(columns).size,columns.length,`Columna duplicada en ${name}`);
  const expected=Object.values(getTableColumns(table)).map(column=>column.name);
  assert.deepEqual([...columns].sort(),expected.sort(),`Columnas perdidas o añadidas en ${name}; revisar la copia de seguridad`);
 }
});

test('las tablas se restauran con las tablas padre antes que sus dependientes',()=>{
 const order=Object.keys(tableColumns);
 for(const [name,table] of Object.entries(tables)){
  if(!order.includes(name))continue;
  for(const fk of getTableConfig(table).foreignKeys){
   const parent=getTableName(fk.reference().foreignTable);
   if(!order.includes(parent))continue;
   assert.ok(order.indexOf(parent)<order.indexOf(name),
    `Orden incorrecto al restaurar: ${parent} debe ir antes que ${name}`);
  }
 }
});
