/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // the audio engine holds real AudioContext state; double-mount breaks it
};

export default nextConfig;
