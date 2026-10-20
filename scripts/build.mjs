import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { createHash,randomUUID } from 'node:crypto';
import { readFile,writeFile,mkdir,cp,rename,rm,readdir } from 'node:fs/promises';
import { dirname,join,relative,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILL_TEXT } from '../src/workflow.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
if(!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version))throw Error('Use a semantic version in package.json');
const manifest=JSON.parse(await readFile(join(root,'src/plugin.json'),'utf8'));manifest.version=pkg.version;
const name=manifest.name, parent=join(root,'plugins'), dest=join(parent,name), tmp=join(parent,`.${name}.build-${randomUUID()}`), old=join(parent,`.${name}.previous-${randomUUID()}`);
await mkdir(join(tmp,'runtime/assets'),{recursive:true});
const json=async(path,data)=>writeFile(path,JSON.stringify(data,null,2)+'\n');
let moved=false,published=false;
try {
 await writeFile(join(root,'src/skills/debug-mode/SKILL.md'),SKILL_TEXT);
 const result=await build({absWorkingDir:root,entryPoints:{server:'src/server.mjs',receiver:'src/receiver.mjs'},outdir:join(tmp,'runtime'),outExtension:{'.js':'.mjs'},bundle:true,platform:'node',format:'esm',target:'node22',packages:'bundle',legalComments:'eof',metafile:true,write:true,banner:{js:'import { createRequire as __debugCreateRequire } from "node:module"; const require = __debugCreateRequire(import.meta.url);'}});
 const builtins=new Set(builtinModules.flatMap(x=>[x,x.replace(/^node:/,''),'node:'+x.replace(/^node:/,'')]));
 for(const output of Object.values(result.metafile.outputs))for(const imp of output.imports)if(imp.external&&!builtins.has(imp.path))throw Error('Unbundled dependency: '+imp.path);
 for(const file of ['view.mjs','client-state.mjs','launch.sh'])await cp(join(root,'src',file),join(tmp,'runtime',file));
 await cp(join(root,'src/assets/debug-card.html'),join(tmp,'runtime/assets/debug-card.html'));
 await mkdir(join(tmp,'assets'));await cp(join(root,'src/assets/icon.svg'),join(tmp,'assets/icon.svg'));
 await cp(join(root,'src/skills'),join(tmp,'skills'),{recursive:true});
 await json(join(tmp,'plugin.json'),manifest);
 await cp(join(root,'LICENSE'),join(tmp,'LICENSE'));
 await json(join(tmp,'package.json'),{name,version:pkg.version,private:true,type:'module',engines:{node:'>=22'}});
 const server={type:'stdio',command:'/bin/sh',args:['${PLUGIN_ROOT}/runtime/launch.sh'],cwd:'${PLUGIN_ROOT}'};
 await json(join(tmp,'mcp.json'),{$schema:'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',mcpServers:{'debug-mode':server}});
 await mkdir(join(tmp,'.codex-plugin'));
 const interfaceMeta=manifest.extensions['com.openai'].interface;
 await json(join(tmp,'.codex-plugin/plugin.json'),{name,version:pkg.version,description:manifest.description,author:manifest.author,keywords:manifest.keywords,requires_local_executor:true,skills:'./skills/',mcpServers:'./.mcp.json',interface:interfaceMeta});
 await json(join(tmp,'.mcp.json'),{mcpServers:{'debug-mode':{command:'/bin/sh',args:['./runtime/launch.sh'],cwd:'.',env_vars:['PATH','CODEX_MCP_NODE_PATH','CODEX_DEBUG_NODE_PATH'],tool_timeout_sec:120}}});
 // Retain license texts for packages actually included by the bundler.
 const packageDirs=new Set();
 for(const input of Object.keys(result.metafile.inputs)){
  if(!input.split('/').includes('node_modules'))continue;
  let folder=dirname(resolve(root,input));
  while(folder.startsWith(root)&&folder!==root){try{const candidate=JSON.parse(await readFile(join(folder,'package.json'),'utf8'));if(candidate.name&&candidate.version){packageDirs.add(folder);break;}}catch{}folder=dirname(folder);}
 }
 const notices=['# Bundled third-party notices','Generated from esbuild inputs. These licenses apply to bundled dependencies, not to the original Debug Mode source.'];const dependencies=[];
 for(const folder of [...packageDirs].sort()){
  const dependency=JSON.parse(await readFile(join(folder,'package.json'),'utf8'));
  const licenseFiles=(await readdir(folder)).filter(x=>/^(licen[cs]e|notice)(\.|$|-)/i.test(x)).sort();
  if(!licenseFiles.length)throw Error('No license text found for bundled package '+dependency.name);
  notices.push(`\n## ${dependency.name} ${dependency.version}\nLicense metadata: ${typeof dependency.license==='string'?dependency.license:JSON.stringify(dependency.license)}`);
  for(const file of licenseFiles)notices.push(`\n### ${file}\n\n${await readFile(join(folder,file),'utf8')}`);
  dependencies.push({name:dependency.name,version:dependency.version,license:dependency.license});
 }
 await writeFile(join(tmp,'THIRD_PARTY_NOTICES.md'),notices.join('\n')+'\n');
 const hashes={};async function collect(folder){for(const entry of await readdir(folder,{withFileTypes:true})){const path=join(folder,entry.name);if(entry.isSymbolicLink())throw Error('No symlinks in payload');if(entry.isDirectory())await collect(path);else hashes[relative(tmp,path).split('\\').join('/')]=createHash('sha256').update(await readFile(path)).digest('hex');}}await collect(tmp);
 await json(join(tmp,'BUILD_INFO.json'),{version:pkg.version,nodeTarget:'node22',dependencies,sha256:hashes});
 try{await rename(dest,old);moved=true;}catch(e){if(e.code!=='ENOENT')throw e;}
 await rename(tmp,dest);published=true;
 await mkdir(join(root,'.agents/plugins'),{recursive:true});
 await json(join(root,'.agents/plugins/marketplace.json'),{name:'codex-debug-mode',interface:{displayName:'Debug Mode Team'},plugins:[{name,source:{source:'local',path:`./plugins/${name}`},policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'},category:'开发工具',interface:{displayName:'Debug Mode'}}]});
 if(moved)await rm(old,{recursive:true});
 console.log(`Built ${name} ${pkg.version}: ${Object.keys(hashes).length+1} payload files; ${dependencies.length} bundled dependency packages.`);
}catch(error){if(moved&&!published)await rename(old,dest);throw error;}finally{await rm(tmp,{recursive:true,force:true});}
