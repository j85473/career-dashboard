export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.DASHBOARD_RESPONSIVENESS_FILE) {
    const { initializeDashboardResponsiveness } = await import('./lib/dashboardResponsiveness');
    initializeDashboardResponsiveness();
  }
}
