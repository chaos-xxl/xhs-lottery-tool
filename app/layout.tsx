import type { Metadata } from 'next';
import Link from 'next/link';
import { Toaster } from 'sonner';
import { CookieStatusBadge } from '../components/cookie-status-badge';
import { SelfDestructButton } from '../components/self-destruct-button';
import './globals.css';

export const metadata: Metadata = {
  title: '小红书抽奖',
  description: '把粉丝的每一条留言，都郑重对待一次。',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-background antialiased">
        <header className="border-b border-border">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
            <Link href="/" className="flex items-center gap-2 text-sm font-medium">
              <span className="text-lg">🎁</span>
              <span>小红书抽奖</span>
            </Link>
            <nav className="flex items-center gap-4 text-sm">
              <Link href="/" className="text-muted-foreground hover:text-foreground">
                帖子
              </Link>
              <Link href="/history" className="text-muted-foreground hover:text-foreground">
                历史记录
              </Link>
              <CookieStatusBadge />
              <SelfDestructButton />
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
        <Toaster position="top-center" richColors closeButton />
      </body>
    </html>
  );
}
