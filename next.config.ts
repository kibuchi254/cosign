import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the dev badge clear of the sidebar mandate card and PayPal status.
  devIndicators: { position: "bottom-right" },
};

export default nextConfig;
