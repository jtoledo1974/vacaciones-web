import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import type {Repository,Statement} from '../server/repository.ts';
export class SQLiteRepo implements Repository{
 db=new DatabaseSync(':memory:');
 constructor(){this.db.exec('PRAGMA foreign_keys=ON');for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())this.db.exec(readFileSync('drizzle/'+file,'utf8'));}
 async all<T=any>(sql:string,args:any[]=[]):Promise<T[]>{return this.db.prepare(sql).all(...args) as T[];}
 async batch(statements:Statement[]){this.db.exec('BEGIN IMMEDIATE');try{const result=statements.map(s=>{const query=this.db.prepare(s.sql);return {results:query.columns().length?query.all(...(s.args??[]) as any[]):(query.run(...(s.args??[]) as any[]),[])}});this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
}
