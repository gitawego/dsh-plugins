/** Termux storage-path translation: /storage/emulated/0/... and /sdcard/...
 *  are translated to the app-accessible Termux spelling (<home>/storage/<map>)
 *  so path resolution works on Android/Termux. Non-storage and non-Termux
 *  inputs pass through unchanged. */
import { describe, expect, it } from 'vitest'
import { isTermux, resolveInputPath, termuxStoragePath } from '../src/paths.ts'

const HOME = '/data/data/com.termux/files/home'

describe('termuxStoragePath (pure translation)', () => {
  it('maps /storage/emulated/0/DCIM/... to <home>/storage/dcim/...', () => {
    expect(termuxStoragePath('/storage/emulated/0/DCIM/Screenshots/x.jpg', HOME))
      .toBe(HOME + '/storage/dcim/Screenshots/x.jpg')
  })

  it('maps known top-level dirs to Termux symlink names', () => {
    expect(termuxStoragePath('/storage/emulated/0/Download/a.png', HOME)).toBe(HOME + '/storage/downloads/a.png')
    expect(termuxStoragePath('/storage/emulated/0/Pictures/b.jpg', HOME)).toBe(HOME + '/storage/pictures/b.jpg')
    expect(termuxStoragePath('/sdcard/Music/c.mp3', HOME)).toBe(HOME + '/storage/music/c.mp3')
  })

  it('maps unknown top-level dirs under shared/', () => {
    expect(termuxStoragePath('/storage/emulated/0/Custom/d.png', HOME)).toBe(HOME + '/storage/shared/Custom/d.png')
  })

  it('leaves non-storage, windows, and bare-root paths unchanged', () => {
    expect(termuxStoragePath('/tmp/plain.png', HOME)).toBe('/tmp/plain.png')
    expect(termuxStoragePath('C:\\pics\\a.png', HOME)).toBe('C:\\pics\\a.png')
    expect(termuxStoragePath('/storage/emulated/0', HOME)).toBe('/storage/emulated/0')
  })
})

describe('resolveInputPath (host-aware selection)', () => {
  it('never translates on a non-Termux host (no env markers, non-Termux home)', () => {
    const env = {} as NodeJS.ProcessEnv
    const linuxHome = '/home/ubuntu'
    expect(isTermux(env, linuxHome)).toBe(false)
    expect(resolveInputPath('/storage/emulated/0/DCIM/x.jpg', linuxHome, env, () => true))
      .toBe('/storage/emulated/0/DCIM/x.jpg')
  })

  it('detects Termux from the home path even without env markers', () => {
    const env = {} as NodeJS.ProcessEnv
    expect(isTermux(env, HOME)).toBe(true)
    expect(resolveInputPath('/storage/emulated/0/DCIM/x.jpg', HOME, env, () => true))
      .toBe(HOME + '/storage/dcim/x.jpg')
  })

  it('prefers the translated path on Termux when it exists', () => {
    const env = { TERMUX_VERSION: '0.118.1' } as NodeJS.ProcessEnv
    const exists = (path: string) => path.startsWith(HOME + '/storage/')
    expect(resolveInputPath('/storage/emulated/0/DCIM/x.jpg', HOME, env, exists))
      .toBe(HOME + '/storage/dcim/x.jpg')
  })

  it('falls back to the original on Termux when the translation does not exist', () => {
    const env = { TERMUX_VERSION: '0.118.1' } as NodeJS.ProcessEnv
    expect(resolveInputPath('/storage/emulated/0/DCIM/x.jpg', HOME, env, () => false))
      .toBe('/storage/emulated/0/DCIM/x.jpg')
  })

  it('leaves plain paths untouched on Termux', () => {
    const env = { TERMUX_VERSION: '0.118.1' } as NodeJS.ProcessEnv
    expect(resolveInputPath('/tmp/x.png', HOME, env, () => true)).toBe('/tmp/x.png')
  })
})

