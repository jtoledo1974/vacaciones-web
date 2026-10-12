import assert from 'node:assert/strict';
const root='http://127.0.0.1:5173';
let cookie='';
async function req(path,body,auth=true){const r=await fetch(root+'/api/'+path,{headers:{...(auth?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json',Origin:root}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};}
const sign=await fetch(root+'/signin-with-chatgpt?return_to=/',{redirect:'manual'});cookie=sign.headers.get('set-cookie')?.split(';')[0]??'';
assert.equal((await req('session')).body.principal.role,'superadmin');
let ix=(await req('index')).body;if(!ix.teams.length){const init=await req('initialize',{});assert.equal(init.status,200);ix=init.body;}
assert.equal(ix.teams.length,8);assert.ok(ix.campaigns.length>=8);
const cid=ix.campaigns.find(c=>c.team_id==='C'&&c.year===2026).id;let d=(await req('campaign/'+cid)).body;
assert.equal(d.editable,true);
const anon=await req('campaign/'+cid,{action:'request',version:d.campaign.version},false);assert.equal(anon.status,401);
const noOrigin=await fetch(root+'/api/campaign/'+cid,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'});assert.equal(noOrigin.status,403);
const dates=d.result.cycles;const member=d.members[0];const write=await req('campaign/'+cid,{action:'request',version:d.campaign.version,memberId:member.id,slot:1,date:dates[0].date});assert.equal(write.status,200);d=write.body;
assert.equal((await req('campaign/'+cid)).body.requests.find(r=>r.member_id===member.id&&r.slot===1).cycle_date,dates[0].date);
assert.equal((await req('campaign/'+cid,{action:'request',version:d.campaign.version-1,memberId:member.id,slot:2,date:dates[1].date})).status,409);
const backup=(await req('backup')).body;assert.equal(backup.payload.format,'vacaciones-backup-v1');
console.log(JSON.stringify({passed:true,teams:ix.teams.length,campaigns:ix.campaigns.length,persistence:true,anonymousWrite:401,csrf:403,staleWrite:409,backup:true,localOnly:true}));
