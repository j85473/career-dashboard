/** Remembering UI preferences is optional; blocked storage must not interrupt navigation. */
export function readBrowserPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeBrowserPreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The current selection still works when the browser cannot persist it.
  }
}
