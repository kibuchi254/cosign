import type { Metadata } from "next";
import "@fontsource-variable/public-sans";
import "@fontsource/jetbrains-mono/400.css";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    template: "%s · Cosign",
    default: "Cosign: an AI that pays your bills, with your signature",
  },
  description:
    "Cosign reads your invoices with AI and pays them through PayPal, but only within the limits you sign. Anything unusual waits for you.",
};

const THEME_SCRIPT = `try{var t=localStorage.getItem('cosign-theme');if(t!=='dark')t='light';document.documentElement.dataset.theme=t;if(localStorage.getItem('cosign-sidebar')==='collapsed')document.documentElement.dataset.sidebar='collapsed'}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html suppressHydrationWarning lang="en" className="h-full antialiased">
      <head>
        {/* Apply the saved theme and sidebar width before first paint, so neither flashes. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col" suppressHydrationWarning>{children}</body>
    </html>
  );
}
