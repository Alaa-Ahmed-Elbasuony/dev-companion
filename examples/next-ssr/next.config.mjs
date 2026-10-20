/** @type {import('next').NextConfig} */
const nextConfig = {
  // Next.js 16 blocks dev resources (HMR, client chunks) for hosts other than localhost.
  // The automated tests open the app on 127.0.0.1.
  allowedDevOrigins: ['127.0.0.1'],
  experimental: {
    // Renders <meta name="traceparent"> into server-rendered HTML so the browser
    // navigation and the server render can be correlated by trace id.
    clientTraceMetadata: ['traceparent'],
  },
};

export default nextConfig;
