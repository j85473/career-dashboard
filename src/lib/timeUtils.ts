export function isDeepseekOffPeak(): { isOffPeak: boolean; reason?: string } {
  const now = new Date();
  const cstHour = (now.getUTCHours() + 8) % 24;
  
  if (cstHour >= 9 && cstHour < 12) {
    return { isOffPeak: false, reason: "Morning Peak (09:00-12:00 CST)" };
  }
  if (cstHour >= 14 && cstHour < 18) {
    return { isOffPeak: false, reason: "Afternoon Peak (14:00-18:00 CST)" };
  }
  
  return { isOffPeak: true };
}
