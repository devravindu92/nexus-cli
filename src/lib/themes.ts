import type { ITheme } from "@xterm/xterm";

export type ThemePref = "system" | "dark" | "light";
export type ThemeName = "dark" | "light";

export const ACCENTS = [
  "#8b9cff",
  "#5eead4",
  "#f0a35e",
  "#f472b6",
  "#a3e635",
  "#38bdf8",
  "#c084fc",
  "#facc15",
  "#f87171",
];

export const TERMINAL_THEMES: Record<ThemeName, ITheme> = {
  dark: {
    background: "#0d0e12",
    foreground: "#d7dae0",
    cursor: "#8b9cff",
    cursorAccent: "#0d0e12",
    selectionBackground: "#3a4270",
    black: "#1c1e26",
    red: "#f07178",
    green: "#a5d68a",
    yellow: "#e6c07b",
    blue: "#7aa2f7",
    magenta: "#c792ea",
    cyan: "#5ccfe6",
    white: "#c8ccd4",
    brightBlack: "#5c6370",
    brightRed: "#ff8b92",
    brightGreen: "#bae6a0",
    brightYellow: "#f5d491",
    brightBlue: "#9ab8ff",
    brightMagenta: "#ddb0f5",
    brightCyan: "#84e1f2",
    brightWhite: "#ffffff",
  },
  light: {
    background: "#ffffff",
    foreground: "#24262d",
    cursor: "#4a56c8",
    cursorAccent: "#ffffff",
    selectionBackground: "#c9d0ff",
    black: "#24262d",
    red: "#c4343c",
    green: "#3d8a2e",
    yellow: "#a36a00",
    blue: "#2f5fd0",
    magenta: "#9340b8",
    cyan: "#0f7f93",
    white: "#8a8f9c",
    brightBlack: "#5f6470",
    brightRed: "#de4a52",
    brightGreen: "#4fa23e",
    brightYellow: "#b97c08",
    brightBlue: "#4674e6",
    brightMagenta: "#a956cf",
    brightCyan: "#1895ab",
    brightWhite: "#3a3d46",
  },
};

export function resolveTheme(pref: ThemePref): ThemeName {
  if (pref === "system") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return pref;
}
