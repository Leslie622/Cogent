/**
 * 引擎侧输出文件（临时落盘给模型/用户回看的产物：被截断工具输出的全文、
 * 未来的 bash 全量日志 / MCP 二进制资源）。
 *
 * 搬运自 pi 上游 reference/pi/packages/coding-agent/src/utils/output-files.ts
 * （MIT License, Copyright (c) 2025 Mario Zechner），算法原样。所有输出文件
 * 收口在本模块创建 —— 将来要挪位置（如 ~/.cogent/output/）只改这一处。
 */

import { randomBytes } from 'node:crypto'
import { createWriteStream, type WriteStream } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 输出可能带私有数据，文件权限只许本用户读（Windows 上 mode 近似为 ACL，无害） */
const OUTPUT_FILE_MODE = 0o600

/** 生成未占用的新路径：`<tmp>/<prefix>-<random hex><extension>`（extension 含点） */
function createOutputFilePath(prefix: string, extension: string): string {
  return join(tmpdir(), `${prefix}-${randomBytes(8).toString('hex')}${extension}`)
}

/** 把 data 写入新输出文件并返回路径 */
export async function writeOutputFile(
  prefix: string,
  extension: string,
  data: string | Uint8Array
): Promise<string> {
  const path = createOutputFilePath(prefix, extension)
  // `wx` = 存在即失败：不跟进别人放好的同名链接/文件（随机名下仍是一道防线）
  await writeFile(path, data, { mode: OUTPUT_FILE_MODE, flag: 'wx' })
  return path
}

/** 为流式输出打开新输出文件（OutputAccumulator 超限转存用） */
export function createOutputFileStream(
  prefix: string,
  extension: string
): { path: string; stream: WriteStream } {
  const path = createOutputFilePath(prefix, extension)
  return { path, stream: createWriteStream(path, { mode: OUTPUT_FILE_MODE, flags: 'wx' }) }
}
