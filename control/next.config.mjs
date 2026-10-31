import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
const config = { poweredByHeader: false, outputFileTracingRoot: root }

export default config
