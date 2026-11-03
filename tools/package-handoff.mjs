// Workspace-only exporter. Produces a portable staging folder; never copies secrets or Git history.
import { mkdir, readFile, writeFile, readdir, copyFile, stat, lstat } from 'node:fs/promises';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { scanText, TEXT_FILE } from './secret-scan.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const ownerTemplate=JSON.parse(await readFile(join(root,'deployment-owner.example.json'),'utf8'));
if(ownerTemplate.ownerAddress!==''||ownerTemplate.platformRecipientAddress!=='')throw new Error('Handoff ownership template must have blank owner and platform-recipient addresses. Local choices belong in runtime/deployment-owner.json.');
const destination=process.argv[2];
if(!destination)throw new Error('Usage: bun tools/package-handoff.mjs <new-empty-staging-directory>');
const out=resolve(destination);
try{await stat(out);throw new Error('Destination already exists; use a new staging directory.');}catch(error){if(error.code!=='ENOENT')throw error;}
await mkdir(out,{recursive:true});
const privatePath=/(^|\/)(node_modules|runtime|backups|broadcast|cache|out|\.git|\.ssh|keystores?)(\/|$)|(^|\/)(?:\.env(?!\.example$)|secrets\.env$|service\.env$|deployment-owner\.json$)|\.(sqlite(?:3)?|db|pem|key|p12|pfx)(?:-|$)/i;
async function files(dir){const result=[];for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isSymbolicLink())throw new Error('Package inputs must not contain symlinks');if(entry.isDirectory())result.push(...await files(path));else if(entry.isFile())result.push(path);}return result;}
async function sourceFiles(dir){const result=[];for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name),name=relative(root,path).replaceAll('\\','/');if(privatePath.test(name))continue;if(entry.isSymbolicLink())throw new Error('Package sources must not contain symlinks');if(entry.isDirectory())result.push(...await sourceFiles(path));else if(entry.isFile()&&/\.(mjs|js|ts|sol|md|json|html|css|svg|service|timer|example)$/.test(entry.name)||entry.isFile()&&entry.name==='Caddyfile')result.push(path);}return result;}
const viem=JSON.parse(await readFile(join(root,'../app/node_modules/viem/package.json'),'utf8'));
const pngjs=JSON.parse(await readFile(join(root,'../app/node_modules/pngjs/package.json'),'utf8'));
if(pngjs.version!=='5.0.0')throw new Error('Requalify the media decoder before changing pngjs 5.0.0');
for(const name of ['lib','web','test','tools','ops','workstreams','contracts/src','contracts/test','contracts/script']){
  for(const source of await sourceFiles(join(root,name))){
    if(source===fileURLToPath(import.meta.url))continue;
    const target=join(out,relative(root,source));await mkdir(dirname(target),{recursive:true});
    let text=await readFile(source,'utf8');
    text=text.replaceAll('../../app/node_modules/viem/_esm/index.js','viem');
    text=text.replaceAll('../../app/node_modules/viem/_esm/accounts/index.js','viem/accounts').replaceAll('../../app/node_modules/viem/_esm/chains/index.js','viem/chains');
    text=text.replaceAll('../../app/node_modules/pngjs/','pngjs/');
    let carbonPath=relative(dirname(target),join(out,'lib/vendor/carbon')).replaceAll('\\','/');if(!carbonPath.startsWith('.'))carbonPath='./'+carbonPath;
    text=text.replaceAll('../../app/src/lib/',carbonPath+'/');
    if(/\.(mjs|ts|js)$/.test(source)){
      const before=text;
      text=text.replaceAll("'C:/Users/shies/.bun/install/cache/playwright-core@1.62.1@@@1/index.mjs'", "portableFilePath(new URL('../node_modules/playwright-core/index.mjs',import.meta.url))")
        .replaceAll("'C:/Users/shies/.bun/install/cache/@accesslint/core@0.21.0@@@1/dist/index.iife.js'", "portableFilePath(new URL('../node_modules/@accesslint/core/dist/index.iife.js',import.meta.url))")
        .replace(/\s*\|\|\s*'C:\/Program Files\/Google\/Chrome\/Application\/chrome.exe'/g,'')
        .replace(/'C:\/Users\/shies\/AppData\/Local\/Temp\/opencode\/([^']+)'/g,"(portableTmpdir()+'/plugged-evidence/$1')");
      if(text!==before)text="import { fileURLToPath as portableFilePath } from 'node:url';\nimport { tmpdir as portableTmpdir } from 'node:os';\n"+text;
      if(/\.\.\/\.\.\/app\//.test(text))throw new Error('Unrewritten workspace import: '+relative(root,source));
    }
    await writeFile(target,text);
  }
}
await mkdir(join(out,'data'),{recursive:true});
for(const name of ['assets.json','carbon-deployment.json','carbon-pairs.json','pons-reference.json','quotes.json','deployment-profile.example.json'])await copyFile(join(root,'data',name),join(out,'data',name));
await mkdir(join(out,'lib/vendor/carbon'),{recursive:true});
for(const name of ['openingTick.ts','cid.ts','abi.ts'])await copyFile(join(root,'../app/src/lib',name),join(out,'lib/vendor/carbon',name));
for(const name of ['server.ts','.env.example','.gitignore','deployment-owner.example.json','PRODUCT.md','DESIGN.md','FEATURES.md','RESEARCH.md','ASSETS.md','VERIFICATION.md','HANDOFF.md','MVP.md','MVP-HANDOFF.md','PLATFORM-STATUS.md'])await copyFile(join(root,name),join(out,name));
await copyFile(join(root,'README.md'),join(out,'WORKSPACE-README.md'));
await copyFile(join(root,'MVP-HANDOFF.md'),join(out,'README.md'));
const config=await readFile(join(root,'contracts/foundry.toml'),'utf8');
await writeFile(join(out,'contracts/foundry.toml'),config.replaceAll('../../contracts','vendor/carbon'));
await copyFile(join(root,'contracts/ADVANCED-API.md'),join(out,'contracts/ADVANCED-API.md'));
// Copy only the Solidity import closure, never the upstream tree, runtime or deploy keys.
const upstream=resolve(root,'../contracts');
const mappings=[...config.matchAll(/"([^"=]+\/)=([^"\n]+)"/g)].map(([,prefix,target])=>({prefix,target:resolve(root,'contracts',target)})).sort((a,b)=>b.prefix.length-a.prefix.length);
const queue=(await sourceFiles(join(root,'contracts'))).filter(p=>p.endsWith('.sol'));
queue.push(...(await sourceFiles(join(root,'test'))).filter(p=>p.endsWith('.sol')));
const visited=new Set();
const within=(parent,path)=>{const rel=relative(parent,path);return !rel.startsWith('..')&&!isAbsolute(rel);};
while(queue.length){
  const source=queue.pop();if(visited.has(source))continue;visited.add(source);
  if(!within(root,source)&&!within(upstream,source))throw new Error('Solidity import escapes approved source roots');
  if((await lstat(source)).isSymbolicLink())throw new Error('Solidity symlink is not allowed');
  const text=await readFile(source,'utf8');
  if(within(upstream,source)){const target=join(out,'contracts/vendor/carbon',relative(upstream,source));await mkdir(dirname(target),{recursive:true});await writeFile(target,text);}
  for(const [,specifier] of text.matchAll(/\bimport\s+(?:[^;]*?\sfrom\s*)?["']([^"']+)["']\s*;/g)){
    if(specifier.startsWith('.'))queue.push(resolve(dirname(source),specifier));
    else {const mapping=mappings.find(m=>specifier.startsWith(m.prefix));if(!mapping)throw new Error('Unresolved Solidity import: '+specifier);queue.push(resolve(mapping.target,specifier.slice(mapping.prefix.length)));}
  }
}
const provenance=[];
for(const [name,url] of [['openzeppelin-contracts','https://github.com/OpenZeppelin/openzeppelin-contracts'],['forge-std','https://github.com/foundry-rs/forge-std'],['v4-periphery','https://github.com/Uniswap/v4-periphery'],['v4-periphery/lib/v4-core','https://github.com/Uniswap/v4-core'],['v4-periphery/lib/permit2','https://github.com/Uniswap/permit2'],['v4-periphery/lib/v4-core/lib/solmate','https://github.com/transmissions11/solmate']]){
  const source=resolve(upstream,'lib',name),target=join(out,'contracts/vendor/carbon/lib',name);
  await mkdir(target,{recursive:true});
  for(const entry of await readdir(source)){if(/^(LICENSE|COPYING|NOTICE)/i.test(entry)&&(await stat(join(source,entry))).isFile())await copyFile(join(source,entry),join(target,entry));}
  const git=Bun.spawnSync(['git','-C',source,'rev-parse','HEAD']);if(git.exitCode!==0)throw new Error('Cannot determine dependency provenance');
  provenance.push({name,source:url,commit:git.stdout.toString().trim(),included:'Reachable Solidity source files and root licenses only'});
}
for(const entry of await readdir(upstream)){if(/^(LICENSE|COPYING|NOTICE)/i.test(entry)&&(await stat(join(upstream,entry))).isFile())await copyFile(join(upstream,entry),join(out,'contracts/vendor/carbon',entry));}
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
pkg.scripts.start='bun run server.bundle.js';pkg.scripts.dev='bun run server.ts';
pkg.dependencies={viem:viem.version,pngjs:'5.0.0'};pkg.engines={bun:'1.3.9'};
await writeFile(join(out,'package.json'),JSON.stringify(pkg,null,2)+'\n');
await writeFile(join(out,'DEPENDENCY-PROVENANCE.json'),JSON.stringify({viem:viem.version,pngjs:'5.0.0',contracts:provenance},null,2)+'\n');
await writeFile(join(out,'PACKAGE-INDEX.md'),'# Portable Plugged handoff\n\n- Start: README.md\n- Integrated status: PLATFORM-STATUS.md and workstreams/integration.md\n- Operations and backups: ops/README.md\n- Exact API contracts: workstreams/\n- Deployment tooling: workstreams/deployment.md\n- Runtime: Bun 1.3.9. Optional browser checks require operator-installed playwright-core and @accesslint/core plus Chrome, or explicit module paths.\n- Run `bun test test/ tools/deployment.test.mjs`; network/fork and Anvil tests have separate prerequisites in their workstream reports.\n- All dependency source copies are import-closure allowlists, with licenses and per-file hashes. No live activation is asserted.\n');
const buildFile=join(out,'tools/build.mjs');
await writeFile(buildFile,(await readFile(buildFile,'utf8'))+`\nconst backend=await Bun.build({entrypoints:[new URL('server.ts',root).pathname.replace(/^\\/([A-Za-z]:)/,'$1')],outdir:new URL('.',root).pathname.replace(/^\\/([A-Za-z]:)/,'$1'),naming:'server.bundle.js',target:'bun',minify:true});\nif(!backend.success){console.error(backend.logs);process.exit(1);}\n`);
const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|HTTPS?_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(name)));
const install=Bun.spawnSync([process.execPath,'--no-env-file','install','--ignore-scripts'],{cwd:out,env,stdout:'inherit',stderr:'inherit'});
if(install.exitCode!==0)throw new Error('Standalone dependency install failed');
const build=Bun.spawnSync([process.execPath,'--no-env-file','run','build'],{cwd:out,env,stdout:'inherit',stderr:'inherit'});
if(build.exitCode!==0)throw new Error('Standalone build failed');
await mkdir(join(out,'licenses'),{recursive:true});
for(const path of await files(join(out,'node_modules'))){
  if(/^(LICENSE|LICENCE|COPYING|NOTICE)(\.|$)/i.test(path.split(/[\\/]/).at(-1))){
    const name=relative(join(out,'node_modules'),path).replaceAll('\\','__').replaceAll('/','__');await copyFile(path,join(out,'licenses',name));
  }
}
// Two explicit historical fork fixtures are runtime inputs of existing Solidity tests.
await mkdir(join(out,'artifacts'),{recursive:true});
for(const name of ['carbon-fork-fixtures.json','carbon-deployment-check.json'])await copyFile(join(root,'artifacts',name),join(out,'artifacts',name));
// Runtime ABI checks read these compiled artifacts. Ship ABI-only copies; `forge build` regenerates full ones.
const abiArtifacts=new Set();
for(const name of ['PluggedAdvancedFactory','PluggedLaunchRegistry','FeeHook','TradeRouter','PluggedAdvancedSplitter','PluggedAdvancedFeed']){
  abiArtifacts.add(`contracts/out/${name}.sol/${name}.json`);
  const source=join(root,'contracts/out',`${name}.sol`,`${name}.json`),target=join(out,'contracts/out',`${name}.sol`,`${name}.json`);
  const {abi}=JSON.parse(await readFile(source,'utf8'));if(!Array.isArray(abi))throw new Error(`Missing ABI in ${name} artifact; run forge build first.`);
  await mkdir(dirname(target),{recursive:true});await writeFile(target,JSON.stringify({abi})+'\n');
}
const hashes=[],leaks=[];
for(const path of await files(out)){
  const name=relative(out,path).replaceAll('\\','/');if(name.startsWith('node_modules/'))continue;
  if(privatePath.test(name)&&!abiArtifacts.has(name))throw new Error('Private/runtime path in release: '+name);
  const content=await readFile(path);hashes.push({path:name,bytes:content.length,sha256:createHash('sha256').update(content).digest('hex')});
  // L9: path rules miss secrets pasted into ordinary files; scan every shipped text file's content.
  if(TEXT_FILE.test(name))leaks.push(...scanText(content.toString('utf8'),name));
}
if(leaks.length)throw new Error('Secret-like content in release (values withheld):\n'+leaks.map(f=>`${f.path}:${f.line} ${f.rule}`).join('\n'));
await writeFile(join(out,'PACKAGE-MANIFEST.json'),JSON.stringify({createdAt:new Date().toISOString(),package:'Plugged developer handoff for Merc',transformations:['Standalone pinned viem and pngjs imports','Allowlisted Solidity import closure and licenses','Portable optional browser-tool defaults','Bundled backend and frozen frontend','Operations templates and workstream API contracts'],files:hashes},null,2)+'\n');
console.log(JSON.stringify({directory:out,files:hashes.length,sourceBytes:hashes.reduce((n,f)=>n+f.bytes,0),note:'Exclude node_modules when archiving. Verify from a clean extraction before delivery.'}));
