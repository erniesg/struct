import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as processTools from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('node:child_process', async importOriginal => { const real=await importOriginal();return {...real,execFile:vi.fn(real.execFile)} })
import { saveNewDirectory } from '../adapters/text/artifacts.mjs'
const dirs=[]
afterEach(async()=>{const real=await vi.importActual('node:child_process');vi.mocked(processTools.execFile).mockReset();vi.mocked(processTools.execFile).mockImplementation(real.execFile);await Promise.all(dirs.splice(0).map(p=>fs.rm(p,{recursive:true,force:true})))})
async function fixture(){const root=await fs.mkdtemp(join(tmpdir(),'struct-output-'));dirs.push(root);return{root,out:join(root,'out'),files:new Map([['first.txt',Buffer.from('ours')],['second.txt',Buffer.from('ours too')]])}}
describe('atomic new output publication',()=>{
 it('publishes complete files exclusively and refuses an existing destination',async()=>{
  const f=await fixture();await saveNewDirectory(f.out,f.files);expect(await fs.readFile(join(f.out,'first.txt'),'utf8')).toBe('ours');await expect(saveNewDirectory(f.out,f.files)).rejects.toMatchObject({code:'EEXIST'})
 })
 it('preserves an empty competing directory created at the publication boundary',async()=>{
  const f=await fixture(),real=await vi.importActual('node:child_process');let before
  vi.mocked(processTools.execFile).mockImplementation((exe,args,options,callback)=>{fs.mkdir(f.out).then(()=>fs.stat(f.out)).then(info=>{before=info;real.execFile(exe,args,options,callback)}).catch(callback)})
  await expect(saveNewDirectory(f.out,f.files)).rejects.toMatchObject({code:'EEXIST'})
  const after=await fs.stat(f.out);expect(after.ino).toBe(before.ino);expect(after.dev).toBe(before.dev);expect(await fs.readdir(f.out)).toEqual([])
  expect(await fs.readdir(f.root)).toEqual(['out'])
 })
 it('preserves competing files and publishes nothing into their directory',async()=>{
  const f=await fixture(),real=await vi.importActual('node:child_process')
  vi.mocked(processTools.execFile).mockImplementation((exe,args,options,callback)=>{fs.mkdir(f.out).then(()=>fs.writeFile(join(f.out,'first.txt'),'their replacement')).then(()=>real.execFile(exe,args,options,callback)).catch(callback)})
  await expect(saveNewDirectory(f.out,f.files)).rejects.toMatchObject({code:'EEXIST'})
  expect(await fs.readFile(join(f.out,'first.txt'),'utf8')).toBe('their replacement');expect(await fs.readdir(f.out)).toEqual(['first.txt'])
 })
 it('refuses a destination symlink without following or replacing it',async()=>{
  const f=await fixture(),other=join(f.root,'other');await fs.mkdir(other);await fs.symlink(other,f.out)
  await expect(saveNewDirectory(f.out,f.files)).rejects.toMatchObject({code:'EEXIST'});expect(await fs.readlink(f.out)).toBe(other);expect(await fs.readdir(other)).toEqual([])
 })
 it('rejects unsafe filenames before creating an output directory',async()=>{
  const f=await fixture();await expect(saveNewDirectory(f.out,new Map([['../bad',Buffer.from('x')]]))).rejects.toThrow(/filename/);await expect(fs.stat(f.out)).rejects.toMatchObject({code:'ENOENT'})
 })
})
