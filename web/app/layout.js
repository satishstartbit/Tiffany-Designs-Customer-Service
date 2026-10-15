import { Red_Hat_Display } from 'next/font/google';
import './globals.css';

// A light geometric sans, close to the ROCCO storefront's type.
const font = Red_Hat_Display({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-sans', display: 'swap' });

export const metadata = {
  title: { default: 'Tiffany Designs · Service console', template: '%s · Tiffany Designs' },
  description: 'Products, orders, cases and service requests for the Tiffany Designs customer service team, with the AI voice agent.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={font.variable}>
      <body>{children}</body>
    </html>
  );
}
