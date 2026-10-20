import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function atomicJson(path, value) { await atomicText(path, JSON.stringify(value)+'\n'); }
async function atomicText(path, value) { const tmp=path+'.'+randomUUID()+'.tmp';try {await writeFile(tmp,value,{mode:0o600,flag:'wx'});await rename(tmp,path);} finally {await unlink(tmp).catch(()=>{});} }
export class SessionStore {
 constructor(root){this.root=root;this.queue=new Map();this.indices=new Map();this.scannedBytes=0;}
 dir(id){if(!ID.test(id))throw Error('Invalid session ID');return join(this.root,id);}
 serial(id,task){this.dir(id);const next=(this.queue.get(id)||Promise.resolve()).catch(()=>{}).then(task);this.queue.set(id,next);return next.finally(()=>{if(this.queue.get(id)===next)this.queue.delete(id);});}
 file(id,round,generation=0){return join(this.dir(id),`events-${round}-${generation}.ndjson`);}
 async load(id){const s=JSON.parse(await readFile(join(this.dir(id),'session.json'),'utf8'));if(s.id!==id||!Number.isFinite(Date.parse(s.createdAt))||Date.now()-Date.parse(s.createdAt)>30*86400000)throw Error('调试会话不存在或已过期');if(s.storageVersion!==2)await this.migrate(s);s.purpose ||= 'unknown';await this.cleanGarbage(s);return s;}
 async cleanGarbage(s){if(!s.garbageFiles?.length)return;const left=[];for(const name of s.garbageFiles){if(!/^events-[0-9]+-[0-9]+\.ndjson$/.test(name)){left.push(name);continue;}try{await unlink(join(this.dir(s.id),name));}catch(e){if(e.code!=="ENOENT")left.push(name);}}if(left.length!==s.garbageFiles.length){s.garbageFiles=left;await atomicJson(join(this.dir(s.id),"session.json"),s);}}
 async save(s){s.revision=(s.revision||0)+1;s.updatedAt=new Date().toISOString();await atomicJson(join(this.dir(s.id),'session.json'),s);}
 async importLogs(source,dest,round,cutoff){
  const tmp=dest+'.'+randomUUID()+'.tmp';const out=await open(tmp,'wx',0o600);let n=0;
  try {const input=createReadStream(source,{encoding:'utf8'});const lines=createInterface({input,crlfDelay:Infinity});
   try {for await(const line of lines){let r;try{r=JSON.parse(line);}catch{continue;}if(Date.parse(r.time)<=Date.parse(cutoff))continue;await out.write(JSON.stringify({...r,id:r.id||randomUUID(),sequence:++n,round})+'\n');}}catch(e){if(e.code!=='ENOENT')throw e;}finally{lines.close();input.destroy();}
   await out.close();await rename(tmp,dest);
  }catch(e){await out.close().catch(()=>{});await unlink(tmp).catch(()=>{});throw e;}
 }
 async migrate(s){
  await this.importLogs(join(this.dir(s.id),'logs.ndjson'),this.file(s.id,s.round||1,s.clearGeneration||0),s.round||1,s.logsClearedAt);
  s.storageVersion=2;s.round=s.round||1;s.clearGeneration=s.clearGeneration||0;s.actions=s.actions||{};await this.save(s);
 }
 async index(path){let info;try{info=await stat(path);}catch(e){if(e.code==='ENOENT')return {rows:[],size:0,stamp:0};throw e;}
  const old=this.indices.get(path);if(old&&old.size===info.size&&old.stamp===info.mtimeMs)return old;
  const rows=[];let position=0,buffer=Buffer.alloc(0);this.scannedBytes+=info.size;
  for await(const chunk of createReadStream(path)){buffer=Buffer.concat([buffer,chunk]);let end;while((end=buffer.indexOf(10))>=0){const line=buffer.subarray(0,end);try{JSON.parse(line.toString('utf8'));rows.push([position,position+end+1]);}catch{}position+=end+1;buffer=buffer.subarray(end+1);}}
  if(buffer.length){try{JSON.parse(buffer.toString('utf8'));rows.push([position,position+buffer.length]);}catch{}}
  const index={rows,size:info.size,stamp:info.mtimeMs};this.indices.set(path,index);return index;
 }
 async page(path,offset=null,limit=100){const idx=await this.index(path);const start=offset===null?Math.max(0,idx.rows.length-limit):offset;const selected=idx.rows.slice(start,start+limit);let logs=[];
  if(selected.length){const begin=selected[0][0],end=selected.at(-1)[1];const f=await open(path,'r');try{const buf=Buffer.alloc(end-begin);let done=0;while(done<buf.length){const {bytesRead}=await f.read(buf,done,buf.length-done,begin+done);if(!bytesRead)break;done+=bytesRead;}logs=buf.subarray(0,done).toString('utf8').split('\n').filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});}finally{await f.close();}}
  return {logs,totalCount:idx.rows.length,offset:start,limit};
 }
 async snapshot(s){const p=await this.page(this.file(s.id,s.round,s.clearGeneration));return {...s,logs:p.logs,totalCount:p.totalCount,logOffset:p.offset,logVersion:`${s.round}:${s.clearGeneration}:${p.totalCount}`};}
 async append(id,body,token){return this.serial(id,async()=>{const s=await this.load(id);const left=Buffer.from(typeof token==='string'?token:''),right=Buffer.from(typeof s.token==='string'?s.token:'');if(!left.length||left.length!==right.length||!timingSafeEqual(left,right))throw Error('Invalid debug session token');if(['cleanup','fixed','closed'].includes(s.status))throw Error('Debug session is closed');const path=this.file(id,s.round,s.clearGeneration);const idx=await this.index(path);let safePath='/';try{safePath=new URL(typeof body.path==='string'?body.path:'/', 'http://localhost').pathname.slice(0,500);}catch{}
  const text=(key,max)=>typeof body[key]==='string'?body[key].slice(0,max):'';
  const record={id:randomUUID(),sequence:idx.rows.length+1,round:s.round,runId:text('runId',80)||`round-${s.round}`,hypothesisId:text('hypothesisId',80),location:text('location',300),message:text('message',500),data:Object.fromEntries(Object.entries(body.data&&typeof body.data==='object'&&!Array.isArray(body.data)?body.data:{}).slice(0,30).filter(([k,v])=>k.length<=100&&(v===null||['string','number','boolean'].includes(typeof v))).map(([k,v])=>[k,typeof v==='string'?v.slice(0,500):v])),time:new Date().toISOString(),method:text('method',16).toUpperCase()||'FETCH',path:safePath,status:Number.isInteger(body.status)?body.status:null,durationMs:Number.isFinite(body.durationMs)?Math.max(0,Math.min(600000,Math.round(body.durationMs))):null,errorName:text('errorName',80)||null};
  const line=Buffer.from(JSON.stringify(record)+'\n');const f=await open(path,'a',0o600);try{await f.writeFile(line);}finally{await f.close();}const info=await stat(path);idx.rows.push([idx.size,idx.size+line.length]);idx.size=info.size;idx.stamp=info.mtimeMs;this.indices.set(path,idx);return record;
 });}
 clearCurrent(s){const path=this.file(s.id,s.round,s.clearGeneration);this.indices.delete(path);s.garbageFiles||=[];s.garbageFiles.push(`events-${s.round}-${s.clearGeneration}.ndjson`);s.clearGeneration++;}
 async control(id,args){return this.serial(id,async()=>{const s=await this.load(id);const op=args.op;
  if(op==='snapshot')return this.snapshot(s);
  if(op==='action_status')return {sessionId:id,committed:Boolean(s.actions?.[args.actionId]),action:s.actions?.[args.actionId]||null};
  if(op==='page'){let round=args.round??s.round;let p;
   if(!Number.isInteger(round)||round<1||!Number.isInteger(args.offset??0)||args.offset<0||!Number.isInteger(args.limit??100)||(args.limit??100)<1||(args.limit??100)>500)throw Error('Invalid page');
   if(round===s.round)p=await this.page(this.file(id,round,s.clearGeneration),args.offset??0,args.limit??100);
   else {const metaPath=join(this.dir(id),`meta-${round}.json`);try{const meta=JSON.parse(await readFile(metaPath,'utf8'));p={...meta,...await this.page(this.file(id,round,round===s.round?s.clearGeneration:meta.clearGeneration),args.offset??0,args.limit??100)};}catch(e){if(e.code!=='ENOENT')throw e;const legacy=JSON.parse(await readFile(join(this.dir(id),`round-${round}.json`),'utf8'));
     const source=join(this.dir(id),`round-${round}.ndjson`);const exists=await stat(source).then(()=>true).catch(error=>{if(error.code==='ENOENT')return false;throw error;});
     const dest=this.file(id,round,0);
     if(exists)await this.importLogs(source,dest,round,legacy.logsClearedAt);
     else await atomicText(dest,(legacy.logs||[]).map((r,i)=>JSON.stringify({...r,id:r.id||randomUUID(),sequence:i+1,round})).join('\n')+((legacy.logs||[]).length?'\n':''));
     const meta={round,hypotheses:legacy.hypotheses,reproductionSteps:legacy.reproductionSteps,clearGeneration:0,legacySnapshot:true,note:exists?'旧版归档，保留现有记录':'旧版快照，之前截断的数据不可恢复'};
     await atomicJson(metaPath,meta);p={...meta,...await this.page(dest,args.offset??0,args.limit??100)};}}

   return {...p,sessionId:id,round,clearGeneration:round===s.round?s.clearGeneration:(p.clearGeneration||0),revision:s.revision};
  }
  const actionId=args.actionId;if(actionId&&!ID.test(actionId))throw Error('Invalid action ID');
  if(actionId&&s.actions?.[actionId]){if(s.actions[actionId].op!==op)throw Error('Action ID conflict');return this.snapshot(s);}
  if(args.expectedRevision!==undefined&&args.expectedRevision!==s.revision)throw Error('会话已变化，请刷新后重新操作');
  if(args.expectedRound!==undefined&&args.expectedRound!==s.round)throw Error('轮次已变化，请重新操作');
  if(op==='show'){if(s.status==='preparing'&&!s.instrumentationRemovedByRequest){if((await this.page(this.file(id,s.round,s.clearGeneration))).totalCount)this.clearCurrent(s);s.status='waiting';s.statusLabel=`第 ${s.round} 轮：等待复现`;}}
  else if(op==='proceed'){if(!['waiting','awaiting_confirmation'].includes(s.status))throw Error('当前不在等待用户反馈状态');s.status='investigating';s.statusLabel='用户已反馈，正在分析运行证据';}
  else if(op==='mark_fixed'){if(!['waiting','investigating','awaiting_confirmation'].includes(s.status))throw Error('当前不能确认修复');s.cleanupReason='confirmed_fixed';s.cleanupReturnStatus='fixed';s.status='cleanup';s.statusLabel='用户已确认，等待清理';}
  else if(op==='request_cleanup'){
   if(!['preparing','waiting','investigating','awaiting_confirmation'].includes(s.status))throw Error('当前不能请求移除埋点');
   if(typeof args.endSession!=='boolean')throw Error('必须明确用户只移除埋点还是结束本次调试');
   s.cleanupReason='instrumentation_removal';s.cleanupReturnStatus=args.endSession?'closed':s.status;s.status='cleanup';s.statusLabel='按用户要求清理埋点，尚未确认修复';
  }
  else if(op==='finish'){
   if(!['cleanup','fixed','closed'].includes(s.status))throw Error('尚未获得清理请求或修复确认');
   if(s.status==='cleanup'){
    s.status=s.cleanupReturnStatus||'fixed';
    if(s.cleanupReason==='instrumentation_removal'){
     s.instrumentationRemovedByRequest=true;
     s.statusLabel=s.status==='closed'?'用户已结束调试，埋点已清理；未确认修复':'埋点已按要求清理；未确认修复，等待后续指示';
    }else{s.instrumentationRemovedByRequest=false;s.statusLabel='调试已结束，清理完成';}
   }
  }
  else if(op==='resume'){if(args.interrupted!==true)throw Error('请先确认上一轮任务已停止');if(s.status==='cleanup'){/* resume cleanup without changing state */}else if(['preparing','investigating'].includes(s.status)){s.statusLabel=s.status==='preparing'?'已恢复，继续准备埋点与复现条件':'已恢复，继续分析本轮证据';}else throw Error('当前状态无需恢复');}
  else if(op==='await_confirmation'){
   if(s.status!=='investigating'||s.purpose!=='verification'||!s.baselineRound)throw Error('仅修复后复验分析可以等待确认');
   if(typeof args.evidenceSummary!=='string'||!args.evidenceSummary.trim())throw Error('需要前后日志的证据说明');
   const current=await this.page(this.file(id,s.round,s.clearGeneration));
   const baseline=JSON.parse(await readFile(join(this.dir(id),`meta-${s.baselineRound}.json`),'utf8'));
   const before=await this.page(this.file(id,s.baselineRound,baseline.clearGeneration));
   if(!current.totalCount||!before.totalCount)throw Error('缺少修复前或修复后日志，不能声称日志支持成功；用户仍可明确确认解决');
   s.evidenceSummary=args.evidenceSummary.trim();s.status='awaiting_confirmation';s.statusLabel='日志比较支持成功，等待你确认';
  }
  else if(op==='clear'){this.clearCurrent(s);}
  else if(op==='prepare'){
   if(!['preparing','waiting','investigating'].includes(s.status))throw Error('会话已结束');
   if(!['investigation','verification'].includes(args.purpose))throw Error('必须明确本轮用于调查还是修复后复验');
   if(args.nextRound===false&&(s.status!=='preparing'||s.round!==1||(await this.page(this.file(id,s.round,s.clearGeneration))).totalCount>0))throw Error('同轮准备仅限尚未交接的首轮');
   if(args.purpose==='verification'){
    if(!Number.isInteger(args.baselineRound)||args.baselineRound<1||args.baselineRound>s.round||args.nextRound===false)throw Error('复验必须指定已有的修复前基线轮次并推进新轮');
    if(args.baselineRound<s.round)await readFile(join(this.dir(id),`meta-${args.baselineRound}.json`),'utf8');
   }
   if(args.nextRound!==false){await atomicJson(join(this.dir(id),`meta-${s.round}.json`),{round:s.round,purpose:s.purpose,baselineRound:s.baselineRound??null,hypotheses:s.hypotheses,reproductionSteps:s.reproductionSteps,clearGeneration:s.clearGeneration});s.round++;s.clearGeneration=0;}
   s.instrumentationRemovedByRequest=false;s.cleanupReason=null;s.cleanupReturnStatus=null;s.purpose=args.purpose;s.baselineRound=args.purpose==='verification'?args.baselineRound:null;s.evidenceSummary='';
   s.hypotheses=args.hypotheses;s.reproductionSteps=args.reproductionSteps;s.status='waiting';s.statusLabel=`第 ${s.round} 轮：等待复现`;
  }else throw Error('Unknown control operation');
  if(actionId){s.actions||={};s.actions[actionId]={op,at:new Date().toISOString()};}
  await this.save(s);await this.cleanGarbage(s);return this.snapshot(s);
 });}
}
