import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ReadRoom — 多机联读',
  description: '把一份 transcript 分给一屋子的电脑，各自用自己的音色念出来',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
