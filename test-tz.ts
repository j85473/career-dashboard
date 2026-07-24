function getStartOfDayChicago() {
  const now = new Date();
  const year = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric' }).format(now));
  const month = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'numeric' }).format(now));
  const day = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', day: 'numeric' }).format(now));
  
  const d = new Date(Date.UTC(year, month - 1, day, 5, 0, 0)); 
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: 'numeric', hour12: true });
  
  // Node 18+ includes non-breaking spaces sometimes in AM/PM, so use includes
  if (formatter.format(d).includes('12:00') && formatter.format(d).includes('AM')) {
    return d;
  }
  return new Date(Date.UTC(year, month - 1, day, 6, 0, 0));
}

console.log(getStartOfDayChicago().toISOString());
