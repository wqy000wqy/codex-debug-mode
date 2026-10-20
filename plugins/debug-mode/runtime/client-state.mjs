export class DebugClient {
 constructor({rpc,store,changed=()=>{},id=()=>crypto.randomUUID()}){this.rpc=rpc;this.store=store;this.changed=changed;this.newId=id;this.contexts=new Map();this.current=null;this.capabilities={};}
 emit(c){if(c===this.current)this.changed(c);}
 async restore(c){if(c.restored)return;if(c.restoreJob)return c.restoreJob;c.restoring=true;this.emit(c);const job=(async()=>{const saved=await this.store.load(c.id);if(saved){c.text=saved.text||'';c.images=saved.images||[];c.pending=saved.pending||null;c.version=saved.version||0;if(c.pending?.phase==='sending')c.pending.phase='uncertain';if(c.pending?.phase==='delivered'){c.text='';c.images=[];c.pending=null;}}c.restored=true;c.restoreError='';})();c.restoreJob=job;
  try{await job;}catch(e){c.restoreError=e.message;throw e;}finally{c.restoreJob=null;c.restoring=false;this.emit(c);}
 }
 async select(sessionId){let c=this.contexts.get(sessionId);if(!c){c={id:sessionId,state:null,text:'',images:[],pending:null,restoring:true,busy:false,version:0,page:null,pageEpoch:0,pageRequest:0,saveQueue:Promise.resolve(),status:'',connectionError:''};this.contexts.set(sessionId,c);}this.current=c;this.emit(c);await this.refresh(c);return c;
 }
 update(c,s){if(!s||s.sessionId!==c.id)return false;const old=c.state;if(old&&s.revision<old.revision)return false;if(old&&s.revision===old.revision&&s.clearGeneration===old.clearGeneration&&s.round===old.round&&s.logCount<old.logCount)return false;
  if(!old||s.revision!==old.revision||s.round!==old.round||s.clearGeneration!==old.clearGeneration){c.page=null;c.pageEpoch++;c.pageRequest++;}c.state=s;this.emit(c);return true;
 }
 async tool(c,name,args){const result=await this.rpc('tools/call',{name,arguments:{sessionId:c.id,...args}});if(result?.isError)throw Error(result.content?.map(x=>x.text||'').join('\n')||'工具操作失败');if(result?.structuredContent)this.update(c,result.structuredContent);return result;}
 async refresh(c=this.current){if(!c)return;try{await this.restore(c);const result=await this.tool(c,'debug_get_logs',{});if(!result.structuredContent)throw Error('宿主未返回会话状态');c.connectionError='';}catch(e){c.connectionError=e.message;}this.emit(c);}
 save(c){const value=structuredClone({text:c.text,images:c.images,pending:c.pending,version:c.version});const job=c.saveQueue.catch(()=>{}).then(()=>this.store.save(c.id,value));c.saveQueue=job;return job;}
 editable(c){return c&&c===this.current&&!c.busy&&!c.restoring&&!c.restoreError&&!c.pending;}
 async edit(c,text){if(!this.editable(c))return;c.text=text;c.version++;this.emit(c);}
 async add(c,files,read){if(!this.editable(c))throw Error('当前正在恢复或发送，请稍后再添加图片');if(!this.capabilities.image)throw Error('当前宿主不支持图片，请用中间输入框发送');c.busy=true;this.emit(c);try{const additions=[];for(const file of files){if(!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type))throw Error('仅支持 PNG、JPEG、WebP、GIF');if(c.images.length+additions.length>=4||c.images.reduce((n,x)=>n+x.size,0)+additions.reduce((n,x)=>n+x.size,0)+file.size>8*1024*1024)throw Error('最多4张图片，总计8MB');const image=await read(file);additions.push({...image,id:this.newId()});}if(this.current!==c)throw Error('会话已切换，取消本次添加');c.images.push(...additions);c.version++;await this.save(c);}finally{c.busy=false;this.emit(c);}}
 async remove(c,id){if(!this.editable(c))return;c.images=c.images.filter(x=>x.id!==id);c.version++;await this.save(c);this.emit(c);}
 async act(c,toolName,message,args={}){
  if(!c||c!==this.current||c.busy||c.restoring||c.restoreError||c.connectionError)return;
  c.busy=true;c.status='';this.emit(c);
  try{
   if(!this.capabilities.text)throw Error('宿主不支持消息发送，请使用中间输入框');
   if(!c.pending){const s=c.state;if(!s)throw Error('会话尚未连接');if(c.images.length&&!this.capabilities.image)throw Error('当前宿主不接受图片，附件已保留');
    c.pending={actionId:this.newId(),sessionId:c.id,round:s.round,toolName,args:{expectedRound:s.round,expectedRevision:s.revision,...args},message,images:structuredClone(c.images),phase:'prepared'};
    try{await this.save(c);}catch(e){c.pending=null;throw Error('无法保存待发操作，尚未提交：'+e.message);}
   }
   const p=c.pending;if(p.phase==='delivered'){await this.finalize(c,p);return;}if(p.sessionId!==c.id)throw Error('待发消息会话不一致');if(p.images.length&&!this.capabilities.image)throw Error('当前宿主不接受待发图片，原消息已保留');
   if(p.phase==='uncertain'||p.phase==='sending')throw Error('消息是否送达尚未确认，请先核对对话');
   if(p.phase==='prepared'){
    if(p.toolName!=='feedback')await this.tool(c,p.toolName,{...p.args,actionId:p.actionId});
    p.phase='transitioned';await this.save(c);
   }
   if(this.current!==c)throw Error('会话已切换，原会话待发操作已保留');
   p.phase='sending';await this.save(c);
   const content=[...(p.message?[{type:'text',text:p.message}]:[]),...p.images.map(x=>({type:'image',mimeType:x.mimeType,data:x.data}))];
   let response;try{response=await this.rpc('ui/message',{role:'user',content});}catch(e){p.phase=e.definite?'rejected':'uncertain';await this.save(c);throw e;}
   if(!response||typeof response!=='object'){p.phase='uncertain';await this.save(c);throw Error('未获得有效投递回执，请核对对话');}
   if(response?.isError){p.phase='rejected';await this.save(c);throw Error('宿主拒绝了消息，原输入和附件已保留');}
   p.phase='delivered';await this.save(c);await this.finalize(c,p);
  }catch(e){c.status=e.message;}finally{c.busy=false;this.emit(c);}
 }
 async finalize(c,p){const close=p.toolName==='debug_mark_fixed';c.text='';c.images=[];c.pending=null;c.version++;await this.save(c);c.status='已发送';if(close&&this.current===c)this.changed(c,{close:true});}
 async resolveUncertain(c,received){if(!c?.pending||!['uncertain','sending'].includes(c.pending.phase)||c.busy)return;c.busy=true;this.emit(c);try{const p=c.pending;if(received){p.phase='delivered';await this.save(c);await this.finalize(c,p);}else{p.phase='rejected';await this.save(c);c.busy=false;await this.act(c,p.toolName,p.message);}}catch(e){c.status=e.message;}finally{c.busy=false;this.emit(c);}}
 async resetPending(c){if(!c?.pending||c.busy)return;c.busy=true;this.emit(c);try{const p=c.pending;if(p.phase!=='prepared')throw Error('此操作已提交，请先完成原消息投递');if(p.toolName!=='feedback'){const result=await this.tool(c,'debug_action_status',{actionId:p.actionId});const status=JSON.parse(result.content[0].text);if(status.committed){p.phase='transitioned';await this.save(c);throw Error('操作已执行，请重试发送原消息');}}c.pending=null;await this.save(c);await this.refresh(c);c.status='未执行的操作已取消，可重新编辑';}catch(e){c.status=e.message;}finally{c.busy=false;this.emit(c);}}
 async page(c){if(!c?.state||c.busy)return;const state=c.state,epoch=c.pageEpoch,request=++c.pageRequest;const offset=Math.max(0,(c.page?.offset??state.logOffset)-100);const result=await this.tool(c,'debug_get_log_page',{offset,limit:100});const page=JSON.parse(result.content.find(x=>x.type==='text').text);if(c===this.current&&request===c.pageRequest&&epoch===c.pageEpoch&&page.round===c.state.round&&page.clearGeneration===c.state.clearGeneration){c.page=page;this.emit(c);}}
 live(c){c.page=null;c.pageEpoch++;c.pageRequest++;this.emit(c);}
}
