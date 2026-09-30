import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "server/tests/**/*.test.ts",
      "client/src/lib/realtime-compat.test.ts",
      "client/src/lib/realtime-compat-sdk.test.ts",
      "client/src/lib/realtime-compatibility.test.ts",
    ],
    environment: "node",
  },
});
