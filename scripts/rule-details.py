exec(open('scripts/extract-rules.py',encoding='utf8').read().split("print('NAMES')")[0])
for sn,refs in {'Vac':['N3','Q3','T4','AA1','AE2','AE3','Y52','Y53','Y54','AI1','AI2','AI3','AI4','O5','P5','Q5','R5','AC4','E1','G1','I1','I2','I3','G2','G3','Z3','AG1','AG2','AG3','AG4','AF1','AG6','AG7','AG8','AG9','AG10','AG11','AG12'], 'Cuenta horas':['B3','C3','D3','E3','C4','C5','AM2','AM3','AN2','AN3','AO2','AP2','AQ2','AR2','AS2','AT2','AU2','AV2'], 'Baremo':['AI8','AI9','AI10','AI14','AI15','AI21','AI23','AI24','AJ24','AL24','AI25','AJ25','AL25','AI26','AJ26','AL26','AI27','AJ27','AL27','AI28','AJ28','AL28','AI29','AJ29','AL29','AI30','AJ30','AL30'],'Turno básico':['AG1','AH1','AI1','AJ1','AK1','AL1','AM1','AN1','AG2','AH2','AI2','AJ2','AK2','AL2','AM2','AN2']}.items():
 print(sn)
 for a in refs:
  c=w[sn][a]; val=c.value
  if c.data_type=='f' and not isinstance(val,str):val=val.text
  print(a,str(val),' => ',v[sn][a].value)
