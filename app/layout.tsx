import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "偏爱 PALACE · 你的多智能体庭院",
  description: "相遇、偏爱与共同完成。一个有独立人格、长短期记忆和自发协作的私人多智能体庭院。",
  icons: { icon: "/brand/palace-mark-64.png", apple: "/brand/palace-mark-128.png" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
