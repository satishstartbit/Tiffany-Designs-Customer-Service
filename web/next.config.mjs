import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The repository root has the Express server's own package-lock.json; this app only uses what is in web/.
const appRoot = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: appRoot,
  turbopack: { root: appRoot },
};

export default nextConfig;
