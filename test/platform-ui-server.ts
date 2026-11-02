// Isolated browser-test adapter, not a production server. No signing or upload routes.
// Unconfigured-state responses come from the real feature services, not canned fixtures.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {MediaService,createPinataProvider} from '../lib/media-service.mjs';
import {ProgramService} from '../lib/program-service.mjs';
import {ProgramStore} from '../lib/program-service-store.mjs';

const media=new MediaService({provider:createPinataProvider({jwt:''})});
const store=new ProgramStore(':memory:');
const programs=new ProgramService({manifest:[],enabled:false,store});
const files=new Map([['/','index.html'],['/index.html','index.html'],['/app.js','app.js'],['/style.css','style.css'],['/mark.svg','mark.svg']]);
const types={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',svg:'image/svg+xml'};
const server=createServer(async(req,res)=>{
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src https://dexscreener.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('cache-control','no-store');
  const json=(body,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
  try{
    const path=new URL(req.url||'/','http://localhost').pathname;
    if(req.method!=='GET')return json({error:'Isolated browser test server has no write routes.'},405);
    if(path==='/api/media/status')return json(media.status());
    if(path==='/api/programs')return json(await programs.list());
    if(path.startsWith('/api/'))return json({error:'Source unavailable in this isolated unconfigured-service browser check.'},404);
    const file=files.get(path);if(!file)return json({error:'Not found'},404);
    res.writeHead(200,{'content-type':types[file.split('.').at(-1)]});res.end(await readFile(new URL('../dist/'+file,import.meta.url)));
  }catch{json({error:'Isolated browser test service failed.'},500);}
});
server.listen(Number(process.env.PORT||4327),'127.0.0.1',()=>console.log('Isolated frontend test adapter: real unconfigured MediaService and ProgramService; no write routes.'));
const stop=()=>server.close(()=>{store.close();process.exit(0);});
process.on('SIGTERM',stop);process.on('SIGINT',stop);
