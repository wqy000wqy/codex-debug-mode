import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionStore } from './session-store.mjs';
const root=process.env.CODEX_DEBUG_DATA_DIR;if(!root)throw Error('CODEX_DEBUG_DATA_DIR is required');await mkdir(root,{recursive:true,mode:0o700});
const config=JSON.parse(await readFile(join(root,'receiver.json'),'utf8'));if(!Number.isInteger(config.port)||config.port<1024||config.port>65535||typeof config.brokerToken!=='string'||config.brokerToken.length<32)throw Error('Invalid receiver configuration');const store=new SessionStore(root);let lastActivity=Date.now();
const equal=(a,b)=>{const x=Buffer.from(typeof a==='string'?a:''),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
async function body(req,max){let n=0;const parts=[];for await(const p of req){n+=p.length;if(n>max)throw Error('Payload too large');parts.push(p);}const value=JSON.parse(Buffer.concat(parts).toString());if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Expected object');return value;}
const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
const server=createServer(async(req,res)=>{
 lastActivity=Date.now();res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','content-type,x-debug-token,x-debug-broker-token');res.setHeader('Access-Control-Allow-Private-Network','true');
 if(req.method==='OPTIONS'){res.writeHead(204).end();return;}
 const path=new URL(req.url,'http://127.0.0.1').pathname;
 try{
  if(path==='/health'&&req.method==='GET'){if(!equal(req.headers['x-debug-broker-token'],config.brokerToken)){json(res,401,{error:'Unauthorized'});return;}json(res,200,{service:'debug-mode',ready:true,schemaVersion:7});return;}
  const control=/^\/control\/([0-9a-f-]{36})$/i.exec(path);
  if(control&&req.method==='POST'){if(!equal(req.headers['x-debug-broker-token'],config.brokerToken)){json(res,401,{error:'Unauthorized'});return;}json(res,200,await store.control(control[1],await body(req,64*1024)));return;}
  const logs=/^\/logs\/([0-9a-f-]{36})$/i.exec(path);
  if(logs&&req.method==='POST'){const value=await body(req,16*1024);const record=await store.append(logs[1],value,req.headers['x-debug-token']);json(res,201,{accepted:true,id:record.id,round:record.round});return;}
  json(res,404,{error:'Unknown endpoint'});
 }catch(e){json(res,e.message.includes('token')?401:e.message==='Payload too large'?413:409,{error:e.message});}
});
server.on('error',e=>{process.send?.({type:'error',code:e.code,message:e.message},()=>process.disconnect());process.exitCode=1;});
server.listen(config.port,'127.0.0.1',()=>process.send?.({type:'ready'},()=>process.disconnect()));
const timer=setInterval(()=>{if(Date.now()-lastActivity>12*3600000){clearInterval(timer);server.close(()=>process.exit(0));server.closeAllConnections?.();}},60000);timer.unref();
