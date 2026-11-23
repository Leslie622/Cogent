/** 提示音的读写共用受管文件标识，兼容已保存的旧文件名。 */
import type { NotifyKind } from '../../shared/ipc'

const AUDIO_FILE = /^(?:turn-done|approval|question)-[^<>:"/\\|?*]+\.(?:mp3|wav|ogg|flac|m4a)$/i

export function managedSoundFileName(value: unknown, kind?: NotifyKind): string | undefined {
  if (typeof value !== 'string' || !AUDIO_FILE.test(value) ||
      Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return undefined
  if (kind !== undefined && !value.startsWith(kind + '-')) return undefined
  return value
}
