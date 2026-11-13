/**
 * 存储层出口（目录内唯一 import 点，同 protocol/ 手法）。
 */
export type { StorageDriver, StoredDocument } from './driver'
export { JsonStorageDriver } from './json-driver'
export type { InspectRecord } from './inspect-store'
export { InspectStore } from './inspect-store'
