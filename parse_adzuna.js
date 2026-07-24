const fs = require('fs');
const html = fs.readFileSync('adzuna.html', 'utf8');
const links = html.match(/href="([^"]+)"/g);
if (links) {
  links.forEach(l => {
    if (l.includes('5805858554')) console.log(l);
  });
}
