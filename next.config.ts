import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // GitHub Pages only hosts static files; relative URLs are applied to the
  // generated artifact by scripts/prepare-github-pages.mjs.
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;
