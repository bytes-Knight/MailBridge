import { nativeImage, app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { logger } from './logger'

/**
 * Icon resolution result.
 */
interface IconAssets {
  /** Path to the best icon file found (or null if none found) */
  filePath: string | null
  /** NativeImage for use as tray icon (always valid — never empty) */
  trayImage: Electron.NativeImage
  /** NativeImage for use as window icon (always valid — never empty) */
  windowImage: Electron.NativeImage
  /** Source description for logging */
  source: string
}

let _cachedAssets: IconAssets | null = null

/**
 * Resolve the path to the best available application icon.
 *
 * Search order (cached after first call):
 *  1. resources/icon.ico  (alongside app resources in packaged build)
 *  2. resources/icon.png  (fallback to PNG)
 *  3. __dirname relative paths for dev mode
 *  4. process.cwd() relative paths
 *  5. Fallback: generate a 32×32 coloured square with "M" letter
 */
function resolveIconPaths(): IconAssets {
  const platform = process.platform

  // Collect candidate paths in priority order
  const candidates: string[] = []

  // 1) Packaged build — extraResources copies icons alongside the app
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'icon.ico'))
    candidates.push(path.join(process.resourcesPath, 'icon.png'))
  }

  // 2) App-relative (works in dev from out/main/, and in packaged)
  candidates.push(path.join(__dirname, '..', '..', 'resources', 'icon.ico'))
  candidates.push(path.join(__dirname, '..', '..', 'resources', 'icon.png'))
  candidates.push(path.join(app.getAppPath(), 'resources', 'icon.ico'))
  candidates.push(path.join(app.getAppPath(), 'resources', 'icon.png'))

  // 3) Project root (dev mode from project root)
  candidates.push(path.join(__dirname, '..', '..', 'icon.ico'))
  candidates.push(path.join(__dirname, '..', '..', 'icon.png'))

  // 4) Current working directory
  candidates.push(path.join(process.cwd(), 'icon.ico'))
  candidates.push(path.join(process.cwd(), 'icon.png'))
  candidates.push(path.join(process.cwd(), 'resources', 'icon.ico'))
  candidates.push(path.join(process.cwd(), 'resources', 'icon.png'))

  // Deduplicate while preserving order
  const seen = new Set<string>()
  const uniqueCandidates = candidates.filter(c => {
    if (seen.has(c)) return false
    seen.add(c)
    return true
  })

  // Find the first readable file
  let chosenPath: string | null = null
  let chosenLabel = 'none'

  for (const c of uniqueCandidates) {
    try {
      fs.accessSync(c, fs.constants.R_OK)
      chosenPath = c
      chosenLabel = path.basename(c)
      break
    } catch {
      // not accessible, try next
    }
  }

  // Build NativeImage from the path or generate fallback
  let trayImage: Electron.NativeImage
  let windowImage: Electron.NativeImage

  if (chosenPath) {
    const ext = path.extname(chosenPath).toLowerCase()

    // For the tray, we want a 16×16 or 32×32 version.
    // .ico files contain multiple sizes so we can load directly.
    // .png files need explicit resizing.
    if (ext === '.ico') {
      // On Windows, nativeImage handles .ico with multi-res correctly.
      // Don't resize — let the OS pick the right frame.
      trayImage = nativeImage.createFromPath(chosenPath)
      windowImage = nativeImage.createFromPath(chosenPath)
    } else {
      // PNG — resize for tray (16×16) and keep original for window
      trayImage = nativeImage.createFromPath(chosenPath).resize({
        width: 16,
        height: 16
      })
      windowImage = nativeImage.createFromPath(chosenPath)
    }

    // Sanity check: if the image is empty for some reason, regenerate
    if (trayImage.isEmpty()) {
      logger.warn('Icon loaded from path but NativeImage is empty, using fallback', { path: chosenPath })
      const fallback = generateFallbackIcon()
      trayImage = fallback.trayImage
      windowImage = fallback.windowImage
      chosenLabel = `${chosenLabel} (empty — using fallback)`
    }
  } else {
    const fallback = generateFallbackIcon()
    trayImage = fallback.trayImage
    windowImage = fallback.windowImage
    chosenLabel = 'generated fallback'
  }

  logger.info(`Icon resolved: ${chosenLabel}${chosenPath ? ` (${chosenPath})` : ''}`)

  return {
    filePath: chosenPath,
    trayImage,
    windowImage,
    source: chosenLabel
  }
}

/**
 * Generate a simple 32×32 icon with "M" letter on a branded background.
 * This is a last-resort fallback when no icon file can be found.
 */
function generateFallbackIcon(): { trayImage: Electron.NativeImage; windowImage: Electron.NativeImage } {
  const size = 32
  const canvas = Buffer.alloc(size * size * 4, 0)

  // Brand color: indigo (#6366f1)
  const r = 99, g = 102, b = 241

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4
      // Rounded square (rough approximation)
      const cx = size / 2, cy = size / 2
      const dx = Math.abs(x - cx), dy = Math.abs(y - cy)
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < size / 2 - 1) {
        canvas[idx] = r
        canvas[idx + 1] = g
        canvas[idx + 2] = b
        canvas[idx + 3] = 255
      } else if (dist < size / 2) {
        // Anti-aliased edge
        const alpha = Math.round((size / 2 - dist) * 255)
        canvas[idx] = r
        canvas[idx + 1] = g
        canvas[idx + 2] = b
        canvas[idx + 3] = alpha
      }
    }
  }

  const rawImage = nativeImage.createFromBuffer(canvas, {
    width: size,
    height: size
  })

  return {
    trayImage: rawImage.resize({ width: 16, height: 16 }),
    windowImage: rawImage
  }
}

/**
 * Get cached icon assets (lazily resolved on first call).
 */
export function getIconAssets(): IconAssets {
  if (!_cachedAssets) {
    _cachedAssets = resolveIconPaths()
  }
  return _cachedAssets
}

/**
 * Convenience: get a NativeImage suitable for the system tray.
 * Never returns an empty image.
 */
export function getTrayIcon(): Electron.NativeImage {
  return getIconAssets().trayImage
}

/**
 * Convenience: get a NativeImage suitable for window chrome / taskbar.
 * Never returns an empty image.
 */
export function getWindowIcon(): Electron.NativeImage {
  return getIconAssets().windowImage
}

/**
 * Convenience: get the best available icon file path, or null.
 */
export function getIconPath(): string | null {
  return getIconAssets().filePath
}

/**
 * For diagnostic purposes — returns info about the resolved icon.
 */
export function getIconDiagnostics(): Record<string, unknown> {
  const assets = getIconAssets()
  return {
    filePath: assets.filePath,
    source: assets.source,
    platform: process.platform,
    resourcesPath: process.resourcesPath || 'not set',
    appPath: app.getAppPath(),
    cwd: process.cwd(),
    __dirname: __dirname,
    trayImageEmpty: assets.trayImage.isEmpty(),
    windowImageEmpty: assets.windowImage.isEmpty(),
    trayImageSize: assets.trayImage.getSize(),
    windowImageSize: assets.windowImage.getSize()
  }
}

/**
 * Reset the cached assets (useful in tests or if icon files change at runtime).
 */
export function resetIconCache(): void {
  _cachedAssets = null
}
