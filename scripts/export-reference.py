import openpyxl,json,pathlib,datetime
p=pathlib.Path(__file__).resolve().parents[2]
w=openpyxl.load_workbook(p/'fuentes'/'Vacaciones V21.1.3X Perpetuo.xlsm',data_only=False)
v=openpyxl.load_workbook(p/'fuentes'/'Vacaciones V21.1.3X Perpetuo.xlsm',data_only=True)
for sn,refs in {'Vac':['N49','N50','N51','M49','M50','AC2','AC3','AD2','AD3','Y3','O1','O2','Q1','Q4'], 'Baremo':['AI67','AJ67','AI68','AJ68','AI69','AJ69','AI70','AJ70','AI71','AJ71','AI72','AJ72','AI73','AJ73','AI74','AJ74','AI75','AJ75','AI76','AJ76','AI77','AJ77','AI78','AJ78','AI79','AJ79','AI80','AJ80','AI81','AJ81','AI82','AJ82','AI83','AJ83','AI84','AJ84','AI85','AJ85','AI86','AJ86','AI87','AJ87','AI88','AJ88','AI89','AJ89','AI90','AJ90','AI91','AJ91','AI92','AJ92','AI93','AJ93','AI94','AJ94','AI95','AJ95','AI96','AJ96','AI97','AJ97','AI98','AJ98','AI99','AJ99','AI100','AJ100','AI101','AJ101','AI102','AJ102','AI103','AJ103','AI104','AJ104','AI105','AJ105','AI106','AJ106','AI107','AJ107','AI108','AJ108']}.items():
 print(sn)
 for a in refs:print(a,str(w[sn][a].value),'=>',v[sn][a].value)
def iso(x):return x.strftime('%Y-%m-%d') if isinstance(x,datetime.datetime) else x
base=[{'date':iso(v['Baremo'][f'AI{r}'].value),'score':v['Baremo'][f'AJ{r}'].value} for r in range(67,109) if isinstance(v['Baremo'][f'AI{r}'].value,datetime.datetime)]
cycles=[{'date':iso(v['Vac'][f'N{r}'].value),'score':v['Vac'][f'M{r}'].value} for r in range(5,51) if isinstance(v['Vac'][f'N{r}'].value,datetime.datetime)]
rotation=[[v['Turno básico'].cell(r,c).value or ' ' for c in range(33,41)] for r in range(3,11)]
out={'year':2026,'team':'C','base':base,'cycles':cycles,'rotation':rotation}
(p/'web-mvp'/'tests').mkdir(exist_ok=True)
(p/'web-mvp'/'tests'/'excel-reference.json').write_text(json.dumps(out,ensure_ascii=False),encoding='utf8')
