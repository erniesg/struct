import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
const execute = promisify(execFile)
const cli = resolve('adapters/text/text2epub.mjs')
const paths = []
afterEach(async () => { await Promise.all(paths.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
async function fixture() {
 const dir = await mkdtemp(join(tmpdir(), 'text-cli-')); paths.push(dir)
 const input = join(dir, 'input.txt'), metadata = join(dir, 'metadata.json'), out = join(dir, 'out')
 const source = '  Prose & 😀\r\nADVERTISEMENT\r\nLast paragraph.\n'
 await writeFile(input, source)
 await writeFile(metadata, JSON.stringify({ title: 'Test book', subtitle: '', authors: ['A Writer'], abstract: '', language: 'en', publicationDate: '2013-10-21', publisher: 'A & B Press' }))
 return { dir, input, metadata, out, source }
}
function run(args) { return execute(process.execPath, [cli, ...args], { timeout: 10000 }) }
describe('text CLI', () => {
 it('explains usage and rejects unknown or missing options', async () => {
  expect((await run(['--help'])).stdout).toContain('--cleanup')
  await expect(run(['--wat'])).rejects.toMatchObject({ code: 1 })
  await expect(run(['x.txt', '--out'])).rejects.toMatchObject({ code: 1 })
 })
 it('preserves the original source and produces deterministic validated EPUB artifacts and hashes', async () => {
  const f = await fixture(); await run([f.input, '--metadata', f.metadata, '--out', f.out])
  expect(await readFile(join(f.out, 'source.txt'), 'utf8')).toBe(f.source)
  const d = JSON.parse(await readFile(join(f.out, 'document.struct.json'), 'utf8'))
  expect(d.blocks.map(b => b.text)).toEqual(['  Prose & 😀', 'ADVERTISEMENT', 'Last paragraph.'])
  const epub = await readFile(join(f.out, 'document.epub'))
  const opf = strFromU8(unzipSync(epub)['EPUB/package.opf'])
  expect(opf).toContain('<dc:publisher>A &amp; B Press</dc:publisher>')
  const report = JSON.parse(await readFile(join(f.out, 'ingestion-report.json'), 'utf8'))
  expect(report.artifacts['document.epub'].sha256).toBe(createHash('sha256').update(epub).digest('hex'))
  await run([f.input, '--metadata', f.metadata, '--out', join(f.dir, 'replay')])
  expect(await readFile(join(f.dir, 'replay', 'document.epub'))).toEqual(epub)
 })
 it('applies a bound cleanup plan while keeping removed text in the Struct graph', async () => {
  const f=await fixture(); const plan=join(f.dir,'plan.json')
  await writeFile(plan,JSON.stringify({schemaVersion:'1.0.0',sourceSha256:createHash('sha256').update(f.source).digest('hex'),actor:'human',decisions:[{blockId:'line-2',action:'remove',reason:'Advertisement label'}]}))
  await run([f.input,'--metadata',f.metadata,'--out',f.out,'--cleanup',plan])
  const d=JSON.parse(await readFile(join(f.out,'document.struct.json'),'utf8'))
  expect(d.blocks[1]).toMatchObject({kind:'furniture',text:'ADVERTISEMENT'})
  expect(await readFile(join(f.out,'document.xhtml'),'utf8')).not.toContain('ADVERTISEMENT')
  expect(JSON.parse(await readFile(join(f.out,'cleanup-plan.json'),'utf8')).decisions).toHaveLength(1)
 })
 it('saves review artifacts with exit code 2 and omits publication outputs', async () => {
  const f=await fixture();const plan=join(f.dir,'plan.json')
  await writeFile(plan,JSON.stringify({schemaVersion:'1.0.0',sourceSha256:createHash('sha256').update(f.source).digest('hex'),actor:'human',decisions:[{blockId:'line-2',action:'review',reason:'Could be a heading'}]}))
  await expect(run([f.input,'--metadata',f.metadata,'--out',f.out,'--cleanup',plan])).rejects.toMatchObject({code:2})
  const files=await readdir(f.out);expect(files).toContain('document.struct.json');expect(files).not.toContain('document.epub');expect(files).not.toContain('document.xhtml')
 })
 it('refuses an existing output destination and invalid cleanup without overwriting files', async () => {
  const f=await fixture()
  await expect(run([f.input,'--metadata',f.metadata,'--out',f.dir])).rejects.toMatchObject({code:1})
  expect(await readFile(f.input,'utf8')).toBe(f.source)
  const plan=join(f.dir,'plan.json');await writeFile(plan,'{"bad":true}')
  await expect(run([f.input,'--metadata',f.metadata,'--out',f.out,'--cleanup',plan])).rejects.toMatchObject({code:1})
  await expect(readdir(f.out)).rejects.toMatchObject({code:'ENOENT'})
 })
 it('rejects ambiguous model flags and output nested beneath a file', async () => {
  const f=await fixture()
  await expect(run([f.input,'--metadata',f.metadata,'--out',f.out,'--model','x'])).rejects.toMatchObject({code:1})
  await expect(run([f.input,'--metadata',f.metadata,'--out',join(f.input,'out')])).rejects.toMatchObject({code:1})
 })
 it('runs explicit model judgment through a fake CLI and binds its applied decisions', async () => {
  const f=await fixture(), fake=join(f.dir,'claude')
  await writeFile(fake,`#!${process.execPath}\nlet input='';for await(const chunk of process.stdin)input+=chunk;const sourceSha256=input.match(/SOURCE DIGEST: ([a-f0-9]{64})/)[1];const line=input.split('\\n').find(l=>l.startsWith('[{"id"'));const blocks=JSON.parse(line);console.log(JSON.stringify({type:'result',is_error:false,subtype:'success',structured_output:{schemaVersion:'1.0.0',sourceSha256,actor:'claude',decisions:blocks.map(b=>({blockId:b.id,action:b.text==='ADVERTISEMENT'?'remove':'keep',reason:'Fake regression classification'}))}}));`)
  await chmod(fake,0o755)
  await execute(process.execPath,[cli,f.input,'--metadata',f.metadata,'--out',f.out,'--judge','claude'],{timeout:10000,env:{...process.env,PATH:f.dir+':'+process.env.PATH}})
  const d=JSON.parse(await readFile(join(f.out,'document.struct.json'),'utf8'))
  expect(d.source.localOnly).toBe(false)
  expect(d.receipt.modelConsultations.decisions).toHaveLength(3)
  expect(d.blocks[1].kind).toBe('furniture')
  expect(JSON.parse(await readFile(join(f.out,'cleanup-plan.json'),'utf8')).consultation.promptSha256).toMatch(/^[a-f0-9]{64}$/)
 })
 it('validates metadata before starting any model subprocess', async () => {
  const f=await fixture(), marker=join(f.dir,'called'),fake=join(f.dir,'claude')
  await writeFile(fake,`#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(marker)},'yes')`);await chmod(fake,0o755)
  await writeFile(f.metadata,'{"title":7}')
  await expect(execute(process.execPath,[cli,f.input,'--metadata',f.metadata,'--out',f.out,'--judge','claude'],{timeout:10000,env:{...process.env,PATH:f.dir+':'+process.env.PATH}})).rejects.toMatchObject({code:1})
  await expect(readFile(marker)).rejects.toMatchObject({code:'ENOENT'})
  await expect(readdir(f.out)).rejects.toMatchObject({code:'ENOENT'})
 })

 it('rejects FIFO source inputs promptly instead of waiting for a writer', async () => {
  if(process.platform==='win32')return
  const f=await fixture(),pipe=join(f.dir,'pipe.txt')
  await execute('mkfifo',[pipe])
  await expect(execute(process.execPath,[cli,pipe,'--metadata',f.metadata,'--out',f.out],{timeout:1000})).rejects.toMatchObject({code:1,stderr:expect.stringContaining('regular file')})
  await expect(readdir(f.out)).rejects.toMatchObject({code:'ENOENT'})
 })

})
