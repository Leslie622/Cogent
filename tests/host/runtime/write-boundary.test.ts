/** 审批规则只匹配本次实际目标所在的工作区根。 */
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { matchingWriteRoots } from '../../../src/host/runtime/write-boundary'

it('保留目标所在的根，拒绝仅有同名前缀的兄弟路径', () => {
  const one = resolve('workspace', 'first')
  const two = resolve('workspace', 'second')
  expect(matchingWriteRoots('../second/file.txt', one, [one, two])).toEqual([two])
  expect(matchingWriteRoots(join(one + '-private', 'file.txt'), one, [one, two])).toEqual([])
  expect(matchingWriteRoots('.', one, [one, two])).toEqual([one])
  expect(matchingWriteRoots('@' + pathToFileURL(join(two, 'file.txt')).href, one, [one])).toEqual([])
})

it('大小写比较遵循运行平台的路径规则', () => {
  const root = resolve('workspace', 'Source')
  const target = resolve('workspace', 'source', 'file.txt')
  expect(matchingWriteRoots(target, root, [root])).toEqual(process.platform === 'win32' ? [root] : [])
})
