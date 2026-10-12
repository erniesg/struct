import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('node:fs/promises', async importOriginal => { const real=await importOriginal();return {...real,link:vi.fn(real.link)} })
import { saveNewDirectory } from '../adapters/text/artifacts.mjs'
const dirs=[]
afterEach(async()=>{vi.mocked(fs.link).mockReset();const real=await vi.importActual('node:fs/promises');vi.mocked(fs.link).mockImplementation(real.link);await Promise.all(dirs.splice(0).map(p=>fs.rm(p,{recursive:true,force:true})))})
async function fixture(){const root=await fs.mkdtemp(join(tmpdir(),'struct-output-'));dirs.push(root);return{root,out:join(root,'out'),files:new Map([['first.txt',Buffer.from('ours')],['second.txt',Buffer.from('ours too')]])}}
describe('new output publication',()=>{
 it('publishes complete files exclusively and refuses an existing destination',async()=>{
  const f=await fixture();await saveNewDirectory(f.out,f.files);expect(await fs.readFile(join(f.out,'first.txt'),'utf8')).toBe('ours');await expect(saveNewDirectory(f.out,f.files)).rejects.toMatchObject({code:'EEXIST'})
 })
 it('never removes a competing file replacement when later publication fails',async()=>{
  const f=await fixture(),real=await vi.importActual('node:fs/promises');let calls=0
  vi.mocked(fs.link).mockImplementation(async(from,to)=>{calls++;if(calls===1){await real.link(from,to);await real.unlink(to);await real.writeFile(to,'their replacement');return}throw Object.assign(new Error('concurrent destination'),{code:'EEXIST'})})
  await expect(saveNewDirectory(f.out,f.files)).rejects.toThrow(/publication incomplete/)
  expect(await fs.readFile(join(f.out,'first.txt'),'utf8')).toBe('their replacement')
  expect(await fs.readdir(f.root)).toEqual(['out'])
 })
 it('never removes a competing directory replacement during a publication failure',async()=>{
  const f=await fixture(),real=await vi.importActual('node:fs/promises');let calls=0,replacement
  vi.mocked(fs.link).mockImplementation(async(from,to)=>{calls++;if(calls===1){await real.link(from,to);return}await real.rm(f.out,{recursive:true});await real.mkdir(f.out);replacement=await real.stat(f.out);throw Object.assign(new Error('concurrent directory'),{code:'EEXIST'})})
  await expect(saveNewDirectory(f.out,f.files)).rejects.toThrow(/publication incomplete/)
  const remains=await fs.stat(f.out);expect(remains.ino).toBe(replacement.ino);expect(remains.dev).toBe(replacement.dev)
 })
 it('rejects unsafe filenames before creating an output directory',async()=>{
  const f=await fixture();await expect(saveNewDirectory(f.out,new Map([['../bad',Buffer.from('x')]]))).rejects.toThrow(/filename/);await expect(fs.stat(f.out)).rejects.toMatchObject({code:'ENOENT'})
 })
})
