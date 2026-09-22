import { useEffect, useLayoutEffect } from "react";

export function markReactStartupMounted(): void {
  const markReactMounted = (
    window as Window & { __lulouMarkReactMounted?: () => void }
  ).__lulouMarkReactMounted;
  markReactMounted?.();
}

export function removeStartupLaunch(): void {
  markReactStartupMounted();
  document.getElementById("lulou-boot-shell")?.remove();
}

/** Controls the persistent pre-React launch node without replacing its logo. */
export function StartupLaunch({ exiting }: { exiting: boolean }) {
  useLayoutEffect(() => {
    markReactStartupMounted();
  }, []);

  useEffect(() => {
    const shell = document.getElementById("lulou-boot-shell");
    return () => {
      shell?.remove();
    };
  }, []);

  useEffect(() => {
    if (!exiting) return;
    document
      .getElementById("lulou-boot-shell")
      ?.classList.add("lulou-boot-shell--exit");
  }, [exiting]);

  return null;
}

export default StartupLaunch;