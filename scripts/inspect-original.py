import openpyxl,json,re,collections,pathlib
p=pathlib.Path(__file__).resolve().parents[2]
w=openpyxl.load_workbook(p/'fuentes'/'Vacaciones V21.1.3X Perpetuo.xlsm',data_only=False,keep_vba=True)
v=openpyxl.load_workbook(p/'fuentes'/'Vacaciones V21.1.3X Perpetuo.xlsm',data_only=True)
out={}
for s in w:
 fs={c.coordinate:c.value if isinstance(c.value,str) else c.value.text for row in s for c in row if c.data_type=='f'}
 out[s.title]={'formulas':fs,'cached':{a:v[s.title][a].value for a in fs}}
 print(s.title,len(fs),collections.Counter(f for z in fs.values() for f in re.findall(r'([A-Z][A-Z0-9_.]*)\(',z)))
 if s.title in ['DATOS','Vac','Baremo','Turno básico']:
  for row in s:
   if row[0].row>(70 if s.title!='DATOS' else 30):break
   cells=[f'{c.coordinate}:{fs.get(c.coordinate,c.value) if c.data_type=="f" or s.title=="DATOS" else "[valor]"}' for c in row if c.value is not None and (s.title=='DATOS' or c.column<12)]
   print(' | '.join(cells))
(p/'web-mvp'/'.sites-runtime'/'original-private.json').write_text(json.dumps(out,default=str,ensure_ascii=False),encoding='utf8')
