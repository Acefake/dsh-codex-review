#!/usr/bin/env node
/**
 * Minimal read-only reader for Electron asar archives.
 *
 * Usage:
 *   node asar-read.mjs ls  <archive> <dir>            list entries under a dir
 *   node asar-read.mjs cat <archive> <file> [--out]   print / write one file
 *   node asar-read.mjs extract <archive> <dir> <dest> extract a subtree
 *
 * The whole point is that shell tools, node's own fs, and ripgrep cannot see
 * inside an asar archive on disk, while `read`/`grep` tools cannot walk it
 * efficiently either. This script decodes the container so the packaged
 * sources can be grepped after extraction.
 */
import fs from 'node:fs'
import path from 'node:path'

/** Read the archive header and the data-area offset. */
function readArchive(archive) {
  const fd = fs.openSync(archive, 'r')
  try {
    const sizeBuf = Buffer.alloc(8)
    fs.readSync(fd, sizeBuf, 0, 8, 0)
    // Pickle layout: [uint32 payloadSize][payload...]; the first pickle holds
    // one uint32 (the size of the second pickle), so the value is at byte 4.
    const headerPickleSize = sizeBuf.readUInt32LE(4)
    const headerBuf = Buffer.alloc(headerPickleSize)
    fs.readSync(fd, headerBuf, 0, headerPickleSize, 8)
    // Second pickle holds one string:
    // [uint32 payloadSize][uint32 stringLength][json bytes][padding]
    const jsonSize = headerBuf.readUInt32LE(4)
    const json = headerBuf.subarray(8, 8 + jsonSize).toString('utf8')
    const header = JSON.parse(json)
    return {
      header,
      dataOffset: 8 + headerPickleSize,
      fd,
    }
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
}

function walk(node, prefix, out) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const p = prefix === '' ? name : `${prefix}/${name}`
    if (child.files) walk(child, p, out)
    else out.push({ path: p, entry: child })
  }
  return out
}

function findEntry(header, target) {
  const parts = target.split('/').filter(Boolean)
  let node = header
  for (const part of parts) {
    if (!node.files) return undefined
    node = node.files[part]
    if (node === undefined) return undefined
  }
  return node
}

function readFile(archive, entry, dataOffset) {
  if (entry.unpacked) {
    const unpacked = archive.replace(/app\.asar$/, 'app.asar.unpacked')
    return fs.readFileSync(path.join(unpacked, entry.path ?? ''))
  }
  const fd = fs.openSync(archive, 'r')
  try {
    const buf = Buffer.alloc(entry.size)
    fs.readSync(fd, buf, 0, entry.size, dataOffset + Number(entry.offset))
    return buf
  } finally {
    fs.closeSync(fd)
  }
}

function main() {
  const [command, archive, target, dest] = process.argv.slice(2)
  if (!command || !archive) {
    console.error('usage: asar-read.mjs <ls|cat|extract> <archive> <target> [dest]')
    process.exit(2)
  }
  const { header, dataOffset } = readArchive(archive)

  if (command === 'ls') {
    const dir = target ?? ''
    const entries = walk(header, '', [])
    const prefix = dir === '' ? '' : `${dir.replace(/\/$/, '')}/`
    for (const { path: p, entry } of entries) {
      if (p.startsWith(prefix)) {
        console.log(`${entry.unpacked ? 'U' : ' '} ${String(entry.size).padStart(9)} ${p}`)
      }
    }
    return
  }

  if (command === 'cat') {
    const entry = findEntry(header, target)
    if (!entry || entry.files) {
      console.error(`not a file: ${target}`)
      process.exit(1)
    }
    const buf = readFile(archive, { ...entry, path: target }, dataOffset)
    process.stdout.write(buf)
    return
  }

  if (command === 'extract') {
    const prefix = target.replace(/\/$/, '')
    const entries = walk(header, '', []).filter(
      ({ path: p }) => p === prefix || p.startsWith(`${prefix}/`),
    )
    if (entries.length === 0) {
      console.error(`no entries under ${target}`)
      process.exit(1)
    }
    for (const { path: p, entry } of entries) {
      const rel = p.slice(prefix.length).replace(/^\//, '')
      const outPath = path.join(dest, rel)
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      fs.writeFileSync(outPath, readFile(archive, { ...entry, path: p }, dataOffset))
    }
    console.log(`extracted ${entries.length} files to ${dest}`)
    return
  }

  console.error(`unknown command: ${command}`)
  process.exit(2)
}

main()
