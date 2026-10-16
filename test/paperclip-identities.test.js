import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../src/server.js';
import { Client } from '../src/client.js';
import { startPaperclipNotifier } from '../src/paperclip-notifier.js';

const until = async (check) => {
  const end=Date.now()+7000;
  while(!await check()){if(Date.now()>end)throw Error('Identity routing timeout');await new Promise(r=>setTimeout(r,15));}
};
test('same-project identities route to separate agents and keep replies, ACK and restart receipts independent',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mailbox-identities-'));
  const app=await startServer({port:0,mcpPort:0,dbPath:':memory:',codexAppOptions:{env:{}}});
  const api=new Client(app.url), tasks=new Map(),services=[],clients=[];
  const hook=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer test-secret');
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const payload=JSON.parse(Buffer.concat(chunks));
    const key=req.headers['idempotency-key'];
    if(!tasks.has(key))tasks.set(key,{id:randomUUID(),status:'issue_created',linkedIssueId:randomUUID(),route:req.url,payload});
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(tasks.get(key)));
  });
  await new Promise(r=>hook.listen(0,'127.0.0.1',r));
  t.after(async()=>{for(const s of services)await s.close();for(const c of clients)await c.close();await app.close();hook.closeAllConnections();await new Promise(r=>hook.close(r));await rm(dir,{recursive:true});});
  const project=await api.request('/api/projects',{name:'Shared project'});
  const topic=await api.request('/api/topics',{title:'Discussion',goal:'Independent agent routing',project:project.id});
  const configs=[],peers=[];
  for(const name of ['gpt-agent','claude-agent']){
    const peer=await api.request('/api/participants',{name,kind:'agent'});peers.push(peer);
    await api.request(`/api/topics/${topic.id}/members`,{as:peer.id});
    const key=await api.request('/api/connectors',{name,as:peer.id,project:project.id});
    const c=new McpClient({name,version:'test'});clients.push(c);
    await c.connect(new StreamableHTTPClientTransport(new URL(app.mcpUrl),{requestInit:{headers:{Authorization:`Bearer ${key.token}`}}}));
    const cfg={mailboxUrl:app.mcpUrl,mailboxToken:key.token,projectId:project.id,participantId:peer.id,
      paperclipWebhookUrl:`http://127.0.0.1:${hook.address().port}/api/routine-triggers/public/${name}/fire`,webhookSecret:'test-secret',statePath:join(dir,name+'.db')};configs.push(cfg);
    services.push(await startPaperclipNotifier(cfg,{retryMs:20}));
  }
  const call=async(i,name,args={})=>{const r=await clients[i].callTool({name,arguments:args});assert.ok(!r.isError,r.content[0]?.text);return r.structuredContent;};
  await until(()=>services.every(s=>s.status().connected));
  for(let i=0;i<2;i++)assert.equal((await call(i,'mailbox_identity')).participant.id,peers[i].id);
  const direct=await api.request(`/api/topics/${topic.id}/messages`,{as:'human',to:peers[0].id,body:'Only A',requestId:randomUUID()});
  await until(()=>tasks.size===1);
  assert.equal([...tasks.values()][0].route,'/api/routine-triggers/public/gpt-agent/fire');
  assert.equal((await call(1,'mailbox_inbox')).notifications.length,0);
  const reply=await call(0,'mailbox_reply',{topic:topic.id,message:direct.id,body:'A replies',notify:false,requestId:'reply-a'});
  assert.equal(reply.author_id,peers[0].id);
  await call(0,'mailbox_ack',{topic:topic.id,through:direct.id});
  await services[1].close();
  const broadcast=await api.request(`/api/topics/${topic.id}/messages`,{as:'human',broadcast:true,body:'Both',requestId:randomUUID()});
  await until(()=>tasks.size===2);
  await call(0,'mailbox_ack',{topic:topic.id,through:broadcast.id});
  assert.equal((await call(0,'mailbox_inbox')).notifications.length,0);
  assert.deepEqual((await call(1,'mailbox_inbox')).notifications.map(m=>m.id),[broadcast.id]);
  const restarted=await startPaperclipNotifier(configs[1],{retryMs:20});services.push(restarted);
  await until(()=>tasks.size===3);
  const bTask=[...tasks.values()].find(t=>t.payload.participantId===peers[1].id);
  assert.equal(bTask.route,'/api/routine-triggers/public/claude-agent/fire');assert.equal(bTask.payload.messageId,broadcast.id);
  const bReply=await call(1,'mailbox_reply',{topic:topic.id,message:broadcast.id,body:'B replies',requestId:'reply-b'});
  assert.equal(bReply.author_id,peers[1].id);
  await call(1,'mailbox_ack',{topic:topic.id,through:broadcast.id});
  assert.equal((await call(1,'mailbox_inbox')).notifications.length,0);
  await restarted.close();
  const again=await startPaperclipNotifier(configs[1],{retryMs:20});services.push(again);
  await until(()=>again.status().connected);assert.equal(tasks.size,3);
});
