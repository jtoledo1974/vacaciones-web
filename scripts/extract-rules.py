import openpyxl,json,pathlib
p=pathlib.Path(__file__).resolve().parents[2]
w=openpyxl.load_workbook(p/'fuentes'/'Vacaciones V21.1.3X Perpetuo.xlsm',data_only=False)
v=openpyxl.load_workbook(p/'fuentes'/'Vacaciones V21.1.3X Perpetuo.xlsm',data_only=True)
print('NAMES')
for n,d in w.defined_names.items(): print(n,d.attr_text)
for sn,refs in {'Vac':['M5','N5','M6','N6','S5','T5','U5','V5','W5','X5','Y5','Z5','AA5','AB5','AC5','AD5','AE5','AF5','AG5','AH5','AI5','AJ5','AK5','AL5','AM5','AN5','AO4','AO5','AP5','AQ5','AR5','AS5','AT5','AU5','AV5','AW5','AX5','AY5','AZ5','BA5','BB5','BC5','BD6','BE2','BF2','E39','D5','E5','F5','G5','H5','I5'], 'Baremo':['AI2','AJ2','AK2','AL2','AI3','AJ3','AK3','AL3','AJ4','AK4','AL4','AJ5','AK5','AL5','AJ6','AK6','AL6','AJ7','AK7','AL7','AJ8','AK8','AL8','AJ9','AK9','AL9','AJ10','AK10','AL10','AJ11','AK11','AL11','AJ12','AK12','AL12','AJ13','AK13','AL13','AJ14','AK14','AL14','AJ15','AK15','AL15','AJ16','AK16','AL16','AJ17','AK17','AL17','AJ18','AK18','AL18','AJ19','AK19','AL19','AJ20','AK20','AL20','AJ21','AK21','AL21','AJ22','AK22','AL22','AJ23','AK23','AL23'], 'Turno básico':['AG14','AH14','AP1','AE3','AG3','AH3','AI3','AJ3','AK3','AL3','AM3','AN3'],'Cuenta horas':['B2','C2','D2','E2','F3','G3']}.items():
 print(sn)
 for a in refs:
  c=w[sn][a]; val=c.value
  if c.data_type=='f' and not isinstance(val,str):val=val.text
  print(a,str(val), '=>',v[sn][a].value)
print('ROTATION')
for row in w['Turno básico'].iter_rows(min_row=3,max_row=10,min_col=31,max_col=40): print([c.value for c in row])
