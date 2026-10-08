/** Public UKG Pro boards use legacy UltiPro hosts or employer UKG.net hosts. */
export function isUkgBoardHost(hostname: string): boolean {
  return /^recruiting\d*\.ultipro\.com$/i.test(hostname)
    || /^[a-z0-9][a-z0-9-]*\.rec\.pro\.ukg\.net$/i.test(hostname);
}
