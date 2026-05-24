import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.lulou.dating",
  appName: "Lulou",
  webDir: "dist/public",
  server: {
    androidScheme: "https",
  },
  ios: {
    contentInset: "automatic",
    backgroundColor: "#fdf6f0",
  },
};

export default config;
