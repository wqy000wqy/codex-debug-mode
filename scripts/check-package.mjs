import assert from 'node:assert/strict';
import { readFile,readdir,lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILL_TEXT } from '../src/workflow.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const readJson=async path=>JSON.parse(await readFile(path,'utf8'));
const pkg=await readJson(join(root,'package.json'));
const payload=join(root,'plugins/debug-mode');
const manifest=await readJson(join(payload,'plugin.json'));
const legacy=await readJson(join(payload,'.codex-plugin/plugin.json'));
const runtimePkg=await readJson(join(payload,'package.json'));
assert.equal(manifest.$schema,'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
assert.equal(manifest.name,'debug-mode');assert.equal(legacy.name,manifest.name);
assert.equal(manifest.version,pkg.version);assert.equal(legacy.version,pkg.version);assert.equal(runtimePkg.version,pkg.version);
assert.equal(manifest.license,'MIT');
const ui=manifest.extensions['com.openai'].interface;
assert.equal(ui.displayName,'Debug Mode');assert(ui.shortDescription.length<=30);assert.deepEqual(ui,legacy.interface);
assert.equal(manifest.extensions['com.openai'].requires_local_executor,true);
assert.equal(await readFile(join(payload,'skills/debug-mode/SKILL.md'),'utf8'),SKILL_TEXT);
assert.equal(await readFile(join(root,'src/skills/debug-mode/SKILL.md'),'utf8'),SKILL_TEXT);
const mcp=await readJson(join(payload,'mcp.json'));
assert.equal(mcp.$schema,'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
assert.deepEqual(Object.keys(mcp.mcpServers),['debug-mode']);
assert.equal(mcp.mcpServers['debug-mode'].command,'/bin/sh');
assert.equal(mcp.mcpServers['debug-mode'].args[0],'${PLUGIN_ROOT}/runtime/launch.sh');
const marketplace=await readJson(join(root,'.agents/plugins/marketplace.json'));
assert.equal(marketplace.plugins.length,1);assert.equal(marketplace.plugins[0].name,manifest.name);
assert.equal(resolve(root,marketplace.plugins[0].source.path),payload);
const info=await readJson(join(payload,'BUILD_INFO.json'));assert.equal(info.version,pkg.version);assert(info.dependencies.length>0);
const allow=new Set(['plugin.json','package.json','mcp.json','.mcp.json','.codex-plugin/plugin.json','assets/icon.svg','runtime/assets/debug-card.html','runtime/server.mjs','runtime/receiver.mjs','runtime/client-state.mjs','runtime/view.mjs','runtime/launch.sh','skills/debug-mode/SKILL.md','LICENSE','THIRD_PARTY_NOTICES.md','BUILD_INFO.json']);
let count=0;
async function visit(dir,rel=''){
 for(const e of await readdir(dir,{withFileTypes:true})){
  const key=rel?rel+'/'+e.name:e.name,path=join(dir,e.name);assert(!e.isSymbolicLink(),'Symlink not allowed: '+key);
  if(e.isDirectory()){await visit(path,key);continue;}
  assert(allow.has(key),'Unexpected payload file: '+key);const bytes=await readFile(path);count++;
  if(key!=='BUILD_INFO.json')assert.equal(createHash('sha256').update(bytes).digest('hex'),info.sha256[key],'Stale generated file: '+key);
  if(/\.(?:mjs|json|md|sh)$/.test(key))assert(!/(?:\/Users\/|\/home\/)[^/\s]+\//.test(bytes.toString('utf8')),'Personal source path: '+key);
 }
}
await visit(payload);
for(const path of allow)assert((await lstat(join(payload,path))).isFile(),'Missing payload file: '+path);
assert.equal(count,allow.size);
for(const [path,hash]of Object.entries(info.sha256))assert(allow.has(path)&&/^[a-f0-9]{64}$/.test(hash),'Unexpected build hash entry');
assert((await readFile(join(payload,'runtime/server.mjs'),'utf8')).includes('debug_await_confirmation'));
assert((await readFile(join(payload,'runtime/server.mjs'),'utf8')).includes('debug_request_cleanup'));
console.log(`Static package checks passed: ${count} files, version ${pkg.version}, bundled runtime, manifests, workflow, licenses and hashes.`);
