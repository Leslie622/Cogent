/** 仅测试使用：记录握手响应写出前真正加载的模块与文件，不计后台厂商预热。 */
import fs from 'node:fs'
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'

const files = new Set()
const read = fs.readFileSync
fs.readFileSync = function (file, ...args) {
  if (typeof file === 'string') files.add(file)
  else if (file instanceof URL) files.add(fileURLToPath(file))
  return read.call(this, file, ...args)
}
syncBuiltinESMExports()
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith('file:')) files.add(fileURLToPath(url))
    return nextLoad(url, context)
  }
})
const write = process.stdout.write
let captured = false
process.stdout.write = function (chunk, ...args) {
  if (!captured && String(chunk).includes('"service":"cogent-agent"')) {
    captured = true
    for (const file of Object.keys(createRequire(import.meta.url).cache)) files.add(file)
    fs.writeFileSync(process.env.COGENT_STARTUP_MODULES_OUT, JSON.stringify([...files]))
  }
  return write.call(this, chunk, ...args)
}
