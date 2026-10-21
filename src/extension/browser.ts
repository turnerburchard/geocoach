declare const browser: typeof chrome | undefined;
export const ext = typeof browser === "undefined" ? chrome : browser;
