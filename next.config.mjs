/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // Metadata here is static, so always render it blocking in <head>. This removes the
  // UA-dependent <div hidden><Suspense name="Next.Metadata"> outlet from the start of <body>.
  htmlLimitedBots: /.*/,
}

export default nextConfig
