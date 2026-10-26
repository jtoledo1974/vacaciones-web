import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {D1_MAX_PARAMETERS,type Repository,type Statement} from '../server/repository.ts';
// Enforce D1's bound-parameter limit so tests catch statements production would reject.
const checked=(args:unknown[])=>{if(args.length>D1_MAX_PARAMETERS)throw Error(`D1 admite como máximo ${D1_MAX_PARAMETERS} parámetros por consulta (recibidos ${args.length})`);return args as any[];};
export class SQLiteRepo implements Repository{
 db=new DatabaseSync(':memory:');
 constructor(){this.db.exec('PRAGMA foreign_keys=ON');for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())this.db.exec(readFileSync('drizzle/'+file,'utf8'));}
 async all<T=any>(sql:string,args:any[]=[]):Promise<T[]>{return this.db.prepare(sql).all(...checked(args)) as T[];}
 async batch(statements:Statement[]){this.db.exec('BEGIN IMMEDIATE');try{const result=statements.map(s=>{const query=this.db.prepare(s.sql);return {results:query.columns().length?query.all(...checked(s.args??[])):(query.run(...checked(s.args??[])),[])}});this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
}
