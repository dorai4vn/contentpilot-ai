import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "Football News Control Center", template: "%s · Football News Control Center" },
  description: "Điều hành luồng tin bóng đá, biên tập nội dung và quản lý xuất bản.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="vi" suppressHydrationWarning className={`${inter.variable} ${geistMono.variable} h-full antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `try{var t=localStorage.getItem("football-news-theme");if(t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}` }} />
      </head>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
