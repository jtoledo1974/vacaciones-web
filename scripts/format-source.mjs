import ts from 'typescript';import {readFileSync,writeFileSync,readdirSync} from 'node:fs';import path from 'node:path';
const printer=ts.createPrinter({newLine:ts.NewLineKind.LineFeed});
for(const dir of ['app','domain','server','db','tests'])for(const file of walk(dir)){if(!/\.tsx?$/.test(file))continue;const source=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,file.endsWith('tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);writeFileSync(file,printer.printFile(source));}
function* walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())yield* walk(f);else yield f;}}
