import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Career Dashboard',
  description: 'AI-powered job search and fit scoring',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
