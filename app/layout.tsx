import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Transcript Reader',
  description: 'Hand a transcript to every computer in the room and let each read its part in its own voice',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
