#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, lstat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { encodeStructDocument } from '../../dist/document/index.js'
import { buildStructEpub } from '../../dist/renderers/epub.js'
import { renderPublicationXhtml } from '../../dist/renderers/xhtml.js'
import { inspectText, ingestText, validateCleanupPlan } from './ingest.mjs'
import { judgeText } from './judge.mjs'
import { saveNewDirectory } from './artifacts.mjs'
const HELP = `Usage: node adapters/text/text2epub.mjs input.txt --metadata metadata.json --out NEW_DIRECTORY
  --cleanup plan.json       Replay a source-bound cleanup plan
  --judge codex|claude       Ask an installed CLI to classify cleanup (sends source text)
  --model NAME              Model used by --judge
  --timeout-ms N            Judgment deadline (default 120000, maximum 600000)
  --help                    Show usage
No judgment or deletion occurs by default. Review decisions save a draft and exit 2.
Run npm run build before using this reference adapter.\n`
function parse(argv) {
 const args = {}; const keys = new Map([['--metadata','metadata'],['--out','out'],['--cleanup','cleanup'],['--judge','judge'],['--model','model'],['--timeout-ms','timeoutMs']])
 if (argv.length === 1 && argv[0] === '--help') return {help:true}
 for(let i=0;i<argv.length;i++) {
  const item=argv[i]
  if (keys.has(item)) {
   const key=keys.get(item); if(args[key]!==undefined) throw new Error(`duplicate option ${item}`)
   const value=argv[++i];if(!value||value.startsWith('--'))throw new Error(`missing value for ${item}`)
   args[key]=value
  } else if(item.startsWith('-'))throw new Error(`unknown option ${item}`)
  else if(args.input)throw new Error('only one input file is supported')
  else args.input=item
 }
 if(!args.input||!args.metadata||!args.out)throw new Error('input, --metadata and --out are required')
 if(args.cleanup&&args.judge)throw new Error('--cleanup and --judge are mutually exclusive')
 if(args.judge&&!['codex','claude'].includes(args.judge))throw new Error('--judge must be codex or claude')
 if((args.model||args.timeoutMs)&&!args.judge)throw new Error('--model and --timeout-ms require --judge')
 if(args.timeoutMs!==undefined) {if(!/^\d+$/.test(args.timeoutMs))throw new Error('invalid timeout');args.timeoutMs=Number(args.timeoutMs);if(!Number.isSafeInteger(args.timeoutMs)||args.timeoutMs<1||args.timeoutMs>600000)throw new Error('timeout must be 1..600000ms')}
 return args
}
async function readBounded(path, maximum) {
 const handle=await open(path,constants.O_RDONLY | constants.O_NONBLOCK)
 try {
  const info=await handle.stat();if(!info.isFile())throw new Error('input must be a regular file');if(info.size>maximum)throw new Error('input file exceeds size limit')
  const buffer=Buffer.alloc(maximum+1);let length=0
  while(length<buffer.length) {const {bytesRead}=await handle.read(buffer,length,buffer.length-length,null);if(bytesRead===0)break;length+=bytesRead}
  if(length>maximum)throw new Error('input file exceeds size limit')
  return buffer.subarray(0,length)
 } finally {await handle.close()}
}
async function readJson(path, maximum) {
 const bytes=await readBounded(path,maximum)
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))
}
async function assertNewDestination(path) {
 try {await lstat(path)} catch(error) {if(error.code==='ENOENT')return;throw error}
 throw new Error('output destination already exists; choose a new directory')
}
const jsonBytes = value => Buffer.from(JSON.stringify(value,null,2)+'\n')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function main() {
 const args=parse(process.argv.slice(2));if(args.help){process.stdout.write(HELP);return}
 const out=resolve(args.out);await assertNewDestination(out)
 const source=await readBounded(args.input,1024*1024),metadata=await readJson(args.metadata,256*1024)
 // Validate source and metadata before invoking a model.
 await ingestText(source,{fileName:basename(args.input),metadata})
 const request=inspectText(source)
 let cleanupPlan
 if(args.cleanup)cleanupPlan=validateCleanupPlan(await readJson(args.cleanup,4*1024*1024),request)
 if(args.judge)cleanupPlan=await judgeText(source,{engine:args.judge,model:args.model,timeoutMs:args.timeoutMs})
 const {document,report}=await ingestText(source,{fileName:basename(args.input),metadata,cleanupPlan})
 const pending=document.recovery.status==='review-required'
 const files=new Map([['source.txt',source],['document.struct.json',jsonBytes(encodeStructDocument(document))]])
 if(cleanupPlan)files.set('cleanup-plan.json',jsonBytes(cleanupPlan))
 if(!pending) {
  files.set('document.xhtml',Buffer.from(renderPublicationXhtml(document,{embedStyles:true})))
  const epub=await buildStructEpub(document);files.set('document.epub',epub.bytes)
 }
 const artifacts=Object.fromEntries([...files].map(([name,bytes])=>[name,{sha256:digest(bytes),byteLength:bytes.length}]))
 files.set('ingestion-report.json',jsonBytes({...report,status:pending?'review-required':'ready',artifacts}))
 await saveNewDirectory(out,files)
 process.stdout.write(`${pending?'Review required':'EPUB created'}: ${out}\n`)
 if(pending)process.exitCode=2
}
main().catch(error=>{process.stderr.write(`text2epub: ${error.message}\n`);process.exitCode=1})
