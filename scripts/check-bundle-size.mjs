import { readdir, readFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

const KIB = 1024
export const MAX_CHUNK_GZIP_BYTES = 180 * KIB
export const MAX_TOTAL_GZIP_BYTES = 220 * KIB

async function listJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) return listJavaScriptFiles(path)
      return entry.isFile() && entry.name.endsWith('.js') ? [path] : []
    })
  )
  return nested.flat()
}

export async function measureJavaScriptBundles(distDirectory = resolve('dist')) {
  const root = resolve(distDirectory)
  const files = (await listJavaScriptFiles(root)).sort()
  if (files.length === 0) throw new Error(`No JavaScript bundles found under ${root}`)

  return Promise.all(
    files.map(async (path) => {
      const contents = await readFile(path)
      return {
        path: relative(root, path),
        rawBytes: contents.byteLength,
        gzipBytes: gzipSync(contents, { level: 9 }).byteLength
      }
    })
  )
}

export function evaluateBundleBudget(measurements) {
  const largest = measurements.reduce((current, item) =>
    item.gzipBytes > current.gzipBytes ? item : current
  )
  const totalGzipBytes = measurements.reduce((total, item) => total + item.gzipBytes, 0)
  const errors = []
  if (largest.gzipBytes > MAX_CHUNK_GZIP_BYTES) {
    errors.push(
      `largest chunk ${largest.path} is ${formatKiB(largest.gzipBytes)}, limit ${formatKiB(MAX_CHUNK_GZIP_BYTES)}`
    )
  }
  if (totalGzipBytes > MAX_TOTAL_GZIP_BYTES) {
    errors.push(
      `total JavaScript is ${formatKiB(totalGzipBytes)}, limit ${formatKiB(MAX_TOTAL_GZIP_BYTES)}`
    )
  }
  return { largest, totalGzipBytes, errors }
}

function formatKiB(bytes) {
  return `${(bytes / KIB).toFixed(2)} KiB gzip`
}

async function main() {
  const measurements = await measureJavaScriptBundles()
  console.log('JavaScript bundle measurements:')
  for (const item of measurements) {
    console.log(
      `- ${item.path}: ${formatKiB(item.gzipBytes)} (${(item.rawBytes / KIB).toFixed(2)} KiB raw)`
    )
  }

  const result = evaluateBundleBudget(measurements)
  console.log(`Largest chunk: ${result.largest.path} at ${formatKiB(result.largest.gzipBytes)}`)
  console.log(`Total dist JavaScript: ${formatKiB(result.totalGzipBytes)}`)

  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`BUDGET_EXCEEDED: ${error}`)
    process.exitCode = 1
    return
  }
  console.log('Bundle budget passed.')
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
