import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isBlankNewRosterRow,withoutBlankNewRosterRows} from '../app/roster-rows.ts';

const blank=()=>({
  code:'',label:'',seniority:'',previousScore:'',provider:'',subject:'',
});

test('una fila nueva vacía o con espacios se descarta, sin tocar el resto de la plantilla',()=>{
  const existing={...blank(),memberId:'persisted-member'};
  const complete={...blank(),code:'JUAN',label:'Juan'};
  const incomplete={...blank(),label:'Solo nombre'};
  const rows=[existing,blank(),complete,{...blank(),code:' \t ',label:'   '},incomplete];
  assert.deepEqual(withoutBlankNewRosterRows(rows),[existing,complete,incomplete]);
  assert.equal(isBlankNewRosterRow(existing),false);
});

test('ningún dato introducido se descarta silenciosamente',()=>{
  const partiallyFilled=[
    {code:'ABC'},
    {label:'Nombre'},
    {seniority:'2020-01-01'},
    {previousScore:'125'},
    {provider:'chatgpt'},
    {subject:'example@example.com'},
    {legacyKey:'chatgpt:legacy'},
  ];
  for(const fields of partiallyFilled){
    assert.equal(isBlankNewRosterRow({...blank(),...fields}),false,JSON.stringify(fields));
  }
  assert.equal(isBlankNewRosterRow(blank()),true);
  assert.equal(isBlankNewRosterRow({...blank(),code:'  ',label:' \n '}),true);
});
