import './globals.css';

export const metadata = {
  title: 'Tiffany Designs voice agent',
  description: 'Talk to the Tiffany Designs customer service voice agent from your browser.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
