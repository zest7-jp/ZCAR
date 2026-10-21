import type { Metadata, Viewport } from "next";
import "./globals.css";
import {
  CAR_DEVICE_KEY,
  PHONE_LONG_EDGE_MAX,
  PHONE_SETUP_SKIP_KEY,
} from "./settings-store";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/**
 * スマホから開いたときに設定ページへ送るための先読みスクリプト。
 * React の読み込みを待つとダッシュボードが一瞬映ってしまうので、
 * HTML を読んでいる途中(まだ何も描画されていない時点)で判定する。
 *
 * 判定の順番:
 *   1. ?app=0 なら車載機の印を消す(誤って付けたときの戻し方)
 *   2. ?app=1 なら車載機として覚え、以後は画面の大きさに関係なく送らない
 *   3. 車載機として覚えていれば送らない
 *   4. iPhone/iPod か、画面の長辺が短ければスマホとして設定ページへ送る
 */
const phoneRedirectScript = `(function(){try{
var b=${JSON.stringify(basePath)};
var CAR=${JSON.stringify(CAR_DEVICE_KEY)};
if(location.pathname.indexOf(b+"/settings")===0)return;
if(/[?&]app=0(&|$)/.test(location.search)){try{localStorage.removeItem(CAR);sessionStorage.removeItem(${JSON.stringify(PHONE_SETUP_SKIP_KEY)})}catch(e){}}
else if(/[?&]app(=|&|$)/.test(location.search)){try{localStorage.setItem(CAR,"car");sessionStorage.setItem(${JSON.stringify(PHONE_SETUP_SKIP_KEY)},"1")}catch(e){}return}
try{if(localStorage.getItem(CAR)==="car")return}catch(e){}
try{if(sessionStorage.getItem(${JSON.stringify(PHONE_SETUP_SKIP_KEY)})==="1")return}catch(e){}
var ua=navigator.userAgent||"";
var longEdge=Math.max(window.innerWidth,window.innerHeight);
if(!/iPhone|iPod/.test(ua)&&longEdge>=${PHONE_LONG_EDGE_MAX})return;
location.replace(b+"/settings/")
}catch(e){}})();`;

const ICON_VERSION = 2;

export const metadata: Metadata = {
  title: "Z CAR",
  description: "PORMIDO G10向け Zポータル・カーナビホーム",
  // アイコンの絵を変えたら ICON_VERSION を上げる(車や iPhone に貯まった古い絵を使わせないため)。
  manifest: `${basePath}/manifest.webmanifest?v=${ICON_VERSION}`,
  icons: {
    icon: [
      { url: `${basePath}/favicon.svg?v=${ICON_VERSION}`, type: "image/svg+xml" },
      { url: `${basePath}/icon-192.png?v=${ICON_VERSION}`, sizes: "192x192", type: "image/png" },
    ],
    shortcut: `${basePath}/favicon.svg?v=${ICON_VERSION}`,
    // iPhoneでホーム画面に追加したときのアイコン(近未来の、光る水色のメーターと Z)。
    apple: [
      { url: `${basePath}/apple-touch-icon.png?v=${ICON_VERSION}`, sizes: "180x180", type: "image/png" },
    ],
  },
  // ホーム画面に並んだときの名前。
  appleWebApp: {
    title: "Z CAR",
  },
  openGraph: {
    title: "Z CAR",
    description: "Z PORTAL | CAR",
    images: [`${basePath}/og.png`],
  },
  twitter: {
    card: "summary_large_image",
    title: "Z CAR",
    description: "Z PORTAL | CAR",
    images: [`${basePath}/og.png`],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#0b0d10",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>
        <script dangerouslySetInnerHTML={{ __html: phoneRedirectScript }} />
        {children}
      </body>
    </html>
  );
}
